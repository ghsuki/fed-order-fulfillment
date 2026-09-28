# Supabase Schema & Seed Data — Design Review
## Version: 2.1.0 (Multi-Segment Order Fulfillment Control Tower)

## Schema Overview

Seven tables + 2 database objects (trigger, view) implementing the multi-segment order fulfillment model.
Replaces v1.0 (federal-only) with policy-driven, segment-agnostic control tower.

### 1. segment_policies
- **PK:** segment (text CHECK IN ('federal', 'commercial', 'distributor', 'd2c'))
- **Key fields:** priority_tier (1–4 UNIQUE), priority_handling, compliance_framework, primary_sla_driver, cost_of_failure
- **Purpose:** Single source of truth for priority tier, compliance framework, SLA driver, and cost-of-failure language per segment. Mirrors the Policy Table in agent_system_prompt.md v2.1.0
- **Seed:** 4 rows (federal tier 1, commercial tier 2, distributor tier 3, d2c tier 4)
- **Constraint:** segment unique (PK), priority_tier unique (ensures one row per tier)

### 2. contract_manufacturers
- **PK:** cm_id (text)
- **Key fields:** country, compliance_frameworks_met (TEXT[] - e.g., ['TAA', 'ITAR']), lead_time_days, created_at
- **Change from v1.0:** `taa_compliant` bool → `compliance_frameworks_met` TEXT array (segment-agnostic, supports any compliance framework)
- **Seed:** 3 CMs (CM1 Vietnam TAA/ITAR, CM2 Mexico TAA/ITAR, CM3 China [])

### 3. orders
- **PK:** order_id (text, e.g., FED-88421, COM-10001, DIST-20001, D2C-30001)
- **Change from v1.0:** Renamed from `federal_orders` → `orders`
- **Key fields:** 
  - segment FK (references segment_policies) — never inferred, always provided
  - priority_tier INT (auto-synced from segment_policies by trigger, not set manually)
  - sku, qty_required (> 0), required_ship_date
  - compliance_requirements TEXT[] (e.g., ['TAA'] for federal, [] for commercial/distributor/d2c)
  - contract_value_usd INT (present for commercial orders, null for others)
  - region TEXT (populated for distributor orders, drives regional pooling per Constraint 7)
  - status (open/at_risk/fulfilled/rejected), risk_score (low/medium/high/critical)
  - created_at, updated_at
- **Indexes:** sku, segment, status, risk_score, region
- **Trigger:** `trg_orders_sync_priority_tier` — BEFORE INSERT/UPDATE on segment, pulls priority_tier from segment_policies
- **Seed:** 5 federal + 3 multi-segment (commercial, distributor, d2c) = 8 total orders

### 4. cm_inventory
- **PK:** inventory_id (UUID auto)
- **Key fields:** 
  - cm_id FK, sku, stock_type (FG/WIP/RM), qty_available (>= 0)
  - compliance_frameworks_met TEXT[] (row-level override; NULL falls back to CM default)
  - hold_status (available/qa_hold/committed)
  - lead_time_days INT (row-level override; NULL falls back to CM default)
  - est_completion_date (WIP only, triggers Lever 4 feasibility)
  - updated_at, created_at
- **Change from v1.0:** `taa_compliant` bool → `compliance_frameworks_met` TEXT array; row-level overrides for compliance and lead_time_days
- **Indexes:** (cm_id, sku), sku, updated_at for freshness checks
- **Seed:** 10 rows across all 8 orders (RTR-4500 x 4 rows, SRV-2200 x 2 rows, NET-900 x 4 rows)

### 5. competing_orders
- **PK:** commit_id (text, e.g., COMM-88421-CM2, DIST-LATAM-CM3)
- **Change from v1.0:** Renamed from `committed_orders` → `competing_orders` (holds competing orders from ANY segment, not just federal commitments)
- **Key fields:**
  - cm_id FK, sku, segment FK (not inferred from order type), priority_tier INT (auto-synced by trigger)
  - region TEXT (populated for distributor commitments, drives Lever 3 regional pooling per Constraint 7)
  - committed_qty (> 0), promised_date, contract_value_usd INT (optional)
  - created_at
