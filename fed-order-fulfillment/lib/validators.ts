import type { FulfillmentResult, ContextPayload, ValidationResult, ValidationError, CMInventory } from './types';

// Validate JSON schema of Claude response (multi-segment v2.1.0)
export function validateSchema(data: any): ValidationResult {
  const errors: ValidationError[] = [];

  if (!data || typeof data !== 'object') {
    errors.push({ type: 'schema', message: 'Response is not a valid object' });
    return { isValid: false, errors };
  }

  // Check required top-level fields
  const requiredFields = ['order_id', 'segment', 'priority_tier', 'risk_assessment', 'scenarios', 'recommendation', 'units_unresolvable'];
  for (const field of requiredFields) {
    if (!(field in data)) {
      errors.push({ type: 'schema', message: `Missing required field: ${field}` });
    }
  }

  // Validate segment
  if (data.segment && !['federal', 'commercial', 'distributor', 'd2c'].includes(data.segment)) {
    errors.push({ type: 'schema', message: `Invalid segment: ${data.segment}` });
  }

  // Validate priority_tier
  if (data.priority_tier !== undefined && ![1, 2, 3, 4].includes(data.priority_tier)) {
    errors.push({ type: 'schema', message: `Invalid priority_tier: ${data.priority_tier}. Must be 1-4.` });
  }

  // Validate risk_assessment
  if (data.risk_assessment) {
    if (!['critical', 'high', 'medium', 'low'].includes(data.risk_assessment.risk_score)) {
      errors.push({
        type: 'schema',
        message: `Invalid risk_score: ${data.risk_assessment.risk_score}`,
      });
    }
    if (typeof data.risk_assessment.risk_reason !== 'string') {
      errors.push({ type: 'schema', message: 'risk_reason must be a string' });
    }
  }

  // Validate scenarios array
  if (!Array.isArray(data.scenarios)) {
    errors.push({ type: 'schema', message: 'scenarios must be an array' });
  } else {
    data.scenarios.forEach((scenario: any, index: number) => {
      if (scenario.rank !== undefined && ![1, 2, 3].includes(scenario.rank)) {
        errors.push({
          type: 'schema',
          message: `Scenario ${index}: rank must be 1-3`,
          scenario_rank: scenario.rank,
        });
      }
      if (!Array.isArray(scenario.levers_used)) {
        errors.push({
          type: 'schema',
          message: `Scenario ${index}: levers_used must be an array`,
        });
      }
      if (!Array.isArray(scenario.steps)) {
        errors.push({
          type: 'schema',
          message: `Scenario ${index}: steps must be an array`,
        });
      }
      if (!['full', 'partial'].includes(scenario.feasibility)) {
        errors.push({
          type: 'schema',
          message: `Scenario ${index}: feasibility must be 'full' or 'partial'`,
        });
      }
    });
  }

  return { isValid: errors.length === 0, errors };
}

// Validate compliance constraints (segment-agnostic, not TAA-only) — Hard Constraint 2
export function validateCompliance(result: FulfillmentResult, context: ContextPayload): ValidationResult {
  const errors: ValidationError[] = [];
  const requiredCompliance = context.order.compliance_requirements || [];

  // If no compliance requirements, any stock is acceptable
  if (requiredCompliance.length === 0) {
    return { isValid: true, errors };
  }

  // Build a map of cm_id -> compliance_frameworks_met for quick lookup
  const cmComplianceMap = new Map<string, string[]>();
  context.cm_inventory.forEach((inv) => {
    cmComplianceMap.set(inv.cm_id, inv.compliance_frameworks_met || []);
  });

  result.scenarios.forEach((scenario) => {
    scenario.steps.forEach((step, stepIndex) => {
      const cmFrameworks = cmComplianceMap.get(step.cm_id);

      // If CM not found in inventory, it's a hallucination (caught by another validator)
      if (cmFrameworks === undefined) {
        return;
      }

      // Check: all required frameworks must be present in CM's compliance_frameworks_met
      for (const required of requiredCompliance) {
        if (!cmFrameworks.includes(required)) {
          errors.push({
            type: 'compliance',
            message: `Step ${stepIndex} in scenario ${scenario.rank}: CM ${step.cm_id} missing required compliance framework '${required}'`,
            scenario_rank: scenario.rank,
            step_index: stepIndex,
          });
        }
      }
    });
  });

  return { isValid: errors.length === 0, errors };
}

