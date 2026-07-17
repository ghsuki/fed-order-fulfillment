# AI-Native PRD: Federal Order Fulfillment Control Tower (PoC)
# Version: 2.0 — Eval section revised

## Overview

A PoC web application that simulates a Global Federal Order Fulfillment
Control Tower. The AI agent analyses cross-CM inventory, detects fulfillment
risk for incoming federal orders, and returns ranked fulfillment scenarios
with clear reasoning. Supabase replaces Celonis and real CM integrations
for the PoC. Synthetic data populates the data model.

Stack: Next.js · Supabase (PostgreSQL) · Claude API · Vercel · Langfuse

---

## Input / Output Contract

### Inputs

| Name | Format | Constraints | Required |
|------|--------|-------------|----------|
| order_id | Text string | Must exist in federal_orders table in Supabase; must have status = 'open' or 'at_risk' | Yes |
| trigger_mode | Enum: auto \| manual | auto = triggered by risk score threshold; manual = planner clicks "Run Scenario" in UI | Yes |
| context_payload | JSON object | Built by API route from Supabase query; must include federal_order, cm_inventory array, committed_orders array; all three keys required | Yes (assembled server-side) |

#### context_payload structure (assembled server-side before Claude call)

```json
{
  "federal_order": {
    "order_id": "string",
    "sku": "string",
    "qty_required": "integer > 0",
    "required_ship_date": "ISO date string",
    "compliance_rule": "TAA | ITAR | NONE"
  },
  "cm_inventory": [
    {
      "cm_id": "string",
      "cm_name": "string",
      "country": "string",
      "taa_compliant": "boolean",
      "sku": "string",
      "stock_type": "FG | WIP | RM",
      "qty_available": "integer >= 0",
      "hold_status": "available | qa_hold | committed",
      "lead_time_days": "integer",
      "est_completion_date": "ISO date string | null"
    }
  ],
  "committed_orders": [
    {
      "commit_id": "string",
      "cm_id": "string",
      "sku": "string",
      "committed_qty": "integer > 0",
      "promised_date": "ISO date string",
      "priority_tier": "commercial | federal",
      "revenue_impact_usd": "integer >= 0"
    }
  ]
}
```

### Outputs

**fulfillmentResult** — JSON object written to fulfillment_scenarios table
and returned to planner UI

Always present: order_id, risk_assessment, scenarios, recommendation,
units_unresolvable

#### fulfillmentResult structure

```json
{
  "order_id": "string",
  "risk_assessment": {
    "risk_score": "critical | high | medium | low",
    "risk_reason": "string — one sentence"
  },
  "scenarios": [
    {
      "rank": "integer 1–3",
      "levers_used": ["direct_ship | cross_cm_transfer | commitment_rebalancing | multi_stage_manufacturing"],
      "plan_summary": "string — 2-3 sentences plain English",
      "steps": [
        {
          "action": "string",
          "cm_id": "string",
          "qty": "integer",
          "note": "string",
          "disruption_impact": "string | null"
        }
      ],
      "total_qty_fulfilled": "integer",
      "cost_impact_usd": "integer",
      "feasibility": "full | partial",
      "compliance_status": "string",
      "trade_off_note": "string | null"
    }
  ],
  "recommendation": "string",
  "units_unresolvable": "integer >= 0"
}
```

### Bad Input Handling

**1. order_id does not exist in federal_orders table**
- System Behavior: Return HTTP 404; do not call Claude; do not write to fulfillment_scenarios
- User Message: "Order not found. Please check the order ID and try again."

**2. order_id exists but status is already 'fulfilled' or 'rejected'**
- System Behavior: Return HTTP 409; do not call Claude
- User Message: "This order has already been processed. Navigate to order history to view its fulfillment record."

**3. cm_inventory array is empty after Supabase query (no inventory records for that SKU)**
- System Behavior: Proceed with Claude call; pass empty array; agent must return risk_score = 'critical' and scenarios = [] with explanation
- User Message: Surface agent's recommendation text in UI with a red banner: "No inventory found across any CM for this SKU."

**4. context_payload is malformed or missing required keys (server-side assembly failure)**
- System Behavior: Return HTTP 500; do not call Claude; log error with order_id and payload snapshot
- User Message: "An internal error occurred while preparing order data. Please try again or contact support."

**5. Claude API returns non-JSON or malformed response**
- System Behavior: Retry once after 2 seconds; if retry also fails, return HTTP 502; log raw Claude response for debugging
- User Message: "The AI agent returned an unexpected response. Please try again."

