-- Multi-CM Order Fulfillment Control Tower — Supabase Schema
-- Version: 2.1  (mirrors agent_system_prompt.md v2.1.0 — Multi-Segment Order
--                Fulfillment Agent: federal / commercial / distributor / d2c)
--
-- Renamed / restructured from v1.0 (federal-only):
--   federal_orders    -> orders              (+ segment, compliance_requirements[], region)
--   committed_orders  -> competing_orders     (+ segment, region; priority_tier now INTEGER 1-4)
--   taa_compliant (bool) on cm tables -> compliance_frameworks_met (TEXT[]) — segment-agnostic
--   NEW: segment_policies                    — DB mirror of the prompt's Policy Table
--   NEW: scenario_disruptions                — auditable per-order disruption trail (Hard Constraint 4/6)

-- ============================================================================
-- TABLE: segment_policies
-- Single source of truth for priority tier, compliance framework, SLA driver
-- and cost-of-failure language per segment — "one engine, four rule books".
-- orders.priority_tier and competing_orders.priority_tier are synced from
-- this table via trigger (see below), never set independently.
-- ============================================================================
CREATE TABLE IF NOT EXISTS segment_policies (
  segment TEXT PRIMARY KEY CHECK (segment IN ('federal', 'commercial', 'distributor', 'd2c')),
  priority_tier INTEGER NOT NULL UNIQUE CHECK (priority_tier BETWEEN 1 AND 4),
  priority_handling TEXT NOT NULL,
  compliance_framework TEXT NOT NULL,
  primary_sla_driver TEXT NOT NULL,
  cost_of_failure TEXT NOT NULL
);

INSERT INTO segment_policies (segment, priority_tier, priority_handling, compliance_framework, primary_sla_driver, cost_of_failure) VALUES
  ('federal',     1, 'Priority #1 — auto-escalate',   'TAA/ITAR, DFARS',                     'Contract delivery dates',                 'Contract penalties, debarment risk'),
  ('commercial',  2, 'Tiered by contract value',       'Customer quality agreements',         'Negotiated ship dates & quality agreements', 'Chargebacks, relationship damage'),
  ('distributor', 3, 'Pooled allocation by region',    'INCOTERMS, distributor agreements',   'PO fill rate & INCOTERMS',                'Fill-rate penalties, reorder loss'),
  ('d2c',         4, 'Dynamic, demand-triggered',       'Consumer protection, marketplace SLAs', 'Promised ship date at checkout',        'Refunds, reviews, churn')
ON CONFLICT (segment) DO UPDATE SET
  priority_tier = EXCLUDED.priority_tier,
  priority_handling = EXCLUDED.priority_handling,
  compliance_framework = EXCLUDED.compliance_framework,
  primary_sla_driver = EXCLUDED.primary_sla_driver,
  cost_of_failure = EXCLUDED.cost_of_failure;

