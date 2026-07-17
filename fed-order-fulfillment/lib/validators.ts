import type { FulfillmentResult, ContextPayload, ValidationResult, ValidationError, CMInventory } from './types';

// Validate JSON schema of Claude response
export function validateSchema(data: any): ValidationResult {
  const errors: ValidationError[] = [];

  if (!data || typeof data !== 'object') {
    errors.push({ type: 'schema', message: 'Response is not a valid object' });
    return { isValid: false, errors };
  }

  // Check required top-level fields
  const requiredFields = ['order_id', 'risk_assessment', 'scenarios', 'recommendation', 'units_unresolvable'];
  for (const field of requiredFields) {
    if (!(field in data)) {
      errors.push({ type: 'schema', message: `Missing required field: ${field}` });
    }
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

// Validate compliance constraints (TAA/ITAR)
export function validateCompliance(result: FulfillmentResult, context: ContextPayload): ValidationResult {
  const errors: ValidationError[] = [];
  const complianceRule = context.federal_order.compliance_rule;

  if (complianceRule === 'NONE') {
    return { isValid: true, errors };
  }

  // Build a map of cm_id -> taa_compliant for quick lookup
  const cmComplianceMap = new Map<string, boolean>();
  context.cm_inventory.forEach((inv) => {
    cmComplianceMap.set(inv.cm_id, inv.taa_compliant);
  });

  result.scenarios.forEach((scenario) => {
    scenario.steps.forEach((step, stepIndex) => {
      const cmTaaCompliant = cmComplianceMap.get(step.cm_id);

      // If CM not found in inventory, it's a hallucination (caught by another validator)
      if (cmTaaCompliant === undefined) {
        return;
      }

      // TAA compliance: all units must come from TAA-compliant CMs
      if (complianceRule === 'TAA' && !cmTaaCompliant) {
        errors.push({
          type: 'compliance',
          message: `Step ${stepIndex} in scenario ${scenario.rank}: Non-TAA-compliant CM ${step.cm_id} proposed for TAA order`,
          scenario_rank: scenario.rank,
          step_index: stepIndex,
        });
      }

      // ITAR compliance: similar logic (ITAR designation assumed on cm_id basis in this PoC)
      // For ITAR, we'd typically check a separate itar_compliant flag; using taa_compliant as proxy
      if (complianceRule === 'ITAR' && !cmTaaCompliant) {
        errors.push({
          type: 'compliance',
          message: `Step ${stepIndex} in scenario ${scenario.rank}: Non-compliant CM ${step.cm_id} proposed for ITAR order`,
          scenario_rank: scenario.rank,
          step_index: stepIndex,
        });
      }
    });
  });

  return { isValid: errors.length === 0, errors };
}

// Validate hallucinated inventory
export function validateHallucination(result: FulfillmentResult, context: ContextPayload): ValidationResult {
  const errors: ValidationError[] = [];

  // Build inventory map: cm_id + stock_type -> qty_available
  const inventoryMap = new Map<string, number>();
  context.cm_inventory.forEach((inv) => {
    const key = `${inv.cm_id}`;
    inventoryMap.set(key, inv.qty_available);
  });

  // Also track what we've already allocated to catch over-allocation
  const allocationTracker = new Map<string, number>();

  result.scenarios.forEach((scenario) => {
    allocationTracker.clear();

    scenario.steps.forEach((step, stepIndex) => {
      const key = `${step.cm_id}`;
      const availableQty = inventoryMap.get(key);

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
      const currentAllocation = allocationTracker.get(key) || 0;
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

      allocationTracker.set(key, newAllocation);
    });
  });

  return { isValid: errors.length === 0, errors };
}

// Validate quantity assertions (feasibility = full requires total_qty_fulfilled = qty_required)
export function validateQtyAssertion(result: FulfillmentResult, context: ContextPayload): ValidationResult {
  const errors: ValidationError[] = [];
  const qtyRequired = context.federal_order.qty_required;

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

// Master validation function
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

  // 2. Compliance validation
  const complianceResult = validateCompliance(result, context);
  allErrors.push(...complianceResult.errors);

  // 3. Hallucination validation
  const hallucinationResult = validateHallucination(result, context);
  allErrors.push(...hallucinationResult.errors);

  // 4. Quantity assertion validation
  const qtyResult = validateQtyAssertion(result, context);
  allErrors.push(...qtyResult.errors);

  return { isValid: allErrors.length === 0, allErrors };
}