// Validate tier ordering (Hard Constraint 1: tier ordering is non-negotiable)
export function validateTierOrdering(result: FulfillmentResult, context: ContextPayload): ValidationResult {
  const errors: ValidationError[] = [];
  const orderTier = context.order.priority_tier || 0;

  // Build map of commit_id -> priority_tier
  const competingOrderTierMap = new Map<string, number>();
  context.competing_orders.forEach((co) => {
    competingOrderTierMap.set(co.commit_id, co.priority_tier);
  });

  result.scenarios.forEach((scenario) => {
    scenario.steps.forEach((step, stepIndex) => {
      if (step.action === 'rebalance_commitment' && step.commit_id) {
        const disruptedTier = competingOrderTierMap.get(step.commit_id);

        if (disruptedTier === undefined) {
          // Will be caught by hallucination validator
          return;
        }

        // Check: order.priority_tier must be <= disruptedTier (numerically: lower tier number = higher priority)
        // A lower-numbered (higher priority) order cannot pull from a lower-numbered (higher priority) order
        if (orderTier > disruptedTier) {
          errors.push({
            type: 'tier_ordering',
            message: `Step ${stepIndex} in scenario ${scenario.rank}: Tier ${orderTier} order cannot reallocate from tier ${disruptedTier} order (violates Hard Constraint 1)`,
            scenario_rank: scenario.rank,
            step_index: stepIndex,
          });
        }
      }
    });
  });

  return { isValid: errors.length === 0, errors };
}

// Validate D2C constraint (Hard Constraint 1 corollary: D2C tier 4 never reallocates)
export function validateD2CConstraint(result: FulfillmentResult, context: ContextPayload): ValidationResult {
  const errors: ValidationError[] = [];

  if (context.order.segment === 'd2c') {
    result.scenarios.forEach((scenario) => {
      scenario.steps.forEach((step, stepIndex) => {
        if (step.action === 'rebalance_commitment') {
          errors.push({
            type: 'd2c_constraint',
            message: `Step ${stepIndex} in scenario ${scenario.rank}: D2C orders (tier 4) may never reallocate from competing orders (violates Hard Constraint 1)`,
            scenario_rank: scenario.rank,
            step_index: stepIndex,
          });
        }
      });
    });
  }

  return { isValid: errors.length === 0, errors };
}

// Validate disruption visibility (Hard Constraint 4: cross-segment disruptions must be named)
export function validateDisruptionVisibility(result: FulfillmentResult, context: ContextPayload): ValidationResult {
  const errors: ValidationError[] = [];

  result.scenarios.forEach((scenario) => {
    scenario.steps.forEach((step, stepIndex) => {
      if (step.action === 'rebalance_commitment') {
        // Check: disruption_impact must be present
        if (!step.disruption_impact || step.disruption_impact.trim().length === 0) {
          errors.push({
            type: 'disruption_visibility',
            message: `Step ${stepIndex} in scenario ${scenario.rank}: Rebalance step missing disruption_impact (Hard Constraint 4)`,
            scenario_rank: scenario.rank,
            step_index: stepIndex,
          });
        }

        // Check: disrupted_segment, disrupted_priority_tier must be present
        if (!step.disrupted_segment) {
          errors.push({
            type: 'disruption_visibility',
            message: `Step ${stepIndex} in scenario ${scenario.rank}: Rebalance step missing disrupted_segment (Hard Constraint 4)`,
            scenario_rank: scenario.rank,
            step_index: stepIndex,
          });
        }

        if (step.disrupted_priority_tier === undefined) {
          errors.push({
            type: 'disruption_visibility',
            message: `Step ${stepIndex} in scenario ${scenario.rank}: Rebalance step missing disrupted_priority_tier (Hard Constraint 4)`,
            scenario_rank: scenario.rank,
            step_index: stepIndex,
          });
        }
      }
    });
  });

  return { isValid: errors.length === 0, errors };
}

