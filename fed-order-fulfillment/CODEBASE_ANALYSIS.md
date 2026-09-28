# Codebase Analysis: Technology Stack & Migration to Multi-Segment Model

## Current Technology Stack

### Frontend
- **Framework:** Next.js 14.0.0
- **UI Library:** React 18.2.0 with React DOM 18.2.0
- **Styling:** Built-in CSS (no external framework)
- **State Management:** React hooks (useState, useEffect)

### Backend
- **Runtime:** Node.js (Next.js API routes)
- **Database:** Supabase (PostgreSQL)
- **Database Client:** @supabase/supabase-js 2.38.0

### AI/ML
- **LLM Provider:** Anthropic Claude
- **SDK:** @anthropic-ai/sdk 0.24.0
- **Model:** claude-opus-4-8 (in code, but should be updated to latest)
- **Observability:** Langfuse (latest)

### Database Driver
- **PostgreSQL Client:** pg 8.23.0 (installed but not actively used in current codebase)

### Development
- **Language:** TypeScript 5.3.0
- **Type Definitions:** @types/node, @types/react, @types/react-dom
- **Build Tool:** Next.js built-in (SWC compiler)

---

## Current Architecture Overview

### Project Structure
```
fed-order-fulfillment/
├── app/                          # Next.js app directory
│   ├── api/
│   │   ├── orders/route.ts        # GET /api/orders — fetch all federal orders
│   │   ├── scenario/route.ts      # POST /api/scenario — main agent endpoint
│   │   └── test/route.ts          # Test endpoint (likely for debugging)
│   ├── layout.tsx                 # Root layout
│   └── page.tsx                   # Dashboard UI (Federal order list + scenario modal)
│
├── lib/                           # Shared utilities
│   ├── types.ts                   # TypeScript interfaces (FederalOrder, CMInventory, etc.)
│   ├── supabase.ts                # Supabase client + context assembly (assembleContextPayload)
│   ├── validators.ts              # Compliance, hallucination, qty assertion validators
│   └── langfuse.ts                # Langfuse tracing wrapper (FulfillmentTracer class)
│
├── schema.sql                     # Database schema (MULTI-SEGMENT v2.1.0)
├── agent_system_prompt.md         # Agent system prompt v2.1.0 (multi-segment)
├── fed_agent_system_prompt.md     # Old federal-only agent system prompt v1.0 (deprecated)
├── federal-fulfillment-control-tower-prd-v2.md  # Old PRD (federal-only)
├── multi-segment-fulfillment-control-tower-prd.md # NEW PRD v3.0 (multi-segment)
├── SCHEMA_REVIEW.md               # Schema design review (updated to v2.1.0)
├── package.json                   # Dependencies
├── next.config.js                 # Next.js config
└── vercel.json                    # Vercel deployment config
```

### Data Flow (Current — Federal-Only)

1. **Fetch Orders** (GET /api/orders)
   - Query: `federal_orders` table
   - Return: Array of federal orders with SKU names

2. **Request Scenario** (POST /api/scenario)
   - Input: `{ order_id, trigger_mode }`
   - Fetch order from `federal_orders` table
   - Validate order exists and status is 'open' or 'at_risk'
   - Call `assembleContextPayload(order_id)`
     - Fetch order from `federal_orders`
     - Fetch inventory from `cm_inventory` (query by SKU)
     - Fetch committed orders from `committed_orders` (query by SKU)
   - Call Claude with system prompt + context payload
   - Validate response (compliance, hallucination, qty assertion, schema)
   - Write scenarios to `fulfillment_scenarios` table
   - Update order risk score in `federal_orders`
   - Log to Langfuse
   - Return scenarios to UI

3. **Display UI** (GET / page.tsx)
   - Fetch federal orders
   - Display dashboard with order list (columns: order_id, SKU, qty, SLA, status, risk_score)
   - On "Run Scenario" click: POST /api/scenario
   - Display scenario modal with steps, cost impact, trade-offs

---

## Database Schema Changes Required

### Current (v1.0 — Federal-Only)
- `federal_orders` — order-specific table
- `contract_manufacturers` — with `taa_compliant` boolean
- `cm_inventory` — with `taa_compliant` boolean
- `committed_orders` — with `priority_tier` binary (commercial/federal)
- `fulfillment_scenarios` — basic scenario storage