---

## Supabase Data Model

### Table: federal_orders
| Column | Type | Notes |
|--------|------|-------|
| order_id | text PK | e.g. FED-88421 |
| sku | text | |
| qty_required | integer | > 0 |
| required_ship_date | date | |
| compliance_rule | text | TAA / ITAR / NONE |
| status | text | open / at_risk / fulfilled / rejected |
| risk_score | text | low / medium / high / critical; updated after each agent run |
| created_at | timestamptz | |

### Table: contract_manufacturers
| Column | Type | Notes |
|--------|------|-------|
| cm_id | text PK | e.g. CM1 |
| cm_name | text | |
| country | text | |
| taa_compliant | boolean | |
| capacity_units | integer | |
| lead_time_days | integer | Static field for PoC |

### Table: cm_inventory
| Column | Type | Notes |
|--------|------|-------|
| inventory_id | uuid PK | |
| cm_id | text FK → contract_manufacturers | |
| sku | text | |
| stock_type | text | FG / WIP / RM |
| qty_available | integer | >= 0 |
| taa_compliant | boolean | |
| hold_status | text | available / qa_hold / committed |
| est_completion_date | date | WIP only; null for FG/RM |
| updated_at | timestamptz | |

### Table: committed_orders
| Column | Type | Notes |
|--------|------|-------|
| commit_id | text PK | |
| cm_id | text FK → contract_manufacturers | |
| sku | text | |
| committed_qty | integer | |
| promised_date | date | |
| priority_tier | text | commercial / federal |
| revenue_impact_usd | integer | |

### Table: fulfillment_scenarios
| Column | Type | Notes |
|--------|------|-------|
| scenario_id | uuid PK | |
| order_id | text FK → federal_orders | |
| rank | integer | 1 / 2 / 3 |
| levers_used | text[] | |
| plan_summary | text | |
| steps | jsonb | Full steps array from agent output |
| total_qty_fulfilled | integer | |
| cost_impact_usd | integer | |
| feasibility | text | full / partial |
| compliance_status | text | |
| trade_off_note | text | |
| status | text | proposed / approved / rejected |
| langfuse_trace_id | text | Links Supabase row to Langfuse trace for audit |
| created_at | timestamptz | |

---

## Synthetic Seed Data

Three CMs:
- CM1 · Vietnam · TAA compliant · lead_time_days = 4
- CM2 · Mexico · TAA compliant · lead_time_days = 5
- CM3 · China · TAA non-compliant · lead_time_days = 3

Three SKUs: RTR-4500 · SRV-2200 · NET-900

### Named seed orders — five total (three primary + two adversarial)

| order_id | SKU | Qty | SLA | Compliance | Expected risk | Levers exercised | Used in test |
|----------|-----|-----|-----|------------|---------------|-----------------|--------------|
| FED-88421 | RTR-4500 | 600 | July 14 | TAA | Critical | Levers 1+3+4 combined | T2, T6, A4, A5 |
| FED-90012 | NET-900 | 300 | July 18 | TAA | Low | Lever 1 only | T1 |
| FED-91005 | SRV-2200 | 450 | July 20 | ITAR | High | Levers 1+2 combined | T3 |
| FED-92001 | RTR-4500 | 400 | July 16 | TAA | Critical | None — all stock on qa_hold | T4 |
| FED-92002 | NET-900 | 250 | July 19 | TAA | Critical | None — only CM3 stock available | T5 |

### Inventory setup per order

- FED-88421: 180 FG at CM1 (TAA ✓, available), 200 WIP at CM1 (TAA ✓,
  est_completion July 12), 240 FG at CM2 (TAA ✓, committed/commercial),
  500 FG at CM3 (TAA ✗, available) — forces agent to combine levers and
  exclude CM3
- FED-90012: 300 FG at CM2 (TAA ✓, available) — clean happy path,
  Lever 1 stops the search
- FED-91005: 150 FG at CM1 (ITAR ✓, available), 300 FG at CM2
  (ITAR ✓, available, lead_time_days = 5, transfer ETA July 15 < SLA July 20)
  — forces cross-CM transfer for remaining 300 units
- FED-92001: 400 FG at CM1 (TAA ✓) with hold_status = qa_hold;
  no other stock for this SKU — forces scenarios = [], units_unresolvable = 400
- FED-92002: 250 FG at CM3 only (TAA ✗, available) — compliance gate
  blocks only available stock; forces scenarios = [] with compliance explanation