-- ============================================================================
-- TABLE: contract_manufacturers
-- ============================================================================
CREATE TABLE IF NOT EXISTS contract_manufacturers (
  cm_id TEXT PRIMARY KEY,
  cm_name TEXT NOT NULL,
  country TEXT NOT NULL,
  compliance_frameworks_met TEXT[] NOT NULL DEFAULT '{}',
  capacity_units INTEGER NOT NULL DEFAULT 10000,
  lead_time_days INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- TABLE: orders
-- Replaces federal_orders. Any segment's order lands here; priority_tier is
-- always derived from segment_policies (see sync_priority_tier trigger) —
-- never inferred from order size, revenue, or urgency language.
-- ============================================================================
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  segment TEXT NOT NULL REFERENCES segment_policies(segment),
  priority_tier INTEGER, -- auto-synced from segment_policies; do not set manually
  sku TEXT NOT NULL,
  sku_name TEXT,
  qty_required INTEGER NOT NULL CHECK (qty_required > 0),
  required_ship_date DATE NOT NULL,
  compliance_requirements TEXT[] NOT NULL DEFAULT '{}',
  contract_value_usd INTEGER CHECK (contract_value_usd IS NULL OR contract_value_usd >= 0),
  region TEXT, -- populated for distributor orders; drives regional pooling (Hard Constraint 7)
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'at_risk', 'fulfilled', 'rejected')),
  risk_score TEXT CHECK (risk_score IS NULL OR risk_score IN ('low', 'medium', 'high', 'critical')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- TABLE: cm_inventory
-- taa_compliant (bool) -> compliance_frameworks_met (TEXT[]), since only
-- federal orders need TAA/ITAR; other segments check their own framework
-- (or an empty compliance_requirements array, satisfied by any stock).
-- ============================================================================
CREATE TABLE IF NOT EXISTS cm_inventory (
  inventory_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cm_id TEXT NOT NULL REFERENCES contract_manufacturers(cm_id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  stock_type TEXT NOT NULL CHECK (stock_type IN ('FG', 'WIP', 'RM')),
  qty_available INTEGER NOT NULL CHECK (qty_available >= 0),
  compliance_frameworks_met TEXT[], -- row-level override; NULL falls back to the CM's default in v_cm_inventory_context
  hold_status TEXT NOT NULL DEFAULT 'available' CHECK (hold_status IN ('available', 'qa_hold', 'committed')),
  lead_time_days INTEGER, -- row-level override; NULL falls back to the CM's default in v_cm_inventory_context
  est_completion_date DATE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- TABLE: competing_orders
-- Replaces committed_orders. Holds every order from ANY segment currently
-- holding stock at any CM, so a distributor or D2C order's context can
-- surface a commercial or federal order competing for the same SKU, not
-- just a peer in its own segment. region drives distributor pooling
-- (Hard Constraint 7 / Lever 3 in the agent prompt).
-- ============================================================================
CREATE TABLE IF NOT EXISTS competing_orders (
  commit_id TEXT PRIMARY KEY,
  cm_id TEXT NOT NULL REFERENCES contract_manufacturers(cm_id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  segment TEXT NOT NULL REFERENCES segment_policies(segment),
  priority_tier INTEGER, -- auto-synced from segment_policies; do not set manually
  region TEXT, -- populated for distributor commitments
  committed_qty INTEGER NOT NULL CHECK (committed_qty > 0),
  promised_date DATE NOT NULL,
  contract_value_usd INTEGER CHECK (contract_value_usd IS NULL OR contract_value_usd >= 0),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- TRIGGER: keep priority_tier locked to segment_policies on orders & competing_orders
-- Enforces "never infer priority ... always look it up by segment" at the DB layer.
-- ============================================================================
CREATE OR REPLACE FUNCTION sync_priority_tier() RETURNS TRIGGER AS $$
BEGIN
  SELECT priority_tier INTO NEW.priority_tier
  FROM segment_policies
  WHERE segment = NEW.segment;

  IF NEW.priority_tier IS NULL THEN
    RAISE EXCEPTION 'Unrecognized segment "%": no matching row in segment_policies', NEW.segment;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_sync_priority_tier ON orders;
CREATE TRIGGER trg_orders_sync_priority_tier
  BEFORE INSERT OR UPDATE OF segment ON orders
  FOR EACH ROW EXECUTE FUNCTION sync_priority_tier();

DROP TRIGGER IF EXISTS trg_competing_orders_sync_priority_tier ON competing_orders;
CREATE TRIGGER trg_competing_orders_sync_priority_tier
  BEFORE INSERT OR UPDATE OF segment ON competing_orders
  FOR EACH ROW EXECUTE FUNCTION sync_priority_tier();

-- ============================================================================
-- TABLE: fulfillment_scenarios
-- ============================================================================
CREATE TABLE IF NOT EXISTS fulfillment_scenarios (
  scenario_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  segment TEXT NOT NULL REFERENCES segment_policies(segment),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
  levers_used TEXT[] NOT NULL,
  plan_summary TEXT NOT NULL,
  steps JSONB NOT NULL,
  total_qty_fulfilled INTEGER NOT NULL CHECK (total_qty_fulfilled >= 0),
  cost_impact_usd INTEGER CHECK (cost_impact_usd IS NULL OR cost_impact_usd >= 0),
  feasibility TEXT NOT NULL CHECK (feasibility IN ('full', 'partial')),
  compliance_status TEXT NOT NULL,
  trade_off_note TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  langfuse_trace_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- TABLE: scenario_disruptions
-- One row per competing_order touched by a scenario (Lever 3 rebalancing or
-- Lever 5 re-prioritization). Operationalizes Hard Constraints 4 and 6:
-- every cross-segment disruption is named, and its cost-of-failure is
-- recorded in the disrupted order's own segment language, not a generic
-- number — "every decision audit-traced".
-- ============================================================================
CREATE TABLE IF NOT EXISTS scenario_disruptions (
  disruption_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES fulfillment_scenarios(scenario_id) ON DELETE CASCADE,
  commit_id TEXT NOT NULL REFERENCES competing_orders(commit_id) ON DELETE CASCADE,
  disrupted_segment TEXT NOT NULL REFERENCES segment_policies(segment),
  disrupted_priority_tier INTEGER NOT NULL,
  disrupted_region TEXT,
  qty_reallocated INTEGER NOT NULL CHECK (qty_reallocated > 0),
  disruption_impact TEXT NOT NULL, -- phrased in the disrupted segment's cost_of_failure terms
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- VIEW: v_cm_inventory_context
-- Assembles cm_inventory rows exactly as the agent's JSON context expects
-- them (each row carries its own lead_time_days, falling back to the CM's
-- default when no row-level override is set).
-- ============================================================================
CREATE OR REPLACE VIEW v_cm_inventory_context AS
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

-- ============================================================================
-- INDEXES for query performance
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_orders_sku ON orders(sku);
CREATE INDEX IF NOT EXISTS idx_orders_segment ON orders(segment);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_risk_score ON orders(risk_score);
CREATE INDEX IF NOT EXISTS idx_orders_region ON orders(region);

CREATE INDEX IF NOT EXISTS idx_cm_inventory_cm_id_sku ON cm_inventory(cm_id, sku);
CREATE INDEX IF NOT EXISTS idx_cm_inventory_sku ON cm_inventory(sku);
CREATE INDEX IF NOT EXISTS idx_cm_inventory_updated_at ON cm_inventory(updated_at);

CREATE INDEX IF NOT EXISTS idx_competing_orders_cm_id_sku ON competing_orders(cm_id, sku);
CREATE INDEX IF NOT EXISTS idx_competing_orders_segment ON competing_orders(segment);
CREATE INDEX IF NOT EXISTS idx_competing_orders_region ON competing_orders(region);
CREATE INDEX IF NOT EXISTS idx_competing_orders_priority_tier ON competing_orders(priority_tier);

CREATE INDEX IF NOT EXISTS idx_fulfillment_scenarios_order_id ON fulfillment_scenarios(order_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_scenarios_segment ON fulfillment_scenarios(segment);
CREATE INDEX IF NOT EXISTS idx_fulfillment_scenarios_status ON fulfillment_scenarios(status);

CREATE INDEX IF NOT EXISTS idx_scenario_disruptions_scenario_id ON scenario_disruptions(scenario_id);
CREATE INDEX IF NOT EXISTS idx_scenario_disruptions_commit_id ON scenario_disruptions(commit_id);

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- Contract Manufacturers (compliance_frameworks_met replaces taa_compliant bool)
INSERT INTO contract_manufacturers (cm_id, cm_name, country, compliance_frameworks_met, lead_time_days) VALUES
  ('CM1', 'Vietnam Manufacturing Co.', 'Vietnam', ARRAY['TAA', 'ITAR'], 4),
  ('CM2', 'Mexico Operations Ltd.',    'Mexico',  ARRAY['TAA', 'ITAR'], 5),
  ('CM3', 'China Assembly Inc.',       'China',   ARRAY[]::TEXT[],      3)
ON CONFLICT (cm_id) DO NOTHING;

-- Orders — original 5 federal test cases, unchanged in substance, now typed
-- as segment='federal' with compliance_requirements[] instead of a single
-- compliance_rule column.
INSERT INTO orders (order_id, segment, sku, qty_required, required_ship_date, compliance_requirements, status) VALUES
  ('FED-88421', 'federal', 'RTR-4500', 600, '2026-07-14', ARRAY['TAA'],  'open'),
  ('FED-90012', 'federal', 'NET-900',  300, '2026-07-18', ARRAY['TAA'],  'open'),
  ('FED-91005', 'federal', 'SRV-2200', 450, '2026-07-20', ARRAY['ITAR'], 'open'),
  ('FED-92001', 'federal', 'RTR-4500', 400, '2026-07-16', ARRAY['TAA'],  'open'),
  ('FED-92002', 'federal', 'NET-900',  250, '2026-07-19', ARRAY['TAA'],  'open')
ON CONFLICT (order_id) DO NOTHING;

-- Orders — new commercial / distributor / D2C test cases, demonstrating the
-- broadened segment coverage from agent_system_prompt.md v2.1.0.
INSERT INTO orders (order_id, segment, sku, qty_required, required_ship_date, compliance_requirements, contract_value_usd, region, status) VALUES
  ('COM-10001',  'commercial',  'RTR-4500', 200, '2026-07-17', ARRAY[]::TEXT[], 220000, NULL,    'open'),
  ('DIST-20001', 'distributor', 'RTR-4500', 150, '2026-07-15', ARRAY[]::TEXT[], NULL,    'LATAM', 'open'),
  ('D2C-30001',  'd2c',         'NET-900',  60,  '2026-07-12', ARRAY[]::TEXT[], NULL,    NULL,    'open')
ON CONFLICT (order_id) DO NOTHING;

-- Inventory for FED-88421 / FED-92001 / COM-10001 / DIST-20001 (RTR-4500)
-- 180 FG at CM1 (TAA/ITAR, available)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, compliance_frameworks_met, hold_status) VALUES
  ('CM1', 'RTR-4500', 'FG', 180, ARRAY['TAA', 'ITAR'], 'available')
ON CONFLICT DO NOTHING;

-- 200 WIP at CM1 (TAA/ITAR, est_completion July 12)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, compliance_frameworks_met, hold_status, est_completion_date) VALUES
  ('CM1', 'RTR-4500', 'WIP', 200, ARRAY['TAA', 'ITAR'], 'available', '2026-07-12')
ON CONFLICT DO NOTHING;

-- 240 FG at CM2 (TAA/ITAR, committed — see COMM-88421-CM2 below, segment=commercial)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, compliance_frameworks_met, hold_status) VALUES
  ('CM2', 'RTR-4500', 'FG', 240, ARRAY['TAA', 'ITAR'], 'committed')
ON CONFLICT DO NOTHING;

-- 500 FG at CM3 (no compliance frameworks met, available)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, compliance_frameworks_met, hold_status) VALUES
  ('CM3', 'RTR-4500', 'FG', 500, ARRAY[]::TEXT[], 'available')
ON CONFLICT DO NOTHING;

-- 150 FG at CM3 (no compliance frameworks met, committed — see DIST-LATAM-CM3 below,
-- segment=distributor, region=LATAM — mirrors the worked example in agent_system_prompt.md)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, compliance_frameworks_met, hold_status) VALUES
  ('CM3', 'RTR-4500', 'FG', 150, ARRAY[]::TEXT[], 'committed')
ON CONFLICT DO NOTHING;

-- Inventory for FED-90012 / D2C-30001 (NET-900)
-- 300 FG at CM2 (TAA/ITAR, available)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, compliance_frameworks_met, hold_status) VALUES
  ('CM2', 'NET-900', 'FG', 300, ARRAY['TAA', 'ITAR'], 'available')
ON CONFLICT DO NOTHING;

-- Inventory for FED-91005 (SRV-2200)
-- 150 FG at CM1 (ITAR, available)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, compliance_frameworks_met, hold_status) VALUES
  ('CM1', 'SRV-2200', 'FG', 150, ARRAY['TAA', 'ITAR'], 'available')
ON CONFLICT DO NOTHING;

-- 300 FG at CM2 (ITAR, available, lead_time_days = 5, transfer ETA July 15 < SLA July 20)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, compliance_frameworks_met, hold_status) VALUES
  ('CM2', 'SRV-2200', 'FG', 300, ARRAY['TAA', 'ITAR'], 'available')
