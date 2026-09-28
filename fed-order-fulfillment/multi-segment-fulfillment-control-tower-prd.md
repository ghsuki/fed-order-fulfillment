# AI-Native PRD: Multi-Segment Order Fulfillment Control Tower (PoC)
# Version: 3.0 — Multi-Segment Extension (Fedora → Federal/Commercial/Distributor/D2C)

## Overview

A PoC web application that simulates a Global Multi-Segment Order Fulfillment
Control Tower. The AI agent analyses cross-CM inventory, detects fulfillment
risk for any incoming order—federal, commercial, distributor, or D2C—and
returns ranked fulfillment scenarios with clear reasoning. Every decision is
segment-specific (not one-size-fits-all), and every cross-segment disruption
is audit-traced. Supabase replaces Celonis and real CM integrations for the PoC.
Synthetic data populates the data model.

**Key evolution from v2.0:** Moves from federal-only (Tier 1 absolute priority)
to policy-driven multi-segment (Tier 1–4 per segment, different compliance
frameworks, different cost-of-failure language, regional pooling for distributor).
Every lever, priority decision, and disruption now respects the order's own segment
policy, not a hardcoded federal ruleset.

Stack: Next.js · Supabase (PostgreSQL) · Claude API · Vercel · Langfuse

---

## Input / Output Contract

### Inputs

| Name | Format | Constraints | Required |
|------|--------|-------------|----------|
| order_id | Text string | Must exist in orders table in Supabase; must have status = 'open' or 'at_risk'; must have segment in ('federal', 'commercial', 'distributor', 'd2c') | Yes |
| trigger_mode | Enum: auto \| manual | auto = triggered by risk score threshold; manual = planner clicks "Run Scenario" in UI | Yes |
| context_payload | JSON object | Built by API route from Supabase query; must include order (with segment & priority_tier auto-synced), cm_inventory via v_cm_inventory_context, competing_orders from any segment, and segment_policies lookup for this order's segment; all keys required | Yes (assembled server-side) |

#### context_payload structure (assembled server-side before Claude call)

```json
{
  "order": {
    "order_id": "string",
    "segment": "federal | commercial | distributor | d2c",
    "priority_tier": "integer 1–4 (auto-synced from segment_policies)",
    "sku": "string",
    "qty_required": "integer > 0",
    "required_ship_date": "ISO date string",
    "compliance_requirements": "array of strings (e.g., ['TAA'] for federal, [] for commercial/distributor/d2c)",
    "contract_value_usd": "integer or null (populated for commercial orders)",
    "region": "string or null (populated for distributor orders; drives regional pooling)"
  },
  "segment_policy": {
    "segment": "federal | commercial | distributor | d2c",
    "priority_tier": "integer 1–4",
    "priority_handling": "string",
    "compliance_framework": "string",
    "primary_sla_driver": "string",
    "cost_of_failure": "string"
  },
  "cm_inventory": [
    {
      "inventory_id": "uuid",
      "cm_id": "string",
      "cm_name": "string",
      "country": "string",
      "sku": "string",
      "stock_type": "FG | WIP | RM",
      "qty_available": "integer >= 0",
      "compliance_frameworks_met": "array of strings (e.g., ['TAA', 'ITAR']; coalesced from row or CM default)",
      "hold_status": "available | qa_hold | committed",
      "lead_time_days": "integer (coalesced from row or CM default)",
      "est_completion_date": "ISO date string | null"
    }
  ],
  "competing_orders": [
    {
      "commit_id": "string",
      "cm_id": "string",
      "sku": "string",
      "segment": "federal | commercial | distributor | d2c",
      "priority_tier": "integer 1–4 (auto-synced from segment_policies)",
      "region": "string or null (populated for distributor commitments)",
      "committed_qty": "integer > 0",
      "promised_date": "ISO date string",
      "contract_value_usd": "integer or null"
    }
  ]
}
```

### Outputs

**fulfillmentResult** — JSON object written to fulfillment_scenarios table
and returned to planner UI

Always present: order_id, segment, priority_tier, risk_assessment, scenarios,
recommendation, units_unresolvable

#### fulfillmentResult structure

```json
{
  "order_id": "string",
  "segment": "federal | commercial | distributor | d2c",
  "priority_tier": "integer 1–4",
  "risk_assessment": {
    "risk_score": "critical | high | medium | low",
    "risk_reason": "string — one sentence"
  },
  "scenarios": [
    {
      "rank": "integer 1–3",
      "levers_used": ["direct_ship | cross_cm_transfer | commitment_rebalancing | multi_stage_manufacturing | cross_segment_reallocation"],
      "plan_summary": "string — 2-3 sentences plain English",
      "steps": [
        {
          "action": "string (direct_ship | transfer | rebalance_commitment)",
          "cm_id": "string",
          "qty": "integer",
          "note": "string",
          "disrupted_segment": "string or null (only on rebalance_commitment steps)",
          "disrupted_priority_tier": "integer or null",
          "disrupted_region": "string or null"
        }
      ],
      "total_qty_fulfilled": "integer",
      "cost_impact_usd": "integer or null",
      "feasibility": "full | partial",
      "compliance_status": "string (e.g., 'TAA/ITAR compliant' for federal, 'customer quality agreement compliant' for commercial)",
      "trade_off_note": "string or null"
    }
  ],
  "recommendation": "string",
  "units_unresolvable": "integer >= 0"
}
```

### Bad Input Handling

**1. order_id does not exist in orders table**
- System Behavior: Return HTTP 404; do not call Claude; do not write to fulfillment_scenarios
- User Message: "Order not found. Please check the order ID and try again."

**2. order_id exists but status is already 'fulfilled' or 'rejected'**
- System Behavior: Return HTTP 409; do not call Claude
- User Message: "This order has already been processed. Navigate to order history to view its fulfillment record."

**3. order_id has unrecognized segment value (not in segment_policies)**
- System Behavior: Return HTTP 400; do not call Claude; log with order_id for audit
- User Message: "This order's segment is not recognized. Please update the order segment and try again."

