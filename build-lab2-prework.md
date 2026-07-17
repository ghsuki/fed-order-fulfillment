##Step 1 - Agent loop

**What is the initial input?**
- Job Description(JD) + Resume + Status (Recommend|Hold) from Resume Screener

**What does the agent decide first?**
- Identify the relevant areas of must-have expertise/experience required for the job role mentioned in the JD 

**What does it call / retrieve?**
- Job Description document & the Resume document

**What does it do with that information?**
- For each area of must-have expertise/experience as per JD, assign a weightage % to each area of required experience with all areas of must-have experiences adding to 100%.  total it will check the resume, ask a question to the candidate. Question should be scenario based and of evidence-seeking type. The opening question should be relevant to the candidate's background and the role

**What triggers the next step?**
- Answer to the previous question will trigger the next question. Is the answer complete, or does it need a follow-up? The follow-up question should be based on the coverage & depth of must-have expertise related questions asked till this point. When deciding if an answer needs follow-up, should I use a prompt that tells Claude to evaluate Coverage of the specific expertise area, and Depth of evidence/examples

**What triggers termination?**
- 8 questions, or candidate's response indicating to exit/quit the interview

**What is the final output?**
- It should score/rank candidates based on responses. A score in between 0 to 100 indicating performance of interview matching the JD, and rationale of the score with individual scoring of must-have experiences by applying the weightage. Weightage weightage assignment be done by Claude (ask it to parse JD and assign weights), or should I build logic to extract and weight expertise areas?  Output JSON Structure should include:
  - Individual scores per expertise area (with their assigned weights)
  - Question-answer pairs
  - Past interview history (if available)

##Step 2 - List your tools
- Check in the Supabase database if the same candidate identified by email or Phone number) had given interview in the past. If yes, include the past interview Job role, Date interviewed and interview result summary. Include this Past Interview History information also in the output report if available, else put Not available

##Step 3: Write one failure-mode scenario
- When candidate's response is not having clarity or does not answer properly, the agent will ask follow-up questions but it may so happen the agent can not check out all the must-have areas as the limit of 8 questions is reached. The agent will score the candidate on all the areas without assessing some of the must-have areas. Instead, it should include in the output that experience 1,2, 3 are assessed and scored, but experience 4,5 are not interviewed

##Language & Framework and other specifications to be used to build:
- Node.js, HTML + JS with API calls
- Expose REST endpoint, use ANTHROPIC_API_KEY
- Store interview result as JSON data
- Interview can be paused by the candidate and resumed at later point
- Input Format: job description and resume are pasted text
- Start with as a standalone service taking inputs as above
- HR Manager will be the consumer of the output, interview summary with score with factual response
- Assume Supabase Setup is already configured
- Pause/Resume: Store interview state (current question count, answered areas, conversation history) so candidates can resume exactly where they left off.
ENDPOINTS to be created:
- POST /interview/start (with JD, resume, email, phone)
  - POST /interview/{sessionId}/answer (with candidate's answer)
  - GET /interview/{sessionId} (check status/history)?
