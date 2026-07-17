# Federal Order Fulfillment Control Tower PoC

AI-powered web application for analyzing cross-CM inventory and generating ranked fulfillment scenarios for federal orders.

## Stack

- **Frontend:** Next.js 14 (React 18) · TypeScript
- **Backend:** Next.js API Routes
- **Database:** Supabase (PostgreSQL)
- **AI:** Anthropic Claude API (claude-3-5-sonnet-20241022)
- **Observability:** Langfuse (tracing, scoring, prompt management)

## Setup

### 1. Environment Variables

Copy `.env.local.example` to `.env.local` and fill in your credentials:

```bash
cp .env.local.example .env.local
```

Required:
- `NEXT_PUBLIC_SUPABASE_URL` — Your Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase public anon key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key
- `ANTHROPIC_API_KEY` — Claude API key

Optional (for Langfuse tracing):
- `NEXT_PUBLIC_LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `NEXT_PUBLIC_LANGFUSE_BASE_URL`

### 2. Install Dependencies

```bash
npm install
```

### 3. Database Schema

The Supabase schema and seed data are defined in `schema.sql`. Load this into your Supabase project via the SQL editor.

### 4. System Prompt

The Claude system prompt is loaded from `agent_system_prompt.md`. This file contains the reasoning logic and output schema for the fulfillment agent.

## Running Locally

```bash
npm run dev
```

Opens at `http://localhost:3000`

## API Endpoint

### POST `/api/scenario`

Generate fulfillment scenarios for a federal order.

**Request:**
```json
{
  "order_id": "FED-88421",
  "trigger_mode": "manual"
}
```

**Response:**
```json
{
  "order_id": "FED-88421",
  "risk_assessment": {
    "risk_score": "critical",
    "risk_reason": "..."
  },
  "scenarios": [
    {
      "rank": 1,
      "levers_used": ["direct_ship", "commitment_rebalancing"],
      "plan_summary": "...",
      "steps": [
        {
          "action": "direct_ship",
          "cm_id": "CM1",
          "qty": 180,
          "note": "..."
        }
      ],
      "total_qty_fulfilled": 420,
      "cost_impact_usd": 12000,
      "feasibility": "full",
      "compliance_status": "TAA compliant",
      "trade_off_note": "..."
    }
  ],
  "recommendation": "...",
  "units_unresolvable": 0
}
```

## Server-Side Validators

All Claude responses are validated before writing to Supabase:

1. **Schema Validation** — Ensures JSON matches fulfillmentResult structure
2. **Compliance Validation** — Verifies TAA/ITAR constraints are met
3. **Hallucination Detection** — Checks that proposed inventory exists in context
4. **Quantity Assertion** — Ensures `feasibility=full` implies `total_qty_fulfilled = qty_required`

Validation failures trigger one automatic retry. Persistent failures are logged as P0 events.

## Langfuse Integration

Every scenario run is traced in Langfuse with:

- **Spans:** Context assembly, Claude call, validation, Supabase write
- **Scores:** compliance_pass, qty_assertion_pass, hallucination_pass, schema_valid, latency_within_sla
- **Tags:** order_id, trigger_mode, risk_score, levers_used, feasibility, compliance_rule
- **Events:** Failure modes (compliance_violation, hallucinated_inventory, etc.)

Traces link scenario results to reasoning for audit and evaluation.

## Test Cases

Five named seed orders in the database for evaluation:

| ID | Order | SKU | Qty | SLA | Compliance | Expected Levers |
|----|-------|-----|-----|-----|------------|-----------------|
| T1 | FED-90012 | NET-900 | 300 | July 18 | TAA | direct_ship only |
| T2 | FED-88421 | RTR-4500 | 600 | July 14 | TAA | direct_ship + commitment_rebalancing + multi_stage |
| T3 | FED-91005 | SRV-2200 | 450 | July 20 | ITAR | direct_ship + cross_cm_transfer |
| T4 | FED-92001 | RTR-4500 | 400 | July 16 | TAA | (none — qa_hold blocks all) |
| T5 | FED-92002 | NET-900 | 250 | July 19 | TAA | (none — only CM3 non-compliant) |

## Project Structure

```
├── app/
│   ├── api/scenario/route.ts    — Main API endpoint
│   ├── layout.tsx               — Root layout
│   ├── page.tsx                 — Dashboard UI
│   └── globals.css              — Global styles
├── lib/
│   ├── supabase.ts              — Supabase client & queries
│   ├── validators.ts            — Response validation
│   ├── langfuse.ts              — Tracing & scoring
│   └── types.ts                 — TypeScript interfaces
├── schema.sql                   — Database schema & seed
├── agent_system_prompt.md       — Claude system prompt
├── .env.local.example           — Environment template
└── package.json
```

## Quality Criteria

All tests must pass before demo:

- ✅ **Compliance constraint** — 100% zero violations
- ✅ **Federal priority satisfaction** — Full scenarios match qty exactly
- ✅ **Hallucinated inventory** — 0% hallucinations
- ✅ **Schema validity** — 100% valid JSON responses
- ✅ **Seed order lever accuracy** — 5/5 orders return expected levers

## Failure Modes & Escalation

| Failure | Trigger | User Experience | Escalation |
|---------|---------|-----------------|------------|
| Compliance violated | Non-compliant CM proposed | Scenario hidden from UI | Retry once; if persists, return 500 |
| Hallucinated inventory | CM or qty not in context | Scenario hidden from UI | Retry once; if persists, disable agent |
| Qty assertion failed | `feasibility=full` but qty < required | Scenario hidden from UI | Retry once; if persists, return 500 |
| No inventory | SKU has zero inventory | Red banner with AI recommendation | No retry; return result with scenarios=[] |
| Claude API error | Timeout or rate limit | Spinner waits; after timeout shows retry button | Retry once; if persists, return 503 |

## Next Steps

- [ ] Set up Langfuse project & get API keys
- [ ] Configure environment variables
- [ ] Test API endpoint with seed orders
- [ ] Run eval suite on all test cases
- [ ] Deploy to Vercel
