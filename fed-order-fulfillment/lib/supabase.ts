import { createClient } from '@supabase/supabase-js';
import type { ContextPayload, FederalOrder, CMInventory, CommittedOrder } from './types';

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

// Assemble context payload for Claude from Supabase
export async function assembleContextPayload(orderId: string): Promise<ContextPayload | null> {
  const supabase = getSupabase();

  // Fetch federal order
  const { data: orderData, error: orderError } = await supabase
    .from('federal_orders')
    .select('*')
    .eq('order_id', orderId)
    .single();

  if (orderError || !orderData) {
    console.error('Federal order not found:', orderId);
    return null;
  }

  const federalOrder = orderData as FederalOrder;

  // Fetch CM inventory for this SKU
  const { data: inventoryData, error: inventoryError } = await supabase
    .from('cm_inventory')
    .select(
      `
      inventory_id,
      cm_id,
      sku,
      stock_type,
      qty_available,
      taa_compliant,
      hold_status,
      est_completion_date,
      contract_manufacturers (cm_name, country, lead_time_days)
    `
    )
    .eq('sku', federalOrder.sku);

  if (inventoryError) {
    console.error('Error fetching inventory:', inventoryError);
    return null;
  }

  const cmInventory: CMInventory[] = (inventoryData || []).map((row: any) => ({
    inventory_id: row.inventory_id,
    cm_id: row.cm_id,
    cm_name: row.contract_manufacturers?.cm_name || '',
    country: row.contract_manufacturers?.country || '',
    taa_compliant: row.taa_compliant,
    sku: row.sku,
    stock_type: row.stock_type,
    qty_available: row.qty_available,
    hold_status: row.hold_status,
    lead_time_days: row.contract_manufacturers?.lead_time_days || 0,
    est_completion_date: row.est_completion_date,
  }));

  // Fetch committed orders for this SKU
  const { data: committedData, error: committedError } = await supabase
    .from('committed_orders')
    .select('*')
    .eq('sku', federalOrder.sku);

  if (committedError) {
    console.error('Error fetching committed orders:', committedError);
    return null;
  }

  const committedOrders: CommittedOrder[] = (committedData || []) as CommittedOrder[];

  return {
    federal_order: {
      order_id: federalOrder.order_id,
      sku: federalOrder.sku,
      qty_required: federalOrder.qty_required,
      required_ship_date: federalOrder.required_ship_date,
      compliance_rule: federalOrder.compliance_rule,
    },
    cm_inventory: cmInventory,
    committed_orders: committedOrders,
  };
}

// Write fulfillment scenario to Supabase
export async function writeFulfillmentScenario(orderId: string, scenarioData: any, langfuseTraceId?: string) {
  const supabase = getSupabase() as any;

  const { data, error } = await supabase
    .from('fulfillment_scenarios')
    .insert([
      {
        order_id: orderId,
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

  if (error) {
    console.error('Error writing scenario to Supabase:', error);
    throw error;
  }

  return data;
}

// Update federal order risk score
export async function updateOrderRiskScore(orderId: string, riskScore: string) {
  const supabase = getSupabase() as any;

  const { error } = await (supabase as any)
    .from('federal_orders')
    .update({ risk_score: riskScore, updated_at: new Date().toISOString() })
    .eq('order_id', orderId);

  if (error) {
    console.error('Error updating order risk score:', error);
    throw error;
  }
}
