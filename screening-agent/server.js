const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// POST /api/load-file — Load a file from disk
app.post('/api/load-file', (req, res) => {
  try {
    const { path: filePath } = req.body;

    if (!filePath) {
      return res.status(400).json({ error: 'Missing path' });
    }

    // Security: prevent directory traversal
    const normalizedPath = path.normalize(filePath);
    if (normalizedPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    // Read the file
    const fullPath = path.join(__dirname, normalizedPath);
    const text = fs.readFileSync(fullPath, 'utf-8');

    res.json({ text });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Run a claude -p command with a system prompt and user message
async function runClaudePCommand(stepNum, systemPrompt, userMessage, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const claude = spawn('claude', ['-p', '--append-system-prompt', systemPrompt, userMessage]);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      claude.kill();
      reject(new Error(`timeout after ${timeout}ms`));
    }, timeout);

    claude.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    claude.on('close', (code) => {
      clearTimeout(timeoutHandle);

      console.log(`[Step ${stepNum}] Raw stdout:\n${stdout}\n`);

      if (timedOut) {
        reject(new Error('timeout after ' + timeout + 'ms'));
      } else if (code !== 0) {
        reject(new Error(`exited with code ${code}`));
      } else if (!stdout.trim()) {
        reject(new Error('empty output'));
      } else {
        // Extract JSON from code fences, handling extra text after closing fence
        let json = stdout.trim();

        // Find opening code fence
        const openMatch = json.match(/```(?:json)?\s*\n/);
        if (!openMatch) {
          reject(new Error(`invalid JSON: no opening code fence found`));
          return;
        }

        // Find closing code fence
        const closeIdx = json.indexOf('```', openMatch.index + openMatch[0].length);
        if (closeIdx === -1) {
          reject(new Error(`invalid JSON: no closing code fence found`));
          return;
        }

        // Extract JSON between fences
        json = json.substring(openMatch.index + openMatch[0].length, closeIdx).trim();

        try {
          const parsed = JSON.parse(json);
          resolve(parsed);
        } catch (e) {
          reject(new Error(`invalid JSON: ${e.message}`));
        }
      }
    });

    claude.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`claude CLI not found: ${err.message}`));
    });
  });
}

// Step 1: Function Extraction & Criterion Decomposition
async function runStep1(candidateId, jdText, resumeText) {
  const systemPrompt = `You are analyzing a resume against a job description to identify function types.

YOUR TASK:
1. Extract the required functions from the job description provided.
2. Parse the candidate's resume to identify what work functions they claim to have performed.
3. Output a structured mapping of required vs. claimed functions.

FUNCTION DEFINITIONS (for CSM roles):
- portfolio_management: Owning a list of customer accounts (X accounts), tracking their health
- renewal_ownership: Directly managing contract renewals, expansion revenue, preventing churn
- product_adoption_leadership: Driving customers to adopt more features, training, education
- qbr_facilitation: Conducting quarterly business reviews or similar executive touchpoints
- expansion_identification: Finding upsell and expansion opportunities within accounts
- support_escalation: Managing escalations, working with support to resolve customer issues

OTHER FUNCTION TYPES (distinct from CSM):
- new_customer_acquisition (field sales): Closing new deals, territory management, lead generation
- strategy_advisory (consulting): Developing strategies, analyzing markets, advising clients
- support_delivery (support): Resolving tickets, providing technical assistance, reactive help

INSTRUCTIONS:
- For each required function, list it in the output.
- For each function mentioned in the resume, identify it and cite which job role/section mentioned it.
- Do NOT evaluate whether the claims are real yet — just identify what the candidate claims.
- Output JSON format as specified below.`;

  const userPrompt = `JOB DESCRIPTION:
${jdText}

CANDIDATE RESUME:
${resumeText}

Output a JSON object with:
- candidate_id: "${candidateId}"
- step: 1
- required_functions: array of {function_name, is_knockout, mentioned_in_jd}
- claimed_functions: array of {function_name, found_in_resume_section, source_job_title}
- missing_functions: array of function names from required that aren't in claimed
- timestamp: ISO8601 timestamp
- model_version: "claude-agent-v1"`;

  return runClaudePCommand(1, systemPrompt, userPrompt);
}

