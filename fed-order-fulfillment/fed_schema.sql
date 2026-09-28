-- Federal Order Fulfillment Control Tower — Supabase Schema
-- Version: 1.0

-- ============================================================================
-- TABLE: contract_manufacturers
-- ============================================================================
CREATE TABLE IF NOT EXISTS contract_manufacturers (
  cm_id TEXT PRIMARY KEY,
  cm_name TEXT NOT NULL,
  country TEXT NOT NULL,
  taa_compliant BOOLEAN NOT NULL,
  capacity_units INTEGER NOT NULL DEFAULT 10000,
  lead_time_days INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- TABLE: federal_orders
-- ============================================================================
CREATE TABLE IF NOT EXISTS federal_orders (
  order_id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  sku_name TEXT,
  qty_required INTEGER NOT NULL CHECK (qty_required > 0),
  required_ship_date DATE NOT NULL,
  compliance_rule TEXT NOT NULL CHECK (compliance_rule IN ('TAA', 'ITAR', 'NONE')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'at_risk', 'fulfilled', 'rejected')),
  risk_score TEXT CHECK (risk_score IS NULL OR risk_score IN ('low', 'medium', 'high', 'critical')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- TABLE: cm_inventory
-- ============================================================================
CREATE TABLE IF NOT EXISTS cm_inventory (
  inventory_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cm_id TEXT NOT NULL REFERENCES contract_manufacturers(cm_id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  stock_type TEXT NOT NULL CHECK (stock_type IN ('FG', 'WIP', 'RM')),
  qty_available INTEGER NOT NULL CHECK (qty_available >= 0),
  taa_compliant BOOLEAN NOT NULL,
  hold_status TEXT NOT NULL DEFAULT 'available' CHECK (hold_status IN ('available', 'qa_hold', 'committed')),
  est_completion_date DATE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- TABLE: committed_orders
-- ============================================================================
CREATE TABLE IF NOT EXISTS committed_orders (
  commit_id TEXT PRIMARY KEY,
  cm_id TEXT NOT NULL REFERENCES contract_manufacturers(cm_id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  committed_qty INTEGER NOT NULL CHECK (committed_qty > 0),
  promised_date DATE NOT NULL,
  priority_tier TEXT NOT NULL CHECK (priority_tier IN ('commercial', 'federal')),
  revenue_impact_usd INTEGER NOT NULL CHECK (revenue_impact_usd >= 0),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- TABLE: fulfillment_scenarios
-- ============================================================================
CREATE TABLE IF NOT EXISTS fulfillment_scenarios (
  scenario_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT NOT NULL REFERENCES federal_orders(order_id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
  levers_used TEXT[] NOT NULL,
  plan_summary TEXT NOT NULL,
  steps JSONB NOT NULL,
  total_qty_fulfilled INTEGER NOT NULL CHECK (total_qty_fulfilled >= 0),
  cost_impact_usd INTEGER NOT NULL CHECK (cost_impact_usd >= 0),
  feasibility TEXT NOT NULL CHECK (feasibility IN ('full', 'partial')),
  compliance_status TEXT NOT NULL,
  trade_off_note TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  langfuse_trace_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INDEXES for query performance
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_federal_orders_sku ON federal_orders(sku);
CREATE INDEX IF NOT EXISTS idx_federal_orders_status ON federal_orders(status);
CREATE INDEX IF NOT EXISTS idx_federal_orders_risk_score ON federal_orders(risk_score);
CREATE INDEX IF NOT EXISTS idx_cm_inventory_cm_id_sku ON cm_inventory(cm_id, sku);
CREATE INDEX IF NOT EXISTS idx_cm_inventory_sku ON cm_inventory(sku);
CREATE INDEX IF NOT EXISTS idx_cm_inventory_updated_at ON cm_inventory(updated_at);
CREATE INDEX IF NOT EXISTS idx_committed_orders_cm_id_sku ON committed_orders(cm_id, sku);
CREATE INDEX IF NOT EXISTS idx_fulfillment_scenarios_order_id ON fulfillment_scenarios(order_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_scenarios_status ON fulfillment_scenarios(status);

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- Contract Manufacturers
INSERT INTO contract_manufacturers (cm_id, cm_name, country, taa_compliant, lead_time_days) VALUES
  ('CM1', 'Vietnam Manufacturing Co.', 'Vietnam', true, 4),
  ('CM2', 'Mexico Operations Ltd.', 'Mexico', true, 5),
  ('CM3', 'China Assembly Inc.', 'China', false, 3)
ON CONFLICT (cm_id) DO NOTHING;

-- Federal Orders (5 named test cases)
INSERT INTO federal_orders (order_id, sku, qty_required, required_ship_date, compliance_rule, status) VALUES
  ('FED-88421', 'RTR-4500', 600, '2026-07-14', 'TAA', 'open'),
  ('FED-90012', 'NET-900', 300, '2026-07-18', 'TAA', 'open'),
  ('FED-91005', 'SRV-2200', 450, '2026-07-20', 'ITAR', 'open'),
  ('FED-92001', 'RTR-4500', 400, '2026-07-16', 'TAA', 'open'),
  ('FED-92002', 'NET-900', 250, '2026-07-19', 'TAA', 'open')
ON CONFLICT (order_id) DO NOTHING;

-- Inventory for FED-88421 (RTR-4500)
-- 180 FG at CM1 (TAA ✓, available)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, taa_compliant, hold_status) VALUES
  ('CM1', 'RTR-4500', 'FG', 180, true, 'available')
ON CONFLICT DO NOTHING;

-- 200 WIP at CM1 (TAA ✓, est_completion July 12)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, taa_compliant, hold_status, est_completion_date) VALUES
  ('CM1', 'RTR-4500', 'WIP', 200, true, 'available', '2026-07-12')
ON CONFLICT DO NOTHING;

-- 240 FG at CM2 (TAA ✓, committed/commercial)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, taa_compliant, hold_status) VALUES
  ('CM2', 'RTR-4500', 'FG', 240, true, 'committed')
ON CONFLICT DO NOTHING;

-- 500 FG at CM3 (TAA ✗, available)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, taa_compliant, hold_status) VALUES
  ('CM3', 'RTR-4500', 'FG', 500, false, 'available')
ON CONFLICT DO NOTHING;

-- Inventory for FED-90012 (NET-900)
-- 300 FG at CM2 (TAA ✓, available)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, taa_compliant, hold_status) VALUES
  ('CM2', 'NET-900', 'FG', 300, true, 'available')
ON CONFLICT DO NOTHING;

-- Inventory for FED-91005 (SRV-2200)
-- 150 FG at CM1 (ITAR ✓, available)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, taa_compliant, hold_status) VALUES
  ('CM1', 'SRV-2200', 'FG', 150, true, 'available')
ON CONFLICT DO NOTHING;

-- 300 FG at CM2 (ITAR ✓, available, lead_time_days = 5, transfer ETA July 15 < SLA July 20)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, taa_compliant, hold_status) VALUES
  ('CM2', 'SRV-2200', 'FG', 300, true, 'available')
ON CONFLICT DO NOTHING;

-- Inventory for FED-92001 (RTR-4500)
-- 400 FG at CM1 (TAA ✓, qa_hold)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, taa_compliant, hold_status) VALUES
  ('CM1', 'RTR-4500', 'FG', 400, true, 'qa_hold')
ON CONFLICT DO NOTHING;

-- Inventory for FED-92002 (NET-900)
-- 250 FG at CM3 only (TAA ✗, available)
INSERT INTO cm_inventory (cm_id, sku, stock_type, qty_available, taa_compliant, hold_status) VALUES
  ('CM3', 'NET-900', 'FG', 250, false, 'available')
ON CONFLICT DO NOTHING;

-- Committed Orders (associated with FED-88421 inventory at CM2)
INSERT INTO committed_orders (commit_id, cm_id, sku, committed_qty, promised_date, priority_tier, revenue_impact_usd) VALUES
  ('COMM-88421-CM2', 'CM2', 'RTR-4500', 240, '2026-07-10', 'commercial', 180000)
ON CONFLICT (commit_id) DO NOTHING;