// Validate hallucinated inventory (zero tolerance)
export function validateHallucination(result: FulfillmentResult, context: ContextPayload): ValidationResult {
  const errors: ValidationError[] = [];

  // Build inventory map: cm_id -> qty_available
  const inventoryMap = new Map<string, number>();
  context.cm_inventory.forEach((inv) => {
    inventoryMap.set(inv.cm_id, inv.qty_available);
  });

  // Also track what we've already allocated to catch over-allocation
  const allocationTracker = new Map<string, number>();

  result.scenarios.forEach((scenario) => {
    allocationTracker.clear();

    scenario.steps.forEach((step, stepIndex) => {
      const availableQty = inventoryMap.get(step.cm_id);

      // CM not in inventory at all = hallucination
      if (availableQty === undefined) {
        errors.push({
          type: 'hallucination',
          message: `Step ${stepIndex} in scenario ${scenario.rank}: CM ${step.cm_id} not found in inventory`,
          scenario_rank: scenario.rank,
          step_index: stepIndex,
        });
        return;
      }

      // Track cumulative allocation per CM within this scenario
      const currentAllocation = allocationTracker.get(step.cm_id) || 0;
      const newAllocation = currentAllocation + step.qty;

      // Exceeds available quantity
      if (newAllocation > availableQty) {
        errors.push({
          type: 'hallucination',
          message: `Step ${stepIndex} in scenario ${scenario.rank}: Proposed qty ${newAllocation} exceeds available ${availableQty} at CM ${step.cm_id}`,
          scenario_rank: scenario.rank,
          step_index: stepIndex,
        });
      }

      allocationTracker.set(step.cm_id, newAllocation);
    });
  });

  return { isValid: errors.length === 0, errors };
}

// Validate quantity assertions (Hard Constraint 3: feasibility = full requires total_qty_fulfilled = qty_required)
export function validateQtyAssertion(result: FulfillmentResult, context: ContextPayload): ValidationResult {
  const errors: ValidationError[] = [];
  const qtyRequired = context.order.qty_required;

  result.scenarios.forEach((scenario) => {
    if (scenario.feasibility === 'full' && scenario.total_qty_fulfilled !== qtyRequired) {
      errors.push({
        type: 'qty_assertion',
        message: `Scenario ${scenario.rank}: Marked feasibility='full' but total_qty_fulfilled (${scenario.total_qty_fulfilled}) != qty_required (${qtyRequired})`,
        scenario_rank: scenario.rank,
      });
    }
  });

  return { isValid: errors.length === 0, errors };
}

// Master validation function (v2.1.0 multi-segment with Hard Constraints)
export function validateFulfillmentResult(
  result: FulfillmentResult,
  context: ContextPayload
): { isValid: boolean; allErrors: ValidationError[] } {
  const allErrors: ValidationError[] = [];

  // 1. Schema validation
  const schemaResult = validateSchema(result);
  allErrors.push(...schemaResult.errors);
  if (!schemaResult.isValid) {
    return { isValid: false, allErrors };
  }

  // 2. Tier ordering validation (HC 1)
  const tierOrderingResult = validateTierOrdering(result, context);
  allErrors.push(...tierOrderingResult.errors);

  // 3. Compliance validation (HC 2 - segment-agnostic)
  const complianceResult = validateCompliance(result, context);
  allErrors.push(...complianceResult.errors);

  // 4. Quantity assertion validation (HC 3)
  const qtyResult = validateQtyAssertion(result, context);
  allErrors.push(...qtyResult.errors);

  // 5. Disruption visibility validation (HC 4)
  const disruptionResult = validateDisruptionVisibility(result, context);
  allErrors.push(...disruptionResult.errors);

  // 6. D2C constraint validation (HC 1 corollary)
  const d2cResult = validateD2CConstraint(result, context);
  allErrors.push(...d2cResult.errors);

  // 7. Hallucination validation
  const hallucinationResult = validateHallucination(result, context);
  allErrors.push(...hallucinationResult.errors);

  return { isValid: allErrors.length === 0, allErrors };
}