**4. cm_inventory array is empty after Supabase query (no inventory records for that SKU)**
- System Behavior: Proceed with Claude call; pass empty array; agent must return risk_score = 'critical' and scenarios = [] with explanation
- User Message: Surface agent's recommendation text in UI with a red banner: "No inventory found across any CM for this SKU."

**5. context_payload is malformed or missing required keys (server-side assembly failure)**
- System Behavior: Return HTTP 500; do not call Claude; log error with order_id and payload snapshot
- User Message: "An internal error occurred while preparing order data. Please try again or contact support."

**6. Claude API returns non-JSON or malformed response**
- System Behavior: Retry once after 2 seconds; if retry also fails, return HTTP 502; log raw Claude response for debugging
- User Message: "The AI agent returned an unexpected response. Please try again."

---

## Supabase Data Model

### Table: segment_policies
| Column | Type | Notes |
|--------|------|-------|
| segment | text PK | federal / commercial / distributor / d2c |
| priority_tier | integer UNIQUE | 1 / 2 / 3 / 4 (Tier 1 highest, Tier 4 lowest) |
| priority_handling | text | Description of how this tier's orders are prioritized |
| compliance_framework | text | e.g., "TAA / ITAR / DFARS" for federal, "Customer quality agreement" for commercial |
| primary_sla_driver | text | e.g., "Contract delivery date" for federal, "Promised ship date at checkout" for D2C |
| cost_of_failure | text | Phrase cost risk in segment terms, not generic dollars |

### Table: contract_manufacturers
| Column | Type | Notes |
|--------|------|-------|
| cm_id | text PK | e.g. CM1 |
| cm_name | text | |
| country | text | |
| compliance_frameworks_met | text[] | e.g., ['TAA', 'ITAR'] or [] (empty for non-compliant) |
| capacity_units | integer | |
| lead_time_days | integer | Default; may be overridden per row in cm_inventory |
| created_at | timestamptz | |

### Table: orders
| Column | Type | Notes |
|--------|------|-------|
| order_id | text PK | e.g. FED-88421, COM-10001, DIST-20001, D2C-30001 |
| segment | text FK → segment_policies | federal / commercial / distributor / d2c (never inferred, always provided) |
| priority_tier | integer | Auto-synced from segment_policies by trigger; do not set manually |
| sku | text | |
| qty_required | integer | > 0 |
| required_ship_date | date | |
| compliance_requirements | text[] | e.g., ['TAA'] for federal, [] for commercial/distributor/d2c |
| contract_value_usd | integer | Optional; populated for commercial orders |
| region | text | Optional; populated for distributor orders (drives regional pooling) |
| status | text | open / at_risk / fulfilled / rejected |
| risk_score | text | low / medium / high / critical; updated after each agent run |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### Table: cm_inventory
| Column | Type | Notes |
|--------|------|-------|
| inventory_id | uuid PK | |
| cm_id | text FK → contract_manufacturers | |
| sku | text | |
| stock_type | text | FG / WIP / RM |
| qty_available | integer | >= 0 |
| compliance_frameworks_met | text[] | Row-level override; NULL falls back to CM default |
| hold_status | text | available / qa_hold / committed |
| lead_time_days | integer | Row-level override; NULL falls back to CM default |
| est_completion_date | date | WIP only; null for FG/RM |
| updated_at | timestamptz | |
| created_at | timestamptz | |

### Table: competing_orders
| Column | Type | Notes |
|--------|------|-------|
| commit_id | text PK | |
| cm_id | text FK → contract_manufacturers | |
| sku | text | |
| segment | text FK → segment_policies | Any segment, not just federal/commercial |
| priority_tier | integer | Auto-synced from segment_policies by trigger; do not set manually |
| region | text | Optional; populated for distributor commitments (drives regional pooling) |
| committed_qty | integer | > 0 |
| promised_date | date | |
| contract_value_usd | integer | Optional |
| created_at | timestamptz | |

### Table: fulfillment_scenarios
| Column | Type | Notes |
|--------|------|-------|
| scenario_id | uuid PK | |
| order_id | text FK → orders | |
| segment | text FK → segment_policies | Denormalized for query efficiency |
| rank | integer | 1 / 2 / 3 |
| levers_used | text[] | |
| plan_summary | text | |
| steps | jsonb | Full steps array from agent output |
| total_qty_fulfilled | integer | |
| cost_impact_usd | integer | Optional |
| feasibility | text | full / partial |
| compliance_status | text | |
| trade_off_note | text | |
| status | text | proposed / approved / rejected |
| langfuse_trace_id | text | Links Supabase row to Langfuse trace for audit |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### Table: scenario_disruptions
| Column | Type | Notes |
|--------|------|-------|
| disruption_id | uuid PK | |
| scenario_id | uuid FK → fulfillment_scenarios | |
| commit_id | text FK → competing_orders | Which order was disrupted |
| disrupted_segment | text FK → segment_policies | Segment of disrupted order |
| disrupted_priority_tier | integer | Tier of disrupted order |
| disrupted_region | text | Region of disrupted order (null if not distributor) |
| qty_reallocated | integer | > 0 — units pulled from competing order |
| disruption_impact | text | Phrased in disrupted order's Cost-of-Failure terms (Hard Constraint 6) |
| created_at | timestamptz | |

### View: v_cm_inventory_context
Simplifies context assembly by coalescing row-level overrides with CM defaults:

```sql
SELECT
  i.inventory_id,
  i.cm_id,
  cm.cm_name,
  cm.country,
  i.sku,
  i.stock_type,
  i.qty_available,
  COALESCE(i.compliance_frameworks_met, cm.compliance_frameworks_met) AS compliance_frameworks_met,
  i.hold_status,
  COALESCE(i.lead_time_days, cm.lead_time_days) AS lead_time_days,
  i.est_completion_date,
  i.updated_at
FROM cm_inventory i
JOIN contract_manufacturers cm ON cm.cm_id = i.cm_id;
```

---

## Synthetic Seed Data

