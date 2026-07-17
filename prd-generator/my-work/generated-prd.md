# AI-Native PRD: Resume Screener

## Input / Output Contract

### Inputs

| Name | Format | Constraints | Required |
|------|--------|-------------|----------|
| jobDescription | UTF-8 plaintext or extracted text from PDF/DOCX; maximum 5000 characters | Must contain role title and at least 3 functional requirements. Accepted encodings: UTF-8, ISO 8859-1. Must include at least one of: required qualifications, experience level, or technical skills. | Yes |
| candidateResume | UTF-8 plaintext or extracted text from PDF/DOCX; maximum 8000 characters | English or Hinglish (Hindi-English mix) only. Must contain candidate name and at least 1 employment entry OR 1 educational qualification. No handwritten/scanned-image-only resumes. | Yes |

### Outputs

**screeningResult** — JSON object with nested structure

Always present: recommendation, evidence, confidenceScore, matchedRequirements, unmetRequirements

### Bad Input Handling

**1. Job description or resume is empty, null, or contains only whitespace characters**
- System Behavior: Return HTTP 400 error; abort screening without calling model; do not log as failed screening
- User Message: Both resume and job description are required. Please provide non-empty documents and try again.

**2. Resume lacks any identifiable work experience, education, or skills; or job description has no extractable requirements or role title**
- System Behavior: Proceed with screening but return recommendation='hold' with empty evidence array and explicit note in reasonForDecision field
- User Message: Could not extract sufficient information from the resume. Please verify it is formatted correctly and includes work experience or education, then resubmit.

## Quality Criteria

### 1. Recommendation accuracy — alignment with expert HR judgment ⚠️ Launch Blocker
- **Threshold:** Weighted F1 score of 80% or higher across recommend/hold/reject classes on held-out test set of 150+ manually annotated Indian resumes
- **Measurement:** Run screener on annotated test set with expert HR labels (collected from TalentScope partner HR managers). Calculate per-class precision, recall, F1; report weighted average. Disagree threshold: if inter-rater agreement (HR experts) is <85%, exclude those cases.

### 2. Evidence citation accuracy — every cited qualification exists in source resume ⚠️ Launch Blocker
- **Threshold:** 95% or higher of all evidence items must be verbatim matches or close paraphrases (word-order variation only, no semantic change) of text present in the input resume
- **Measurement:** Manual spot-check: randomly sample 80 screenings from production over 1 week. For each evidence item, verify it is present in the source resume. Calculate percentage of valid citations. Perform this check weekly.

### 3. End-to-end screening latency
- **Threshold:** Median latency 2.5 seconds or lower; 95th percentile latency 6 seconds or lower, measured over 1000 consecutive screening requests in production
- **Measurement:** Log millisecond timestamps at request receipt and response dispatch. Aggregate over 1-week rolling window. Report median and 95th percentile latency every Monday.

## Failure Modes

### 1. Resume document parsing failure
- **Trigger:** Resume is in unsupported format (image-only PDF, encrypted PDF, non-UTF8 encoding), or contains unrecognized character encoding, or extraction library times out after 5 seconds
- **User Experience:** User sees inline message: 'Could not parse this resume. Supported formats: PDF, Word document, plain text. Please reupload.' Screening is skipped for that resume.
- **Logged:** Event: 'resume_parse_error'; fields: document_format, error_type, file_size_bytes, timestamp, resume_id
- **Escalation:** Monitor error rate in real-time dashboard. If parse errors exceed 5% of all incoming resumes in any 1-hour window, trigger alert to on-call engineer; investigate and patch extraction library. Do not disable screener unless error rate exceeds 10%.

### 2. False positive — unqualified candidate marked 'recommend'
- **Trigger:** Model assigns recommendation='recommend' AND confidenceScore ≥ 70 to a resume that is missing 2 or more of the top 3 job-required qualifications extracted from job description
- **User Experience:** HR manager views recommendation='recommend' but supporting evidence does not align with actual job needs; manager must spend 2–3 minutes manually reviewing the resume to catch the mismatch. Trust in screener erodes.
- **Logged:** Event: 'false_positive_candidate'; fields: recommendation, confidenceScore, topRequirements, unmetCount, resumeId, jobId, timestamp
- **Escalation:** If false positive rate exceeds 8% on weekly evaluation set (evaluated on 100+ previously unscreened resumes), pause new screenings for 2 hours. Trigger model retraining review. Notify PM of quality regression. Update confidence thresholds in next deployment.

