import { Langfuse } from 'langfuse';
import type { FulfillmentResult, ContextPayload, ValidationError } from './types';

const langfuse = new Langfuse({
  publicKey: process.env.NEXT_PUBLIC_LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.NEXT_PUBLIC_LANGFUSE_BASE_URL,
});

export class FulfillmentTracer {
  private traceId: string;
  private orderId: string;
  private triggerMode: 'auto' | 'manual';

  constructor(orderId: string, triggerMode: 'auto' | 'manual') {
    this.orderId = orderId;
    this.triggerMode = triggerMode;
    this.traceId = `order-${orderId}-${Date.now()}`;
  }

  createTrace() {
    const trace = langfuse.trace({
      id: this.traceId,
      name: 'federal_order_scenario_generation',
      input: {
        order_id: this.orderId,
        trigger_mode: this.triggerMode,
      },
      userId: `order:${this.orderId}`,
      tags: ['federal-fulfillment', 'control-tower', 'poc'],
    });
    return trace;
  }

  spanContextAssembly(trace: any, duration: number, inventoryRowsReturned: number, committedOrdersReturned: number, context: ContextPayload) {
    trace.span({
      name: 'supabase_context_assembly',
      input: {
        order_id: this.orderId,
        trigger_mode: this.triggerMode,
      },
      output: context,
      metadata: {
        query_duration_ms: duration,
        inventory_rows_returned: inventoryRowsReturned,
        committed_orders_returned: committedOrdersReturned,
      },
    });
  }

  generationClaudeCall(
    trace: any,
    systemPrompt: string,
    context: ContextPayload,
    rawResponse: string,
    metadata: {
      model: string;
      tokens_input: number;
      tokens_output: number;
      latency_ms: number;
      claude_api_status: number;
    }
  ) {
    trace.generation({
      name: 'claude_agent_call',
      input: {
        system_prompt: systemPrompt,
        context_payload: context,
      },
      output: rawResponse,
      model: metadata.model,
      usage: {
        input: metadata.tokens_input,
        output: metadata.tokens_output,
      },
      metadata,
    });
  }

  spanValidation(
    trace: any,
    validationResult: { isValid: boolean; allErrors: ValidationError[] },
    result: FulfillmentResult
  ) {
    const violations = validationResult.allErrors.map((err) => ({
      type: err.type,
      message: err.message,
      scenario_rank: err.scenario_rank,
      step_index: err.step_index,
    }));

    trace.span({
      name: 'response_validator',
      input: {
        raw_response: JSON.stringify(result),
      },
      output: {
        validation_result: validationResult.isValid ? 'pass' : 'fail',
        violations,
      },
      metadata: {
        compliance_check_result: !violations.some((v) => v.type === 'compliance'),
        schema_valid: !violations.some((v) => v.type === 'schema'),
        qty_assertion_result: !violations.some((v) => v.type === 'qty_assertion'),
        hallucination_check_result: !violations.some((v) => v.type === 'hallucination'),
      },
    });
  }

  spanSupabaseWrite(trace: any, duration: number, scenariosWrittenCount: number) {
    trace.span({
      name: 'supabase_write',
      input: {
        scenarios_count: scenariosWrittenCount,
      },
      output: {
        scenarios_written_count: scenariosWrittenCount,
        langfuse_trace_id: this.traceId,
      },
      metadata: {
        write_duration_ms: duration,
        scenarios_written_count: scenariosWrittenCount,
      },
    });
  }

  attachScores(
    trace: any,
    scores: {
      tier_ordering_pass: number;
      compliance_pass: number;
      qty_assertion_pass: number;
      disruption_traced: number;
      d2c_constraint_pass: number;
      hallucination_pass: number;
      schema_valid: number;
      latency_within_sla?: number;
    }
  ) {
    trace.score({
      name: 'tier_ordering_pass',
      value: scores.tier_ordering_pass,
    });
    trace.score({
      name: 'compliance_pass',
      value: scores.compliance_pass,
    });
    trace.score({
      name: 'qty_assertion_pass',
      value: scores.qty_assertion_pass,
    });
    trace.score({
      name: 'disruption_traced',
      value: scores.disruption_traced,
    });
    trace.score({
      name: 'd2c_constraint_pass',
      value: scores.d2c_constraint_pass,
    });
    trace.score({
      name: 'hallucination_pass',
      value: scores.hallucination_pass,
    });
    trace.score({
      name: 'schema_valid',
      value: scores.schema_valid,
    });
    if (scores.latency_within_sla !== undefined) {
      trace.score({
        name: 'latency_within_sla',
        value: scores.latency_within_sla,
      });
    }
  }

  attachTags(
    trace: any,
    tags: {
      order_id: string;
      segment: string;
      priority_tier: number;
      trigger_mode: string;
      risk_score: string;
      levers_used: string[];
      feasibility: string;
      compliance_framework: string;
      primary_sla_driver: string;
    }
  ) {
    trace.update({
      tags: [
        ...tags.feasibility.split(',').map((f) => `feasibility:${f.trim()}`),
        `order_id:${tags.order_id}`,
        `segment:${tags.segment}`,
        `priority_tier:${tags.priority_tier}`,
        `trigger_mode:${tags.trigger_mode}`,
        `risk_score:${tags.risk_score}`,
        `compliance_framework:${tags.compliance_framework}`,
        `primary_sla_driver:${tags.primary_sla_driver}`,
        ...tags.levers_used.map((l) => `lever:${l}`),
      ],
    });
  }

  logFailureEvent(eventName: string, fields: Record<string, any>) {
    langfuse.event({
      name: eventName,
      input: fields,
    });
  }

  getTraceId() {
    return this.traceId;
  }

  async flush() {
    await langfuse.flush();
  }
}
