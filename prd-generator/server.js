const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function buildPrompt(featureName, featureDescription, companyContext, userProblem) {
  return `You are a senior AI product manager. You write AI-native PRDs that include the four sections traditional PRDs miss: input/output contract, quality criteria, failure modes and fallbacks, and an eval plan. When given a feature brief, you produce a structured PRD section in valid JSON — no markdown, no code fences, just the JSON object.
Write the AI-native PRD section for this feature:
Feature name: ${featureName}
Description: ${featureDescription}
Company context: ${companyContext}
User problem: ${userProblem}

CONTRACT — return exactly this JSON structure:
{
  "featureName": "string",
  "inputOutputContract": {
    "inputs": [
      { "name": "string", "format": "string", "constraints": "string", "required": true }
    ],
    "outputs": [
      { "name": "string", "format": "string", "alwaysPresent": ["list of fields guaranteed in every output"] }
    ],
    "badInputHandling": [
      { "scenario": "string", "systemBehavior": "string", "userMessage": "string" }
    ]
  },
  "qualityCriteria": [
    {
      "criterion": "string — one specific, measurable quality property",
      "threshold": "string — numeric or observable threshold, no adjectives",
      "measurementMethod": "string — exactly how you would measure this",
      "launchBlocker": true
    }
  ],
  "failureModes": [
    {
      "name": "string — a short name for this failure mode",
      "trigger": "string — exact input condition or model behavior",
      "userExperience": "string — exact message or behavior the user sees (not 'handle gracefully')",
      "logged": "string — what event is logged",
      "escalation": "string — who is notified and what they do"
    }
  ],
  "evalPlan": {
    "owner": "string — role responsible for writing and maintaining the test suite",
    "testCategories": ["list of input categories the suite must cover"],
    "adversarialCases": ["3 specific inputs designed to break this feature"],
    "cadence": "string — when the suite runs",
    "passThreshold": "string — specific pass/fail threshold",
    "failureAction": "string — what happens when the suite fails"
  }
}
CONSTRAINTS:
- Exactly 2 inputs, 1 output with at least 3 guaranteed fields, 2 bad input scenarios
- Exactly 3 quality criteria
- Exactly 5 failure modes
- Every threshold must include a number (percentage, count, or time value) — no adjectives allowed. If no benchmark data exists, write the threshold as [NEEDS DATA: description of what data would set this threshold].`;
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'text'], {
      shell: true,
      timeout: 120000,
    });

    let stdout = '';
    let stderr = '';

    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Claude CLI timed out after 120s'));
    }, 120000);

    child.on('close', (code) => {
      clearTimeout(timer);
      console.log('--- Claude stdout ---');
      console.log(stdout);
      console.log('--- Claude stderr ---');
      console.log(stderr);

      if (code !== 0) {
        return reject(new Error(`Claude CLI exited with code ${code}. stderr: ${stderr.trim()}`));
      }
      resolve(stdout);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error('Claude CLI not found. Ensure `claude` is installed and on PATH.'));
      } else {
        reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
      }
    });
  });
}

function extractJson(raw) {
  // Strip ```json ... ``` or ``` ... ``` fences if present
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : raw.trim();
}

app.post('/api/generate-prd', async (req, res) => {
  const { featureName, featureDescription, companyContext, userProblem } = req.body;

  if (!featureName || !featureDescription || !companyContext || !userProblem) {
    return res.status(400).json({ success: false, error: 'Missing required fields: featureName, featureDescription, companyContext, userProblem' });
  }

  const prompt = buildPrompt(featureName, featureDescription, companyContext, userProblem);

  let raw;
  try {
    raw = await callClaude(prompt);
  } catch (err) {
    console.error('Claude call failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }

  if (!raw || raw.trim() === '') {
    console.error('Claude returned empty output');
    return res.status(500).json({ success: false, error: 'Claude returned empty output' });
  }

  const jsonStr = extractJson(raw);

  let prd;
  try {
    prd = JSON.parse(jsonStr);
  } catch (err) {
    console.error('Failed to parse Claude output as JSON:', err.message);
    console.error('Raw output was:', raw);
    return res.status(500).json({ success: false, error: `Claude output was not valid JSON: ${err.message}` });
  }

  return res.json({ success: true, prd });
});

app.post('/api/save-prd', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