### Segment Policies (4 rows)
| Segment | Tier | Handling | Framework | SLA Driver | Cost of Failure |
|---------|------|----------|-----------|------------|-----------------|
| federal | 1 | Priority #1 — auto-escalate | TAA / ITAR / DFARS | Contract delivery date | Contract penalties, debarment risk |
| commercial | 2 | Tiered by contract value | Customer quality agreement | Negotiated ship date & quality agreement | Chargebacks, relationship damage |
| distributor | 3 | Pooled allocation by region | INCOTERMS / distributor agreement | PO fill rate & INCOTERMS | Fill-rate penalties, reorder loss |
| d2c | 4 | Dynamic, demand-triggered | Consumer protection / marketplace SLAs | Promised ship date at checkout | Refunds, negative reviews, churn |

### Contract Manufacturers (3 total)
- CM1 · Vietnam · compliance_frameworks_met = ['TAA', 'ITAR'] · lead_time_days = 4
- CM2 · Mexico · compliance_frameworks_met = ['TAA', 'ITAR'] · lead_time_days = 5
- CM3 · China · compliance_frameworks_met = [] · lead_time_days = 3

### SKUs (3 total)
RTR-4500 · SRV-2200 · NET-900

### Named seed orders (8 total)

#### Federal Tier 1 (5 orders)

| order_id | SKU | Qty | SLA | Compliance | Expected risk | Levers exercised | Used in test |
|----------|-----|-----|-----|------------|---------------|-----------------|--------------|
| FED-88421 | RTR-4500 | 600 | July 14 | TAA | Critical | Levers 1+3+4 combined | T2, T6 |
| FED-90012 | NET-900 | 300 | July 18 | TAA | Low | Lever 1 only | T1 |
| FED-91005 | SRV-2200 | 450 | July 20 | ITAR | High | Levers 1+2 combined | T3 |
| FED-92001 | RTR-4500 | 400 | July 16 | TAA | Critical | None — all stock on qa_hold | T4 |
| FED-92002 | NET-900 | 250 | July 19 | TAA | Critical | None — only CM3 stock available | T5 |

#### Commercial Tier 2 (1 order)

| order_id | SKU | Qty | SLA | Compliance | contract_value_usd | Expected risk | Levers | Used in test |
|----------|-----|-----|-----|------------|-------------------|---------------|--------|--------------|
| COM-10001 | RTR-4500 | 200 | July 17 | (none) | 220000 | Low | Lever 1 only | C1 |

#### Distributor Tier 3 (1 order)

| order_id | SKU | Qty | SLA | Region | Compliance | Expected risk | Levers | Used in test |
|----------|-----|-----|-----|--------|------------|---------------|--------|--------------|
| DIST-20001 | RTR-4500 | 150 | July 15 | LATAM | (none) | Low | Lever 1 only | D1 |

#### D2C Tier 4 (1 order)

| order_id | SKU | Qty | SLA | Compliance | Expected risk | Levers | Used in test |
|----------|-----|-----|-----|------------|---------------|--------|--------------|
| D2C-30001 | NET-900 | 60 | July 12 | (none) | Low | Lever 1 only | X1 |

### Inventory setup per order (≈16 rows)

- **FED-88421:** 180 FG at CM1 (compliance=['TAA', 'ITAR'], available), 200 WIP at CM1
  (est_completion July 12), 240 FG at CM2 (compliance=['TAA', 'ITAR'], committed by
  COMM-88421-CM2 commercial order), 500 FG at CM3 (compliance=[], available) — forces
  agent to combine levers and exclude CM3 by compliance gate

- **FED-90012:** 300 FG at CM2 (compliance=['TAA', 'ITAR'], available) — clean happy
  path; Lever 1 stops the search

- **FED-91005:** 150 FG at CM1 (compliance=['TAA', 'ITAR'], available), 300 FG at CM2
  (compliance=['TAA', 'ITAR'], available, lead_time_days=5, transfer ETA ≈ July 22
  vs. SLA July 20) — forces cross-CM transfer

- **FED-92001:** 400 FG at CM1 (compliance=['TAA', 'ITAR']) with hold_status = qa_hold;
  no other stock for this SKU — forces scenarios = [], units_unresolvable = 400

- **FED-92002:** 250 FG at CM3 only (compliance=[], available) — compliance gate blocks
  only available stock; forces scenarios = [] with compliance explanation

- **COM-10001:** Shares RTR-4500 with federal orders (shared inventory pool). 180 FG
  available at CM1, 500 available at CM3. Commercial has no compliance gate, so CM3
  is usable. Lever 1: 180+20 from CM3 = 200 units.

- **DIST-20001:** Shares RTR-4500, region=LATAM. Competing against DIST-LATAM-CM3
  (same region, same tier 3). Lever 1: 150 units from available pool.

- **D2C-30001:** Shares NET-900 with federal orders. 300 FG at CM2, 250 FG at CM3
  (both usable, no compliance gate). Lever 1 only: 60 units from first available.

### Competing Orders (2 total)

- **COMM-88421-CM2:** segment='commercial', priority_tier=2 (auto-synced), cm_id='CM2',
  sku='RTR-4500', committed_qty=240, promised_date='2026-07-10', contract_value_usd=180000.
  Held at CM2 FG (240 units). Lever 3 candidate for FED-88421 (federal tier 1 may
  reallocate from commercial tier 2).

- **DIST-LATAM-CM3:** segment='distributor', priority_tier=3 (auto-synced), cm_id='CM3',
  sku='RTR-4500', region='LATAM', committed_qty=150, promised_date='2026-07-11'.
  Held at CM3 FG (150 units). Regional pooling example: DIST-20001 (same region,
  same tier) competes in LATAM pool.

---

## Quality Criteria

### 1. Tier ordering enforcement (Hard Constraint 1) ⚠️ DEMO-BLOCKING
- **Threshold:** 100% of scenarios must respect tier ordering — no scenario may
  reallocate from a competing_order whose priority_tier < order.priority_tier
  (numerically less = higher tier = protected). Zero tolerance.
- **Measurement:** Server-side validator cross-checks every rebalance_commitment
  step against competing_orders priority_tier. A step that violates tier ordering
  suppresses the scenario, triggers re-prompt, and emits Langfuse event
  'tier_ordering_violation' with tier_ordering_pass = 0.
- **Cadence:** Every agent call. Reported as Langfuse score tier_ordering_pass;
  must trend at 1.0 across all traces.
