// Segment type
export type Segment = 'federal' | 'commercial' | 'distributor' | 'd2c';

// Supabase types - v2.1.0 Multi-Segment Model
export interface SegmentPolicy {
  segment: Segment;
  priority_tier: number; // 1 (highest) to 4 (lowest)
  priority_handling: string;
  compliance_framework: string;
  primary_sla_driver: string;
  cost_of_failure: string;
}

export interface ContractManufacturer {
  cm_id: string;
  cm_name: string;
  country: string;
  compliance_frameworks_met: string[]; // e.g., ['TAA', 'ITAR'] or []
  capacity_units: number;
  lead_time_days: number;
  created_at?: string;
}

export interface CMInventory {
  inventory_id: string;
  cm_id: string;
  cm_name: string;
  country: string;
  compliance_frameworks_met: string[]; // Coalesced from row-level override or CM default
  sku: string;
  stock_type: 'FG' | 'WIP' | 'RM';
  qty_available: number;
  hold_status: 'available' | 'qa_hold' | 'committed';
  lead_time_days: number; // Coalesced from row-level override or CM default
  est_completion_date: string | null;
  updated_at?: string;
}

export interface CompetingOrder {
  commit_id: string;
  cm_id: string;
  sku: string;
  segment: Segment; // Any segment, not just federal/commercial
  priority_tier: number; // Auto-synced from segment_policies (1–4)
  region?: string | null; // Populated for distributor commitments
  committed_qty: number;
  promised_date: string;
  contract_value_usd?: number | null;
  created_at?: string;
}

export interface Order {
  order_id: string;
  segment: Segment; // federal | commercial | distributor | d2c
  priority_tier?: number; // Auto-synced from segment_policies (1–4)
  sku: string;
  qty_required: number;
  required_ship_date: string;
  compliance_requirements: string[]; // e.g., ['TAA'] for federal, [] for others
  contract_value_usd?: number | null; // Populated for commercial orders
  region?: string | null; // Populated for distributor orders (drives regional pooling)
  status: 'open' | 'at_risk' | 'fulfilled' | 'rejected';
  risk_score?: string;
  created_at?: string;
  updated_at?: string;
}

// Context payload (assembled server-side)
export interface ContextPayload {
  order: {
    order_id: string;
    segment: Segment;
    priority_tier: number; // Auto-synced, 1–4
    sku: string;
    qty_required: number;
    required_ship_date: string;
    compliance_requirements: string[]; // Array-based compliance gate
    contract_value_usd?: number | null;
    region?: string | null; // For distributor
  };
  segment_policy: {
    segment: Segment;
    priority_tier: number;
    priority_handling: string;
    compliance_framework: string;
    primary_sla_driver: string;
    cost_of_failure: string;
  };
  cm_inventory: CMInventory[];
  competing_orders: CompetingOrder[];
}

// Agent output - Fulfillment Step
export interface FulfillmentStep {
  action: string; // direct_ship | transfer | rebalance_commitment
  cm_id: string;
  qty: number;
  commit_id?: string; // For rebalance_commitment steps
  note: string;
  disrupted_segment?: Segment | null; // Only on rebalance steps
  disrupted_priority_tier?: number | null; // Only on rebalance steps
  disrupted_region?: string | null; // Only on rebalance steps (for distributor)
  disruption_impact?: string | null; // Phrased in disrupted segment's cost-of-failure terms
}

export interface FulfillmentScenario {
  rank: number; // 1, 2, or 3
  levers_used: string[];
  plan_summary: string;
  steps: FulfillmentStep[];
  total_qty_fulfilled: number;
  cost_impact_usd?: number | null;
  feasibility: 'full' | 'partial';
  compliance_status: string; // e.g., 'TAA/ITAR compliant' for federal
  trade_off_note?: string | null;
}

export interface FulfillmentResult {
  order_id: string;
  segment: Segment;
  priority_tier: number; // 1–4, auto-synced
  risk_assessment: {
    risk_score: 'critical' | 'high' | 'medium' | 'low';
    risk_reason: string;
  };
  scenarios: FulfillmentScenario[];
  recommendation: string;
  units_unresolvable: number;
}

// Scenario Disruption - Audit trail for cross-segment disruptions
export interface ScenarioDisruption {
  disruption_id?: string;
  scenario_id?: string;
  commit_id: string;
  disrupted_segment: Segment;
  disrupted_priority_tier: number;
  disrupted_region?: string | null;
  qty_reallocated: number;
  disruption_impact: string; // Phrased in disrupted segment's cost-of-failure terms (HC 6)
  created_at?: string;
}

// Validator results
export type ValidationErrorType =
  | 'compliance'
  | 'hallucination'
  | 'qty_assertion'
  | 'schema'
  | 'tier_ordering'      // HC 1: tier ordering non-negotiable
  | 'd2c_constraint'      // HC 1 corollary: D2C never reallocates
  | 'regional_pooling'    // HC 7: distributor regional pooling
  | 'disruption_visibility' // HC 4: disruptions must be tracked
  | 'cost_of_failure_phrasing'; // HC 6: disruption_impact phrased correctly

export interface ValidationError {
  type: ValidationErrorType;
  message: string;
  scenario_rank?: number;
  step_index?: number;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  allErrors?: ValidationError[]; // For retry logic
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
  debug?: string;
}