- **Purpose:** Every order from ANY segment currently holding stock at any CM, enabling cross-segment disruption visibility per Hard Constraint 4
- **Trigger:** `trg_competing_orders_sync_priority_tier` — BEFORE INSERT/UPDATE on segment
- **Seed:** 
  - COMM-88421-CM2: commercial, 240 units, $180K (Lever 3 candidate for federal order)
  - DIST-LATAM-CM3: distributor, region=LATAM, 150 units (Lever 3/Lever 5 candidate, region pooling example)

### 6. fulfillment_scenarios
- **PK:** scenario_id (UUID auto)
- **Key fields:** 
  - order_id FK, segment FK (denormalized for query efficiency), rank (1–3)
  - levers_used TEXT[] (e.g., ['direct_ship', 'commitment_rebalancing'])
  - steps JSONB (array of action objects per step schema in agent_system_prompt.md OUTPUT FORMAT)
  - total_qty_fulfilled INT (>= 0), cost_impact_usd INT (optional)
  - feasibility (full/partial), compliance_status TEXT, trade_off_note TEXT
  - status (proposed/approved/rejected), langfuse_trace_id (for tracing to Langfuse)
  - created_at, updated_at
- **Indexes:** order_id, segment, status
- **Constraint:** rank BETWEEN 1 AND 3, feasibility in ('full', 'partial'), status in ('proposed', 'approved', 'rejected')