- **Hard Constraint enforcement:** If agent attempts federal (tier 1) to disrupt
  another federal (tier 1), or commercial (tier 2) to disrupt federal (tier 1),
  or distributor (tier 3) to disrupt any tier 1–2, or D2C (tier 4) to disrupt
  any tier 1–3, validator rejects and re-prompts.

### 2. Compliance constraint enforcement (segment-agnostic, not TAA-only) ⚠️ DEMO-BLOCKING
- **Threshold:** 100% of scenarios must contain zero allocations where
  compliance_frameworks_met does not include all compliance_requirements
  for that order. Compliance check is segment-specific: federal orders gate on
  ['TAA', 'ITAR', 'DFARS']; commercial on [] or customer-specific tag; distributor
  on []; D2C on []. Zero tolerance.
- **Measurement:** Server-side validator runs after every Claude response. For each
  step allocating inventory, cross-check that compliance_frameworks_met ⊇
  order.compliance_requirements. Any violation suppresses scenario, triggers
  re-prompt, emits Langfuse event 'compliance_violation' with compliance_pass = 0.
- **Cadence:** Every agent call. Reported as Langfuse score compliance_pass;
  must trend at 1.0.

### 3. Full satisfaction attempt (Hard Constraint 3) ⚠️ DEMO-BLOCKING
- **Threshold:** Every scenario ranked must attempt full satisfaction before
  proposing partial. If feasibility='partial', agent must explicitly state why
  full satisfaction is impossible and explain the constraint (no more compliant
  inventory, tier ordering blocks access, lead_time_days exceed SLA, etc.). Zero
  tolerance for partial fulfillment without explanation.
- **Measurement:** Server-side validator checks feasibility='full' → total_qty_fulfilled
  must equal qty_required. Mismatch before write suppresses, re-prompts, emits
  Langfuse event 'partial_fulfillment_mislabelled' with qty_assertion_pass = 0.
- **Cadence:** Every agent call. Reported as Langfuse score qty_assertion_pass.

### 4. Disruption visibility (Hard Constraint 4) ⚠️ DEMO-BLOCKING
- **Threshold:** Every rebalance_commitment step must be tracked in scenario_disruptions
  table with the disrupted order's segment, priority_tier, region (if distributor),
  qty_reallocated, and disruption_impact. Disruption_impact must be phrased in the
  disrupted order's segment cost-of-failure terms, not generic dollars.
- **Measurement:** After agent response is validated and before writing fulfillment_scenarios,
  API layer creates one scenario_disruptions row for each rebalance_commitment step.
  Missing disruptions or misnamed segments block write and log P0.
- **Cadence:** Every rebalancing scenario. Validated manually (not automated yet;
  PoC limitation).

### 5. Cost-of-failure phrasing (Hard Constraint 6) ⚠️ DEMO-BLOCKING
- **Threshold:** disruption_impact text must use language from segment_policies.cost_of_failure
  for the disrupted_segment (e.g., "fill-rate penalties, reorder loss" for disrupted
  distributor, not "$X revenue loss"). Segment-specific risk language, not generic
  dollar figures.
- **Measurement:** Server-side validator checks disruption_impact text against cost_of_failure
  keyword set for disrupted_segment. Generic dollar phrases trigger manual flag (not
  automated; PoC limitation).
- **Cadence:** Every rebalancing scenario. Langfuse event 'cost_of_failure_phrasing'
  logged for audit.

### 6. Regional pooling (Hard Constraint 7) — distributor only ⚠️ DEMO-BLOCKING
- **Threshold:** For distributor orders or competing distributor commitments,
  Lever 3 rebalancing must prefer same-region competing_orders over cross-region.
  Agent must state regional pooling logic in trade_off_note if a cross-region
  rebalancing is chosen.
- **Measurement:** Server-side validator checks if order.segment='distributor' or
  competing_orders contain distributor region. If Lever 3 is used, verify region
  preference in levers_used and trade_off_note. Violation blocks write, triggers
  manual review.
- **Cadence:** Every distributor scenario. Langfuse event 'regional_pooling_respected'.

### 7. D2C constraint (Hard Constraint 1 corollary) ⚠️ DEMO-BLOCKING
- **Threshold:** D2C orders (tier 4) may NEVER reallocate from any competing_order
  (tiers 1–3). No rebalance_commitment steps allowed in D2C scenarios.
- **Measurement:** Server-side validator: if order.segment='d2c' and scenarios contain
  rebalance_commitment, reject immediately. Emit Langfuse event 'd2c_rebalance_violation'.
- **Cadence:** Every D2C agent call.

### 8. Hallucinated inventory — zero tolerance ⚠️ DEMO-BLOCKING
- **Threshold:** 0% of scenarios may reference a cm_id not present in context_payload,
  or propose qty greater than qty_available for any CM + SKU in context_payload.
- **Measurement:** Server-side validator cross-checks every step's cm_id and qty
  against v_cm_inventory_context rows. Any hallucination suppresses scenario
  immediately, triggers re-prompt once, emits Langfuse event 'hallucinated_inventory'.
  Persistence on retry disables agent for that order.
- **Cadence:** Every agent call. If hallucination rate > 0% on any 24-hour window,
  treat as P0.

### 9. Scenario reasoning accuracy — lever selection correctness (NON-BLOCKING)
- **Threshold:** For each named seed order, agent must select expected lever
  combination or expected empty-scenario outcome on 9/10 consecutive runs (90%).
- **Measurement:** Run each seed order via Langfuse dataset API. Compare levers_used
  array against expected lever set. Calculate match rate. Acceptable variance: lever
  order within a combined plan may vary; lever set must match exactly.
- **Cadence:** Before each demo; after system prompt change.

### 10. Response latency (NON-BLOCKING)
- **Threshold:** Median end-to-end latency (Supabase query + Claude call + response
  write) ≤ 5 seconds; p95 ≤ 10 seconds.
- **Measurement:** Log timestamps at key points. Compute median and p95 over 50 runs.
  Report as Langfuse score latency_within_sla.
- **Cadence:** Measured on every run; aggregated before demos.

