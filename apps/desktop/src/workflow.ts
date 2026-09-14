import type { ComparisonOperator, ExpressionOperandWire, InputValueWire } from './inputValue'

type WaitStep = {
  type: 'wait'
  id: string
  duration_ms: number
}

type SetVariableStep = {
  type: 'set-variable'
  id: string
  variable: string
  value: InputValueWire
}

type OutputStep = {
  type: 'output'
  id: string
  name: string
  value: InputValueWire
}

type AssertStep = {
  type: 'assert'
  id: string
  left: ExpressionOperandWire
  operator: ComparisonOperator
  right: ExpressionOperandWire
  message: string
}

export type ToolActionStep = {
  type: 'tool-action'
  id: string
  target: string
  action: string
  arguments: Record<string, unknown>
  bindings?: Record<string, InputValueWire>
}

export type NonForWorkflowStep = WaitStep | ToolActionStep | SetVariableStep | OutputStep | AssertStep
export type ForStep = {
  type: 'for'
  id: string
  variable: string
  range: { start: string; stop: string; step: string }
  steps: NonForWorkflowStep[]
}
export type WorkflowStep = NonForWorkflowStep | ForStep

export type ForIterationDto = { for_step_id: string; iteration_index: number }
export type StepExecutionDto = {
  step_id: string
  status: 'succeeded' | 'failed' | 'cancelled'
  output: unknown | null
  message: string | null
  for_iteration: ForIterationDto | null
}
export type ResultRowDto = {
  outputs: { name: string; value: unknown }[]
  for_iteration: ForIterationDto | null
}
export type WorkflowRunResultDto = {
  step_executions: StepExecutionDto[]
  result_rows: ResultRowDto[]
}

export function allWorkflowSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.flatMap(step => step.type === 'for' ? [step, ...step.steps] : [step])
}

export function enclosingFor(steps: readonly WorkflowStep[], stepId: string | null): ForStep | undefined {
  return steps.find((step): step is ForStep =>
    step.type === 'for' && step.steps.some(body => body.id === stepId))
}

export function insertionFor(steps: readonly WorkflowStep[], stepId: string | null): ForStep | undefined {
  const selected = steps.find(step => step.id === stepId)
  return selected?.type === 'for' ? selected : enclosingFor(steps, stepId)
}

export function inputScope(steps: readonly WorkflowStep[], stepId: string | null) {
  const parent = enclosingFor(steps, stepId)
  const rootIndex = steps.findIndex(step => step.id === (parent?.id ?? stepId))
  const priorRoots = rootIndex < 0 ? [] : steps.slice(0, rootIndex)
  const priorBody = parent ? parent.steps.slice(0, parent.steps.findIndex(step => step.id === stepId)) : []
  const earlierSteps = parent
    ? [...priorRoots, ...priorBody]
    : priorRoots
  const setVariables = (items: readonly WorkflowStep[]) => items.flatMap(step =>
    step.type === 'set-variable' ? [step.variable] : [])
  const variables = priorRoots.flatMap(step => step.type === 'for'
    ? setVariables(step.steps).filter(variable => variable !== step.variable)
    : setVariables([step]))
  if (parent) variables.push(parent.variable, ...setVariables(priorBody))
  const earlierVariables = [...new Set(variables.filter(variable => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(variable)))]
  return { earlierSteps, earlierVariables }
}

export function outputDefinitions(steps: readonly WorkflowStep[]): OutputStep[] {
  return allWorkflowSteps(steps).filter((step): step is OutputStep => step.type === 'output')
}

export function successfulRun(steps: readonly WorkflowStep[], result: WorkflowRunResultDto | null): boolean {
  return result !== null && result.step_executions.every(execution => execution.status === 'succeeded')
    && steps.every(step => result.step_executions.some(execution =>
      execution.for_iteration === null && execution.step_id === step.id))
}

export function occurrenceKey(execution: StepExecutionDto): string {
  const iteration = execution.for_iteration
  return iteration
    ? `${iteration.for_step_id}:${iteration.iteration_index}:${execution.step_id}`
    : `root:${execution.step_id}`
}