ON CONFLICT DO NOTHING;

-- Inventory for FED-92001 (RTR-4500)
-- 400 FG at CM1 (TAA/ITAR, qa_hold)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, compliance_frameworks_met, hold_status) VALUES
  ('CM1', 'RTR-4500', 'FG', 400, ARRAY['TAA', 'ITAR'], 'qa_hold')
ON CONFLICT DO NOTHING;

-- Inventory for FED-92002 (NET-900)
-- 250 FG at CM3 only (no compliance frameworks met, available)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, compliance_frameworks_met, hold_status) VALUES
  ('CM3', 'NET-900', 'FG', 250, ARRAY[]::TEXT[], 'available')
ON CONFLICT DO NOTHING;

-- Competing Orders (priority_tier is auto-synced from segment_policies by trigger)

-- Commercial commitment at CM2, associated with FED-88421's RTR-4500 inventory
INSERT INTO competing_orders (commit_id, cm_id, sku, segment, committed_qty, promised_date, contract_value_usd) VALUES
  ('COMM-88421-CM2', 'CM2', 'RTR-4500', 'commercial', 240, '2026-07-10', 180000)
ON CONFLICT (commit_id) DO NOTHING;

-- Distributor commitment at CM3, region LATAM — mirrors the worked
-- regional-pooling example in agent_system_prompt.md's context sample.
INSERT INTO competing_orders (commit_id, cm_id, sku, segment, region, committed_qty, promised_date) VALUES
  ('DIST-LATAM-CM3', 'CM3', 'RTR-4500', 'distributor', 'LATAM', 150, '2026-07-11')
ON CONFLICT (commit_id) DO NOTHING;