---

## Quality Criteria

### 1. Compliance constraint enforcement ⚠️ DEMO-BLOCKING
- **Threshold:** 100% of scenarios returned must contain zero non-TAA/ITAR-
  compliant inventory allocations when compliance_rule is TAA or ITAR.
  Zero tolerance — a single violation is a blocking failure.
- **Measurement:** Server-side validator runs after every Claude response,
  before writing to Supabase. Cross-checks each step's cm_id against
  contract_manufacturers.taa_compliant for the order's compliance_rule.
  Any violation suppresses the scenario, triggers a re-prompt, and emits
  a Langfuse event 'compliance_violation' with compliance_pass score = 0.
- **Cadence:** Every agent call in all environments. Reported as Langfuse
  score compliance_pass; must trend at 1.0 across all traces.

### 2. Federal order priority satisfaction ⚠️ DEMO-BLOCKING
- **Threshold:** 100% of returned scenarios where feasibility = 'full'
  must have total_qty_fulfilled = federal_order.qty_required exactly.
  No rounding, no partial fulfillment labelled full.
- **Measurement:** Server-side validator sums qty across all steps in
  each scenario and asserts equality with qty_required before writing
  to Supabase. Mismatch triggers a re-prompt once and emits Langfuse
  event 'partial_fulfillment_mislabelled' with qty_assertion_pass = 0.
- **Cadence:** Every agent call. Reported as Langfuse score
  qty_assertion_pass; must trend at 1.0 across all traces.

### 3. Hallucinated inventory — zero tolerance ⚠️ DEMO-BLOCKING
- **Threshold:** 0% of scenarios may reference a cm_id not present in
  the context_payload, or propose qty greater than qty_available for
  any CM + SKU combination in the context_payload.
- **Measurement:** Server-side validator cross-checks every step's cm_id
  and qty against the exact cm_inventory rows passed in context_payload.
  Any hallucination suppresses the scenario immediately, triggers a
  re-prompt once, and emits Langfuse event 'hallucinated_inventory'.
  If hallucination persists on retry, agent is disabled for that order
  and a manual review banner is shown in UI.
- **Cadence:** Every agent call. If hallucination rate exceeds 0% on
  any 24-hour window across all orders, treat as P0 — review system
  prompt and context assembly before next demo.
- **Note:** Moved from NON-BLOCKING in v1. A hallucinated inventory plan
  that gets planner approval results in an execution failure — equivalent
  in severity to a compliance violation for demo credibility.

### 4. Scenario reasoning accuracy — lever selection correctness
- **Threshold:** For each of the 5 named seed orders (FED-88421,
  FED-90012, FED-91005, FED-92001, FED-92002), agent must select the
  expected lever combination or expected empty-scenario outcome on
  9 out of 10 consecutive runs (90% consistency).
- **Measurement:** Run each seed order 10 times via Langfuse dataset
  run API against dataset 'federal-fulfillment-seed-evals'. Compare
  levers_used array against expected lever set in dataset expected
  output. Calculate match rate per order. Acceptable variance: lever
  order within a combined plan may vary; lever set must match exactly.
  Report lever_accuracy score (1 = match, 0 = mismatch) per trace.
- **Cadence:** Before each demo; after any system prompt change;
  after any Langfuse prompt version update (see cadence note below).

### 5. Response latency
- **Threshold:** Median end-to-end latency (Supabase query + Claude
  call + response write) ≤ 5 seconds; p95 ≤ 10 seconds.
- **Measurement:** Log millisecond timestamps at four points per
  request: request received, Supabase query complete, Claude response
  received, response written to Supabase. Compute median and p95 over
  50 consecutive runs. Report as Langfuse score latency_within_sla
  (1 = ≤ 5s, 0 = > 5s) per trace.
- **Cadence:** Measured on every run; aggregated and reviewed before
  each demo.

### 6. Output schema validity
- **Threshold:** 100% of Claude responses must parse as valid JSON
  matching the fulfillmentResult schema with all required keys present.
- **Measurement:** Server-side JSON schema validator runs on every
  response before writing to Supabase. Schema violations emit
  Langfuse event and trigger one retry. Report as Langfuse score
  schema_valid (1 = valid, 0 = invalid) per trace.
- **Cadence:** Every agent call.

---

## Failure Modes

### 1. Compliance constraint violated — non-compliant inventory proposed
- **Trigger:** Any step in any scenario allocates inventory from a CM
  where taa_compliant = false and the order's compliance_rule = 'TAA',
  or proposes ITAR-restricted inventory from an ineligible CM