### 7. scenario_disruptions
- **PK:** disruption_id (UUID auto)
- **New in v2.1.0** — Operationalizes Hard Constraints 4 and 6: every cross-segment disruption is named and audit-traced
- **Key fields:**
  - scenario_id FK, commit_id FK (which order was disrupted)
  - disrupted_segment FK, disrupted_priority_tier INT, disrupted_region TEXT
  - qty_reallocated INT (> 0) — how many units pulled from the competing order
  - disruption_impact TEXT (phrased in the disrupted order's Cost-of-Failure terms, e.g., "fill-rate penalty" for distributor, not generic "$X")
  - created_at
- **Purpose:** Audit trail of every decision that reallocates stock from another order. Ensures visibility across segments per Hard Constraints 4, 6, and Lever 5 reasoning

### 8. v_cm_inventory_context (VIEW)
- **New in v2.1.0** — Assembles cm_inventory rows exactly as the agent's JSON context expects
- **Fields:** inventory_id, cm_id, cm_name, country, sku, stock_type, qty_available, compliance_frameworks_met (coalesced with CM default), hold_status, lead_time_days (coalesced with CM default), est_completion_date, updated_at
- **Purpose:** Simplifies context building in the API layer; agent receives fully resolved lead_time_days and compliance_frameworks_met per row

---

## Seed Data Mapping to Test Cases (Multi-Segment Model v2.1.0)

### Segment-Policy Test Suite

#### Policy Verification (SegPolicy-1 through SegPolicy-4)

| Test | Segment | Data | Assertion |
|------|---------|------|-----------|
| SegPolicy-1 | federal | FED-88421 | priority_tier = 1 (auto-synced from segment_policies), tier allows rebalancing from tiers 2–4 |
| SegPolicy-2 | commercial | COM-10001 | priority_tier = 2, may rebalance from tiers 3–4, cost-of-failure = chargebacks/relationship damage |
| SegPolicy-3 | distributor | DIST-20001 | priority_tier = 3, region=LATAM pools with other LATAM distributor orders, may rebalance from tier 4 only |
| SegPolicy-4 | d2c | D2C-30001 | priority_tier = 4 (lowest), may never rebalance from competing orders (Hard Constraint 1), cost-of-failure = refunds/reviews/churn |

### Federal Order Test Cases (v2.1.0 adapted)

#### Test Case T1: FED-90012 (Tier 1 Happy path — Lever 1 only)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | FED-90012 | Test case T1 |
| segment | federal | Tier 1 priority |
| priority_tier | 1 (auto-synced) | Pulled from segment_policies by trigger |
| sku | NET-900 | SKU for test |
| qty_required | 300 | Clean 1:1 match with available inventory |
| required_ship_date | 2026-07-18 | SLA |
| compliance_requirements | ['TAA'] | Array-based compliance framework |
| Inventory: CM2 | 300 FG, available, compliance_frameworks_met=['TAA', 'ITAR'] ✓ | Direct ship covers fully |
| Expected outcome | feasibility=full, 1 scenario, 0 units_unresolvable, compliance_status='TAA compliant' | Lever 1 only |

#### Test Case T2: FED-88421 (Tier 1 Complex — Levers 1+3+4)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | FED-88421 | Test case T2, T6 |
| segment | federal | Tier 1 priority |
| priority_tier | 1 (auto-synced) | Highest tier, may reallocate from any lower tier |
| sku | RTR-4500 | SKU for test |
| qty_required | 600 | Requires combining levers |
| required_ship_date | 2026-07-14 | Tight SLA |
| compliance_requirements | ['TAA'] | Federal compliance framework |
| Inventory breakdown | | |
| CM1 FG | 180 available, compliance_frameworks_met=['TAA', 'ITAR'] ✓ | Lever 1: direct ship |
| CM1 WIP | 200 available, compliance_frameworks_met=['TAA', 'ITAR'] ✓, est_completion 2026-07-12 | Lever 4: multi-stage (completes before SLA) |
| CM2 FG | 240 committed by COMM-88421-CM2 (commercial tier 2), compliance=['TAA', 'ITAR'] ✓ | Lever 3: rebalance commercial commitment (tier 2 < tier 1, allowed) |
| CM3 FG | 500 available, compliance_frameworks_met=[] ✗ | Excluded — compliance gate fails (no TAA/ITAR) |
| Competing: COMM-88421-CM2 | segment=commercial, priority_tier=2 (auto-synced), 240 units, $180K revenue | Lever 3 target: federal tier 1 may pull from tier 2 |
| Expected outcome | All 3 levers, feasibility=full, 600 units fulfilled, disruption_impact shows commercial tier 2 delay + cost_of_failure=chargebacks/relationship damage | CM3 never proposed (compliance gate) |

#### Test Case T3: FED-91005 (Tier 1 Cross-CM transfer — Levers 1+2)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | FED-91005 | Test case T3 |
| segment | federal | Tier 1 priority |
| priority_tier | 1 (auto-synced) | Tier 1 SLA driver = contract delivery date |
| sku | SRV-2200 | SKU for test |
| qty_required | 450 | Partial at one CM, remainder transferred |
| required_ship_date | 2026-07-20 | SLA allows transfer |
| compliance_requirements | ['ITAR'] | ITAR compliance only |
| Inventory breakdown | | |
| CM1 FG | 150 available, compliance_frameworks_met=['TAA', 'ITAR'] ✓ | Lever 1: 150 units direct ship |
| CM2 FG | 300 available, compliance_frameworks_met=['TAA', 'ITAR'] ✓, lead_time_days=5 | Lever 2: transfer ETA = today + 5 ≈ 2026-07-22 (tight but > SLA 2026-07-20 if triggered early) |
| Expected outcome | Levers 1+2, feasibility=full, cost_impact=transfer_cost, compliance_status='ITAR compliant' | Transfer timing is tight; cost_impact reflects lead time overhead |

#### Test Case T4: FED-92001 (Tier 1 QA hold blocks all stock — zero levers)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | FED-92001 | Test case T4 |
| segment | federal | Tier 1 priority |
| priority_tier | 1 (auto-synced) | Tier 1 status (highest urgency) |
| sku | RTR-4500 | Same SKU as FED-88421 |
| qty_required | 400 | All units on hold |
| required_ship_date | 2026-07-16 | Tight SLA |
| compliance_requirements | ['TAA'] | Federal compliance |
| Inventory breakdown | | |
| CM1 FG | 400 available, compliance_frameworks_met=['TAA', 'ITAR'] ✓, **hold_status=qa_hold** | Not available for fulfillment (hold_status gate) |
| No other stock | — | No levers viable: Lever 1 blocked by hold; no competing orders to rebalance; no WIP |
| Expected outcome | scenarios=[], 400 units_unresolvable, risk_score=critical, reason='All compliant stock on QA hold; no Lever 1, 3, or 4 alternative' | Hard Constraint 3: must state it is physically impossible |

#### Test Case T5: FED-92002 (Tier 1 Compliance gate blocks all stock — zero levers)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | FED-92002 | Test case T5 |
| segment | federal | Tier 1 priority |
| priority_tier | 1 (auto-synced) | Tier 1 status |
| sku | NET-900 | Same SKU as FED-90012 |
| qty_required | 250 | Only CM3 stock available |
| required_ship_date | 2026-07-19 | SLA |
| compliance_requirements | ['TAA'] | Federal compliance gate |
| Inventory breakdown | | |
| CM3 FG | 250 available, compliance_frameworks_met=[] ✗ | Non-compliant: no TAA/ITAR, rejected by compliance gate (Hard Constraint 2) |
| No compliant stock | — | No levers viable: Lever 1 fails gate; no competing orders; no WIP |
| Expected outcome | scenarios=[], 250 units_unresolvable, risk_score=critical, reason='No compliant stock (TAA required, CM3 only non-compliant)' | Compliance gate enforced per segment policy |

#### Test Case T6: FED-88421 (WIP timing edge case — Lever 4 infeasibility)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | FED-88421 | Same order as T2 |
| Modification | **est_completion_date = 2026-07-16** (overridden from 2026-07-12) | Tests WIP with negative buffer vs. required_ship_date |
| required_ship_date | 2026-07-14 | SLA tighter than completion |
| Expected outcome | WIP not proposed in any step, trade_off_note flags 'WIP infeasible: est_completion 2026-07-16 > required_ship_date 2026-07-14', Levers 1+3 only | Hard Constraint 3: explain why Lever 4 fails |
| Note | Seed has est_completion = 2026-07-12 (passes T2); test must override via UPDATE before T6 run | Runtime override required to avoid T2/T6 seed conflict |

### Multi-Segment Test Cases (New in v2.1.0)

#### Test Case C1: COM-10001 (Tier 2 Commercial — Lever 1 + potential disruption)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | COM-10001 | New commercial order |
| segment | commercial | Tier 2 priority (auto-synced) |
| priority_tier | 2 (auto-synced) | Tier 2: may rebalance from tiers 3–4, not from tier 1 (Hard Constraint 1) |
| sku | RTR-4500 | Shared SKU |
| qty_required | 200 | Moderate quantity |
| required_ship_date | 2026-07-17 | 3 days later than FED-88421 |
| compliance_requirements | [] | Commercial segment has no formal compliance gate |
| contract_value_usd | 220000 | Revenue exposure for rebalancing cost |
| Inventory breakdown | | |
| CM1 FG | 180 available (may be reserved for FED-88421 tier 1) | Lever 1 partial: 180 units |
| CM3 FG | 500 available, compliance_frameworks_met=[] ✓ | Compliant for commercial (no compliance gate), 20 units sufficient for partial |
| Expected outcome | Feasibility=full (180+20=200), cost_impact minimal, no disruption to tier 1 (Lever 1+2 transfer from CM3) | Commercial tier 2 does not disrupt federal tier 1 |

#### Test Case D1: DIST-20001 (Tier 3 Distributor — Regional pooling)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | DIST-20001 | New distributor order |
| segment | distributor | Tier 3 priority (auto-synced) |
| priority_tier | 3 (auto-synced) | Tier 3: may rebalance from tier 4 only (Hard Constraint 1), regional pooling applies (Hard Constraint 7) |
| sku | RTR-4500 | Shared SKU |
| qty_required | 150 | Regional pool quantity |
| required_ship_date | 2026-07-15 | Earlier than COM-10001 |
| compliance_requirements | [] | Distributor segment, no formal compliance |
| region | LATAM | Drives regional pooling |
| Inventory breakdown | | |
| CM3 FG | 500 available, compliance_frameworks_met=[] ✓, hold_status=available (150 sub-allocated for DIST-LATAM-CM3 competing order, see below) | Lever 1: 150 units available after competing order |
| Competing: DIST-LATAM-CM3 | segment=distributor, priority_tier=3, region=LATAM, committed_qty=150, promised_date=2026-07-11 | Same-region distributor order holding stock; both tier 3, but DIST-LATAM-CM3 earlier promised date |
| Expected outcome | Feasibility=full (150 units from CM3 available pool), no rebalancing (same tier, same region), regional pooling rule applies | DIST-20001 ranks lower in LATAM pool due to later promised_date; scenario may defer to DIST-LATAM-CM3 |

#### Test Case D2: DIST-LATAM-CM3 (Tier 3 Distributor — Competing order example for Lever 3)
| Fixture | Value | Reason |
|---------|-------|--------|
| commit_id | DIST-LATAM-CM3 | Pre-seeded competing order |
| segment | distributor | Tier 3 priority |
| priority_tier | 3 (auto-synced) | Tier 3: only tier 4 (D2C) can reallocate from it (Hard Constraint 1) |
| region | LATAM | Regional pool |
| committed_qty | 150 | Units promised |
| promised_date | 2026-07-11 | 4 days before DIST-20001 |
| cost_of_failure | Fill-rate penalties, reorder loss | Per segment_policies for distributor tier 3 |
| Expected in Lever 5 scenario | If a tier 1–3 order needs rebalancing network-wide, this distributor order may be disrupted, triggering scenario_disruptions row with impact='Distributor (LATAM) reallocated to higher tier; fill-rate penalty exposure, reorder loss risk in LATAM region' | Disruption audit trail per Hard Constraint 4 |

#### Test Case X1: D2C-30001 (Tier 4 D2C — No rebalancing, never pulls committed stock)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | D2C-30001 | New D2C order |
| segment | d2c | Tier 4 priority (auto-synced, lowest) |
| priority_tier | 4 (auto-synced) | Tier 4: may NEVER reallocate from competing orders (Hard Constraint 1, "D2C may never pull stock committed to another order") |
| sku | NET-900 | Shared SKU |
| qty_required | 60 | Small quantity |
| required_ship_date | 2026-07-12 | Earliest of all test orders |
| compliance_requirements | [] | D2C segment, no formal compliance |
| Inventory breakdown | | |
| CM2 FG | 300 available, compliance_frameworks_met=['TAA', 'ITAR'] ✓ | Lever 1: available stock |
| CM3 FG | 250 available, compliance_frameworks_met=[] ✓ | Additional inventory |
| No competing orders holding NET-900 for D2C | — | D2C does not disrupt; if FED-90012 (tier 1) claims CM2 stock, D2C must find alternative |
| Expected outcome | Feasibility=full (300 from CM2 or 250+60 split), no Lever 3 rebalancing allowed (Hard Constraint 1), cost_impact minimal | D2C respects all higher tiers; never reallocates |

### Seed Data Distribution Summary

| Segment | Count | Orders | Inventory Rows | Competing Orders |
|---------|-------|--------|----------------|------------------|
| federal | 5 | FED-88421, FED-90012, FED-91005, FED-92001, FED-92002 | 10 | 0 (all available to higher tiers, no pre-commitments) |
| commercial | 1 | COM-10001 | 2 (shared RTR-4500 + adjacent stock) | 1 (COMM-88421-CM2 pre-commitment) |
| distributor | 1 | DIST-20001 | 2 (shared RTR-4500 + regional pool) | 1 (DIST-LATAM-CM3 pre-commitment, same region) |
| d2c | 1 | D2C-30001 | 2 (NET-900 from multiple CMs) | 0 |
| **Total** | **8** | | **≈16 rows** | **2** |

---

## Adversarial Cases (A1–A9) Data Notes

| Case | Order | Condition | Seed adjustment needed? |
|------|-------|-----------|------------------------|
| A1 | any segment | qty_required = 0 | Create ad-hoc test order, don't seed; agent should return risk_score=critical, reason='qty_required must be > 0' |
| A2 | new order, commercial | All CMs compliance_frameworks_met=[] (no compliance frameworks) | Create ad-hoc order with compliance_requirements=[]; commercial allows this, feasibility=full from CM3 |
| A3 | new order, federal | Unrecognized segment value (e.g., segment='aerospace') | Agent should return risk_score=critical, reason='Unrecognized segment "aerospace": no matching row in segment_policies' (Hard Constraint: never infer priority) |
| A4 | FED-88421 variant | Higher-tier competing order (e.g., federal tier 1 competing order holding stock) | Add competing_orders row with segment='federal', priority_tier=1; FED-88421 (tier 1) cannot reallocate from it (Hard Constraint 1: tier ordering non-negotiable) |
| A5 | FED-88421 | est_completion_date = required_ship_date (zero buffer) | Update WIP to 2026-07-14 before run; agent should flag 'WIP infeasible: est_completion equals required_ship_date, no buffer for completion risk' |
| A6 | DIST-20001 variant | Cross-region competing distributor order (e.g., region='APAC' instead of LATAM) | Add competing_orders row with region='APAC', same tier 3; regional pooling rule (Hard Constraint 7) applies: DIST-20001 (LATAM) should not pull from APAC distributor order if same-region alternative exists |
| A7 | D2C-30001 | Competing order at any tier (federal, commercial, distributor) | Pre-seed competing_orders row with segment=federal (tier 1); D2C scenario must not propose rebalancing (Hard Constraint 1: D2C may never pull committed stock); verify scenario_disruptions remains empty |
| A8 | COM-10001 | Attempt to reallocate from FED-88421 (tier 1) | COM-10001 (tier 2) must not rebalance from FED-88421 (tier 1); Hard Constraint 1 enforced: agent must rank scenarios by feasibility only from tier 2+ |
| A9 | Multi-segment scenario | All orders in inventory context, test disruption_impact phrasing | FED-88421 disrupts COMM-88421-CM2 and DIST-LATAM-CM3; verify scenario_disruptions rows capture both disruptions with cost_of_failure in each order's own terms (debarment/chargebacks for federal/commercial vs. fill-rate penalties for distributor) |

---

## Validation Checklist

Before API layer integration:

### Schema Creation & Objects
- [ ] Schema loads into Supabase without errors (zero SQL syntax errors)
- [ ] All 7 tables created with correct columns and constraints
  - [ ] segment_policies (4 rows: federal/1, commercial/2, distributor/3, d2c/4)
  - [ ] contract_manufacturers (3 rows: CM1, CM2, CM3)
  - [ ] orders (8 rows: 5 federal + 3 multi-segment)
  - [ ] cm_inventory (16 rows distributed across orders)
  - [ ] competing_orders (2 rows: commercial + distributor)
  - [ ] fulfillment_scenarios (empty, ready for agent writes)
  - [ ] scenario_disruptions (empty, ready for audit trail writes)
- [ ] View v_cm_inventory_context created and queries without error
- [ ] Triggers created:
  - [ ] trg_orders_sync_priority_tier (BEFORE INSERT/UPDATE on segment)
  - [ ] trg_competing_orders_sync_priority_tier (BEFORE INSERT/UPDATE on segment)
- [ ] All indexes present (11 total across 5 tables per schema.sql)

### Seed Data Integrity
- [ ] Segment policies inserted and unique per tier
  - [ ] federal: priority_tier=1, compliance_framework='TAA / ITAR / DFARS', cost_of_failure='Contract penalties, debarment risk'
  - [ ] commercial: priority_tier=2, compliance_framework='Customer quality agreement', cost_of_failure='Chargebacks, relationship damage'
  - [ ] distributor: priority_tier=3, compliance_framework='INCOTERMS / distributor agreements', cost_of_failure='Fill-rate penalties, reorder loss'
  - [ ] d2c: priority_tier=4, compliance_framework='Consumer protection / marketplace SLAs', cost_of_failure='Refunds, reviews, churn'
- [ ] Contract manufacturers inserted
  - [ ] CM1 Vietnam compliance_frameworks_met=['TAA', 'ITAR']
  - [ ] CM2 Mexico compliance_frameworks_met=['TAA', 'ITAR']
  - [ ] CM3 China compliance_frameworks_met=[] (empty array)
- [ ] Orders inserted with correct segment and auto-synced priority_tier
  - [ ] FED-88421: segment='federal', priority_tier=1 (auto-synced), compliance_requirements=['TAA']
  - [ ] COM-10001: segment='commercial', priority_tier=2 (auto-synced), compliance_requirements=[], contract_value_usd=220000
  - [ ] DIST-20001: segment='distributor', priority_tier=3 (auto-synced), region='LATAM', compliance_requirements=[]
  - [ ] D2C-30001: segment='d2c', priority_tier=4 (auto-synced), compliance_requirements=[]
- [ ] Inventory inserted with correct compliance_frameworks_met (row-level and CM defaults)
  - [ ] RTR-4500: CM1 FG 180+WIP 200, CM2 FG 240, CM3 FG 500+FG 150 (test regional split)
  - [ ] NET-900: CM2 FG 300, CM3 FG 250
  - [ ] SRV-2200: CM1 FG 150, CM2 FG 300
- [ ] Competing orders inserted with correct segment and auto-synced priority_tier
  - [ ] COMM-88421-CM2: segment='commercial', priority_tier=2 (auto-synced), 240 units, $180K
  - [ ] DIST-LATAM-CM3: segment='distributor', priority_tier=3 (auto-synced), region='LATAM', 150 units

### Count & Relationship Checks
- [ ] SELECT COUNT(*) FROM segment_policies → 4
- [ ] SELECT COUNT(*) FROM contract_manufacturers → 3
- [ ] SELECT COUNT(*) FROM orders → 8
- [ ] SELECT COUNT(*) FROM cm_inventory → ≥16
- [ ] SELECT COUNT(*) FROM competing_orders → 2
- [ ] SELECT COUNT(*) FROM fulfillment_scenarios → 0 (empty, ready for agent)
- [ ] SELECT COUNT(*) FROM scenario_disruptions → 0 (empty, ready for audit trail)
- [ ] Foreign key relationships valid
  - [ ] All segment values in orders exist in segment_policies
  - [ ] All segment values in competing_orders exist in segment_policies
  - [ ] All cm_id values in cm_inventory FK to contract_manufacturers
  - [ ] All cm_id values in competing_orders FK to contract_manufacturers
  - [ ] All order_id values (future) in fulfillment_scenarios FK to orders
  - [ ] All scenario_id values (future) in scenario_disruptions FK to fulfillment_scenarios
  - [ ] All commit_id values (future) in scenario_disruptions FK to competing_orders
- [ ] Trigger verification (insert a new order, verify priority_tier auto-synced)
  - [ ] INSERT INTO orders (order_id, segment, sku, qty_required, required_ship_date) VALUES ('TEST-1', 'federal', 'TEST', 100, '2026-08-01')
  - [ ] SELECT priority_tier FROM orders WHERE order_id='TEST-1' → should return 1 (not NULL)
  - [ ] DELETE FROM orders WHERE order_id='TEST-1' (clean up)

### Data Sanity Spot-Checks
- [ ] FED-88421 (federal tier 1)
  - [ ] 4 inventory rows: CM1 FG (180), CM1 WIP (200), CM2 FG (240), CM3 FG (500)
  - [ ] compliance_requirements=['TAA']
  - [ ] 1 competing order: COMM-88421-CM2 (commercial tier 2, 240 units, $180K) at CM2
- [ ] COM-10001 (commercial tier 2)
  - [ ] priority_tier=2, contract_value_usd=220000
  - [ ] can rebalance from tier 3–4 only (Hard Constraint 1)
- [ ] DIST-20001 (distributor tier 3)
  - [ ] priority_tier=3, region='LATAM'
  - [ ] can rebalance from tier 4 only (Hard Constraint 1)
  - [ ] regional pooling applies: DIST-LATAM-CM3 (same region, same tier 3) competes in same pool
- [ ] D2C-30001 (d2c tier 4)
  - [ ] priority_tier=4 (lowest)
  - [ ] may never reallocate from competing orders (Hard Constraint 1)
- [ ] compliance_frameworks_met coalescing via v_cm_inventory_context
  - [ ] SELECT compliance_frameworks_met FROM v_cm_inventory_context WHERE cm_id='CM1' → should show ['TAA', 'ITAR'] (from CM default)
  - [ ] SELECT compliance_frameworks_met FROM v_cm_inventory_context WHERE cm_id='CM3' → should show [] (from CM default)
- [ ] lead_time_days coalescing via v_cm_inventory_context
  - [ ] SELECT lead_time_days FROM v_cm_inventory_context WHERE cm_id='CM1' → should show lead time from contract_manufacturers row

---

## Next Steps

1. **Confirm multi-segment schema design** — Review for alignment with agent_system_prompt.md v2.1.0 and Hard Constraints 1–7
   - [ ] Policy Table (segment_policies) correctly mirrors agent_system_prompt.md v2.1.0 policies
   - [ ] Priority tier ordering (1–4) non-negotiable per Hard Constraint 1
   - [ ] Regional pooling for distributor orders per Hard Constraint 7
   - [ ] Compliance framework checks are segment-agnostic (not TAA-only) per Hard Constraint 2

2. **Load schema into Supabase** — Execute schema.sql (v2.1.0) against Supabase PostgreSQL database
   - [ ] All 7 tables + 2 triggers + 1 view created without errors
   - [ ] Seed data inserted (segment_policies, CMs, 8 orders, 16 inventory rows, 2 competing orders)
   - [ ] Validation checklist above passed

3. **Verify seed data & agent context** — Query v_cm_inventory_context and competing_orders to ensure agent receives properly formatted JSON
   - [ ] Run test query: SELECT * FROM v_cm_inventory_context WHERE sku='RTR-4500' ORDER BY cm_id, stock_type
   - [ ] Verify compliance_frameworks_met and lead_time_days coalescing works per view logic
   - [ ] Sample competing_orders query showing segment, priority_tier (auto-synced), region for distributor orders

4. **API layer — Context builder** — Build /api/scenario route that:
   - [ ] Takes order_id as input (any segment)
   - [ ] Queries order, segment_policies, v_cm_inventory_context, competing_orders
   - [ ] Assembles JSON context per agent_system_prompt.md v2.1.0 "CONTEXT YOU WILL RECEIVE"
   - [ ] Ensures priority_tier is populated (auto-synced by trigger, but verify in context)
   - [ ] Ensures region is populated for distributor orders (drives regional pooling logic)
   - [ ] Ensures compliance_requirements and compliance_frameworks_met arrays are properly formatted

5. **Agent integration** — Wire multi-segment agent
   - [ ] Call Claude with agent_system_prompt.md v2.1.0 (not fed_agent_system_prompt.md v1.0)
   - [ ] Pass assembled JSON context
   - [ ] Parse JSON response (fulfillmentResult schema per v2.1.0 OUTPUT FORMAT)
   - [ ] **CRITICAL:** Response format requires JSON-only, no markdown, no explanatory text

6. **Write fulfillment_scenarios & scenario_disruptions** — After agent returns
   - [ ] INSERT into fulfillment_scenarios (order_id, segment, rank, levers_used, steps JSONB, total_qty_fulfilled, feasibility, compliance_status, langfuse_trace_id)
   - [ ] For each rebalancing step, INSERT into scenario_disruptions (scenario_id, commit_id, disrupted_segment, qty_reallocated, disruption_impact)
   - [ ] Verify scenario_disruptions audit trail names every cross-segment disruption per Hard Constraint 4

7. **Validators & guardrails** — Server-side checks
   - [ ] **Tier ordering:** Scenario may only reallocate from competing_orders with priority_tier >= order.priority_tier (Hard Constraint 1)
   - [ ] **Compliance:** Every unit allocated must have compliance_frameworks_met ⊇ order.compliance_requirements (Hard Constraint 2)
   - [ ] **Full satisfaction attempt:** If feasibility='partial', assert agent has explicitly explained why full satisfaction is impossible (Hard Constraint 3)
   - [ ] **Disruption visibility:** If steps contain any rebalance_commitment, verify scenario_disruptions rows exist for each affected competing_order (Hard Constraint 4)
   - [ ] **Cost-of-failure phrasing:** disruption_impact must use language from segment_policies.cost_of_failure for disrupted_segment, not generic dollar figures (Hard Constraint 6)
   - [ ] **Regional pooling:** For distributor orders, verify Lever 3 prefers same-region competing_orders before cross-region (Hard Constraint 7)
   - [ ] **D2C constraint:** If order.segment='d2c', assert no rebalance_commitment steps exist (Hard Constraint 1: D2C may never pull)

8. **Langfuse integration** — Tracing & observability
   - [ ] Wire Langfuse trace_id at API layer (passed to agent, stored in fulfillment_scenarios.langfuse_trace_id)
   - [ ] Log order context, scenarios returned, and disruption decisions
   - [ ] Link trace_id to agent prompt version (2.1.0) for multi-segment auditing

9. **Test harness** — Execute T1–T6 (federal) + C1/D1/X1 (multi-segment) + A1–A9 (adversarial)
   - [ ] Federal orders (T1–T6) validate Levers 1–4 and compliance/hold gates per v1.0 behavior
   - [ ] Multi-segment orders (C1/D1/X1) validate tier ordering, regional pooling, and segment-specific policies per v2.1.0
   - [ ] Adversarial cases (A1–A9) validate Hard Constraints 1–7 enforcement (no tier violations, no D2C rebalancing, no unrecognized segments, proper disruption tracking)
   - [ ] Disruption audit trail: verify scenario_disruptions captures every rebalancing with cost_of_failure in disrupted order's own terms