### New (v2.1.0 — Multi-Segment)
- `segment_policies` — NEW: single source of truth for tier 1–4 policies
- `orders` — RENAMED from `federal_orders`; added `segment` FK, `priority_tier` (auto-synced), `compliance_requirements[]`, `contract_value_usd`, `region`
- `contract_manufacturers` — `taa_compliant` → `compliance_frameworks_met[]`
- `cm_inventory` — `taa_compliant` → `compliance_frameworks_met[]` (with row-level override)
- `competing_orders` — RENAMED from `committed_orders`; added `segment` FK, `priority_tier` (auto-synced), `region`
- `fulfillment_scenarios` — added `segment` FK, `langfuse_trace_id` fields
- `scenario_disruptions` — NEW: audit trail for cross-segment disruptions
- `v_cm_inventory_context` — NEW: view for coalescing row-level overrides with CM defaults

### Migration Path
1. Execute `schema.sql` v2.1.0 in Supabase (already prepared)
2. This creates new tables alongside old ones initially
3. Data migration: populate `segment_policies`, migrate federal orders to `orders` with segment='federal', etc.
4. Application code must be updated to use new tables and API contracts

---

## Key Files to Change (High Priority)

### 1. **lib/types.ts** — Type Definitions ⚠️ CRITICAL
**Current Issues:**
- `FederalOrder` interface hardcoded for federal-only
- `ContractManufacturer` has `taa_compliant: boolean`
- `CMInventory` has `taa_compliant: boolean`
- `CommittedOrder` has binary `priority_tier: 'commercial' | 'federal'`
- `ContextPayload` hardcoded to `federal_order` key

**Changes Needed:**
- Add `SegmentPolicy` interface with all segment policy fields
- Replace `FederalOrder` with `Order` interface:
  - Add `segment: 'federal' | 'commercial' | 'distributor' | 'd2c'`
  - Add `priority_tier: number` (1–4, auto-synced)
  - Change `compliance_rule` → `compliance_requirements: string[]`
  - Add `contract_value_usd?: number`
  - Add `region?: string` (for distributor)
- Replace `ContractManufacturer.taa_compliant` with `compliance_frameworks_met: string[]`
- Replace `CMInventory.taa_compliant` with `compliance_frameworks_met: string[]`
- Add row-level `compliance_frameworks_met?: string[]` and `lead_time_days?: number` overrides to CMInventory
- Replace `CommittedOrder` with `CompetingOrder`:
  - Add `segment` FK
  - Change `priority_tier` to `number` (1–4)
  - Add `region?: string`
- Update `ContextPayload` to replace `federal_order` with `order` and add `segment_policy`
- Add `FulfillmentResult` fields: `segment`, `priority_tier`
- Add `ScenarioDisruption` interface for audit trail
- Add new validator error types: `tier_ordering`, `d2c_constraint`, `regional_pooling`, `disruption_visibility`

**File:** `lib/types.ts`
**Lines:** ~45–118 (entire interfaces section)

---

### 2. **lib/supabase.ts** — Database Access & Context Assembly ⚠️ CRITICAL
**Current Issues:**
- `assembleContextPayload()` queries `federal_orders` table (hardcoded)
- Queries `committed_orders` instead of `competing_orders`
- Maps `taa_compliant` boolean; needs `compliance_frameworks_met` array
- No segment_policies lookup
- No view usage for coalesced inventory

**Changes Needed:**
- Update `assembleContextPayload(orderId)` to:
  - Query `orders` table (not `federal_orders`)
  - Fetch `segment_policies` row for this order's segment
  - Query `v_cm_inventory_context` instead of `cm_inventory` (coalesces row-level overrides)
  - Query `competing_orders` (not `committed_orders`)
  - Build new `ContextPayload` structure with `order`, `segment_policy`, `cm_inventory`, `competing_orders`
- Add `writeFulfillmentScenario()` updates:
  - Write `segment` FK from order
  - For each rebalancing step, create `scenario_disruptions` row
- Add `writingScenarioDisruptions()` function to handle audit trail writes
- Add segment validation before context assembly (reject if segment not in segment_policies)
- Update `updateOrderRiskScore()` to query `orders` table

