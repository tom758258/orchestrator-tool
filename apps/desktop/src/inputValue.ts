// Mirrors the Core Template wire representation; operands cannot contain expressions.
export type ExpressionOperandWire =
  | { source: 'literal'; value: unknown }
  | { source: 'variable'; variable: string }
  | { source: 'step-output'; step_id: string; pointer: string }

export const COMPARISON_OPERATORS = {
  'greater-than': '>',
  'greater-than-or-equal': '≥',
  'less-than': '<',
  'less-than-or-equal': '≤',
} as const

export type ComparisonOperator = keyof typeof COMPARISON_OPERATORS

export const EXPRESSION_OPERATORS = {
  add: '+',
  subtract: '−',
  multiply: '×',
  divide: '÷',
  ...COMPARISON_OPERATORS,
} as const

export type InputValueWire = ExpressionOperandWire | { source: 'elapsed-time' } | { source: 'timestamp' } | {
  source: 'expression'
  left: ExpressionOperandWire
  operator: keyof typeof EXPRESSION_OPERATORS
  right: ExpressionOperandWire
}

type StepOutputCandidate = {
  id: string
  type: string
  target?: string
  action?: string
}

type ToolIdentity = {
  id: string
  tool: string
}

export function isMeterMeasureStep(step: StepOutputCandidate | undefined, instances: readonly ToolIdentity[]): boolean {
  return step?.type === 'tool-action'
    && step.action === 'measure'
    && instances.find(instance => instance.id === step.target)?.tool === 'meters'
}

export function stepOutputReference(
  step: StepOutputCandidate,
  instances: readonly ToolIdentity[],
): Extract<ExpressionOperandWire, { source: 'step-output' }> {
  return {
    source: 'step-output',
    step_id: step.id,
    pointer: isMeterMeasureStep(step, instances) ? '/value' : '',
  }
}

export function expressionSummary(value: Omit<Extract<InputValueWire, { source: 'expression' }>, 'source'>): string {
  const operandSummary = (operand: ExpressionOperandWire): string => {
    switch (operand.source) {
      case 'literal': return JSON.stringify(operand.value) ?? 'No value'
      case 'variable': return operand.variable
      case 'step-output': return `${operand.step_id} → ${operand.pointer || '(root)'}`
    }
  }
  return `${operandSummary(value.left)} ${EXPRESSION_OPERATORS[value.operator]} ${operandSummary(value.right)}`
}
