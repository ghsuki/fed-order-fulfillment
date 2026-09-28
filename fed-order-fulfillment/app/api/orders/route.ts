import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabase();
    const url = new URL(request.url);
    const segmentFilter = url.searchParams.get('segment'); // Optional filter

    let query = (supabase as any)
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });

    // Apply segment filter if provided
    if (segmentFilter && ['federal', 'commercial', 'distributor', 'd2c'].includes(segmentFilter)) {
      query = query.eq('segment', segmentFilter);
    }

    const { data, error } = await query;

    // Add SKU names to response
    const skuNames: Record<string, string> = {
      'RTR-4500': 'Router RTR-4500',
      'NET-900': 'Network Module NET-900',
      'SRV-2200': 'Server SRV-2200',
    };

    if (data) {
      const enrichedData = data.map((order: any) => ({
        ...order,
        sku_name: skuNames[order.sku] || order.sku,
      }));
      return NextResponse.json(enrichedData);
    }

    if (error) {
      console.error('Error fetching orders:', error);
      return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Orders API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