- **User Experience:** Planner sees a plan that would pass a
  non-compliant unit to a federal customer — a regulatory violation
  with legal consequences
- **Logged:** Event: 'compliance_violation'; fields: order_id,
  scenario_rank, step_index, cm_id, compliance_rule, timestamp,
  model_response_raw
- **Escalation:** Immediately suppress scenario from UI. Do not show
  planner. Retry Claude call once with explicit compliance failure
  noted in re-prompt. If second response also violates — return
  HTTP 500 and alert developer. Zero tolerance; DEMO-BLOCKING.

### 2. Hallucinated inventory — agent proposes stock not in Supabase
- **Trigger:** Agent step references a cm_id or qty not present in
  the context_payload rows, or proposes qty greater than qty_available
  for that CM + SKU
- **User Experience:** Planner approves a plan based on inventory
  that does not physically exist. Execution fails. Trust destroyed.
- **Logged:** Event: 'hallucinated_inventory'; fields: order_id,
  cm_id, proposed_qty, actual_qty_available, scenario_rank,
  timestamp, model_response_raw
- **Escalation:** Suppress scenario immediately. Retry once. If
  hallucination persists on retry, disable agent for that order and
  surface manual review banner. Log as P0. DEMO-BLOCKING.

### 3. Federal order partially fulfilled but marked feasibility = 'full'
- **Trigger:** total_qty_fulfilled < qty_required in a scenario where
  feasibility = 'full'
- **User Experience:** Planner approves a plan believing the order
  is fully covered; federal customer receives short shipment;
  contract penalty triggered
- **Logged:** Event: 'partial_fulfillment_mislabelled'; fields:
  order_id, qty_required, total_qty_fulfilled, scenario_rank,
  timestamp
- **Escalation:** Server-side validator catches before Supabase write.
  Reject, re-prompt once. If second response also mislabelled,
  return error to UI. Log as P1.

### 4. Agent returns no scenarios for a fulfillable order
- **Trigger:** scenarios = [] returned but Supabase data contains
  sufficient compliant inventory to fulfill via at least one lever
- **User Experience:** Planner sees "no plan available" when a valid
  plan exists. Federal order goes unactioned. SLA missed.
- **Logged:** Event: 'missed_fulfillment_opportunity'; fields:
  order_id, qty_required, total_compliant_qty_available, timestamp,
  model_response_raw
- **Escalation:** Server-side pre-check: before calling Claude,
  compute total compliant FG + WIP qty across all CMs. If total >=
  qty_required and Claude returns scenarios = [], log P1 and surface
  fallback banner: "Agent returned no plan. Manual review required."

### 5. Claude API timeout or rate limit
- **Trigger:** Claude API call exceeds 15 seconds or returns HTTP 429
- **User Experience:** Planner sees spinner that never resolves
- **Logged:** Event: 'claude_api_error'; fields: order_id,
  error_type, http_status, latency_ms, timestamp
- **Escalation:** Retry once after 3 seconds with exponential
  backoff. If retry fails, return HTTP 503: "Scenario generation is
  temporarily unavailable. Please try again in 30 seconds." Monitor
  rate limit frequency; upgrade API tier if limits exceed 5/hour.

### 6. Supabase query returns stale data
- **Trigger:** cm_inventory.updated_at timestamp is more than 60
  minutes old at time of agent call
- **User Experience:** Agent reasons on stale inventory figures
- **Logged:** Event: 'stale_inventory_data'; fields: order_id,
  oldest_updated_at, current_timestamp, staleness_minutes
- **Escalation:** Surface yellow warning banner: "Inventory data
  is more than 60 minutes old. Verify stock before approving."
  Do not block scenario generation. Log as P3 for PoC; P1 in
  production.

---

## Planner UI Screens

### Screen 1 — Federal Order Dashboard
- Table of all federal_orders with columns:
  order_id · SKU · qty_required · required_ship_date · status · risk_score
- Risk score shown as colour-coded badge:
  low = green · medium = amber · high = red · critical = flashing red
- "Run Scenario" button per row (manual trigger)
- Auto-trigger badge shown if scenario was auto-generated

### Screen 2 — Scenario Panel (per order)
- Federal order summary at top: order_id · SKU · qty · SLA · compliance rule
- Up to 3 ranked scenario cards, each showing:
  - Rank badge · levers used tags · plan_summary
  - Step-by-step breakdown table: action · CM · qty · note · disruption impact
  - Cost impact · total qty fulfilled · feasibility badge · compliance status
  - trade_off_note highlighted in amber if present
