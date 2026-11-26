import { english, type Translate } from './i18n/index.ts'
import { SCOPES_ACTIONS, scopesActionArguments, type ScopesAction } from './scopesActions'
import type { ToolInstance } from './toolSetup/types'
import { allWorkflowSteps } from './workflow'
import type { WorkflowStep } from './workflow'

export type StepPreset =
  | 'bg-command' | 'bg-get-latest' | 'bg-wait-next' | 'bg-get-result' | 'bg-get-buffer-data' | 'bg-get-buffer-status'
  | 'background-worker-on' | 'background-worker-off' | 'background-capture-on' | 'background-capture-off'
  | `scope-${ScopesAction}`
  | 'serial-send' | 'serial-send-file' | 'serial-receive' | 'serial-query'
  | 'for'
  | 'while'
  | 'if'
  | 'assert'
  | 'set-variable'
  | 'output'
  | 'power-set-output'
  | 'power-protection-status'
  | 'power-measure'
  | 'power-output-on'
  | 'wait'
  | 'meter-measure'
  | 'power-output-off'
  | 'show-message'
  | 'string-process'
  | 'byte-process'
  | 'array-process'

export type StepPresetOption = {
  value: StepPreset
  label: string
  fullLabel?: string
  prefix: string
  category: string
  tool?: ToolInstance['tool']
}

export const STEP_CATEGORY_KEYS: Record<string, string> = {
  "Workflow": "steps.category.workflow",
  "Background Workflow": "steps.category.background",
  "FG/BG Interaction": "steps.category.interaction",
  "Meters": "steps.category.meters",
  "Powers": "steps.category.powers",
  "Scopes": "steps.category.scopes",
  "Serial": "steps.category.serial"
}

export const STEP_CATEGORIES = [
  { category: 'Workflow', tool: null },
  { category: 'Background Workflow', tool: null },
  { category: 'FG/BG Interaction', tool: null },
  { category: 'Meters', tool: 'meters' },
  { category: 'Powers', tool: 'powers' },
  { category: 'Scopes', tool: 'scopes' },
  { category: 'Serial', tool: 'serial' },
] as const

export function nextStepId(prefix: string, steps: WorkflowStep[]): string {
  const existingIds = new Set(allWorkflowSteps(steps).map((step) => step.id))
  let sequence = 1

  while (existingIds.has(`${prefix}-${sequence}`)) {
    sequence += 1
  }

  return `${prefix}-${sequence}`
}