**File:** `lib/supabase.ts`
**Lines:** ~22–100 (assembleContextPayload entire function; writeFulfillmentScenario; ~add new functions for disruptions)

---

### 3. **lib/validators.ts** — Validation Rules ⚠️ CRITICAL
**Current Issues:**
- `validateCompliance()` only checks TAA/ITAR (federal-only)
- No tier ordering validation (Hard Constraint 1)
- No D2C constraint (never reallocates)
- No regional pooling validation (Hard Constraint 7)
- No disruption audit trail validation (Hard Constraint 4)
- No cost-of-failure phrasing validation (Hard Constraint 6)

**Changes Needed:**
- Update `validateSchema()` to include new required fields: `segment`, `priority_tier`
- Rewrite `validateCompliance()` to:
  - Check `compliance_frameworks_met` against order's `compliance_requirements`
  - Be segment-agnostic (every segment can have empty compliance_requirements)
  - Use order's segment policy to determine applicable compliance frameworks
- Add `validateTierOrdering()` function (Hard Constraint 1):
  - For each rebalance_commitment step, verify `competing_order.priority_tier >= order.priority_tier`
  - Reject if federal tries to pull from federal, commercial tries to pull from federal, etc.
- Add `validateD2CConstraint()` function:
  - If `order.segment='d2c'`, assert no `rebalance_commitment` steps exist
- Add `validateDisruptionAuditTrail()` function (Hard Constraint 4):
  - For each `rebalance_commitment` step, verify `scenario_disruptions` row will be created
  - Check `disruption_impact` phrasing matches disrupted segment's cost-of-failure
- Add `validateRegionalPooling()` function (Hard Constraint 7):
  - If distributor order, check Lever 3 prefers same-region `competing_orders`
  - Flag if cross-region when same-region exists
- Update `validateFulfillmentResult()` to call all new validators
- Update `ValidationResult` to include aggregated `allErrors` array for retry logic

**File:** `lib/validators.ts`
**Lines:** ~1–entire file; add ~300 lines for new validators

---