- Approve / Reject buttons per scenario (only one approvable)
- On approve: scenario status → 'approved' in Supabase;
  federal_orders.status → 'fulfilled'; other scenarios → 'rejected'

### Screen 3 — Order History
- Fulfilled and rejected orders with their approved scenario summary
- Audit trail: which scenario was approved, when, lever used, cost impact
- Langfuse trace link per row for full reasoning inspection

---

## Eval Plan

### Owner
Developer (primary); PoC reviewer / judge (secondary). Both jointly
maintain the Langfuse dataset and review scores before each demo.

### Cadence
- **Before each demo:** Run all 5 seed orders through agent via
  Langfuse dataset run API. Verify all scores (compliance_pass,
  qty_assertion_pass, schema_valid, lever_accuracy) = 1.0 for
  T1–T6 and A1–A5. Do not present with any DEMO-BLOCKING failure.
- **After any system prompt change in code:** Re-run full seed suite
  before committing. Block commit if any DEMO-BLOCKING criterion fails.
- **After any Langfuse prompt version update:** Re-run full T1–T6
  and A1–A5 suite via Langfuse dataset run API before marking the
  new prompt version as stable. A prompt update that has not passed
  the full eval suite must not be used in a live demo.
- **On each individual run (automated):** Server-side validators
  run compliance, qty assertion, hallucination, and schema checks
  on every agent response in real time. Scores written to Langfuse
  immediately. Failures trigger re-prompt or suppression per
  failure mode definitions above.

### Pass Threshold

**DEMO-BLOCKING — must all pass before any demo or judge presentation:**

| Criterion | Threshold | Measured by | Langfuse score |
|-----------|-----------|-------------|----------------|
| Compliance constraint | 100% — zero violations | Server-side validator on every call | compliance_pass = 1.0 |
| Federal priority satisfaction | 100% — no partial labelled full | Server-side qty assertion | qty_assertion_pass = 1.0 |
| Hallucinated inventory | 0% — zero hallucinations | Server-side inventory cross-check | hallucination_pass = 1.0 |
| Schema validity | 100% — all responses parse | Server-side JSON schema validator | schema_valid = 1.0 |
| Seed order lever accuracy | 5/5 orders return expected outcome | Langfuse dataset run T1–T6 | lever_accuracy = 1.0 on all 5 |

**NON-BLOCKING — note as known PoC limitation if failing:**

| Criterion | Threshold | Measured by | Langfuse score |
|-----------|-----------|-------------|----------------|
| Latency median | ≤ 5 seconds | Timestamp logging per request | latency_within_sla |
| Latency p95 | ≤ 10 seconds | Aggregated over 50 runs | — |
| Missed fulfillment opportunity | 0 on seed data | Server-side pre-check | — |

### Failure Action
- **DEMO-BLOCKING failure:** Fix system prompt or context assembly
  logic immediately. Do not present to judges. Re-run full eval
  suite after fix. Only proceed when all blocking criteria pass.
- **NON-BLOCKING failure:** Note as known limitation in presentation.
  Attribute latency issues to PoC stack vs. production Celonis context.
  Log as P2 and schedule fix after demo.

---

## Test Cases

| ID | Order | Scenario description | Expected levers | Expected risk | Pass condition |
|----|-------|----------------------|-----------------|---------------|----------------|
| T1 | FED-90012 | Full FG available at CM2, TAA clean | direct_ship only | low | feasibility=full, 1 scenario, no trade-off note, units_unresolvable=0 |
| T2 | FED-88421 | Partial FG at CM1, WIP at CM1, committed at CM2, CM3 non-compliant | direct_ship + commitment_rebalancing + multi_stage | critical | CM3 excluded in all steps, all 3 levers present, feasibility=full, total_qty_fulfilled=600 |
| T3 | FED-91005 | Partial FG at CM1, transfer viable from CM2 within lead time | direct_ship + cross_cm_transfer | high | transfer ETA < July 20 SLA, cost_impact_usd stated, feasibility=full |
| T4 | FED-92001 | All RTR-4500 stock at CM1 on qa_hold | none | critical | scenarios=[], units_unresolvable=400, risk_reason references qa_hold |
| T5 | FED-92002 | Only CM3 stock available, TAA order | compliance gate blocks CM3 | critical | CM3 excluded, scenarios=[], units_unresolvable=250, risk_reason references compliance rule |
| T6 | FED-88421 | Run with WIP est_completion_date overridden to July 16 (after SLA July 14) | direct_ship + commitment_rebalancing only | critical | WIP not proposed in any step, agent trade_off_note references WIP infeasibility |

