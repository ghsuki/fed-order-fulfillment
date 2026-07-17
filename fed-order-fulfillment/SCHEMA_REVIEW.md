# Supabase Schema & Seed Data — Design Review

## Schema Overview

Five tables implementing the Federal Order Fulfillment PoC data model:

### 1. contract_manufacturers
- **PK:** cm_id (text)
- **Key fields:** country, taa_compliant, lead_time_days
- **Seed:** 3 CMs (CM1 Vietnam TAA, CM2 Mexico TAA, CM3 China non-TAA)

### 2. federal_orders
- **PK:** order_id (text, e.g., FED-88421)
- **Key fields:** sku, qty_required, required_ship_date, compliance_rule (TAA/ITAR/NONE), status (open/at_risk/fulfilled/rejected), risk_score
- **Seed:** 5 named test orders (T1–T6 coverage)
- **Constraint:** qty_required > 0, status enum, compliance_rule enum

### 3. cm_inventory
- **PK:** inventory_id (UUID auto)
- **Key fields:** cm_id FK, sku, stock_type (FG/WIP/RM), qty_available, taa_compliant, hold_status (available/qa_hold/committed), est_completion_date (WIP only)
- **Indexes:** (cm_id, sku), sku, updated_at for freshness checks
- **Seed:** 10 inventory rows across 5 orders (see breakdown below)

### 4. committed_orders
- **PK:** commit_id (text)
- **Key fields:** cm_id FK, sku, committed_qty, promised_date, priority_tier (commercial/federal), revenue_impact_usd
- **Seed:** 1 commitment (COMM-88421-CM2) for FED-88421 lever 3 testing

### 5. fulfillment_scenarios
- **PK:** scenario_id (UUID auto)
- **Key fields:** order_id FK, rank (1-3), levers_used (text array), steps (JSONB), total_qty_fulfilled, cost_impact_usd, feasibility (full/partial), compliance_status, trade_off_note, status (proposed/approved/rejected), langfuse_trace_id
- **Constraint:** rank BETWEEN 1 AND 3, feasibility enum, status enum

---

## Seed Data Mapping to Test Cases

### Test Case T1: FED-90012 (Happy path — Lever 1 only)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | FED-90012 | Test case T1 |
| sku | NET-900 | SKU for test |
| qty_required | 300 | Clean 1:1 match with available inventory |
| required_ship_date | 2026-07-18 | SLA |
| compliance_rule | TAA | TAA compliant required |
| Inventory: CM2 | 300 FG, available, TAA ✓ | Direct ship covers fully |
| Expected outcome | feasibility=full, 1 scenario, 0 units_unresolvable | Lever 1 only |

### Test Case T2: FED-88421 (Complex — Levers 1+3+4)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | FED-88421 | Test case T2, T6 |
| sku | RTR-4500 | SKU for test |
| qty_required | 600 | Requires combining levers |
| required_ship_date | 2026-07-14 | Tight SLA |
| compliance_rule | TAA | Non-compliant CM3 excluded |
| Inventory breakdown | | |
| CM1 FG | 180 available, TAA ✓ | Lever 1: direct ship |
| CM1 WIP | 200 available, TAA ✓, est_completion 2026-07-12 | Lever 4: multi-stage (completes before SLA) |
| CM2 FG | 240 committed, TAA ✓ | Lever 3: rebalance commercial commitment |
| CM3 FG | 500 available, TAA ✗ | Excluded — non-compliant |
| Committed: COMM-88421-CM2 | 240 units, commercial, $180K revenue | Lever 3 target |
| Expected outcome | All 3 levers, feasibility=full, 600 units fulfilled | CM3 never proposed |

### Test Case T3: FED-91005 (Cross-CM transfer — Levers 1+2)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | FED-91005 | Test case T3 |
| sku | SRV-2200 | SKU for test |
| qty_required | 450 | Partial at one CM, remainder transferred |
| required_ship_date | 2026-07-20 | SLA allows transfer |
| compliance_rule | ITAR | ITAR compliance required |
| Inventory breakdown | | |
| CM1 FG | 150 available, ITAR ✓ | Lever 1: 150 units direct ship |
| CM2 FG | 300 available, ITAR ✓, lead_time 5 days | Lever 2: transfer ETA = today + 5 = ~2026-07-22 (> SLA 2026-07-20) — note: close timing, feasible if triggered early |
| Expected outcome | Levers 1+2, feasibility=full, cost_impact stated, 450 units | Transfer timing is tight but meets SLA |