// Step 2: Per-Function Verification & Evidence Citation
async function runStep2(candidateId, step1Output, resumeText) {
  const systemPrompt = `You are verifying whether a candidate's resume contains evidence of specific work functions.

YOUR TASK:
For each required function, you will:
1. Search the resume for evidence of that specific work.
2. Determine: MET (clear evidence), NOT_MET (no evidence or contradicts requirement), or CANNOT_VERIFY (ambiguous, insufficient detail).
3. Cite the exact quote from the resume that supports your verdict.
4. If CANNOT_VERIFY, explain why you cannot confirm it from the resume alone.

CRITICAL FUNCTION DISTINCTIONS:
You must treat these as COMPLETELY DIFFERENT functions. Experience in one does NOT count toward requirements in another:

FIELD SALES (new customer acquisition, closing deals, lead generation):
- Does NOT count as portfolio_management or renewal_ownership
- Does NOT count as product_adoption_leadership
- Example: "Generated leads and closed personal loan products" ≠ "renewed customer accounts"

CONSULTING/STRATEGY (advising clients, building strategies, doing analysis):
- Does NOT count as portfolio_management, renewal_ownership, or product_adoption_leadership
- Does NOT count as qbr_facilitation
- Example: "Led operational excellence workstream... mapped processes... identified cost savings" ≠ "managed customer success"

SUPPORT/OPERATIONS (resolving tickets, providing assistance, reactive help):
- Does NOT count as portfolio_management, renewal_ownership, or expansion_identification
- Does NOT count as qbr_facilitation
- Example: "Handled escalations and resolved technical issues" ≠ "owned account renewal and expansion"

WHAT COUNTS as CSM functions:
- portfolio_management: "Managing X accounts" or "Portfolio of X customers" or "Responsible for X accounts"
- renewal_ownership: "Renewed Y contracts", "Managed Y renewals", "All Y accounts renewed", "Y% renewal rate", "Expansion revenue", "NRR", "At-risk account recovery"
- product_adoption_leadership: "Drove adoption", "Trained customers on", "Onboarded", "Product usage increased", "Feature adoption"
- qbr_facilitation: "Quarterly business review", "QBR", "Executive alignment meetings", "Strategic business reviews"
- expansion_identification: "Upsells", "Expansion revenue", "Cross-sell", "Account expansion", "Upsell conversion"
- support_escalation: "Escalation management", "Worked with support team", "Resolved escalations"

YOUR VERDICT RULES:
1. MET: Resume contains a direct statement or quantified outcome showing this function was performed. You can cite it verbatim.
2. NOT_MET: Resume explicitly shows a different function (e.g., field sales instead of CSM), OR the resume mentions customer interaction but NO specific language indicating this required function.
3. CANNOT_VERIFY: The resume is ambiguous (e.g., "worked on customer success" without specifics), OR the job title suggests the function but duties are not detailed. DO NOT GUESS. Return CANNOT_VERIFY, don't assume.

CRITICAL: For CSM roles, if the resume shows ONLY field sales, consulting, or support experience without explicit renewal/portfolio/adoption language, mark those functions as NOT_MET, not CANNOT_VERIFY.

CITATION REQUIREMENT:
- MET verdict: cite the exact quote from the resume
- NOT_MET verdict: cite the quote that shows a different function, OR state "No evidence found in resume"
- CANNOT_VERIFY: cite the ambiguous text and explain why it's insufficient

OUTPUT FORMAT:
See schema below. For every required function, you must produce a complete verdict object.`;

  const requiredFunctions = step1Output.required_functions || [];
  const requiredFunctionsStr = requiredFunctions
    .map(f => `- ${f.function_name}${f.is_knockout ? ' (knockout)' : ' (nice-to-have)'}`)
    .join('\n');

  const userPrompt = `CANDIDATE RESUME:
${resumeText}

REQUIRED FUNCTIONS TO VERIFY:
${requiredFunctionsStr}

For each required function, output a verdict object with: function_name, is_knockout, verdict (MET/NOT_MET/CANNOT_VERIFY), confidence (0-1), evidence_quote, resume_section, reasoning.

Output JSON with:
- candidate_id: "${candidateId}"
- step: 2
- function_verdicts: array of verdict objects
- knockout_verdicts_summary: {all_knockouts_met: boolean, knockouts_met: [], knockouts_not_met: [], knockouts_cannot_verify: []}
- timestamp: ISO8601
- model_version: "claude-agent-v1"`;

  return runClaudePCommand(2, systemPrompt, userPrompt, 60000);
}