### 11. Output schema validity ⚠️ DEMO-BLOCKING
- **Threshold:** 100% of Claude responses must parse as valid JSON matching the
  fulfillmentResult schema with all required keys present (order_id, segment,
  priority_tier, risk_assessment, scenarios, recommendation, units_unresolvable).
- **Measurement:** Server-side JSON schema validator on every response. Schema
  violations emit Langfuse event and trigger one retry. Report as Langfuse score
  schema_valid.
- **Cadence:** Every agent call.

---

## Failure Modes

### 1. Tier ordering constraint violated — lower-tier order reallocates from higher-tier
- **Trigger:** Any step in any scenario allocates from a competing_order whose
  priority_tier < order.priority_tier (e.g., commercial tier 2 reallocates from
  federal tier 1, or distributor tier 3 reallocates from commercial tier 2).
- **User Experience:** Planner approves a plan that violates the segment policy
  priority model; a lower-tier order starves a higher-tier order; customer SLA
  miss and legal/reputational risk.
- **Logged:** Event: 'tier_ordering_violation'; fields: order_id, segment, priority_tier,
  disrupted_commit_id, disrupted_segment, disrupted_priority_tier, timestamp.
- **Escalation:** Immediately suppress scenario. Retry Claude once with explicit
  tier ordering constraint noted in re-prompt. If second response also violates,
  return HTTP 500 and alert developer. Zero tolerance; DEMO-BLOCKING.

### 2. Compliance constraint violated — non-compliant inventory proposed
- **Trigger:** Any step allocates inventory where compliance_frameworks_met does not
  include the required compliance_requirements for this order's segment.
- **User Experience:** Planner approves a plan that violates segment compliance policy
  (e.g., federal order ships TAA-ineligible stock). Regulatory violation.
- **Logged:** Event: 'compliance_violation'; fields: order_id, segment, compliance_requirements,
  cm_id, compliance_frameworks_met, step_index, timestamp.
- **Escalation:** Suppress scenario. Retry once. If second response also violates,
  return HTTP 500. Zero tolerance; DEMO-BLOCKING.

### 3. D2C order reallocates from competing order (Hard Constraint 1 violation)
- **Trigger:** D2C order (tier 4) scenario contains rebalance_commitment step.
- **User Experience:** Planner approves a plan that strips inventory from another
  order to serve a D2C purchase; violates segment policy (D2C may never reallocate).
- **Logged:** Event: 'd2c_rebalance_violation'; fields: order_id, commit_id,
  committed_qty, committed_segment, timestamp.
- **Escalation:** Reject immediately. Suppress all scenarios for this order. Return
  HTTP 400 with message: "D2C orders cannot reallocate committed inventory. Please
  check available inventory and return to planner." Zero tolerance; DEMO-BLOCKING.

### 4. Regional pooling violated — distributor reallocates from different region
- **Trigger:** Distributor order (tier 3) Lever 3 scenario reallocates from a
  distributor competing_order in a different region when a same-region competing
  order exists and is feasible.
- **User Experience:** Planner approves a plan that disrupts a distributor in a
  different region; missed optimization; higher fill-rate penalty exposure across
  multiple regions.
- **Logged:** Event: 'regional_pooling_violated'; fields: order_id, region, disrupted_commit_id,
  disrupted_region, same_region_alternatives_count, timestamp.
- **Escalation:** Server-side validator checks if same-region competing_orders exist
  and are feasible. If yes, flag with manual review banner (not automated rejection;
  PoC limitation). Log as P2.

### 5. Hallucinated inventory — agent proposes stock not in Supabase
- **Trigger:** Agent step references a cm_id or qty not present in context_payload,
  or proposes qty > qty_available for that CM + SKU.
- **User Experience:** Planner approves plan based on inventory that doesn't exist.
  Execution fails. Trust destroyed.
- **Logged:** Event: 'hallucinated_inventory'; fields: order_id, cm_id, proposed_qty,
  actual_qty_available, scenario_rank, timestamp.
- **Escalation:** Suppress scenario immediately. Retry once. Persistence disables
  agent for that order. DEMO-BLOCKING.

### 6. Order partially fulfilled but marked feasibility = 'full'
- **Trigger:** total_qty_fulfilled < qty_required in a scenario where feasibility = 'full'.
- **User Experience:** Planner approves plan believing order is fully covered; customer
  receives short shipment; SLA miss and cost-of-failure impact for that segment.
- **Logged:** Event: 'partial_fulfillment_mislabelled'; fields: order_id, segment,
  qty_required, total_qty_fulfilled, scenario_rank, timestamp.
- **Escalation:** Server-side validator catches before write. Reject, re-prompt once.
  Persistence returns error to UI. DEMO-BLOCKING.

### 7. Disruption_impact not audit-traced — missing scenario_disruptions row
- **Trigger:** fulfillment_scenarios contains rebalance_commitment step(s), but
  corresponding scenario_disruptions rows are missing or incomplete.
- **User Experience:** Planner approves scenario affecting other orders, but audit
  trail is incomplete; compliance/audit failure; visibility lost.
- **Logged:** Event: 'disruption_not_traced'; fields: scenario_id, rebalance_steps_count,
  disruption_rows_count, missing_commits, timestamp.
- **Escalation:** API layer validation before write: for each rebalance_commitment
  step, create one scenario_disruptions row. Missing rows block write. Log as P0.

### 8. Cost-of-failure not phrased in disrupted segment's terms
- **Trigger:** disruption_impact text uses generic dollar figures or neutral language
  instead of segment-specific cost_of_failure terms.
- **User Experience:** Planner sees "Disrupted commercial order costs $X" instead of
  "Chargebacks and customer relationship damage"; loses segment-specific context
  for decision-making.
- **Logged:** Event: 'cost_of_failure_phrasing_invalid'; fields: scenario_id,
  disrupted_segment, disruption_impact, expected_keywords, timestamp.
- **Escalation:** Manual flag (not automated; PoC limitation). Langfuse event logged.
  Reviewed before demo. Log as P2.

### 9. Agent returns no scenarios for a fulfillable order
- **Trigger:** scenarios = [] returned but context contains sufficient compliant
  inventory to fulfill via at least one lever.
- **User Experience:** Planner sees "no plan available" when a valid plan exists.
  Order goes unactioned. SLA missed.