### Test Case T4: FED-92001 (All stock on QA hold — zero levers)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | FED-92001 | Test case T4 |
| sku | RTR-4500 | Same SKU as FED-88421 |
| qty_required | 400 | All units on hold |
| required_ship_date | 2026-07-16 | SLA |
| compliance_rule | TAA | TAA required |
| Inventory breakdown | | |
| CM1 FG | 400 available, TAA ✓, **qa_hold** | Not available for fulfillment |
| No other stock | — | No levers viable |
| Expected outcome | scenarios=[], 400 units_unresolvable, risk_score=critical, reason: qa_hold blocks fulfillment | Agent must flag hold status |

### Test Case T5: FED-92002 (Compliance gate blocks all stock — zero levers)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | FED-92002 | Test case T5 |
| sku | NET-900 | Same SKU as FED-90012 |
| qty_required | 250 | Only CM3 stock available |
| required_ship_date | 2026-07-19 | SLA |
| compliance_rule | TAA | TAA required |
| Inventory breakdown | | |
| CM3 FG | 250 available, TAA ✗ | Non-compliant, rejected |
| No compliant stock | — | No levers viable |
| Expected outcome | scenarios=[], 250 units_unresolvable, risk_score=critical, reason: only stock violates TAA rule | Compliance gate enforced |

### Test Case T6: FED-88421 (WIP timing edge case)
| Field | Value | Reason |
|-------|-------|--------|
| order_id | FED-88421 | Same order as T2 |
| Modification | **est_completion_date = 2026-07-16** (overridden from 2026-07-12) | Tests WIP with zero/negative buffer |
| expected_ship_date | 2026-07-14 | SLA tighter than completion |
| Expected outcome | WIP not proposed in any step, trade_off_note flags WIP infeasibility, Levers 1+3 only | Agent must recognize deadline conflict |
| Note | Seed has est_completion = 2026-07-12 (passes T2); test must override via update() before T6 run | Runtime override required |

---

## Adversarial Cases (A1–A5) Data Notes

| Case | Order | Condition | Seed adjustment needed? |
|------|-------|-----------|------------------------|
| A1 | any | qty_required = 0 | Create ad-hoc test order, don't seed |
| A2 | new order | All CMs taa_compliant = false | Create ad-hoc test order with non-TAA CMs only |
| A3 | FED-88421 variant | Federal-tier commitment | Add committed order with priority_tier='federal' |
| A4 | FED-88421 | est_completion_date = required_ship_date (zero buffer) | Update WIP to 2026-07-14 before run |
| A5 | FED-88421 | Inventory tuned so levers sum to exactly 600 with zero spare | Current seed already satisfies: 180+200+240 = 620 (20 units spare); A5 requires 600 exact → adjust CM2 committed from 240 → 220 for test run |

---

## Validation Checklist

Before application code:

- [ ] Schema loads into Supabase without errors
- [ ] All 5 tables created with correct columns and constraints
- [ ] All indexes present
- [ ] Seed data inserted successfully
  - [ ] 3 CMs with correct lead_time_days
  - [ ] 5 federal orders with correct SKUs and SLAs
  - [ ] 10 inventory rows distributed across orders
  - [ ] 1 committed order (COMM-88421-CM2)
- [ ] Count checks:
  - [ ] SELECT COUNT(*) FROM federal_orders → 5
  - [ ] SELECT COUNT(*) FROM cm_inventory → 10
  - [ ] SELECT COUNT(*) FROM contract_manufacturers → 3
  - [ ] SELECT COUNT(*) FROM committed_orders → 1
- [ ] Inventory uniqueness (no duplicate cm_id + sku rows unintentionally)
- [ ] Foreign key relationships valid
  - [ ] All cm_id values in cm_inventory exist in contract_manufacturers
  - [ ] All order_id values in fulfillment_scenarios FK to federal_orders
  - [ ] All cm_id values in committed_orders exist in contract_manufacturers
- [ ] Data sanity spot-checks:
  - [ ] FED-88421 has 4 inventory rows (CM1 FG, CM1 WIP, CM2 committed, CM3)
  - [ ] FED-90012 has 1 inventory row (CM2, 300 FG, available)
  - [ ] FED-92001 has 1 inventory row (CM1, 400 FG, qa_hold)

---

## Next Steps

1. **Confirm schema design** — Review for any data model mismatches with PRD
2. **Load into Supabase** — Run schema.sql against Supabase PostgreSQL database
3. **Verify seed data** — Spot-check a few rows per table
4. **Move to API layer** — Build /api/scenario route with Supabase queries and Claude call
5. **Add validators** — Server-side compliance, hallucination, qty assertion checks
6. **Wire Langfuse** — Tracing and prompt management integration