export function createPresetStep(preset: StepPreset, id: string, target: string): WorkflowStep {
  if (preset.startsWith('bg-')) {
    const operation: import('./workflow').InteractionOperation = preset === 'bg-command'
      ? { kind: 'command', command: 'software-trigger', wait_for_completion: false }
      : preset === 'bg-get-buffer-data' ? { kind: 'get-buffer-data', read_mode: 'pop', selection: { kind: 'all' } }
      : preset === 'bg-get-buffer-status' ? { kind: 'get-buffer-status' }
      : preset === 'bg-get-result' ? { kind: 'get-command-result', source_step: '' }
        : { kind: preset === 'bg-get-latest' ? 'get-latest' : 'wait-next' }
    return { type: 'bg-interaction', id, background_id: target, operation, timeout_ms: null }
  }
  if (preset.startsWith('background-')) {
    const action = preset.slice(11) as import('./workflow').BackgroundAction
    return { type: 'background', id, background_id: target, action, capture: action === 'worker-off' }
  }
  if (preset.startsWith('serial-')) {
    const action = preset.slice(7)
    const arguments_: Record<string, unknown> = action === 'send-file' ? { path: '' }
      : action === 'receive' ? { max_bytes: 1024, fail_on_read_timeout: false }
      : action === 'query' ? { tx_format: 'text', tx_value: '', delimiter_format: 'text', delimiter_value: '\\r\\n', max_bytes: 1024, fail_on_read_timeout: false }
      : { tx_format: 'text', tx_value: '' }
    return { type: 'tool-action', id, target, action, arguments: arguments_ }
  }
  if (preset.startsWith('scope-')) {
    const action = preset.slice(6) as ScopesAction
    return { type: 'tool-action', id, target, action, arguments: scopesActionArguments(action) }
  }
  switch (preset) {
    case 'while':
      return { type: 'while', id, left: { source: 'literal', value: 0 }, operator: 'less-than', right: { source: 'literal', value: 1 }, max_iterations: 1000, steps: [] }
    case 'if':
      return { type: 'if', id, left: { source: 'literal', value: 0 }, operator: 'equal', right: { source: 'literal', value: 0 }, then_steps: [], else_steps: [] }
    case 'for':
      return { type: 'for', id, variable: 'x', range: { start: '1', stop: '3', step: '1' }, steps: [] }
    case 'assert':
      return {
        type: 'assert', id,
        left: { source: 'literal', value: 0 },
        operator: 'greater-than-or-equal',
        right: { source: 'literal', value: 0 },
        message: 'Assertion failed.',
      }
    case 'set-variable':
      return { type: 'set-variable', id, variable: 'x', value: { source: 'literal', value: 5.0 } }
    case 'output':
      return { type: 'output', id, name: id, page: 'Results', value: { source: 'literal', value: null } }
    case 'power-set-output':
      return {
        type: 'tool-action',
        id,
        target,
        action: 'set-output',
        arguments: { channel: 1, voltage: 5.0 },
      }
    case 'power-protection-status':
      return { type: 'tool-action', id, target, action: 'protection-status', arguments: { channel: 'all' } }
    case 'power-measure':
      return { type: 'tool-action', id, target, action: 'measure', arguments: { channel: 1 } }
    case 'power-output-on':
      return {
        type: 'tool-action',
        id,
        target,
        action: 'output-on',
        arguments: { channel: 1 },
      }
    case 'wait':
      return { type: 'wait', id, duration_ms: 500 }
    case 'meter-measure':
      return {
        type: 'tool-action',
        id,
        target,
        action: 'measure',
        arguments: {},
      }
    case 'power-output-off':
      return {
        type: 'tool-action',
        id,
        target,
        action: 'output-off',
        arguments: { channel: 1 },
      }
    case 'string-process':
      return { type: 'string-process', id, operation: 'length', arguments: { input: { source: 'literal', value: '' } } }
    case 'array-process':
      return { type: 'array-process', id, operation: 'length', arguments: { input: { source: 'step-output', step_id: '', pointer: '' } } }
    case 'byte-process':
      return { type: 'byte-process', id, operation: { kind: 'byte-length' }, arguments: { input: { source: 'literal', value: '' } } }
    case 'show-message':
      return { type: 'show-message', id, target: 'message-1', fields: [{ kind: 'text', text: '', newline: false }] }
    default: throw new Error(`Unsupported preset ${preset}`)
  }
}

export function getStepPresets(t: Translate): StepPresetOption[] {
  return [
    ...(['bg-command', 'bg-get-latest', 'bg-wait-next', 'bg-get-result'] as const).map((value, index) => ({ value, label: [t("app.bGCommand"), t("app.getLatest"), t("app.waitNext"), t("app.getCommandResult")][index], prefix: value, category: 'FG/BG Interaction' })),
    { value: 'bg-get-buffer-data', label: t('steps.interaction.get-buffer-data'), prefix: 'bg-get-buffer-data', category: 'FG/BG Interaction' },
    { value: 'bg-get-buffer-status', label: t('steps.interaction.get-buffer-status'), prefix: 'bg-get-buffer-status', category: 'FG/BG Interaction' },
    ...(['worker-on', 'worker-off', 'capture-on', 'capture-off'] as const).map(action => ({ value: `background-${action}` as StepPreset,
      label: t(`steps.palette.background-${action}`), fullLabel: t(`steps.background.${action}`),
      prefix: `background-${action}`, category: 'Background Workflow' })),
    ...(['send', 'send-file', 'receive', 'query'] as const).map(action => ({
      value: `serial-${action}` as StepPreset, label: t(`steps.serial.${action}`),
      prefix: `serial-${action}`, category: 'Serial', tool: 'serial' as const,
    })),
    ...SCOPES_ACTIONS.map(([action]) => ({ value: `scope-${action}` as StepPreset, label: t(`steps.scope.${action}`), prefix: `scope-${action}`, category: 'Scopes', tool: 'scopes' as const })),
    { value: 'while', label: t("app.while").trim(), prefix: 'while', category: 'Workflow' },
    { value: 'if', label: t("app.ifElse"), prefix: 'if', category: 'Workflow' },
    { value: 'for', label: t("app.for").trim(), prefix: 'for', category: 'Workflow' },
    { value: 'set-variable', label: t("app.setVariable"), prefix: 'set-variable', category: 'Workflow' },
    { value: 'output', label: t("app.output"), prefix: 'output', category: 'Workflow' },
    { value: 'power-set-output', label: t("app.powerSetOutput"), prefix: 'power-set', category: 'Powers', tool: 'powers' },
    { value: 'power-protection-status', label: t("app.powerProtectionStatus"), prefix: 'power-protection', category: 'Powers', tool: 'powers' },
    { value: 'power-measure', label: t("app.powerMeasure"), prefix: 'power-measure', category: 'Powers', tool: 'powers' },
    { value: 'power-output-on', label: t("app.powerOutputON"), prefix: 'power-on', category: 'Powers', tool: 'powers' },
    { value: 'wait', label: t("app.wait"), prefix: 'wait', category: 'Workflow' },
    { value: 'assert', label: t("app.assert"), prefix: 'assert', category: 'Workflow' },
    { value: 'show-message', label: t("app.showMessage"), prefix: 'show-message', category: 'Workflow' },
    { value: 'string-process', label: t("process.stringProcess"), prefix: 'string-process', category: 'Workflow' },
    { value: 'array-process', label: t('process.arrayProcess'), prefix: 'array-process', category: 'Workflow' },
    { value: 'byte-process', label: t("process.byteProcess"), prefix: 'byte-process', category: 'Workflow' },
    { value: 'meter-measure', label: t("app.meterMeasure"), prefix: 'meter-read', category: 'Meters', tool: 'meters' },
    { value: 'power-output-off', label: t("app.powerOutputOFF"), prefix: 'power-off', category: 'Powers', tool: 'powers' },
  ]
}