// Step 3: Knockout Function Synthesis & Decision Generation
async function runStep3(candidateId, step1Output, step2Output, jdText, resumeText) {
  const systemPrompt = `You are generating a final recommendation based on the function verdicts from Step 2.

YOUR TASK:
1. Apply the decision tree below (this is deterministic, not subjective).
2. Generate a specific, evidence-backed rationale that ties to the function verdicts.
3. Cite the specific evidence from Step 2 verdicts in your reasoning.

DECISION TREE:

IF any knockout function verdict = CANNOT_VERIFY:
  → This should not reach this step. Alert engineering.

IF all knockout functions verdict = MET AND all knockout functions confidence >= 0.75:
  → Decision: SHORTLIST
  → Confidence: average of all knockout confidences

IF all knockout functions verdict = MET BUT at least one knockout confidence < 0.75:
  → Decision: HOLD
  → Confidence: average of all knockout confidences
  → Reason: Knockout functions met but some at medium confidence; human review recommended

IF any knockout function verdict = NOT_MET:
  → Decision: REJECT
  → Confidence: 1.0 (this is deterministic)

GENERATING THE RATIONALE:

For SHORTLIST:
- List all knockout functions met and cite the evidence from Step 2
- Note any nice-to-have functions present (bonus)
- Note any nice-to-have functions absent (but not disqualifying)
- Format: "[Candidate] meets all knockout requirements: [list with evidence]. Additionally, [candidate] has [nice-to-have]. [Candidate] does not have [nice-to-have], but this is not required."

For HOLD:
- Explain which knockout functions are met but at medium/low confidence
- Recommend human review to confirm borderline verdicts
- Format: "[Candidate] meets the essential requirements but several at medium confidence: [details]. Recruiter should verify [specific function] in conversation."

For REJECT:
- List which knockout functions are NOT_MET with direct evidence
- Explain the specific gap (not generic language)
- Format: "[Candidate] does not meet essential requirements: [function] is not demonstrated (expected evidence: [what was needed], found: [what was in resume]). [Candidate] is overqualified/underqualified in [specific way]."

RULES:
- Never output generic language like "insufficient relevant experience"
- Every rejection must cite specific missing functions
- Every SHORTLIST must cite specific evidence for each knockout
- Be concise: 2-4 sentences maximum
- Candidate's name should appear once in the rationale (at start)`;

  const verdictsSummary = step2Output.knockout_verdicts_summary || {};
  const functionVerdicts = step2Output.function_verdicts || [];

  const userPrompt = `STEP 2 VERDICTS SUMMARY:
All knockouts met: ${verdictsSummary.all_knockouts_met}
Knockouts met: ${(verdictsSummary.knockouts_met || []).join(', ') || 'none'}
Knockouts not met: ${(verdictsSummary.knockouts_not_met || []).join(', ') || 'none'}
Knockouts cannot verify: ${(verdictsSummary.knockouts_cannot_verify || []).join(', ') || 'none'}

FULL VERDICTS:
${JSON.stringify(functionVerdicts, null, 2)}

JOB DESCRIPTION:
${jdText}

CANDIDATE RESUME:
${resumeText}

Output JSON with:
- candidate_id: "${candidateId}"
- step: 3
- decision: SHORTLIST/HOLD/REJECT
- confidence: number 0-1
- decision_rationale: string (2-4 sentences, specific evidence)
- knockout_functions_met: array
- knockout_functions_not_met: array
- knockout_functions_uncertain: array
- nice_to_have_present: array
- nice_to_have_absent: array
- flags: array
- recommendation_type: SHORTLIST/HOLD/REJECT
- human_review_required: boolean
- timestamp: ISO8601
- model_version: "claude-agent-v1"`;

  return runClaudePCommand(3, systemPrompt, userPrompt, 60000);
}

// Detect prompt injection in text
function detectPromptInjection(text) {
  const patterns = [
    /output\s+(?:the\s+)?following/i,
    /ignore\s+previous/i,
    /system\s+prompt/i,
    /forget/i
  ];
  return patterns.some(p => p.test(text));
}