- **Logged:** Event: 'missed_fulfillment_opportunity'; fields: order_id, segment,
  qty_required, total_compliant_qty_available, timestamp.
- **Escalation:** Server-side pre-check: before calling Claude, compute total
  compliant qty (respecting segment compliance gate). If total >= qty_required
  and Claude returns scenarios=[], log P1 and surface fallback banner.

### 10. Claude API timeout or rate limit
- **Trigger:** Claude API call exceeds 15 seconds or returns HTTP 429.
- **User Experience:** Planner sees spinner that never resolves.
- **Logged:** Event: 'claude_api_error'; fields: order_id, error_type, http_status,
  latency_ms, timestamp.
- **Escalation:** Retry once after 3 seconds with exponential backoff. If retry
  fails, return HTTP 503 with message: "Scenario generation temporarily unavailable.
  Please try again in 30 seconds."

### 11. Supabase query returns stale data
- **Trigger:** cm_inventory.updated_at is > 60 minutes old at time of agent call.
- **User Experience:** Agent reasons on stale inventory figures.
- **Logged:** Event: 'stale_inventory_data'; fields: order_id, oldest_updated_at,
  current_timestamp, staleness_minutes.
- **Escalation:** Surface yellow warning banner: "Inventory data is > 60 minutes old.
  Verify stock before approving." Do not block scenario generation. Log as P3 for
  PoC; P1 in production.

---

## Planner UI Screens

### Screen 1 — Multi-Segment Order Dashboard
- Table of all orders (segment column now included) with columns:
  order_id · segment · priority_tier · SKU · qty_required · required_ship_date · status · risk_score
- Risk score shown as colour-coded badge: low = green · medium = amber · high = red · critical = flashing red
- Segment badge: federal=blue · commercial=orange · distributor=purple · d2c=teal
- "Run Scenario" button per row (manual trigger)
- Auto-trigger badge shown if scenario was auto-generated
- Filter by segment option

### Screen 2 — Scenario Panel (per order)
- Order summary at top: order_id · segment · priority_tier · SKU · qty · SLA · compliance framework (from segment_policies)
- Compliance driver text: e.g., "TAA/ITAR/DFARS" for federal; "Customer quality agreement" for commercial; "INCOTERMS" for distributor; "Marketplace SLA" for D2C
- SLA driver text: e.g., "Contract delivery date" for federal; "Promised ship date at checkout" for D2C
- Cost-of-failure context: e.g., "Contract penalties, debarment risk" for federal; "Refunds, negative reviews, churn" for D2C
- Up to 3 ranked scenario cards, each showing:
  - Rank badge · levers used tags · plan_summary
  - Step-by-step breakdown table: action · CM · qty · note · disrupted_segment (if rebalance) · disruption_impact
  - Cost impact · total qty fulfilled · feasibility badge · compliance status
  - trade_off_note highlighted in amber if present; regional pooling notes for distributor scenarios
- Approve / Reject buttons per scenario
- On approve: scenario status → 'approved'; orders.status → 'fulfilled'; other scenarios → 'rejected'

### Screen 3 — Order History
- Fulfilled and rejected orders with their approved scenario summary
- Segment badge shown per row
- Audit trail: which scenario approved, when, levers, cost impact, disruptions (if any)
- Disruption summary card: if scenario involved rebalancing, show affected competing orders by segment, qty disrupted, cost-of-failure impact phrased in that segment's terms
- Langfuse trace link per row for full reasoning inspection

---

## Eval Plan

### Owner
Developer (primary); PoC reviewer / judge (secondary). Both jointly
maintain the Langfuse dataset and review scores before each demo.

### Cadence
- **Before each demo:** Run all 8 seed orders (T1–T6 federal + C1 commercial +
  D1 distributor + X1 D2C) through agent via Langfuse dataset run API. Verify
  all DEMO-BLOCKING scores = 1.0. Do not present with any failures.
- **After any system prompt change in code:** Re-run full seed suite before committing.
  Block commit if any DEMO-BLOCKING criterion fails.
- **After any Langfuse prompt version update:** Re-run full suite via dataset API
  before marking new version stable.
- **On each individual run (automated):** Server-side validators run tier ordering,
  compliance, full satisfaction, disruption audit, schema checks on every response.
  Scores written to Langfuse immediately. Failures trigger re-prompt or suppression.

### Pass Threshold

**DEMO-BLOCKING — must all pass before any demo:**

| Criterion | Threshold | Measured by | Langfuse score |
|-----------|-----------|-------------|----------------|
| Tier ordering (HC 1) | 100% — zero violations | Server-side validator | tier_ordering_pass = 1.0 |
| Compliance constraint (HC 2) | 100% — zero violations | Server-side validator | compliance_pass = 1.0 |
| Full satisfaction (HC 3) | 100% — no partial labelled full | Server-side qty assertion | qty_assertion_pass = 1.0 |
| Disruption visibility (HC 4) | 100% — all disruptions traced | API layer scenario_disruptions write | disruption_traced = 1.0 |
| Hallucinated inventory | 0% — zero hallucinations | Server-side inventory cross-check | hallucination_pass = 1.0 |
| Schema validity | 100% — all responses parse | Server-side JSON validator | schema_valid = 1.0 |
| Seed order lever accuracy | 8/8 orders return expected outcome | Langfuse dataset run T1–X1 | lever_accuracy = 1.0 on all 8 |
| D2C constraint (HC 1 corollary) | 100% — zero rebalancing in D2C | Server-side validator | d2c_constraint_pass = 1.0 |

**NON-BLOCKING — note as known PoC limitation if failing:**

| Criterion | Threshold | Measured by | Langfuse score |
|-----------|-----------|-------------|----------------|
| Latency median | ≤ 5 seconds | Timestamp logging | latency_within_sla |
| Regional pooling optimization | 90% prefer same-region distributor | Manual review (not automated) | — |
| Cost-of-failure phrasing | Segment-specific language used | Manual review (not automated) | — |

### Failure Action
- **DEMO-BLOCKING failure:** Fix system prompt or server-side validator logic
  immediately. Do not present. Re-run full eval suite. Only proceed when all
  blocking criteria pass.