---

## Adversarial Cases

| ID | Input condition | What is being tested | Pass condition |
|----|----------------|----------------------|----------------|
| A1 | qty_required = 0 on any order | Agent handles zero-quantity order gracefully | HTTP 400 returned before Claude is called; no scenario generated; no Supabase write |
| A2 | All CMs set taa_compliant = false for a TAA order | Agent does not propose non-compliant stock | scenarios=[], units_unresolvable = qty_required, compliance_pass score = 1.0, risk_reason references TAA constraint |
| A3 | committed_order.priority_tier = 'federal' for the only available committed stock | Agent refuses to rebalance a federal-tier committed order | Lever 3 not applied to federal commitment; agent notes in recommendation that federal-to-federal rebalancing is not permitted |
| A4 | FED-88421 WIP est_completion_date = required_ship_date exactly (July 14 = July 14, zero buffer) | Agent flags zero-buffer WIP as risky, does not treat it as safe | WIP may be proposed but trade_off_note must explicitly state zero buffer and flag delay risk; feasibility must not be marked 'full' without this caveat |
| A5 | FED-88421 inventory seeded so all levers combined yield exactly 600 units with zero units to spare | Agent returns feasibility=full but flags zero buffer | feasibility=full, total_qty_fulfilled=600, trade_off_note present on rank 1 scenario stating zero spare units and no fallback if any step fails |

---

## Observability (Langfuse)

### What is traced
Every Claude API call is wrapped in a Langfuse trace with the
following structure:

```
Trace (one per federal order scenario run)
├── Span: supabase_context_assembly
│     Input:  order_id, trigger_mode
│     Output: assembled context_payload JSON
│     Metadata: query_duration_ms, inventory_rows_returned,
│               committed_orders_returned
│
├── Generation: claude_agent_call
│     Input:  system_prompt + context_payload (full text)
│     Output: raw Claude response (before validation)
│     Metadata: model, tokens_input, tokens_output,
│               latency_ms, claude_api_status
│
├── Span: response_validator
│     Input:  raw Claude response
│     Output: validation_result (pass/fail), violations[]
│     Metadata: compliance_check_result, schema_valid,
│               qty_assertion_result, hallucination_check_result
│
└── Span: supabase_write
      Input:  validated fulfillmentResult JSON
      Output: scenario_ids written, order status updated
      Metadata: write_duration_ms, scenarios_written_count,
                langfuse_trace_id stored
```

### Scores attached per trace
- compliance_pass:       1 (pass) | 0 (fail)
- qty_assertion_pass:    1 (pass) | 0 (fail)
- hallucination_pass:    1 (pass) | 0 (fail)
- schema_valid:          1 (pass) | 0 (fail)
- lever_accuracy:        1 (expected levers matched) | 0 (mismatch)
- latency_within_sla:    1 (≤ 5s median) | 0 (> 5s)

### Tags per trace
- order_id
- trigger_mode (auto | manual)
- risk_score (low | medium | high | critical)
- levers_used[] (from agent response)
- feasibility (full | partial)
- compliance_rule (TAA | ITAR | NONE)

### Failure events logged to Langfuse
All six failure modes emit a Langfuse event in addition to server log:
- compliance_violation
- hallucinated_inventory
- partial_fulfillment_mislabelled
- missed_fulfillment_opportunity
- claude_api_error
- stale_inventory_data

### Prompt management via Langfuse
System prompt is managed in Langfuse Prompt Management under the name
'federal-fulfillment-agent'. API route fetches the current published
version at runtime. Every trace records promptName and promptVersion
in the Generation span. A prompt version is only marked 'published'
after passing the full T1–T6 and A1–A5 eval suite via dataset run.

### Eval dataset in Langfuse
All 6 test cases (T1–T6) and 5 adversarial cases (A1–A5) are added
to a Langfuse dataset named 'federal-fulfillment-seed-evals'. Each
dataset item contains:
- input: context_payload JSON for that order/scenario
- expected_output: expected levers_used[], expected risk_score,
  expected feasibility, expected scenarios=[] where applicable

Run dataset evals before every demo and after every prompt version
update using Langfuse SDK dataset run API. All 11 items must pass
their DEMO-BLOCKING criteria before a demo is approved to proceed.
