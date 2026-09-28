'use client';

import { useEffect, useState } from 'react';
import type { Order, FulfillmentResult, Segment } from '@/lib/types';
import { createClient } from '@supabase/supabase-js';

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase credentials');
  }

  return createClient(url, key);
}

function getRiskBadgeColor(riskScore: string | undefined) {
  switch (riskScore) {
    case 'low':
      return 'badge-low';
    case 'medium':
      return 'badge-medium';
    case 'high':
      return 'badge-high';
    case 'critical':
      return 'badge-critical';
    default:
      return 'badge-medium';
  }
}

function getSegmentBadgeColor(segment: Segment): string {
  switch (segment) {
    case 'federal':
      return 'badge-federal';
    case 'commercial':
      return 'badge-commercial';
    case 'distributor':
      return 'badge-distributor';
    case 'd2c':
      return 'badge-d2c';
    default:
      return 'badge-default';
  }
}

function getSegmentLabel(segment: Segment): string {
  const labels: Record<Segment, string> = {
    federal: 'Federal (Tier 1)',
    commercial: 'Commercial (Tier 2)',
    distributor: 'Distributor (Tier 3)',
    d2c: 'D2C (Tier 4)',
  };
  return labels[segment] || segment;
}

function ScenarioModal({ scenario, order, onClose }: { scenario: any; order: any; onClose: () => void }) {
  if (!scenario) return null;

  return (
    <div className="modal open">
      <div className="modal-content">
        <div className="modal-header">
          <span>Scenario {scenario.rank}</span>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="card">
          <div className="card-header">Order Summary</div>
          <table>
            <tbody>
              <tr>
                <td>
                  <strong>Order ID</strong>
                </td>
                <td>{order.order_id}</td>
              </tr>
              <tr>
                <td>
                  <strong>Segment</strong>
                </td>
                <td>
                  <span className={`badge ${getSegmentBadgeColor(order.segment)}`}>
                    {getSegmentLabel(order.segment)}
                  </span>
                </td>
              </tr>
              <tr>
                <td>
                  <strong>Priority Tier</strong>
                </td>
                <td>{order.priority_tier || 'N/A'}</td>
              </tr>
              <tr>
                <td>
                  <strong>SKU</strong>
                </td>
                <td>{order.sku}</td>
              </tr>
              <tr>
                <td>
                  <strong>Required Qty</strong>
                </td>
                <td>{order.qty_required}</td>
              </tr>
              <tr>
                <td>
                  <strong>Required Ship Date</strong>
                </td>
                <td>{order.required_ship_date}</td>
              </tr>
              <tr>
                <td>
                  <strong>Compliance Requirements</strong>
                </td>
                <td>{order.compliance_requirements && order.compliance_requirements.length > 0 ? order.compliance_requirements.join(', ') : '(None)'}</td>
              </tr>
              {order.contract_value_usd && (
                <tr>
                  <td>
                    <strong>Contract Value</strong>
                  </td>
                  <td>${order.contract_value_usd.toLocaleString()}</td>
                </tr>
              )}
              {order.region && (
                <tr>
                  <td>
                    <strong>Region</strong>
                  </td>
                  <td>{order.region}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-header">Scenario Details</div>
          <table>
            <tbody>
              <tr>
                <td>
                  <strong>Levers Used</strong>
                </td>
                <td>{scenario.levers_used.join(', ')}</td>
              </tr>
              <tr>
                <td>
                  <strong>Plan Summary</strong>
                </td>
                <td>{scenario.plan_summary}</td>
              </tr>
              <tr>
                <td>
                  <strong>Total Qty Fulfilled</strong>
                </td>
                <td>{scenario.total_qty_fulfilled}</td>
              </tr>
              <tr>
                <td>
                  <strong>Cost Impact</strong>
                </td>
                <td>${scenario.cost_impact_usd.toLocaleString()}</td>
              </tr>
              <tr>
                <td>
                  <strong>Feasibility</strong>
                </td>
                <td>
                  <span className={`badge ${scenario.feasibility === 'full' ? 'badge-full' : 'badge-partial'}`}>
                    {scenario.feasibility}
                  </span>
                </td>
              </tr>
              <tr>
                <td>
                  <strong>Compliance Status</strong>
                </td>
                <td>{scenario.compliance_status}</td>
              </tr>
              {scenario.trade_off_note && (
                <tr>
                  <td>
                    <strong>Trade-off Note</strong>
                  </td>
                  <td className="alert alert-warning">{scenario.trade_off_note}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-header">Action Steps</div>
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>CM</th>
                <th>Qty</th>
                <th>Note</th>
                {scenario.steps.some((s: any) => s.disruption_impact) && <th>Disruption Impact</th>}
              </tr>
            </thead>
            <tbody>
              {scenario.steps.map((step: any, idx: number) => (
                <tr key={idx}>
                  <td>{step.action}</td>
                  <td>{step.cm_id}</td>
                  <td>{step.qty}</td>
                  <td>{step.note}</td>
                  {scenario.steps.some((s: any) => s.disruption_impact) && (
                    <td>{step.disruption_impact || '—'}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex">
          <button className="btn-success">Approve Scenario</button>
          <button className="btn-danger">Reject Scenario</button>
          <button className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [scenarios, setScenarios] = useState<Map<string, FulfillmentResult>>(new Map());
  const [loading, setLoading] = useState(true);
  const [selectedScenario, setSelectedScenario] = useState<any>(null);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [generatingOrder, setGeneratingOrder] = useState<string | null>(null);

  useEffect(() => {
    fetchOrders();
  }, []);

  async function fetchOrders() {
    setLoading(true);
    try {
      const response = await fetch('/api/orders');
      if (response.ok) {
        const data = await response.json();
        setOrders(data as Order[]);
      } else {
        console.error('Failed to fetch orders:', response.statusText);
      }
    } catch (error) {
      console.error('Failed to fetch orders:', error);
    } finally {
      setLoading(false);
    }
  }

  async function runScenario(order: Order) {
    setGeneratingOrder(order.order_id);
    try {
      const response = await fetch('/api/scenario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_id: order.order_id,
          trigger_mode: 'manual',
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Error: ${error.error || error.message}`);
        return;
      }

      const result: FulfillmentResult = await response.json();
      scenarios.set(order.order_id, result);
      setScenarios(new Map(scenarios));

      if (result.scenarios.length > 0) {
        setSelectedScenario(result.scenarios[0]);
        setSelectedOrder(order);
      } else {
        alert('No fulfillment scenarios available for this order.');
      }
    } catch (error) {
      console.error('Failed to run scenario:', error);
      alert('Failed to generate scenarios. Please try again.');
    } finally {
      setGeneratingOrder(null);
    }
  }

  if (loading) {
    return <div className="text-center mt-4">Loading orders...</div>;
  }

  return (
    <>
      <div className="card">
        <div className="card-header">Multi-Segment Orders</div>
        {orders.length === 0 ? (
          <p className="text-center">No orders found.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Segment</th>
                <th>Tier</th>
                <th>SKU</th>
                <th>SKU Name</th>
                <th>Qty Required</th>
                <th>Required Ship Date</th>
                <th>Status</th>
                <th>Risk Score</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.order_id}>
                  <td>{order.order_id}</td>
                  <td>
                    <span className={`badge ${getSegmentBadgeColor(order.segment)}`}>
                      {order.segment}
                    </span>
                  </td>
                  <td>{order.priority_tier || 'N/A'}</td>
                  <td>{order.sku}</td>
                  <td>{(order as any).sku_name || order.sku}</td>
                  <td>{order.qty_required}</td>
                  <td>{order.required_ship_date}</td>
                  <td>{order.status}</td>
                  <td>
                    {order.risk_score && (
                      <span className={`badge ${getRiskBadgeColor(order.risk_score)}`}>{order.risk_score}</span>
                    )}
                  </td>
                  <td>
                    <button
                      onClick={() => runScenario(order)}
                      disabled={generatingOrder === order.order_id}
                    >
                      {generatingOrder === order.order_id ? (
                        <>
                          <span className="spinner"></span> Running...
                        </>
                      ) : (
                        'Run Scenario'
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedScenario && selectedOrder && (
        <ScenarioModal
          scenario={selectedScenario}
          order={selectedOrder}
          onClose={() => {
            setSelectedScenario(null);
            setSelectedOrder(null);
          }}
        />
      )}
    </>
  );
}