### 3. False negative — qualified candidate marked 'reject'
- **Trigger:** Model assigns recommendation='reject' to a resume that matches 4 or more of the top 5 required qualifications from the job description, OR matches all required years of experience + 3+ of 5 required skills
- **User Experience:** HR manager does not see a qualified candidate in the 'recommend' pile and loses them. Candidate cannot be easily recovered unless HR manager manually reviews the 'reject' bucket. Lost business value.
- **Logged:** Event: 'false_negative_candidate'; fields: recommendation, confidenceScore, matchedRequirements, unmetCount, resumeId, jobId, timestamp
- **Escalation:** If false negative rate exceeds 12% on weekly evaluation set, send Slack alert to PM and ML lead within 1 hour. Schedule emergency review meeting within 24 hours. Rebalance recommendation thresholds (lower reject threshold, raise hold threshold) in next patch. Do not halt screener, but flag issue as P1.

### 4. Hallucinated evidence — model cites qualifications not in resume
- **Trigger:** Evidence array includes a specific skill, degree, company name, or achievement that cannot be found anywhere in the source resume text, even after lemmatization and synonym checking
- **User Experience:** HR manager reads evidence like '5+ years of Kubernetes production experience' in recommendation, but this text does not appear in the resume. Manager loses trust and second-guesses all screener decisions.
- **Logged:** Event: 'hallucinated_evidence'; fields: evidenceText, retrievedFrom, resumeText, resumeId, jobId, timestamp, modelVersion
- **Escalation:** Flag all instances in real-time telemetry. If hallucination rate exceeds 1.5% of all screenings in any 24-hour window, disable screener immediately and rollback to previous model version. Notify CEO. Conduct root-cause review before re-enabling.

### 5. Ambiguous job description — model cannot extract clear requirements
- **Trigger:** Job description is poorly structured, uses vague language ('nice to have', 'preferred', 'ideally'), lists 12+ requirements without hierarchy, or has contradictory skill requirements
- **User Experience:** Model defaults to marking most candidates as 'hold' instead of clear 'recommend' or 'reject'. HR manager receives 50%+ hold rate for that job, making the tool unhelpful for decision-making.
- **Logged:** Event: 'ambiguous_job_description'; fields: jobId, requirementCount, holdRatio, vagueLangFlag, timestamp
- **Escalation:** If hold rate for a single job_id exceeds 65% after 20+ screenings, log warning and surface job description to TalentScope product team. Suggest HR manager use 'clarify job description' template to rewrite requirements. Offer free manual review of borderline 'hold' candidates for that job.

## Eval Plan

- **Owner:** ML Engineer (primary) and QA Lead (secondary); both jointly maintain test suite and review weekly metrics
- **Cadence:** Pre-deployment on staging (all release candidates); weekly on held-out 200-resume test set (Monday 2:00 PM IST); daily spot-check on 25 random production screenings from previous day
- **Pass Threshold:** LAUNCH-BLOCKING: F1 score ≥ 80% on held-out set AND evidence fidelity ≥ 95% AND zero hallucinations on daily spot-check. NON-BLOCKING: Latency ≤ 6s at p95; false positive rate ≤ 8%; false negative rate ≤ 12%; parse error rate ≤ 3%; ambiguous job description rate ≤ 2%
- **Failure Action:** LAUNCH-BLOCKING failure: Screener is automatically taken offline in production within 30 minutes of failure detection. Disable new screening submissions. Notify PM, ML lead, CEO via Slack #urgent. Begin RCA meeting within 2 hours. Do not re-enable until all blocking criteria pass on retest. NON-BLOCKING failure: Create P2 incident ticket, alert on-call engineer, schedule fix within 48 hours; production continues.

**Test Categories:** Perfect match: Resume exactly contains all top 5 required skills/qualifications, Strong match (70–90%): Resume has 4 of 5 top required skills, meets experience level, Weak match (40–70%): Resume has 2–3 of 5 required skills, partial experience, No match (<40%): Resume missing 3+ top required skills, Overqualified: Resume exceeds job requirements significantly (e.g., PhD for junior role), Underqualified: Resume significantly below job requirements, Format edge cases: Very short resumes (<300 chars), very long resumes (>7500 chars), non-standard layouts, Indian-specific education: Recognizing B.Tech, M.Tech, IIT degrees as equivalent to Western degrees, Employment gaps: 6-month, 12-month, 24-month gaps in employment history, Domain shifts: Candidate from adjacent domain with transferable skills (e.g., backend engineer → data engineer)

**Adversarial Cases:**
1. Resume with only academic coursework and 2 internships (no full-time work), applied to mid-level role requiring 3 years of production experience — test if screener incorrectly maps internship to production experience
2. Job description using bleeding-edge terminology ('Rust for systems programming', 'Retrieval-Augmented Generation') matched against resume using 5-year-old technologies (C++, traditional database). Test if screener recognizes transferable fundamentals vs. requiring exact tech match.
3. Resume with 18-month employment gap in career middle, applied to role with no gap tolerance mentioned in JD. Test if screener penalizes gaps or if gap is ignored based on job requirements.