const TOOL_ACTION_LABEL_KEYS: Record<string, string> = {
  'serial/send': "app.serialSend",
  'serial/send-file': "app.serialSendFile",
  'serial/receive': "app.serialReceive",
  'serial/query': "app.serialQuery",
  ...Object.fromEntries(SCOPES_ACTIONS.map(([action]) => [`scopes/${action}`, `steps.scope.${action}`])),
  'powers/set-output': "app.powerSetOutput",
  'powers/protection-status': "app.powerProtectionStatus",
  'powers/measure': "app.powerMeasure",
  'powers/output-on': "app.powerOutputON",
  'meters/measure': "app.meterMeasure",
  'powers/output-off': "app.powerOutputOFF",
}

export function stepHelpKey(step: WorkflowStep, instances: ToolInstance[], presets: readonly StepPresetOption[]): StepPreset | undefined {
  if (step.type === 'bg-interaction') return ({
    command: 'bg-command', 'get-latest': 'bg-get-latest', 'wait-next': 'bg-wait-next',
    'get-command-result': 'bg-get-result', 'get-buffer-data': 'bg-get-buffer-data', 'get-buffer-status': 'bg-get-buffer-status',
  } as const)[step.operation.kind]
  if (step.type === 'background') return `background-${step.action}`
  if (step.type !== 'tool-action') return step.type
  const tool = instances.find(instance => instance.id === step.target)?.tool
  const prefix = tool === 'scopes' ? 'scope' : tool === 'powers' ? 'power' : tool === 'meters' ? 'meter' : tool
  return presets.find(preset => preset.value === `${prefix}-${step.action}`)?.value
}

export function propertiesTitle(step: WorkflowStep, instances: ToolInstance[], locale: string, t: Translate, presets: readonly StepPresetOption[]): string {
  if (step.type === 'for' || step.type === 'while') return t(`steps.properties.${step.type}`)
  const label = stepLabel(step, instances, t).trim()
  if (locale !== 'zh-TW' || !stepHelpKey(step, instances, presets)) return label
  const name = stepLabel(step, instances, english).trim()
  return label.toLowerCase().includes(name.toLowerCase()) ? label : `${label} (${name})`
}

export function stepLabel(step: WorkflowStep, instances: ToolInstance[], translate: Translate): string {
  if (step.type === 'bg-interaction') return translate(`steps.interaction.${step.operation.kind}`)
  if (step.type === 'background') return translate(`steps.background.${step.action}`)
  if (step.type === 'while') return translate("app.while")
  if (step.type === 'if') return translate("app.ifElse")
  if (step.type === 'for') return translate("app.forRange", { value1: step.variable, value2: step.range.start, value3: step.range.stop })
  if (step.type === 'set-variable') {
    return translate("app.setVariable")
  }
  if (step.type === 'output') {
    return translate("app.output")
  }
  if (step.type === 'assert') {
    return translate("app.assert")
  }
  if (step.type === 'string-process') return translate("process.stringProcess")
  if (step.type === 'array-process') return translate('process.arrayProcess')
  if (step.type === 'byte-process') return translate("process.byteProcess")
  if (step.type === 'show-message') {
    return translate("app.showMessage")
  }
  if (step.type === 'wait') {
    return translate("app.wait")
  }

  const tool = instances.find(instance => instance.id === step.target)?.tool
  const key = TOOL_ACTION_LABEL_KEYS[`${tool}/${step.action}`]
  return key ? translate(key) : `${step.target} / ${step.action}`
}