- **NON-BLOCKING failure:** Note as PoC limitation in presentation. Log as P2.

---

## Test Cases

### Federal Tier 1 Tests (T1–T6)

| ID | Order | Scenario | Expected levers | Expected risk | Pass condition |
|----|-------|----------|-----------------|---------------|----------------|
| T1 | FED-90012 | Full FG available at CM2, TAA compliant | direct_ship only | low | feasibility=full, 1 scenario, compliance=TAA, no trade-off, units_unresolvable=0 |
| T2 | FED-88421 | Partial FG at CM1, WIP at CM1, committed at CM2, CM3 non-compliant | direct_ship + commitment_rebalancing + multi_stage | critical | CM3 excluded, all 3 levers present, feasibility=full, total_qty=600, scenario_disruptions row for COMM-88421-CM2 with cost-of-failure='chargebacks/relationship damage' |
| T3 | FED-91005 | Partial FG at CM1, transfer viable from CM2 within lead time | direct_ship + cross_cm_transfer | high | transfer_eta < July 20 SLA, cost_impact stated, feasibility=full, ITAR compliance enforced |
| T4 | FED-92001 | All RTR-4500 stock at CM1 on qa_hold | none | critical | scenarios=[], units_unresolvable=400, risk_reason references qa_hold gate |
| T5 | FED-92002 | Only CM3 stock available (TAA order) | compliance gate blocks CM3 | critical | CM3 excluded by compliance, scenarios=[], units_unresolvable=250, risk_reason references TAA requirement |
| T6 | FED-88421 | WIP est_completion overridden to July 16 (after SLA July 14) | direct_ship + commitment_rebalancing only | critical | WIP not proposed, trade_off_note references WIP infeasibility |

### Commercial Tier 2 Tests (C1)

| ID | Order | Scenario | Expected levers | Expected risk | Pass condition |
|----|-------|----------|-----------------|---------------|----------------|
| C1 | COM-10001 | Partial FG at CM1 available, additional at CM3 (no compliance gate for commercial) | direct_ship + cross_cm_transfer | low | feasibility=full, 200 units fulfilled, no rebalancing from tier 1 (FED-88421 tier 1 protected), compliance_status='customer quality agreement compliant', cost-of-failure context available |

### Distributor Tier 3 Tests (D1)

| ID | Order | Scenario | Expected levers | Expected risk | Pass condition |
|----|-------|----------|-----------------|---------------|----------------|
| D1 | DIST-20001 | Shares RTR-4500 with federal/commercial; competing DIST-LATAM-CM3 in same region | direct_ship or regional_rebalancing | low | feasibility=full, 150 units fulfilled, regional pooling logic stated in trade_off_note, no cross-region rebalancing if same-region option available, cost-of-failure='fill-rate penalties, reorder loss', priority_tier=3 (no rebalancing from tier 1–2) |

### D2C Tier 4 Tests (X1)

| ID | Order | Scenario | Expected levers | Expected risk | Pass condition |
|----|-------|----------|-----------------|---------------|----------------|
| X1 | D2C-30001 | Shares NET-900 with federal orders; no rebalancing allowed (tier 4 constraint) | direct_ship only | low | feasibility=full, 60 units fulfilled, zero rebalance_commitment steps, cost-of-failure='refunds, reviews, churn', priority_tier=4 (lowest tier) |

---

## Adversarial Cases

| ID | Input condition | What is being tested | Pass condition |
|----|----------------|----------------------|----------------|
| A1 | qty_required = 0 on any order | Agent handles zero-quantity order gracefully | HTTP 400 before Claude called; no scenario generated; no Supabase write |
| A2 | All CMs compliance_frameworks_met=[] for a federal TAA order | Compliance gate blocks all inventory | scenarios=[], units_unresolvable=qty_required, compliance_pass=1.0, risk_reason references TAA requirement |
| A3 | competing_order with priority_tier < order.priority_tier (e.g., federal tier 1 competing order holding stock, FED-88421 is also tier 1) | Agent refuses to reallocate from same/higher tier | Lever 3 not applied to that commitment; recommendation notes tier ordering constraint |
| A4 | FED-88421 WIP est_completion_date = required_ship_date exactly (July 14 = July 14, zero buffer) | Agent flags zero-buffer WIP as risky | WIP may be proposed but trade_off_note explicitly states zero buffer and delay risk |
| A5 | FED-88421 inventory tuned so levers sum to exactly 600 with zero spare | Agent returns feasibility=full with zero fallback | feasibility=full, total_qty=600, trade_off_note present on rank 1 stating zero spare units and no fallback if any step fails |
| A6 | Unrecognized segment value (e.g., segment='aerospace') on order | Agent handles unrecognized segment gracefully (Hard Constraint) | HTTP 400 returned before Claude called; system_message states segment must match segment_policies |
| A7 | D2C order with competing_order from any tier (federal, commercial, distributor) | D2C constraint enforced: D2C never reallocates | scenarios must contain zero rebalance_commitment steps; d2c_constraint_pass=1.0 |
| A8 | Commercial tier 2 order attempts to reallocate from federal tier 1 order | Tier ordering constraint enforced (Hard Constraint 1) | Lever 3 cannot be applied to federal commitments; tier_ordering_pass=1.0; recommendation explains tier 2 may only reallocate from tier 3–4 |
| A9 | Multi-segment scenario where FED-88421 (tier 1) disrupts COMM-88421-CM2 (tier 2) and DIST-LATAM-CM3 (tier 3) in Lever 5 | Disruption audit trail and cost-of-failure phrasing | scenario_disruptions rows created for both disruptions; COMM disruption shows 'chargebacks/relationship damage'; DIST disruption shows 'fill-rate penalties, reorder loss'; both phrased in disrupted segment's terms per Hard Constraint 6 |

---

## Observability (Langfuse)

### What is traced
Every Claude API call is wrapped in a Langfuse trace with the
following structure:

