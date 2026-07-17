// Supabase types
export interface ContractManufacturer {
  cm_id: string;
  cm_name: string;
  country: string;
  taa_compliant: boolean;
  capacity_units: number;
  lead_time_days: number;
}

export interface CMInventory {
  inventory_id: string;
  cm_id: string;
  cm_name: string;
  country: string;
  taa_compliant: boolean;
  sku: string;
  stock_type: 'FG' | 'WIP' | 'RM';
  qty_available: number;
  hold_status: 'available' | 'qa_hold' | 'committed';
  lead_time_days: number;
  est_completion_date: string | null;
}

export interface CommittedOrder {
  commit_id: string;
  cm_id: string;
  sku: string;
  committed_qty: number;
  promised_date: string;
  priority_tier: 'commercial' | 'federal';
  revenue_impact_usd: number;
}

export interface FederalOrder {
  order_id: string;
  sku: string;
  qty_required: number;
  required_ship_date: string;
  compliance_rule: 'TAA' | 'ITAR' | 'NONE';
  status: 'open' | 'at_risk' | 'fulfilled' | 'rejected';
  risk_score?: string;
  created_at: string;
}

// Context payload (assembled server-side)
export interface ContextPayload {
  federal_order: {
    order_id: string;
    sku: string;
    qty_required: number;
    required_ship_date: string;
    compliance_rule: 'TAA' | 'ITAR' | 'NONE';
  };
  cm_inventory: CMInventory[];
  committed_orders: CommittedOrder[];
}

// Agent output
export interface FulfillmentStep {
  action: string;
  cm_id: string;
  qty: number;
  commit_id?: string;
  note: string;
  disruption_impact?: string | null;
}

export interface FulfillmentScenario {
  rank: number;
  levers_used: string[];
  plan_summary: string;
  steps: FulfillmentStep[];
  total_qty_fulfilled: number;
  cost_impact_usd: number;
  feasibility: 'full' | 'partial';
  compliance_status: string;
  trade_off_note?: string | null;
}

export interface FulfillmentResult {
  order_id: string;
  risk_assessment: {
    risk_score: 'critical' | 'high' | 'medium' | 'low';
    risk_reason: string;
  };
  scenarios: FulfillmentScenario[];
  recommendation: string;
  units_unresolvable: number;
}

// Validator results
export interface ValidationError {
  type: 'compliance' | 'hallucination' | 'qty_assertion' | 'schema';
  message: string;
  scenario_rank?: number;
  step_index?: number;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
}

// API request/response
export interface ScenarioRequest {
  order_id: string;
  trigger_mode: 'auto' | 'manual';
}

export interface ScenarioResponse {
  success: boolean;
  data?: FulfillmentResult;
  error?: string;
  status_code?: number;
  message?: string;
}