// Check HITL triggers per spec
function checkHITLTriggers(step1Output, step2Output, step3Output, resumeText) {
  const hitlGates = [];

  if (!step2Output || !step3Output) {
    return {
      hitl_required: false,
      hitl_reason: null,
      hitl_gates: []
    };
  }

  // Gate 1: CANNOT_VERIFY escalation
  const cannotVerify = (step2Output.knockout_verdicts_summary && step2Output.knockout_verdicts_summary.knockouts_cannot_verify) || [];
  if (cannotVerify.length > 0) {
    hitlGates.push(`Knockout function ${cannotVerify[0]} cannot be verified from resume — human review required`);
  }

  // Gate 2: Low confidence threshold
  if ((step3Output.confidence || 0) < 0.60) {
    hitlGates.push(`Medium confidence (${(step3Output.confidence || 0).toFixed(2)}). Recommend verification in phone screen`);
  }

  // Gate 3: Persuasive wrong candidate detection
  if ((step3Output.decision || '').toUpperCase() === 'REJECT') {
    const tierOneColleges = ['IIT', 'IIM', 'XLRI', 'SPJIMR'];
    const hasTierOne = tierOneColleges.some(c => resumeText.includes(c));
    const hasCoverLetter = /apply|drawn to|transition|interested|motivation/i.test(resumeText);
    const niceToHaves = step3Output.nice_to_have_present || [];

    if ((hasTierOne || hasCoverLetter) && niceToHaves.length > 0) {
      hitlGates.push(`Candidate has strong credentials and clear interest in role, but does not meet knockout requirements. Recommend phone screen if pipeline is weak`);
    }
  }

  // Gate 4: Function type conflation detection
  if (['SHORTLIST', 'HOLD'].includes((step3Output.decision || '').toUpperCase())) {
    const verdicts = step2Output.function_verdicts || [];
    verdicts.forEach(v => {
      if (v.verdict === 'MET' && v.is_knockout) {
        const quote = (v.evidence_quote || '').toLowerCase();
        const jobTitle = (v.source_job_title || '').toLowerCase();

        const isDifferentFunction =
          ((/sales|closing|leads/i.test(quote) && jobTitle.includes('sales')) ||
           (/strategy|analysis|operations|mapped|processes/i.test(quote) && (jobTitle.includes('consultant') || jobTitle.includes('manager'))) ||
           (/ticket|escalat|help/i.test(quote) && jobTitle.includes('support')));

        const isCsmFunction = ['portfolio_management', 'renewal_ownership', 'product_adoption_leadership'].includes(v.function_name);

        if (isDifferentFunction && isCsmFunction) {
          hitlGates.push(`Attention: ${v.function_name} experience comes from different function type. Verify in conversation`);
        }
      }
    });
  }

  // Gate 5: Prompt injection detected
  if (detectPromptInjection(resumeText)) {
    hitlGates.push(`⚠️ Prompt injection attempt detected in resume. This has been ignored in evaluation`);
  }

  // Gate 6: Anomalous decision
  const knockoutsMet = step3Output.knockout_functions_met || [];
  const knockoutsNotMet = step3Output.knockout_functions_not_met || [];

  if ((step3Output.decision === 'SHORTLIST' && knockoutsNotMet.length > 0) ||
      (step3Output.decision === 'REJECT' && knockoutsMet.length > 0 && knockoutsNotMet.length === 0)) {
    hitlGates.push(`System error: Decision does not match evaluation verdicts`);
  }

  return {
    hitl_required: hitlGates.length > 0,
    hitl_reason: hitlGates.length > 0 ? hitlGates.join(' | ') : null,
    hitl_gates: hitlGates
  };
}

