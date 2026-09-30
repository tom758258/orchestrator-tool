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

export type { OutputStep }

type AssertStep = {
  type: 'assert'
  id: string
  left: ExpressionOperandWire
  operator: ComparisonOperator
  right: ExpressionOperandWire
  message: string
}

export type MessageTargetWire = 'message-1' | 'message-2' | 'message-3'
export const MESSAGE_TARGETS: MessageTargetWire[] = ['message-1', 'message-2', 'message-3']
export const MESSAGE_TARGET_LABELS: Record<MessageTargetWire, string> = {
  'message-1': 'Message 1', 'message-2': 'Message 2', 'message-3': 'Message 3',
}
export const MAX_MESSAGE_FIELDS = 10
export const MAX_MESSAGE_TEXT_CHARS = 256

export type MessageFieldWire =
  | { kind: 'text'; text: string; newline: boolean }
  | { kind: 'output'; step_id: string; pointer: string; newline: boolean }

export type ShowMessageStep = {
  type: 'show-message'
  id: string
  target: MessageTargetWire
  fields: MessageFieldWire[]
}

export type ToolActionStep = {
  type: 'tool-action'
  id: string
  target: string
  action: string
  arguments: Record<string, unknown>
  bindings?: Record<string, InputValueWire>
}

export type NonLoopWorkflowStep = WaitStep | ToolActionStep | SetVariableStep | OutputStep | AssertStep | ShowMessageStep
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
export type NumericSummary = { name: string; count: number; min: number; max: number; avg: number; std_dev: number | null }
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
  completed_successfully: boolean
  manual_exportable: boolean
  execution_count: number
  execution_revision: number
  latest_execution: StepExecutionDto | null
  pages: RunPageMetadata[]
  step_summaries: StepSummaryDto[]
  messages: { target: MessageTargetWire; total: number; revision: number }[]
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

export function enclosingForVariables(steps: readonly WorkflowStep[], stepId: string | null): string[] {
  return loopPath(steps, stepId).flatMap(step => step.type === 'for' ? [step.variable] : [])
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

/** Output steps that a Show Message field may reference from the current lexical scope. */
export function showMessageOutputCandidates(steps: readonly WorkflowStep[]): OutputStep[] {
  return steps.filter((step): step is OutputStep => step.type === 'output')
}

/** Truncates to at most `limit` Unicode characters without splitting a code point. */
export function limitMessageText(text: string, limit: number): string {
  const characters = Array.from(text)
  return characters.length > limit ? characters.slice(0, limit).join('') : text
}

export type MessageWindow = { target: MessageTargetWire; total: number; revision: number }
export type MessageWindowPage = { runId: number; target: MessageTargetWire; messages: string[] }

/**
 * Resolves which message texts the active tab may show. A fetched window is used only
 * when it belongs to the run and target currently on screen, so switching tabs, starting
 * a new run, or clearing the Last Run can never briefly show another tab's or run's text.
 */
export function visibleMessageWindow(page: MessageWindowPage | null,
  active: { runId: number | null; target: MessageTargetWire; counts: readonly MessageWindow[] }) {
  const own = active.counts.find(count => count.target === active.target)
  const total = own?.total ?? 0
  const matches = page !== null && page.runId === active.runId && page.target === active.target
  const items = matches ? page.messages : []
  return {
    // The backend already returns production order, so the oldest retained message is first.
    items,
    total,
    retained: items.length,
    discarded: Math.max(0, total - items.length),
    revision: own?.revision ?? 0,
  }
}

/**
 * Concatenates Show Message fields the same way the Core executor does: a newline follows
 * every field flagged for one, and the record always ends with exactly one newline.
 */
export function composeMessageText(fields: readonly MessageFieldWire[],
  outputName: (stepId: string) => string | undefined): string {
  const last = Math.max(0, fields.length - 1)
  return fields.map((field, index) => {
    const text = field.kind === 'text' ? field.text : `{${outputName(field.step_id) ?? field.step_id}}`
    return index < last && field.newline ? `${text}\n` : text
  }).join('') + (fields.length > 0 ? '\n' : '')
}


export function occurrenceKey(execution: StepExecutionDto): string {
  const whileIteration = execution.while_iteration
  if (whileIteration) return `while:${whileIteration.while_step_id}:${whileIteration.iteration_index}:${execution.step_id}`
  const iteration = execution.for_iteration
  return iteration
    ? `${iteration.for_step_id}:${iteration.iteration_index}:${execution.step_id}`
    : `root:${execution.step_id}`
}
