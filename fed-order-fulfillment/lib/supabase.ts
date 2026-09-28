import { createClient } from '@supabase/supabase-js';
import type { ContextPayload, Order, CMInventory, CompetingOrder, SegmentPolicy, FulfillmentResult, ScenarioDisruption } from './types';

let supabaseClient: ReturnType<typeof createClient> | null = null;

export function getSupabase() {
  if (!supabaseClient) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      throw new Error('Missing Supabase credentials in environment');
    }

    supabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey);
  }

  return supabaseClient;
}

// Assemble context payload for Claude from Supabase (v2.1.0 multi-segment)
export async function assembleContextPayload(orderId: string): Promise<ContextPayload | null> {
  const supabase = getSupabase();

  // Fetch order (multi-segment)
  const { data: orderData, error: orderError } = await supabase
    .from('orders')
    .select('*')
    .eq('order_id', orderId)
    .single();

  if (orderError || !orderData) {
    console.error('Order not found:', orderId);
    return null;
  }

  const order = orderData as Order;

  // Fetch segment_policies for this order's segment
  const { data: policyData, error: policyError } = await supabase
    .from('segment_policies')
    .select('*')
    .eq('segment', order.segment)
    .single();

  if (policyError || !policyData) {
    console.error('Segment policy not found for segment:', order.segment);
    return null;
  }

  const segmentPolicy = policyData as SegmentPolicy;

  // Fetch CM inventory for this SKU using v_cm_inventory_context view
  // (coalesces row-level overrides with CM defaults for compliance_frameworks_met and lead_time_days)
  const { data: inventoryData, error: inventoryError } = await supabase
    .from('v_cm_inventory_context')
    .select('*')
    .eq('sku', order.sku);

  if (inventoryError) {
    console.error('Error fetching inventory:', inventoryError);
    return null;
  }

  const cmInventory: CMInventory[] = (inventoryData || []).map((row: any) => ({
    inventory_id: row.inventory_id,
    cm_id: row.cm_id,
    cm_name: row.cm_name || '',
    country: row.country || '',
    compliance_frameworks_met: row.compliance_frameworks_met || [],
    sku: row.sku,
    stock_type: row.stock_type,
    qty_available: row.qty_available,
    hold_status: row.hold_status,
    lead_time_days: row.lead_time_days || 0,
    est_completion_date: row.est_completion_date,
    updated_at: row.updated_at,
  }));

  // Fetch competing_orders for this SKU (any segment, not just federal/commercial)
  const { data: competingData, error: competingError } = await supabase
    .from('competing_orders')
    .select('*')
    .eq('sku', order.sku);

  if (competingError) {
    console.error('Error fetching competing orders:', competingError);
    return null;
  }

  const competingOrders: CompetingOrder[] = (competingData || []) as CompetingOrder[];

  return {
    order: {
      order_id: order.order_id,
      segment: order.segment,
      priority_tier: order.priority_tier || 0,
      sku: order.sku,
      qty_required: order.qty_required,
      required_ship_date: order.required_ship_date,
      compliance_requirements: order.compliance_requirements || [],
      contract_value_usd: order.contract_value_usd,
      region: order.region,
    },
    segment_policy: {
      segment: segmentPolicy.segment,
      priority_tier: segmentPolicy.priority_tier,
      priority_handling: segmentPolicy.priority_handling,
      compliance_framework: segmentPolicy.compliance_framework,
      primary_sla_driver: segmentPolicy.primary_sla_driver,
      cost_of_failure: segmentPolicy.cost_of_failure,
    },
    cm_inventory: cmInventory,
    competing_orders: competingOrders,
  };
}

// Write fulfillment scenario and scenario_disruptions to Supabase
export async function writeFulfillmentScenario(
  orderId: string,
  segment: string,
  scenarioData: any,
  fulfillmentResult: FulfillmentResult,
  langfuseTraceId?: string
) {
  const supabase = getSupabase() as any;

  // Write fulfillment_scenarios
  const { data: scenarioWriteData, error: scenarioError } = await supabase
    .from('fulfillment_scenarios')
    .insert([
      {
        order_id: orderId,
        segment: segment,
        rank: scenarioData.rank,
        levers_used: scenarioData.levers_used,
        plan_summary: scenarioData.plan_summary,
        steps: scenarioData.steps,
        total_qty_fulfilled: scenarioData.total_qty_fulfilled,
        cost_impact_usd: scenarioData.cost_impact_usd,
        feasibility: scenarioData.feasibility,
        compliance_status: scenarioData.compliance_status,
        trade_off_note: scenarioData.trade_off_note || null,
        status: 'proposed',
        langfuse_trace_id: langfuseTraceId,
      },
    ])
    .select();

  if (scenarioError) {
    console.error('Error writing scenario to Supabase:', scenarioError);
    throw scenarioError;
  }

  if (!scenarioWriteData || scenarioWriteData.length === 0) {
    console.error('No scenario data returned from insert');
    throw new Error('Failed to write scenario');
  }

  const scenarioId = scenarioWriteData[0].scenario_id;

  // Write scenario_disruptions for each rebalancing step (Hard Constraint 4: audit trail)
  const disruptions: ScenarioDisruption[] = [];

  for (const step of scenarioData.steps) {
    if (step.action === 'rebalance_commitment') {
      // Fetch the competing order to get its segment, priority_tier, region
      const { data: competingOrderData, error: competingOrderError } = await supabase
        .from('competing_orders')
        .select('*')
        .eq('commit_id', step.commit_id)
        .single();

      if (!competingOrderError && competingOrderData) {
        disruptions.push({
          scenario_id: scenarioId,
          commit_id: step.commit_id,
          disrupted_segment: competingOrderData.segment,
          disrupted_priority_tier: competingOrderData.priority_tier,
          disrupted_region: competingOrderData.region || null,
          qty_reallocated: step.qty,
          disruption_impact: step.disruption_impact || '', // Phrased in disrupted segment's cost-of-failure terms
        });
      }
    }
  }

  // Batch write disruptions if any exist
  if (disruptions.length > 0) {
    const { error: disruptionError } = await supabase.from('scenario_disruptions').insert(disruptions);

    if (disruptionError) {
      console.error('Error writing scenario_disruptions:', disruptionError);
      // Log but don't throw - scenario is already written; disruption audit trail is secondary
    }
  }

  return scenarioWriteData;
}

// Update order risk score (multi-segment)
export async function updateOrderRiskScore(orderId: string, riskScore: string) {
  const supabase = getSupabase() as any;

  const { error } = await supabase
    .from('orders')
    .update({ risk_score: riskScore, updated_at: new Date().toISOString() })
    .eq('order_id', orderId);

  if (error) {
    console.error('Error updating order risk score:', error);
    throw error;
  }
}