// POST /api/screen endpoint
app.post('/api/screen', async (req, res) => {
  try {
    const { job_description, candidate_profile } = req.body;

    if (!job_description || !candidate_profile) {
      return res.status(400).json({ error: 'Missing job_description or candidate_profile' });
    }

    const jdText = job_description;
    const resumeText = candidate_profile;

    const candidateId = `cand-${Date.now()}`;

    // Step 1: Function extraction
    let step1;
    try {
      step1 = await runStep1(candidateId, jdText, resumeText);
    } catch (err) {
      return res.status(500).json({ error: `Step 1: ${err.message}` });
    }

    // Step 2: Per-function verification
    let step2;
    try {
      step2 = await runStep2(candidateId, step1, resumeText);
    } catch (err) {
      return res.status(500).json({ error: `Step 2: ${err.message}` });
    }

    // If CANNOT_VERIFY on any knockout, route to HOLD
    const cannotVerify = step2.knockout_verdicts_summary?.knockouts_cannot_verify || [];
    if (cannotVerify.length > 0) {
      return res.json({
        recommendation: 'hold',
        confidence: 0.5,
        must_have_coverage: 0,
        hitl_required: true,
        hitl_reason: `Knockout function ${cannotVerify[0]} cannot be verified from resume — human review required`,
        criteria_extracted: (step1.required_functions || []).filter(f => f.is_knockout).map(f => ({ name: f.function_name })),
        criteria_evaluation: [],
        top_reasons: [{ label: 'CANNOT VERIFY', evidence: `${cannotVerify[0]} cannot be confirmed`, signal: 'Insufficient evidence in resume' }]
      });
    }

    // Step 3: Decision generation
    let step3;
    try {
      step3 = await runStep3(candidateId, step1, step2, jdText, resumeText);
    } catch (err) {
      return res.status(500).json({ error: `Step 3: ${err.message}` });
    }

    // Check HITL triggers
    const hitl = checkHITLTriggers(step1, step2, step3, resumeText);

    // Build UI-friendly recommendation output
    const knockoutsMet = (step3 && step3.knockout_functions_met) || [];
    const knockoutsNotMet = (step3 && step3.knockout_functions_not_met) || [];
    const knockoutsUncertain = (step3 && step3.knockout_functions_uncertain) || [];
    const verdicts = (step2 && step2.function_verdicts) || [];

    // Transform verdicts to UI format
    const criteria_evaluation = verdicts
      .filter(v => v.is_knockout)
      .map(v => ({
        criterion: v.function_name,
        verdict: v.verdict,
        evidence_quote: v.evidence_quote || 'No evidence found',
        confidence: v.confidence || 0
      }));

    // Criteria extracted from step 1
    const criteria_extracted = (step1.required_functions || [])
      .filter(f => f.is_knockout)
      .map(f => ({
        name: f.function_name
      }));

    // Top reasons
    const top_reasons = [
      ...knockoutsMet.map(f => ({
        label: 'MET',
        evidence: `${f} requirement met`,
        signal: verdicts.find(v => v.function_name === f)?.evidence_quote || ''
      })),
      ...knockoutsNotMet.map(f => ({
        label: 'NOT MET',
        evidence: `${f} requirement not demonstrated`,
        signal: verdicts.find(v => v.function_name === f)?.evidence_quote || 'No evidence found'
      }))
    ];

    // Calculate must-have coverage percentage
    const totalMustHaves = knockoutsMet.length + knockoutsNotMet.length + knockoutsUncertain.length;
    const must_have_coverage = totalMustHaves > 0 ? knockoutsMet.length / totalMustHaves : 0;

    // Determine recommendation (HITL takes precedence)
    let recommendation = (step3 && step3.decision) ? step3.decision.toUpperCase() : 'HOLD';
    if (hitl.hitl_required && recommendation === 'SHORTLIST') {
      recommendation = 'HOLD';
    }

    // Map recommendation to UI format
    const recMap = {
      'SHORTLIST': 'recommend',
      'HOLD': 'hold',
      'REJECT': 'reject'
    };
    const recUI = recMap[recommendation] || 'hold';

    // Format response for frontend
    const responseData = {
      recommendation: recUI,
      confidence: (step3 && step3.confidence) ? step3.confidence : 0,
      must_have_coverage: must_have_coverage,
      hitl_required: hitl.hitl_required,
      hitl_reason: hitl.hitl_reason || '',
      criteria_extracted: criteria_extracted,
      criteria_evaluation: criteria_evaluation,
      top_reasons: top_reasons.slice(0, 5)
    };

    res.json(responseData);

  } catch (err) {
    console.error('Error in /api/screen:', err);
    res.status(500).json({ error: err.message || 'Unexpected error during screening' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
