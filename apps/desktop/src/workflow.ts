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
  page: string
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

export type NonLoopWorkflowStep = WaitStep | ToolActionStep | SetVariableStep | OutputStep | AssertStep
export type ForStep = {
  type: 'for'
  id: string
  variable: string
  range: { start: string; stop: string; step: string }
  steps: WorkflowStep[]
}
export type WhileStep = {
  type: 'while'
  id: string
  left: ExpressionOperandWire
  operator: ComparisonOperator
  right: ExpressionOperandWire
  max_iterations: number | null
  steps: WorkflowStep[]
}
export type WorkflowStep = NonLoopWorkflowStep | ForStep | WhileStep

export type ForIterationDto = { for_step_id: string; iteration_index: number }
export type WhileIterationDto = { while_step_id: string; iteration_index: number }
export type StepExecutionDto = {
  step_id: string
  status: 'succeeded' | 'failed' | 'cancelled'
  output: unknown | null
  message: string | null
  for_iteration: ForIterationDto | null
  while_iteration: WhileIterationDto | null
  output_omitted: boolean
}
export type ResultRowDto = {
  page: string
  outputs: { name: string; value: unknown }[]
  for_iteration: ForIterationDto | null
  while_iteration: WhileIterationDto | null
}
export type NumericSummary = { name: string; count: number; min: number; max: number; avg: number }
export type RunPageMetadata = {
  name: string
  output_names: string[]
  row_count: number
  revision: number
  iteration_rows: boolean
  numeric_outputs: string[]
  summaries: NumericSummary[]
}
export type StepSummaryDto = Pick<StepExecutionDto, 'step_id' | 'status' | 'output' | 'output_omitted' | 'message'> & {
  has_occurrence: boolean
  any_failed: boolean
  all_succeeded: boolean
  any_cancelled: boolean
}
export type RunMetadataDto = {
  run_id: number
  status: 'running' | 'succeeded' | 'failed'
  error: string | null
  manual_exportable: boolean
  execution_count: number
  execution_revision: number
  latest_execution: StepExecutionDto | null
  pages: RunPageMetadata[]
  step_summaries: StepSummaryDto[]
}

export type WorkflowRunEventDto = {
  type: 'progress-batch'
  run: RunMetadataDto
  completed_step_ids: string[]
}

export function allWorkflowSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.flatMap(step => (step.type === 'for' || step.type === 'while') ? [step, ...allWorkflowSteps(step.steps)] : [step])
}

export function loopPath(steps: readonly WorkflowStep[], stepId: string | null): (ForStep | WhileStep)[] {
  for (const step of steps) {
    if (step.id === stepId) return []
    if (step.type === 'for' || step.type === 'while') {
      if (allWorkflowSteps(step.steps).some(child => child.id === stepId)) {
        return [step, ...loopPath(step.steps, stepId)]
      }
    }
  }
  return []
}

export function enclosingLoop(steps: readonly WorkflowStep[], stepId: string | null) {
  return loopPath(steps, stepId).at(-1)
}

export function insertionLoop(steps: readonly WorkflowStep[], stepId: string | null) {
  const selected = allWorkflowSteps(steps).find(step => step.id === stepId)
  return selected?.type === 'for' || selected?.type === 'while' ? selected : enclosingLoop(steps, stepId)
}

export function mapWorkflowSteps(steps: readonly WorkflowStep[], update: (step: WorkflowStep) => WorkflowStep | null): WorkflowStep[] {
  return steps.flatMap(step => {
    const next = update(step)
    if (!next) return []
    return [(next.type === 'for' || next.type === 'while')
      ? { ...next, steps: mapWorkflowSteps(next.steps, update) } : next]
  })
}

export function inputScope(steps: readonly WorkflowStep[], stepId: string | null) {
  const path = loopPath(steps, stepId)
  const earlierSteps: WorkflowStep[] = []
  const variables: string[] = []
  let siblings = steps
  for (const target of [...path.map(step => step.id), stepId]) {
    const index = siblings.findIndex(step => step.id === target)
    if (index < 0) break
    const prior = siblings.slice(0, index)
    earlierSteps.push(...prior)
    variables.push(...prior.flatMap(step => step.type === 'set-variable' ? [step.variable] : []))
    const step = siblings[index]
    if (step.id === stepId) break
    if (step.type === 'for') variables.push(step.variable)
    if (step.type === 'for' || step.type === 'while') siblings = step.steps
  }
  return { earlierSteps, earlierVariables: [...new Set(variables.filter(variable => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(variable)))] }
}

export function outputPages(steps: readonly WorkflowStep[]) {
  const pages: { name: string; scope: string[]; outputs: OutputStep[] }[] = []
  for (const output of outputDefinitions(steps)) {
    const name = output.page
    const page = pages.find(page => page.name === name)
    if (page) page.outputs.push(output)
    else pages.push({ name, scope: loopPath(steps, output.id).map(loop => loop.id), outputs: [output] })
  }
  return pages
}

export function outputPageContext(steps: readonly WorkflowStep[], selectedPage: string) {
  const pages = outputPages(steps)
  const page = pages.find(page => page.name === selectedPage) ?? pages[0]
  return { pages, page, outputs: page?.outputs ?? [] }
}

export function compatibleOutputPages(steps: readonly WorkflowStep[], outputId: string): string[] {
  const scope = loopPath(steps, outputId).map(loop => loop.id)
  return outputPages(steps)
    .filter(page => page.scope.length === scope.length && page.scope.every((id, index) => id === scope[index]))
    .map(page => page.name)
}

export function outputDefinitions(steps: readonly WorkflowStep[]): OutputStep[] {
  return allWorkflowSteps(steps).filter((step): step is OutputStep => step.type === 'output')
}


export function occurrenceKey(execution: StepExecutionDto): string {
  const whileIteration = execution.while_iteration
  if (whileIteration) return `while:${whileIteration.while_step_id}:${whileIteration.iteration_index}:${execution.step_id}`
  const iteration = execution.for_iteration
  return iteration
    ? `${iteration.for_step_id}:${iteration.iteration_index}:${execution.step_id}`
    : `root:${execution.step_id}`
}