```
Trace (one per multi-segment order scenario run)
├── Span: supabase_context_assembly
│     Input:  order_id, trigger_mode
│     Output: assembled context_payload JSON (order + segment_policy + cm_inventory + competing_orders)
│     Metadata: query_duration_ms, inventory_rows_returned,
│               competing_orders_returned, segment, priority_tier
│
├── Generation: claude_agent_call
│     Input:  system_prompt (agent_system_prompt.md v2.1.0) + context_payload (full text)
│     Output: raw Claude response (before validation)
│     Metadata: model, tokens_input, tokens_output,
│               latency_ms, claude_api_status
│
├── Span: response_validator
│     Input:  raw Claude response
│     Output: validation_result (pass/fail), violations[]
│     Metadata: tier_ordering_check_result, compliance_check_result,
│               schema_valid, qty_assertion_result, disruption_traced,
│               hallucination_check_result, d2c_constraint_check_result
│
└── Span: supabase_write
      Input:  validated fulfillmentResult JSON
      Output: scenario_ids written, scenario_disruptions rows written,
              order status updated
      Metadata: write_duration_ms, scenarios_written_count,
                disruptions_written_count, langfuse_trace_id stored
```

### Scores attached per trace
- tier_ordering_pass:     1 (pass) | 0 (fail) — Hard Constraint 1 enforced
- compliance_pass:        1 (pass) | 0 (fail) — Hard Constraint 2 enforced
- qty_assertion_pass:     1 (pass) | 0 (fail) — Hard Constraint 3 enforced
- disruption_traced:      1 (pass) | 0 (fail) — Hard Constraint 4 enforced
- hallucination_pass:     1 (pass) | 0 (fail)
- schema_valid:           1 (pass) | 0 (fail)
- d2c_constraint_pass:    1 (pass) | 0 (fail) — D2C never reallocates
- lever_accuracy:         1 (expected levers matched) | 0 (mismatch)
- latency_within_sla:     1 (≤ 5s median) | 0 (> 5s)

### Tags per trace
- order_id
- segment (federal | commercial | distributor | d2c)
- priority_tier (1 | 2 | 3 | 4)
- trigger_mode (auto | manual)
- risk_score (low | medium | high | critical)
- levers_used[] (from agent response)
- feasibility (full | partial)
- compliance_framework (e.g., "TAA / ITAR / DFARS" for federal)

### Failure events logged to Langfuse
All failure modes emit a Langfuse event in addition to server log:
- tier_ordering_violation (Hard Constraint 1)
- compliance_violation (Hard Constraint 2)
- partial_fulfillment_mislabelled (Hard Constraint 3)
- disruption_not_traced (Hard Constraint 4)
- d2c_rebalance_violation (Hard Constraint 1 corollary)
- regional_pooling_violated (Hard Constraint 7)
- hallucinated_inventory
- cost_of_failure_phrasing_invalid (Hard Constraint 6)
- missed_fulfillment_opportunity
- claude_api_error
- stale_inventory_data

### Prompt management via Langfuse
System prompt is managed in Langfuse Prompt Management under the name
'multi-segment-fulfillment-agent'. API route fetches current published
version at runtime. Every trace records promptName and promptVersion
in the Generation span. A prompt version is only marked 'published'
after passing the full T1–X1 and A1–A9 eval suite via dataset run.

### Eval dataset in Langfuse
All 8 test cases (T1–T6 federal + C1 commercial + D1 distributor + X1 D2C)
and 9 adversarial cases (A1–A9) are added to a Langfuse dataset named
'multi-segment-fulfillment-seed-evals'. Each dataset item contains:
- input: context_payload JSON for that order/scenario
- expected_output: expected levers_used[], expected risk_score,
  expected feasibility, expected segment/priority_tier, expected disruptions

Run dataset evals before every demo and after every prompt version
update using Langfuse SDK dataset run API. All 17 items must pass
their DEMO-BLOCKING criteria before a demo is approved to proceed.

---

## Key Differences from v2.0 (Federal-Only)

| Aspect | v2.0 (Federal-Only) | v3.0 (Multi-Segment) |
|--------|-------------------|----------------------|
| Data model | 5 tables (federal_orders, contract_manufacturers, cm_inventory, committed_orders, fulfillment_scenarios) | 7 tables (+ segment_policies, scenario_disruptions, + v_cm_inventory_context view) |
| Orders | Single federal_orders table; compliance rule single field (TAA/ITAR/NONE) | Multi-segment orders table; segment + compliance_requirements array; region field for distributor |
| Priority model | Federal Tier 1 (absolute); committed orders may be federal or commercial (binary) | Tiered 1–4 per segment_policies; competing_orders include any segment; tier ordering enforced by validator |
| Compliance | TAA-only compliance gate (boolean per CM) | Segment-agnostic: compliance_frameworks_met array per CM/inventory; different compliance framework per segment |
| Competing orders | commercial / federal tiers only | Any segment (1–4); regional pooling for distributor; region field |
| Disruption tracking | Not formally tracked; disruption_impact field in scenario steps only | Formal scenario_disruptions table; one row per disruption; audit trail per Hard Constraint 4 |
| Cost-of-failure | Generic dollar figures (revenue_impact_usd) | Segment-specific language from segment_policies.cost_of_failure (chargebacks vs. fill-rate penalties vs. refunds/churn) |
| Regional pooling | Not applicable (federal-only) | Hard Constraint 7: distributor orders ranked by region, same-region preferred over cross-region |
| D2C constraint | N/A | Hard Constraint 1 corollary: D2C (tier 4) may never reallocate from any competing order |
| Quality criteria | Compliance, qty assertion, hallucination, schema, latency (5 DEMO-BLOCKING) | Tier ordering, compliance, qty assertion, disruption visibility, cost-of-failure phrasing, regional pooling, D2C constraint, hallucination, schema (8 DEMO-BLOCKING) |
| Test cases | 6 federal (T1–T6) + 5 adversarial (A1–A5) | 6 federal (T1–T6) + 3 multi-segment (C1, D1, X1) + 9 adversarial (A1–A9) |
| System prompt | federal-fulfillment-agent v1.0 | multi-segment-fulfillment-agent v2.1.0 (agent_system_prompt.md) |
| UI changes | Federal order dashboard; planner approves scenarios | Multi-segment dashboard with segment badges; segment policy context (SLA driver, cost-of-failure); disruption audit trail shown per scenario |