### 4. **app/api/scenario/route.ts** — Main Agent Endpoint ⚠️ CRITICAL
**Current Issues:**
- Queries `federal_orders` table (hardcoded table name)
- Calls agent with `agent_system_prompt.md` v2.1.0 (good! but validate it's loaded)
- `FulfillmentTracer` scores don't include tier ordering, D2C constraint, etc.
- No scenario_disruptions write
- No segment validation before context assembly
- Tags don't include segment, priority_tier, compliance_framework

**Changes Needed:**
- Update order fetch:
  - Query `orders` table (not `federal_orders`)
  - Add segment validation: if segment not in ['federal', 'commercial', 'distributor', 'd2c'], return HTTP 400
- Update `assembleContextPayload()` call: 
  - Now returns `ContextPayload` with `order`, `segment_policy`, `cm_inventory`, `competing_orders`
  - Handle segment in response
- Update validator scoring (line 301–304):
  - Add `tier_ordering_pass`, `d2c_constraint_pass`, `disruption_traced`, cost-of-failure phrasing checks
  - Map new validator error types to scores
- Update Langfuse tags (line 308–315):
  - Add `segment` tag
  - Add `priority_tier` tag
  - Add `compliance_framework` (from segment_policies)
  - Add `primary_sla_driver` tag
- Write `scenario_disruptions` rows after `writeFulfillmentScenario()`:
  - For each scenario, for each step with action='rebalance_commitment', create one `scenario_disruptions` row
- Update model name: change from 'claude-opus-4-8' to latest (claude-opus-5-5 or claude-sonnet-5)

**File:** `app/api/scenario/route.ts`
**Lines:** ~35–355; key changes at ~66–71 (order query), ~98–117 (context assembly), ~220–246 (validation), ~298–316 (scores/tags), ~281–293 (write scenarios)

---

### 5. **app/api/orders/route.ts** — Fetch Orders Endpoint ⚠️ HIGH
**Current Issues:**
- Queries `federal_orders` table (hardcoded)
- Returns only federal orders; no multi-segment support

**Changes Needed:**
- Update query: `from('federal_orders')` → `from('orders')`
- Add `segment` field to response
- Add `priority_tier` field to response (auto-synced, read from query)
- Add segment badge/label to enrich data
- Optional: add filter by segment parameter (e.g., `/api/orders?segment=federal`)

**File:** `app/api/orders/route.ts`
**Lines:** ~4–11 (query), ~14–25 (enrichment)

---

### 6. **app/page.tsx** — Dashboard UI ⚠️ HIGH
**Current Issues:**
- Hardcoded types: `FederalOrder` interface
- Dashboard displays federal-only columns (no segment column)
- No segment badge rendering
- No segment policy context (SLA driver, compliance framework, cost-of-failure)
- Scenario modal shows only federal-specific fields
- No disruption audit trail display

**Changes Needed:**
- Update type imports: `FederalOrder` → `Order`
- Add segment to order columns (display segment badge: federal=blue, commercial=orange, distributor=purple, d2c=teal)
- Add priority_tier badge to order columns
- Fetch segment_policies and display context in dashboard:
  - Show SLA driver tooltip (e.g., "Contract delivery date" for federal)
  - Show compliance framework tooltip (e.g., "TAA/ITAR/DFARS" for federal)
  - Show cost-of-failure context (e.g., "Contract penalties, debarment risk" for federal)
- Update ScenarioModal to display segment-specific context:
  - Use segment_policies row to show SLA driver, compliance framework, cost-of-failure
  - If distributor, show region field
  - If commercial, show contract_value_usd
- Add disruption audit trail section in scenario modal:
  - If scenario contains rebalancing steps, show disruption_impact phrased in disrupted segment's terms
  - Display disrupted_segment badge, qty_reallocated, disruption_impact text
- Update risk badge rendering: no changes (still 4 colors)

**File:** `app/page.tsx`
**Lines:** ~1–200+ (entire file refactor); key changes at top (imports, types), table rendering, modal content

---

### 7. **app/layout.tsx** — Root Layout (No Changes)
**Status:** ✅ No changes needed (generic layout, no business logic)

---

### 8. **agent_system_prompt.md** ⚠️ VERIFY (Already Updated)
**Status:** Already updated to v2.1.0 (multi-segment agent_system_prompt.md exists in codebase)
**Action:** Verify route.ts is loading this file, not fed_agent_system_prompt.md

---

## Supporting Documentation Files (Already Updated)

✅ `schema.sql` — v2.1.0 schema (COMPLETE)
✅ `SCHEMA_REVIEW.md` — Updated to v2.1.0 (COMPLETE)
✅ `multi-segment-fulfillment-control-tower-prd.md` — NEW v3.0 PRD (COMPLETE)
✅ `agent_system_prompt.md` — v2.1.0 multi-segment prompt (COMPLETE)
⚠️ `fed_agent_system_prompt.md` — OLD v1.0 (DEPRECATED, keep for reference)
⚠️ `federal-fulfillment-control-tower-prd-v2.md` — OLD v2.0 (DEPRECATED, keep for reference)

---

## Files Summary Table

| File | Priority | Type | Changes | Lines |
|------|----------|------|---------|-------|
| `lib/types.ts` | 🔴 CRITICAL | Types | Complete rewrite for multi-segment | ~150–200 |
| `lib/supabase.ts` | 🔴 CRITICAL | Data access | assembleContextPayload + scenario_disruptions write | ~200–250 |
| `lib/validators.ts` | 🔴 CRITICAL | Validation | Add tier ordering, D2C, regional pooling, disruption, cost-of-failure | ~300–400 |
| `app/api/scenario/route.ts` | 🔴 CRITICAL | API route | Segment validation, new validators, disruption writes, Langfuse tags | ~355 |
| `app/api/orders/route.ts` | 🟠 HIGH | API route | Query `orders` table, add segment/priority_tier fields | ~50 |
| `app/page.tsx` | 🟠 HIGH | UI | Multi-segment dashboard, segment badges, disruption audit trail | ~200–300 |
| `lib/langfuse.ts` | 🟡 MEDIUM | Observability | Add new score types (tier_ordering, D2C, disruption, etc.) | ~50–100 |
| `next.config.js` | 🟢 LOW | Config | No changes needed | — |
| `app/layout.tsx` | 🟢 LOW | Layout | No changes needed | — |

---

## Implementation Sequence

### Phase 1: Type System & Data Access (1–2 days)
1. Update `lib/types.ts` with all new interfaces
2. Update `lib/supabase.ts` with new queries and context assembly
3. Execute `schema.sql` v2.1.0 in Supabase
4. Seed segment_policies, migrate orders to new table

### Phase 2: Validation & Business Logic (1–2 days)
5. Rewrite `lib/validators.ts` with all Hard Constraints
6. Update `lib/langfuse.ts` with new score types
7. Update `app/api/scenario/route.ts` with new validators and disruption writes

### Phase 3: API & UI (1–2 days)
8. Update `app/api/orders/route.ts` to query new `orders` table
9. Refactor `app/page.tsx` with multi-segment dashboard and segment badges
10. Test end-to-end with all 4 segments

### Phase 4: Testing & Validation (1–2 days)
11. Run eval suite with T1–X1 (8 test cases) + A1–A9 (9 adversarial cases)
12. Verify all DEMO-BLOCKING criteria pass
13. Manual QA: federal, commercial, distributor, D2C order flows

---

## Breaking Changes Summary

| Change | Impact | Migration Path |
|--------|--------|-----------------|
| `federal_orders` → `orders` table | All queries that reference table name | Update all `from('federal_orders')` to `from('orders')` |
| `committed_orders` → `competing_orders` table | Queries for competing orders | Update all `from('committed_orders')` to `from('competing_orders')` |
| `taa_compliant: boolean` → `compliance_frameworks_met: string[]` | Type changes in multiple interfaces | Migrate boolean to array in db, update all references |
| `priority_tier` binary → integer 1–4 | Priority logic throughout system | Update comparisons and validations to use numeric tier ordering |
| `FederalOrder` → `Order` interface | Type imports and variable names | Search/replace type name, add segment field throughout |
| `compliance_rule` → `compliance_requirements[]` | Compliance validation logic | Update gate checks from single value to array membership |
| Context payload structure | API contract for agent call | Agent system prompt already updated (v2.1.0); update context assembly |
| New `scenario_disruptions` table | Audit trail writes | Add write logic for every rebalancing step |

---

## Environment Variables (No Changes Required)
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
ANTHROPIC_API_KEY=...
NEXT_PUBLIC_LANGFUSE_PUBLIC_KEY=...
LANGFUSE_SECRET_KEY=...
NEXT_PUBLIC_LANGFUSE_BASE_URL=...
```

No new env vars needed for multi-segment model.

---

## Rollback Plan

If issues arise during migration:

1. **Before schema migration:** Backup Supabase database
2. **After schema migration but before app update:** Old app code will fail on `federal_orders` query (doesn't exist). Restore backup or keep both old and new tables parallel during transition.
3. **Staged rollout:** Test multi-segment app against new schema with synthetic data before going live with production orders.
4. **Feature flag:** Consider adding `ENABLE_MULTI_SEGMENT=true/false` env var to toggle between old federal-only path and new multi-segment path during transition.

---

## Testing Checklist

- [ ] **Unit:** Type definitions compile; validators execute
- [ ] **Integration:** Context assembly retrieves correct data from new tables
- [ ] **E2E:** T1–T6 (federal) pass with new schema
- [ ] **E2E:** C1 (commercial) returns Tier 2 scenarios with no Tier 1 rebalancing
- [ ] **E2E:** D1 (distributor) respects regional pooling; LATAM order prefers same-region
- [ ] **E2E:** X1 (D2C) Tier 4 has zero rebalancing steps
- [ ] **Adversarial:** A1–A9 all validators trigger correctly
- [ ] **Langfuse:** All new scores and tags appear in traces
- [ ] **UI:** Dashboard shows segment badges, priority tier, disruption audit trail
- [ ] **Regression:** No federal order functionality broken

---

## Estimated Effort

- **Type System:** 2–3 hours
- **Data Access Layer:** 3–4 hours
- **Validators:** 4–6 hours
- **API Routes:** 2–3 hours
- **UI:** 4–6 hours
- **Testing & Debugging:** 4–6 hours
- **Total:** ~20–25 hours (5–6 developer days with integration testing)
