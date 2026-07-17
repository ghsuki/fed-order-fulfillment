import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import {
  assembleContextPayload,
  writeFulfillmentScenario,
  updateOrderRiskScore,
  getSupabase,
} from '@/lib/supabase';
import { validateFulfillmentResult } from '@/lib/validators';
import { FulfillmentTracer } from '@/lib/langfuse';
import type { ScenarioRequest, ScenarioResponse, FulfillmentResult, ContextPayload, FederalOrder } from '@/lib/types';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Load system prompt from file
function getSystemPrompt(): string {
  const promptPath = path.join(process.cwd(), 'agent_system_prompt.md');
  try {
    const content = fs.readFileSync(promptPath, 'utf-8');
    if (!content || content.trim().length === 0) {
      throw new Error('System prompt file is empty');
    }
    return content;
  } catch (error) {
    console.error('Failed to load system prompt from', promptPath);
    console.error('Error:', error);
    throw new Error(`Failed to load system prompt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleScenarioRequest(request: NextRequest): Promise<ScenarioResponse> {
  const startTime = Date.now();
  let tracer: FulfillmentTracer | null = null;

  try {
    // Parse request
    const body = (await request.json()) as ScenarioRequest;
    const { order_id: orderId, trigger_mode: triggerMode } = body;

    if (!orderId || !triggerMode) {
      return {
        success: false,
        error: 'Missing required fields: order_id, trigger_mode',
        status_code: 400,
        message: 'Bad Request',
      };
    }

    if (!['auto', 'manual'].includes(triggerMode)) {
      return {
        success: false,
        error: 'Invalid trigger_mode. Must be "auto" or "manual"',
        status_code: 400,
        message: 'Bad Request',
      };
    }

    tracer = new FulfillmentTracer(orderId, triggerMode as 'auto' | 'manual');
    const trace = tracer.createTrace();

    // Verify order exists and is in open or at_risk status
    const supabase = getSupabase();
    const { data: orderData, error: orderError } = await supabase
      .from('federal_orders')
      .select('*')
      .eq('order_id', orderId)
      .single();

    if (orderError || !orderData) {
      tracer.logFailureEvent('order_not_found', {
        order_id: orderId,
        timestamp: new Date().toISOString(),
      });
      return {
        success: false,
        error: 'Order not found. Please check the order ID and try again.',
        status_code: 404,
        message: 'Not Found',
      };
    }

    const federalOrder = orderData as unknown as FederalOrder;

    if (federalOrder.status === 'fulfilled' || federalOrder.status === 'rejected') {
      return {
        success: false,
        error: 'This order has already been processed. Navigate to order history to view its fulfillment record.',
        status_code: 409,
        message: 'Conflict',
      };
    }

    // Assemble context payload
    const contextStart = Date.now();
    const contextPayload = await assembleContextPayload(orderId);

    if (!contextPayload) {
      return {
        success: false,
        error: 'An internal error occurred while preparing order data. Please try again or contact support.',
        status_code: 500,
        message: 'Internal Server Error',
      };
    }

    const contextDuration = Date.now() - contextStart;
    tracer.spanContextAssembly(
      trace,
      contextDuration,
      contextPayload.cm_inventory.length,
      contextPayload.committed_orders.length,
      contextPayload
    );

    // Check if inventory is stale (more than 60 minutes old)
    if (contextPayload.cm_inventory.length > 0) {
      const oldestInventory = contextPayload.cm_inventory.reduce((oldest, current) => {
        const oldestDate = new Date(oldest.est_completion_date || 0);
        const currentDate = new Date(current.est_completion_date || 0);
        return oldestDate < currentDate ? oldest : current;
      });
    }

    // Handle empty inventory for that SKU
    if (contextPayload.cm_inventory.length === 0) {
      const result: FulfillmentResult = {
        order_id: orderId,
        risk_assessment: {
          risk_score: 'critical',
          risk_reason: 'No inventory found across any CM for this SKU.',
        },
        scenarios: [],
        recommendation: 'No inventory available to fulfill order. Contact procurement.',
        units_unresolvable: contextPayload.federal_order.qty_required,
      };

      return {
        success: true,
        data: result,
        message: 'No inventory found across any CM for this SKU.',
      };
    }

    // Get system prompt
    const systemPrompt = getSystemPrompt();
    console.log('System prompt loaded, length:', systemPrompt.length);
    console.log('System prompt (first 200 chars):', systemPrompt.substring(0, 200));

    // Call Claude (with retry logic)
    let claudeResponse: FulfillmentResult | null = null;
    let validationErrors: any[] = [];
    let retryCount = 0;
    const maxRetries = 1;

    while (retryCount <= maxRetries && !claudeResponse) {
      try {
        const claudeStart = Date.now();
        const response = await anthropic.messages.create({
          model: 'claude-opus-4-8',
          max_tokens: 4096,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: JSON.stringify(contextPayload),
            },
          ],
        });

        const claudeDuration = Date.now() - claudeStart;

        // Find the text content in the response (handle thinking/other types)
        let rawContent = response.content.find((c: any) => c.type === 'text');
        if (!rawContent) {
          const types = response.content.map((c: any) => c.type).join(', ');
          throw new Error(`No text content in Claude response. Available types: ${types}`);
        }

        // Parse response (strip markdown code blocks if present)
        let result: FulfillmentResult;
        try {
          const textContent = rawContent as any;
          let jsonText = textContent.text || '';
          console.log('Claude response (first 100 chars):', jsonText.substring(0, 100));

          // Remove markdown code block markers if present
          if (jsonText.includes('```json')) {
            jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
          }
          jsonText = jsonText.trim();

          result = JSON.parse(jsonText);
          console.log('✓ Successfully parsed Claude response');
        } catch (parseError) {
          console.error('Failed to parse Claude response:', parseError);
          const textContent = rawContent as any;
          console.error('Raw response (first 500 chars):', textContent.text?.substring(0, 500));
          throw new Error(`Failed to parse Claude response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        }

        tracer.generationClaudeCall(
          trace,
          systemPrompt,
          contextPayload,
          (rawContent as any).text,
          {
            model: 'claude-sonnet-5',
            tokens_input: response.usage.input_tokens,
            tokens_output: response.usage.output_tokens,
            latency_ms: claudeDuration,
            claude_api_status: 200,
          }
        );

        // Validate result
        const validationResult = validateFulfillmentResult(result, contextPayload);
        tracer.spanValidation(trace, validationResult, result);

        if (!validationResult.isValid) {
          validationErrors = validationResult.allErrors;

          // Log violations
          validationErrors.forEach((err) => {
            tracer!.logFailureEvent(`${err.type}_violation`, {
              order_id: orderId,
              message: err.message,
              scenario_rank: err.scenario_rank,
              step_index: err.step_index,
              timestamp: new Date().toISOString(),
            });
          });

          if (retryCount < maxRetries) {
            console.log(`Validation failed. Retrying (${retryCount + 1}/${maxRetries})...`);
            retryCount++;
            await new Promise((r) => setTimeout(r, 2000)); // Wait 2 seconds before retry
          } else {
            throw new Error(`Validation failed after ${maxRetries} retries: ${validationErrors.map((e) => e.message).join('; ')}`);
          }
        } else {
          claudeResponse = result;
        }
      } catch (error) {
        console.error('Claude API error details:', error);
        if (retryCount < maxRetries) {
          console.log(`Claude call failed. Retrying (${retryCount + 1}/${maxRetries})...`);
          retryCount++;
          await new Promise((r) => setTimeout(r, 3000)); // Wait 3 seconds before retry
        } else {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`Claude API failed after ${maxRetries} retries: ${errorMsg}`);
          tracer.logFailureEvent('claude_api_error', {
            order_id: orderId,
            error: errorMsg,
            timestamp: new Date().toISOString(),
          });

          return {
            success: false,
            error: 'The AI agent returned an unexpected response. Please try again.',
            status_code: 502,
            message: 'Bad Gateway',
          };
        }
      }
    }

    if (!claudeResponse) {
      return {
        success: false,
        error: 'Failed to generate scenarios after retries.',
        status_code: 500,
        message: 'Internal Server Error',
      };
    }

    // Write scenarios to Supabase
    const writeStart = Date.now();
    let writtenCount = 0;

    if (claudeResponse.scenarios.length > 0) {
      for (const scenario of claudeResponse.scenarios) {
        await writeFulfillmentScenario(orderId, scenario, tracer.getTraceId());
        writtenCount++;
      }
    }

    const writeDuration = Date.now() - writeStart;
    tracer.spanSupabaseWrite(trace, writeDuration, writtenCount);

    // Update order risk score
    await updateOrderRiskScore(orderId, claudeResponse.risk_assessment.risk_score);

    // Attach scores and tags
    const latencySecs = (Date.now() - startTime) / 1000;
    tracer.attachScores(trace, {
      compliance_pass: validationErrors.filter((e) => e.type === 'compliance').length === 0 ? 1 : 0,
      qty_assertion_pass: validationErrors.filter((e) => e.type === 'qty_assertion').length === 0 ? 1 : 0,
      hallucination_pass: validationErrors.filter((e) => e.type === 'hallucination').length === 0 ? 1 : 0,
      schema_valid: validationErrors.filter((e) => e.type === 'schema').length === 0 ? 1 : 0,
      latency_within_sla: latencySecs <= 5 ? 1 : 0,
    });

    tracer.attachTags(trace, {
      order_id: orderId,
      trigger_mode: triggerMode as any,
      risk_score: claudeResponse.risk_assessment.risk_score,
      levers_used: claudeResponse.scenarios.flatMap((s) => s.levers_used),
      feasibility: claudeResponse.scenarios.map((s) => s.feasibility).join(','),
      compliance_rule: contextPayload.federal_order.compliance_rule,
    });

    await tracer.flush();

    return {
      success: true,
      data: claudeResponse,
    };
  } catch (error) {
    console.error('Scenario request failed:', error);
    if (tracer) {
      await tracer.flush();
    }

    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: 'An unexpected error occurred. Please try again.',
      status_code: 500,
      message: 'Internal Server Error',
      debug: process.env.NODE_ENV === 'development' ? errorMsg : undefined,
    };
  }
}

export async function POST(request: NextRequest) {
  const result = await handleScenarioRequest(request);

  if (result.success) {
    return NextResponse.json(result.data, { status: 200 });
  }

  return NextResponse.json(
    {
      error: result.error,
      message: result.message,
    },
    { status: result.status_code || 500 }
  );
}
