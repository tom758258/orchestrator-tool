import { uiMessage, useMessage } from './i18n/useMessage'
import { useI18n } from './i18n/I18nProvider'
import { english, type Translate } from './i18n/index.ts'
import ScopesActionEditor from './ScopesActionEditor'
import SerialActionEditor from './SerialActionEditor'
import { useLivePreflight } from './useLivePreflight'
import { SCOPES_ACTIONS, scopesActionArguments, type ScopesAction } from './scopesActions'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { Channel, invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { effectiveTheme, nextThemePreference, readThemePreference, writeThemePreference } from './theme'
import { confirm, open, save } from '@tauri-apps/plugin-dialog'
import SequenceEditor, { type SequenceEditorHandle, type SequenceDropTarget, type StepDensity } from './SequenceEditor'
import { canMoveSteps, copySteps, deleteSteps, isEditableTarget, moveSteps, pasteSteps, reconcileSelection, renameStepId, renameStepReferenceInInput, relocateSteps, replaceSiblings, selectAllSteps, selectStep, singleSelection, stepClipboardShortcut, stepContainer } from './stepEditing'
import type { StepSelection } from './stepEditing'
import OutputCharts, { LiveMonitors } from './OutputCharts'
import Collapsible from './Collapsible'
import type { BackgroundChartSelections } from './BackgroundChartPanel'
import { EXECUTION_WINDOW_SIZE, MESSAGE_WINDOW_SIZE } from './executionWindow'
import VirtualizedOutputTable from './VirtualizedOutputTable'
import PageResultSummary from './PageResultSummary'
import { reconcileRunChartPanels, savedChartsToPanels, type ChartPanel } from './chartPanels'
import { parseChartThresholdPercent, pruneChartData, type ChartChangeSettings, type PageChartData } from './chartData'
import { claimRunGate, isCurrentRunGeneration, lastRunWorkspaceState, prepareLastRunReplacement, releaseRunGate } from './runLifecycle'
import FailureDetails from './FailureDetails'
import WorkflowRunSummary from './WorkflowRunSummary'
import { InteractionEditor, InteractionSettingsEditor, type InteractionCommandDrafts } from './InteractionEditor'
import { templateDraftJson, workflowOnlyDraft, type WorkflowDraft } from './templateDraft'
import ToolSetupEditor from './ToolSetupEditor'
import ErrorQueueSetup, { type ErrorQueueResult, type ErrorQueueSetupProps, type ErrorQueueTool } from './ErrorQueueSetup'
import BackgroundOutput from './BackgroundOutput'
import { useSimulationSamples } from './useSimulationSamples'
import { toolInstanceLabel } from './toolInstanceLabel'
import type { ToolInstance } from './ToolSetupEditor'
import { protectionChannelNumbers } from './powersProtectionSetup'
import { changeOutputValue, DEFAULT_NUMERIC_DISPLAY_FORMAT } from './outputTime'
import type { NumericDisplayFormat } from './outputTime'
import InputValueEditor, { ExpressionOperandEditor } from './InputValueEditor'
import { COMPARISON_OPERATORS, curatedResultFields } from './inputValue'
import type { ComparisonOperator, InputValueWire } from './inputValue'
import { allWorkflowSteps, containerPath, mapWorkflowSteps, loopPath, outputPages, outputPageContext, enclosingLoop, enclosingForVariables, inputScope, outputDefinitions, occurrenceKey, compatibleOutputPages, showMessageOutputCandidates, visibleMessageWindow, MESSAGE_TARGETS } from './workflow'
import type { WorkflowStep, ToolActionStep, WorkflowRunEventDto, StepExecutionDto, RunMetadataDto, MessageTargetWire, MessageWindow, StepBranch } from './workflow'
import ShowMessageEditor from './ShowMessageEditor'
import ProcessEditor from './ProcessEditor'
import { hasPowerSetpoint, powerSetpointLiteralDefault, togglePowerSetpoint } from './powerSetpoint'
import type { PowerSetpoint } from './powerSetpoint'
import { DEFAULT_EXECUTION_MODE, executionModeLabel, manualOperationRequiresSavedResource, workflowRunCommand } from './executionMode'
import type { ExecutionMode } from './executionMode'
export type { WorkflowStep } from './workflow'

type ToolStatus = {
  tool_id: string
  path: string | null
  source: string | null
  executable_status: string
  compatibility: string
  tool_version: string | null
  worker_schema_versions: number[]
  reason: string | null
}

type ResourceIdentity = {
  manufacturer: string | null
  model: string | null
  model_id?: string | null
  serial: string | null
  identity: string | null
}

type VisaBackend = 'system' | '@py'

type LiveResourceCandidate = ResourceIdentity & { resource: string }

type PowersProtectionStatus = {
  protection_tripped: boolean
  over_voltage_tripped: boolean
  over_current_tripped: boolean
  channels: {
    channel: number
    output_enabled: boolean
    over_voltage_tripped: boolean
    over_current_tripped: boolean
  }[]
}

type PowersStatusState = {
  status: PowersProtectionStatus | null
  error: string | null
  operation: 'refresh' | 'clear' | null
  clearPlan: { channel: number } | null
  clearCompleted: boolean
}

type PowersClearResult =
  | { mode: 'simulate'; outcome: 'planned'; plan: unknown }
  | { mode: 'live'; outcome: 'completed'; status: PowersProtectionStatus }

function deviceName(identity: ResourceIdentity | null | undefined): string {
  return [identity?.manufacturer?.trim(), identity?.model?.trim()].filter(Boolean).join(' ')
    || identity?.identity?.trim() || ''
}

function targetLabel(instance: ToolInstance, identity: ResourceIdentity | null | undefined): string {
  const name = identity?.model?.trim() || deviceName(identity)
  const serial = identity?.serial?.trim()
  const detail = [name, serial ? `[${serial}]` : ''].filter(Boolean).join(' ')
  const label = toolInstanceLabel(instance)
  return detail ? `${label} — ${detail}` : label
}

function formatResourceCandidate(candidate: LiveResourceCandidate): string {
  const name = deviceName(candidate)
  const serial = candidate.serial?.trim()
  const detail = [name, serial ? `[${serial}]` : ''].filter(Boolean).join(' ')
  return detail ? `${detail} — ${candidate.resource}` : candidate.resource
}

function tcpEndpointParts(resource: string): { host: string; port: string } {
  const bracketed = /^\[(.+)\]:(.*)$/.exec(resource)
  const simple = /^([^:]*):(.*)$/.exec(resource)
  const match = bracketed ?? simple
  return match ? { host: match[1], port: match[2] } : { host: '', port: '' }
}

function formatTcpEndpoint(host: string, port: string): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`
}

function formatLiveResourceConfirmation(
  instance: ToolInstance,
  resource: string,
  backend: VisaBackend,
  identity: ResourceIdentity | null | undefined,
  t: Translate = english,
): string {
  const lines = [`${instance.id} (${instance.tool})`]
  const name = deviceName(identity)
  const serial = identity?.serial?.trim()
  const modelId = identity?.model_id?.trim()
  if (modelId) lines.push(t("app.modelId", { value1: modelId }))
  if (name) {
    lines.push(name)
  }
  if (serial) {
    lines.push(`S/N: ${serial}`)
  }
  if (instance.tool === 'serial') lines.push(`${instance.setup.transport === 'tcp' ? t('app.tcpEndpoint') : t('app.comPort')}: ${resource}`)
  else lines.push(t("app.backend", { value1: backend === '@py' ? 'PyVISA-py (@py)' : 'System VISA' }), resource)
  return lines.join('\n')
}

type ActiveTab = 'tools' | 'setup' | 'workflow' | 'output'
type ValidationStatus = 'idle' | 'validating' | 'valid'
type TemplateIoStatus = 'idle' | 'loading' | 'saving'
type RunStatus = 'idle' | 'running'
type WorkflowStopRequest = { generation: number; sent: boolean; error?: string }
type StepPreset =
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

type StepPresetOption = {
  value: StepPreset
  label: string
  fullLabel?: string
  prefix: string
  category: string
  tool?: ToolInstance['tool']
}

const STEP_CATEGORY_KEYS: Record<string, string> = {
  "Workflow": "steps.category.workflow",
  "Background Workflow": "steps.category.background",
  "FG/BG Interaction": "steps.category.interaction",
  "Meters": "steps.category.meters",
  "Powers": "steps.category.powers",
  "Scopes": "steps.category.scopes",
  "Serial": "steps.category.serial"
}

const STEP_CATEGORIES = [
  { category: 'Workflow', tool: null },
  { category: 'Background Workflow', tool: null },
  { category: 'FG/BG Interaction', tool: null },
  { category: 'Meters', tool: 'meters' },
  { category: 'Powers', tool: 'powers' },
  { category: 'Scopes', tool: 'scopes' },
  { category: 'Serial', tool: 'serial' },
] as const

function formatWorkerSchemas(versions: number[]): string {
  if (versions.length === 0) {
    return '—'
  }
  return versions.join(', ')
}

function nextStepId(prefix: string, steps: WorkflowStep[]): string {
  const existingIds = new Set(allWorkflowSteps(steps).map((step) => step.id))
  let sequence = 1

  while (existingIds.has(`${prefix}-${sequence}`)) {
    sequence += 1
  }

  return `${prefix}-${sequence}`
}

function createPresetStep(preset: StepPreset, id: string, target: string): WorkflowStep {
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

function numericArgument(step: ToolActionStep, name: string): number | '' {
  const value = step.arguments[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : ''
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function formatMeasurement(output: unknown): string | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return null
  }

  const value = (output as Record<string, unknown>).value
  const unit = (output as Record<string, unknown>).unit
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof unit !== 'string') {
    return null
  }

  return `${value} ${unit}`
}

type CsvStreamStatus = {
  path: string
  rows: number
  error: string | null
  finished: boolean
  workflow_succeeded: boolean
}
type DesktopRunEvent = WorkflowRunEventDto | { type: 'csv-stream'; status: CsvStreamStatus }
type ExecutionRowsResponse = {
  run_id: number
  total_executions: number
  offset: number
  executions: StepExecutionDto[]
}
type MessageRowsResponse = {
  run_id: number
  target: MessageTargetWire
  revision: number
  total_messages: number
  offset: number
  messages: string[]
}

const EMPTY_MESSAGE_COUNTS: readonly MessageWindow[] = []

/**
 * Both run paths snapshot the Chart Sampling Options through this one rule, so
 * Simulation and Live cannot disagree about an invalid threshold. Called only when the
 * option is enabled; throws before a run starts if the threshold is unusable.
 */
function chartSamplingSnapshot(options: { enabled: boolean; threshold: string; showMarkers: boolean }): ChartChangeSettings {
  const thresholdPercent = parseChartThresholdPercent(options.threshold)
  if (Number.isNaN(thresholdPercent)) {
    throw new Error('Chart Sampling change threshold must be a finite number greater than zero.')
  }
  return { enabled: true, thresholdPercent, showMarkers: options.showMarkers }
}

function streamingOptions(enabled: boolean, outputFolder: string | null, page: string, allPages: boolean) {  if (!enabled) return null
  const timestamp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
    .slice(0, 19).replace(/[T:]/g, '-')
  return { output_folder: outputFolder, timestamp, page, all_pages: allPages }
}

function LiveDeviceSetup({ children, errorQueue }: { children: ReactNode; errorQueue?: ErrorQueueSetupProps }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(true)
  return <div className="live-resource">
    <h4>
      <button type="button" className="action-button tool-setup-toggle" aria-expanded={expanded}
        aria-label={t("app.liveDevice", { value1: expanded ? t("app.collapse") : t("app.expand") })} onClick={() => setExpanded(!expanded)}>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>{t("app.liveDevice2")}</h4>
    <div hidden={!expanded}>{errorQueue ? <ErrorQueueSetup {...errorQueue}>{children}</ErrorQueueSetup> : children}</div>
  </div>
}

const STEP_DENSITY_STORAGE_KEY = 'orchestrator-tool.step-density'

function readStepDensity(): StepDensity {
  try {
    const stored = localStorage.getItem(STEP_DENSITY_STORAGE_KEY)
    return stored === 'compact' || stored === 'comfortable' ? stored : 'standard'
  } catch {
    return 'standard'
  }
}

function App() {
  const { locale, setLocale, t } = useI18n()
  useEffect(() => {
    // With WebView-native drag and drop enabled, reject unsupported drops
    // instead of letting a file or URL navigate away from the workflow.
    function preventUnsupportedDrop(event: DragEvent) {
      const target = event.target
      const textField = target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(target.type))
      if (textField && !target.matches(':disabled') && !target.readOnly && !event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    }
    document.addEventListener('dragover', preventUnsupportedDrop, true)
    document.addEventListener('drop', preventUnsupportedDrop, true)
    return () => {
      document.removeEventListener('dragover', preventUnsupportedDrop, true)
      document.removeEventListener('drop', preventUnsupportedDrop, true)
    }
  }, [])
  const STEP_PRESETS: StepPresetOption[] = [
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

  const EXECUTABLE_LABELS: Record<string, string> = {
    'not-configured': t("app.notConfigured"),
    available: t("app.available"),
    missing: t("app.missing"),
    'not-file': t("app.notAFile"),
    error: t("app.error"),
  }

  const COMPATIBILITY_LABELS: Record<string, string> = {
    compatible: t("app.compatible"),
    incompatible: t("app.incompatible"),
    'not-probed': '—',
    error: t("app.error"),
  }

  const SOURCE_LABELS: Record<string, string> = {
    configured: t("app.configured"),
    'not-configured': t("app.notConfigured"),
  }

  function stepHelpKey(step: WorkflowStep, instances: ToolInstance[]): StepPreset | undefined {
    if (step.type === 'bg-interaction') return ({
      command: 'bg-command', 'get-latest': 'bg-get-latest', 'wait-next': 'bg-wait-next',
      'get-command-result': 'bg-get-result', 'get-buffer-data': 'bg-get-buffer-data', 'get-buffer-status': 'bg-get-buffer-status',
    } as const)[step.operation.kind]
    if (step.type === 'background') return `background-${step.action}`
    if (step.type !== 'tool-action') return step.type
    const tool = instances.find(instance => instance.id === step.target)?.tool
    const prefix = tool === 'scopes' ? 'scope' : tool === 'powers' ? 'power' : tool === 'meters' ? 'meter' : tool
    return STEP_PRESETS.find(preset => preset.value === `${prefix}-${step.action}`)?.value
  }

  function propertiesTitle(step: WorkflowStep, instances: ToolInstance[]): string {
    if (step.type === 'for' || step.type === 'while') return t(`steps.properties.${step.type}`)
    const label = stepLabel(step, instances).trim()
    if (locale !== 'zh-TW' || !stepHelpKey(step, instances)) return label
    const name = stepLabel(step, instances, english).trim()
    return label.toLowerCase().includes(name.toLowerCase()) ? label : `${label} (${name})`
  }

  function stepLabel(step: WorkflowStep, instances: ToolInstance[], translate: Translate = t): string {
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

  const simulationSamples = useSimulationSamples()
  const [backgroundCsvEnabled, setBackgroundCsvEnabled] = useState(false)
  const [backgroundCsvMode, setBackgroundCsvMode] = useState<'values-only' | 'values-quality'>('values-only')
  const [serialCsvMode, setSerialCsvMode] = useState<'hex' | 'text'>('hex')
  const [backgroundCsvTarget, setBackgroundCsvTarget] = useState('all')
  const [backgroundCsvFolder, setBackgroundCsvFolder] = useState<string | null>(null)
  const [backgroundCsvError, setBackgroundCsvError] = useState<string | null>(null)
  const [themePreference, setThemePreference] = useState(readThemePreference)
  const [stepDensity, setStepDensity] = useState<StepDensity>(readStepDensity)
  const [collapsedStepIds, setCollapsedStepIds] = useState<Set<string>>(() => new Set())
  const [collapsedBranches, setCollapsedBranches] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    try {
      localStorage.setItem(STEP_DENSITY_STORAGE_KEY, stepDensity)
    } catch {
      // A disabled preference store must not prevent editing.
    }
  }, [stepDensity])
  const [applicationVersion, setApplicationVersion] = useState<string | null>(null)
  const [helpError, setHelpError] = useState<string | null>(null)
  async function handleOpenHelp() {
    setHelpError(null)
    try {
      await invoke('open_help', { locale, theme: themePreference })
    } catch (message) {
      setHelpError(String(message))
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const version = await getVersion()
        if (version.trim()) {
          setApplicationVersion(version)
        }
      } catch {
        // Tauri runtime is unavailable, such as browser-only Vite mode.
      }
    })()
  }, [])

  const themeLabel = (value: string) => t(`preferences.theme.${value}`)
  const nextThemeLabel = themeLabel(nextThemePreference(themePreference))

  useEffect(() => {
    writeThemePreference(themePreference)
    let media: MediaQueryList | undefined
    if (themePreference === 'system') {
      try {
        media = window.matchMedia('(prefers-color-scheme: dark)')
      } catch {
        // Use light when the system preference is unavailable.
      }
    }
    const updateTheme = () => {
      document.documentElement.dataset.theme = effectiveTheme(themePreference, media?.matches ?? false)
    }
    updateTheme()
    media?.addEventListener('change', updateTheme)
    void (async () => {
      try {
        await getCurrentWindow().setTheme(themePreference === 'system' ? null : themePreference)
      } catch (error) {
        console.warn('Could not sync native window theme:', error)
      }
    })()
    return () => media?.removeEventListener('change', updateTheme)
  }, [themePreference])

  const [selectedRunPage, setSelectedRunPage] = useState('Results')
  const [numericFormat, setNumericFormat] = useState<NumericDisplayFormat>(DEFAULT_NUMERIC_DISPLAY_FORMAT)
  const [streamPage, setStreamPage] = useState('Results')
  const [streamAllPages, setStreamAllPages] = useState(false)
  const [scopesOutputFolder, setScopesOutputFolder] = useState<string | null>(null)
  const [scopesOutputError, setScopesOutputError] = useMessage()
  const [streamOutputFolder, setStreamOutputFolder] = useState<string | null>(null)
  const [streamOutputFolderError, setStreamOutputFolderError] = useMessage()
  const [chartSaveCount, setChartSaveCount] = useState(0)
  const chartSaving = chartSaveCount > 0
  const handleChartSavingChange = useCallback((saving: boolean) => {
    setChartSaveCount(count => count + (saving ? 1 : -1))
  }, [])
  const [choosingStreamOutputFolder, setChoosingStreamOutputFolder] = useState(false)
  const [exportAllPages, setExportAllPages] = useState(false)
  const [exportFormat, setExportFormat] = useState<'csv' | 'xlsx'>('xlsx')
  const [chartPanels, setChartPanels] = useState<ChartPanel[]>([])
  const [saveChartsWithTemplate, setSaveChartsWithTemplate] = useState(false)
  const [chartSamplingOptions, setChartSamplingOptions] = useState({ enabled: false, threshold: '5', showMarkers: false })
  const [chartFitData, setChartFitData] = useState(false)
  // Snapshots of Chart Options captured when the current run started.
  const [runChartSampling, setRunChartSampling] = useState<ChartChangeSettings | null>(null)
  const [runChartFitData, setRunChartFitData] = useState(false)
  const [expandedStepCategories, setExpandedStepCategories] = useState<Record<string, boolean>>({
    Workflow: true, 'Background Workflow': true, 'FG/BG Interaction': true, Powers: true, Meters: true, Scopes: true, Serial: true,
  })
  const [unavailableCategoriesExpanded, setUnavailableCategoriesExpanded] = useState(false)
  const [stepsExpanded, setStepsExpanded] = useState(true)
  const [selectedPaletteStep, setSelectedPaletteStep] = useState<StepPreset | null>(null)
  const sequenceEditorRef = useRef<SequenceEditorHandle>(null)
  const paletteDragRef = useRef<{
    preset: StepPreset; pointerId: number; handle: HTMLButtonElement;
    startX: number; startY: number; started: boolean
  } | null>(null)
  const suppressPaletteClickRef = useRef<StepPreset | null>(null)
  const [streamingExpanded, setStreamingExpanded] = useState(false)
  const [scopesOutputExpanded, setScopesOutputExpanded] = useState(false)
  const [chartOptionsExpanded, setChartOptionsExpanded] = useState(false)
  const [chartSamplingExpanded, setChartSamplingExpanded] = useState(true)
  const [chartYAxisExpanded, setChartYAxisExpanded] = useState(true)
  const [executionsExpanded, setExecutionsExpanded] = useState(true)
  const [messagesExpanded, setMessagesExpanded] = useState(true)
  const [messageTarget, setMessageTarget] = useState<MessageTargetWire>('message-1')
  const [activeTab, setActiveTab] = useState<ActiveTab>('tools')
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(DEFAULT_EXECUTION_MODE)
  const [lastRunExecutionMode, setLastRunExecutionMode] = useState<ExecutionMode | null>(null)
  const [tools, setTools] = useState<ToolStatus[]>([])
  const [toolRefreshRevision, setToolRefreshRevision] = useState(0)
  const [expandedToolIds, setExpandedToolIds] = useState<string[]>([])
  const [templateUiGeneration, setTemplateUiGeneration] = useState(0)
  useEffect(() => {
    setExpandedToolIds(current => {
      const remaining = current.filter(id => tools.some(tool => tool.tool_id === id && tool.executable_status !== 'not-configured'))
      return remaining.length === current.length ? current : remaining
    })
  }, [tools])
  const configuredTools = tools.filter(tool => tool.executable_status !== 'not-configured')
  const configuredToolTypes = configuredTools.map(tool => tool.tool_id as ToolInstance['tool'])
  const unconfiguredTools = tools.filter(tool => tool.executable_status === 'not-configured')
  const [toolToAdd, setToolToAdd] = useState('')
  const selectedToolToAdd = unconfiguredTools.some(tool => tool.tool_id === toolToAdd)
    ? toolToAdd : unconfiguredTools[0]?.tool_id ?? ''
  const metersTool = tools.find(tool => tool.tool_id === 'meters')
  const metersExecutableKey = JSON.stringify([metersTool?.source ?? null, metersTool?.path ?? null])
  const powersTool = tools.find(status => status.tool_id === 'powers')
  const scopesTool = tools.find(tool => tool.tool_id === 'scopes')
  const scopesExecutableKey = JSON.stringify([scopesTool?.source ?? null, scopesTool?.path ?? null])
  const powersExecutableKey = JSON.stringify([powersTool?.source ?? null, powersTool?.path ?? null])
  const [resourceIdentities, setResourceIdentities] = useState<Record<string, ResourceIdentity | null>>({})
  const [resourceIdentityDrafts, setResourceIdentityDrafts] = useState<Record<string, ResourceIdentity | null>>({})
  const [resourceDrafts, setResourceDrafts] = useState<Record<string, string>>({})
  const [savedResources, setSavedResources] = useState<Record<string, string>>({})
  const [savedBackends, setSavedBackends] = useState<Record<string, VisaBackend>>({})
  const [backendDrafts, setBackendDrafts] = useState<Record<string, VisaBackend>>({})
  const discoveryRequests = useRef<Record<string, number>>({})
  const [powersStatuses, setPowersStatuses] = useState<Record<string, PowersStatusState>>({})
  const [powersOperationBusy, setPowersOperationBusy] = useState<string | null>(null)
  const [errorQueueBusy, setErrorQueueBusy] = useState(false)
  const errorQueueInFlight = useRef(false)
  const [powersCapabilityChannels, setPowersCapabilityChannels] = useState<{
    key: string; models: Record<string, { status: 'ready'; channels: number[] } | { status: 'error' }>
  } | null>(null)
  const [discoveredResources, setDiscoveredResources] = useState<Record<string, LiveResourceCandidate[] | undefined>>({})
  const [discoveryErrors, setDiscoveryErrors] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toolConfigBusy, setToolConfigBusy] = useState<string | null>(null)
  const [toolConfigError, setToolConfigError] = useState<string | null>(null)
  const [workflowDraft, setWorkflowDraft] = useState<WorkflowDraft | null>(null)
  const [interactionCommandDrafts, setInteractionCommandDrafts] = useState<Record<string, InteractionCommandDrafts>>({})
  useEffect(() => {
    const commandIds = new Set(allWorkflowSteps(workflowDraft?.workflow.steps ?? [])
      .filter(step => step.type === 'bg-interaction' && step.operation.kind === 'command').map(step => step.id))
    setInteractionCommandDrafts(current => {
      const remaining = Object.fromEntries(Object.entries(current).filter(([id]) => commandIds.has(id)))
      return Object.keys(remaining).length === Object.keys(current).length ? current : remaining
    })
  }, [workflowDraft?.workflow.steps])
  useEffect(() => {
    if (backgroundCsvTarget !== 'all' && !workflowDraft?.backgrounds?.some(background => background.id === backgroundCsvTarget)) {
      setBackgroundCsvTarget('all')
    }
  }, [workflowDraft?.backgrounds, backgroundCsvTarget])
  const scopesOutputLocked = !workflowDraft?.tool_instances.some(instance => instance.tool === 'scopes')
  const scopesOutputVisible = !scopesOutputLocked && scopesOutputExpanded
  const powersModels = executionMode === 'simulate' ? [null]
    : [...new Set((workflowDraft?.tool_instances ?? []).flatMap(instance => {
        const modelId = resourceIdentityDrafts[instance.id]?.model_id
        return instance.tool === 'powers' && modelId ? [modelId] : []
      }))].sort()
  const powersCapabilityKey = JSON.stringify([executionMode, powersExecutableKey, powersModels])
  const [draftLoading, setDraftLoading] = useState(true)
  const [draftCreationError, setDraftCreationError] = useState<string | null>(null)
  const [validationStatus, setValidationStatus] = useState<ValidationStatus>('idle')
  const [validationError, setValidationError] = useMessage()
  const [validationIssue, setValidationIssue] = useState<{ step_id: string | null; message: string } | null>(null)
  const validationGenerationRef = useRef(0)
  const clearValidation = useCallback(() => {
    validationGenerationRef.current++
    setValidationIssue(null)
    setValidationError(null)
    setValidationStatus('idle')
  }, [])
  const validateTemplate = useCallback(async (templateJson: string) => {
    const generation = ++validationGenerationRef.current
    setValidationStatus('validating')
    setValidationIssue(null)
    setValidationError(null)
    try {
      const canonical = await invoke<string>('validate_workflow_draft', { templateJson })
      if (generation === validationGenerationRef.current) setValidationStatus(validationStatus)
      return canonical
    } catch (error) {
      const issue = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
        ? { message: error.message, step_id: 'step_id' in error && typeof error.step_id === 'string' ? error.step_id : null }
        : { message: String(error), step_id: null }
      if (generation === validationGenerationRef.current) {
        setValidationIssue(issue)
        setValidationError(issue.message)
        setValidationStatus('idle')
      }
      throw issue.message
    }
  }, [validationStatus])
  const [stepSelection, setStepSelection] = useState<StepSelection>(() => singleSelection(null))
  const [editingStepId, setEditingStepId] = useState<string | null>(null)
  const [stepIdDraft, setStepIdDraft] = useState('')
  const [stepIdEditError, setStepIdEditError] = useState<string | null>(null)
  const selection = reconcileSelection(workflowDraft?.workflow.steps ?? [], stepSelection)
  const { active: selectedStepId, ids: selectedStepIds } = selection
  useEffect(() => {
    setEditingStepId(null)
    setStepIdEditError(null)
  }, [selectedStepId])
  const setSelectedStepId = useCallback((id: string | null) => setStepSelection(singleSelection(id)), [])
  const [preferredIfBranch, setPreferredIfBranch] = useState<{ id: string; branch: StepBranch }>({ id: '', branch: 'then' })

  const revealSequencePath = useCallback((steps: readonly WorkflowStep[], stepId: string,
    includeContainer = false, branch: StepBranch | null = null) => {
    const ancestors = containerPath(steps, stepId)
    const ids = [...ancestors.map(({ step }) => step.id), ...(includeContainer ? [stepId] : [])]
    const branches = ancestors.flatMap(({ step, branch }) => branch ? [`${step.id}:${branch}`] : [])
    if (includeContainer && branch) branches.push(`${stepId}:${branch}`)
    setCollapsedStepIds(current => {
      if (!ids.some(id => current.has(id))) return current
      const next = new Set(current)
      ids.forEach(id => next.delete(id))
      return next
    })
    setCollapsedBranches(current => {
      if (!branches.some(key => current.has(key))) return current
      const next = new Set(current)
      branches.forEach(key => next.delete(key))
      return next
    })
  }, [])

  const toggleSequenceContainer = useCallback((id: string) => {
    setCollapsedStepIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const toggleSequenceBranch = useCallback((id: string, branch: StepBranch) => {
    setCollapsedBranches(current => {
      const next = new Set(current)
      const key = `${id}:${branch}`
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  const setAllSequenceExpanded = useCallback((expanded: boolean) => {
    const controls = allWorkflowSteps(workflowDraft?.workflow.steps ?? []).filter(
      step => step.type === 'if' || step.type === 'for' || step.type === 'while')
    setCollapsedStepIds(new Set(expanded ? [] : controls.map(step => step.id)))
    setCollapsedBranches(new Set(expanded ? [] : controls.flatMap(step => step.type === 'if'
      ? [`${step.id}:then`, `${step.id}:else`] : [])))
  }, [workflowDraft?.workflow.steps])

  useEffect(() => {
    const controls = allWorkflowSteps(workflowDraft?.workflow.steps ?? []).filter(
      step => step.type === 'if' || step.type === 'for' || step.type === 'while')
    const validIds = new Set(controls.map(step => step.id))
    const validBranches = new Set(controls.flatMap(step => step.type === 'if'
      ? [`${step.id}:then`, `${step.id}:else`] : []))
    setCollapsedStepIds(current => {
      const next = new Set([...current].filter(id => validIds.has(id)))
      return next.size === current.size ? current : next
    })
    setCollapsedBranches(current => {
      const next = new Set([...current].filter(key => validBranches.has(key)))
      return next.size === current.size ? current : next
    })
  }, [workflowDraft?.workflow.steps])

  useEffect(() => {
    if (validationIssue?.step_id && workflowDraft) {
      revealSequencePath(workflowDraft.workflow.steps, validationIssue.step_id)
    }
  }, [validationIssue, workflowDraft?.workflow.steps, revealSequencePath])
  const stepClipboardRef = useRef<WorkflowStep[]>([])
  const stepClipboardCutRef = useRef(false)
  const pastedStepIdsRef = useRef(new Set<string>())
  const stepEditingBusyRef = useRef(false)
  useEffect(() => {
    setStepSelection(current => reconcileSelection(workflowDraft?.workflow.steps ?? [], current))
  }, [workflowDraft])
  const [templateIoStatus, setTemplateIoStatus] = useState<TemplateIoStatus>('idle')
  const [templateIoError, setTemplateIoError] = useState<string | null>(null)
  const [templateIoMessage, setTemplateIoMessage] = useMessage()
  const livePreflight = useLivePreflight(executionMode, workflowDraft, savedResources, resourceDrafts,
    resourceIdentities, resourceIdentityDrafts, powersExecutableKey, scopesExecutableKey,
    loading || draftLoading || templateIoStatus === 'loading' || toolConfigBusy !== null, savedBackends, backendDrafts)
  const runInFlightRef = useRef(false)
  const runGenerationRef = useRef(0)
  const [liveConfirmationPending, setLiveConfirmationPending] = useState(false)
  const [liveStartError, setLiveStartError] = useState<string | null>(null)
  const [runStatus, setRunStatus] = useState<RunStatus>('idle')
  const [runWorkflowSnapshot, setRunWorkflowSnapshot] = useState<WorkflowDraft | null>(null)
  const [workflowChangedSinceRun, setWorkflowChangedSinceRun] = useState(false)
  const [executionOffset, setExecutionOffset] = useState(0)
  const [runMetadata, setRunMetadata] = useState<RunMetadataDto | null>(null)
  const runIdRef = useRef<number | null>(null)
  const [executionPage, setExecutionPage] = useState<ExecutionRowsResponse | null>(null)
  const [messagePage, setMessagePage] = useState<MessageRowsResponse | null>(null)
  const progressChannelRef = useRef<Channel<DesktopRunEvent> | null>(null)
  const [stopRequest, setStopRequest] = useState<{ loopId: string, error?: string } | null>(null)
  const [workflowStopRequest, setWorkflowStopRequest] = useState<WorkflowStopRequest | null>(null)
  const workflowStopRef = useRef<WorkflowStopRequest | null>(null)
  const resetWorkflowStop = useCallback(() => {
    workflowStopRef.current = null
    setWorkflowStopRequest(null)
  }, [])
  const sendWorkflowStop = useCallback(async () => {
    const request = workflowStopRef.current
    const runId = runIdRef.current
    if (!request || request.sent || request.error || runId === null || request.generation !== runGenerationRef.current) return
    request.sent = true
    try {
      const accepted = await invoke<boolean>('request_global_workflow_stop', { runId })
      if (!accepted) throw new Error('This workflow is no longer active.')
    } catch (message) {
      if (workflowStopRef.current !== request || request.generation !== runGenerationRef.current) return
      const failed = { ...request, error: String(message) }
      workflowStopRef.current = failed
      setWorkflowStopRequest(failed)
    }
  }, [])
  const workflowStopping = workflowStopRequest !== null && !workflowStopRequest.error
  const requestWorkflowStop = () => {
    if (runStatus !== 'running' || (workflowStopRef.current && !workflowStopRef.current.error)) return
    const request = { generation: runGenerationRef.current, sent: false }
    workflowStopRef.current = request
    setWorkflowStopRequest(request)
    void sendWorkflowStop()
  }
  const [runError, setRunError] = useState<string | null>(null)
  const [showLastRunError, setShowLastRunError] = useState(false)
  const clearRunFeedback = useCallback(() => {
    setRunError(null)
    setLiveStartError(null)
    setShowLastRunError(false)
  }, [])
  const [clearLastRunError, setClearLastRunError] = useMessage()
  const [streamCsv, setStreamCsv] = useState(false)
  const [csvStreamStatus, setCsvStreamStatus] = useState<CsvStreamStatus | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportMessage, setExportMessage] = useMessage()
  useEffect(() => {
    let cancelled = false
    void Promise.all(powersModels.map(async modelId => {
      const result = await invoke<{ channels: number[] }>('get_powers_capabilities', { modelId, executionMode })
        .then(capabilities => ({ status: 'ready' as const, channels: capabilities.channels }),
          () => ({ status: 'error' as const }))
      return [modelId ?? 'simulator', result] as const
    })).then(models => {
      if (!cancelled) setPowersCapabilityChannels({ key: powersCapabilityKey, models: Object.fromEntries(models) })
    })
    return () => { cancelled = true }
  }, [executionMode, powersCapabilityKey])
  const outputSteps = outputDefinitions(workflowDraft?.workflow.steps ?? [])
  const pages = outputPages(workflowDraft?.workflow.steps ?? [])
  const streamingPage = pages.some(page => page.name === streamPage) ? streamPage : pages[0]?.name ?? 'Results'
  const hasWorkflowOutputs = outputSteps.length > 0
  const runWorkflowSteps = runWorkflowSnapshot?.workflow.steps ?? []
  const runStepsById = useMemo(
    () => new Map(allWorkflowSteps(runWorkflowSnapshot?.workflow.steps ?? []).map(step => [step.id, step])),
    [runWorkflowSnapshot],
  )
  const { pages: runPages, page: runPage, outputs: runOutputs } = useMemo(() =>
    outputPageContext(runWorkflowSnapshot?.workflow.steps ?? [], selectedRunPage), [runWorkflowSnapshot, selectedRunPage])
  const hasRunOutputs = outputDefinitions(runWorkflowSteps).length > 0
  const runCompletedSuccessfully = runMetadata?.completed_successfully === true
  const partialRun = runMetadata !== null && runMetadata.status !== 'running' && (runMetadata.status === 'failed' || !runCompletedSuccessfully)
  const runExportable = runMetadata?.manual_exportable === true
  const runPageMetadata = runMetadata?.pages.find(page => page.name === runPage?.name)
  const hasExportableOutputRows = exportAllPages
    ? runMetadata?.pages.some(page => page.row_count > 0) ?? false
    : (runPageMetadata?.row_count ?? 0) > 0
  const latestExecution = runMetadata?.latest_execution
  const activeLoop = runStatus !== 'running' ? null : latestExecution?.for_iteration
    ? { kind: t("app.for"), id: latestExecution.for_iteration.for_step_id, index: latestExecution.for_iteration.iteration_index }
    : latestExecution?.while_iteration
      ? { kind: t("app.while"), id: latestExecution.while_iteration.while_step_id, index: latestExecution.while_iteration.iteration_index }
      : null
  const stopping = activeLoop !== null && stopRequest?.loopId === activeLoop.id && !stopRequest.error
  const runningText = workflowStopping ? t("app.stoppingWorkflowWaitingForTheCurrentOperationAndCleanup") : activeLoop
    ? t("app.loopRunning", { kind: activeLoop.kind, id: activeLoop.id, iteration: activeLoop.index + 1, status: stopping ? t("app.stopping") : t("app.running") })
    : t("app.running2")
  const activeAncestors = activeLoop ? loopPath(runWorkflowSteps, activeLoop.id) : []
  const requestStop = async (loopId = activeLoop?.id) => {
    if (!loopId || stopping) return
    const request = { loopId }
    setStopRequest(request)
    try {
      const accepted = await invoke<boolean>('request_workflow_stop', { loopStepId: request.loopId })
      if (!accepted) setStopRequest(current => current === request ? null : current)
    } catch (message) {
      setStopRequest(current => current === request ? { ...request, error: String(message) } : current)
    }
  }
  const stopControls = <>
    {runStatus === 'running' && <button className="action-button action-button-danger" type="button"
      disabled={workflowStopping} onClick={requestWorkflowStop}>
      {workflowStopping ? t("app.stoppingWorkflow") : t("app.stopWorkflow")}
    </button>}
    {activeLoop && <>
      {activeAncestors.map(loop => <button className="action-button action-button-danger" type="button" key={loop.id}
        disabled={workflowStopping || (stopRequest !== null && !stopRequest.error)} onClick={() => void requestStop(loop.id)}>{t("app.stop")}{loop.id}</button>)}
      <button className="action-button action-button-danger" type="button" onClick={() => void requestStop()} disabled={workflowStopping || (stopRequest !== null && !stopRequest.error)}>
        {stopping ? t("app.stopping") : t("app.stop")}
      </button>
    </>}
  </>
  const stopFeedback = <>
    {workflowStopRequest?.error && <p className="error" role="alert">{t("app.workflowStopRequestFailed")}{workflowStopRequest.error}</p>}
    {activeLoop && <p>{t("app.loopStopFinishesTheCurrentInnermostIterationThenStops")}</p>}
    {stopRequest?.error && <p className="error" role="alert">{t("app.stopRequestFailed")}{stopRequest.error}</p>}
  </>
  const displayedRun = runWorkflowSnapshot ? runMetadata : null
  const runWorkspace = lastRunWorkspaceState(!!runWorkflowSnapshot, runStatus === 'running', !!runMetadata)
  // Numeric arrays survive Page/Output tab switches, but never cross a run ID.
  const chartData = useMemo(() => new Map<string, PageChartData>(), [runMetadata?.run_id])
  const backgroundChartSelections = useMemo<BackgroundChartSelections>(() => new Map(), [runMetadata?.run_id])
  useEffect(() => {
    if (!runWorkflowSnapshot || !displayedRun || saveChartsWithTemplate) return
    setChartPanels(panels => reconcileRunChartPanels(
      panels, outputPages(runWorkflowSnapshot.workflow.steps), displayedRun.pages,
    ))
  }, [runWorkflowSnapshot, displayedRun, saveChartsWithTemplate])
  useEffect(() => {
    pruneChartData(chartData, chartPanels, activeTab === 'output' ? runPage?.name : undefined)
  }, [activeTab, chartData, chartPanels, runPage?.name])
  useEffect(() => {
    if (!displayedRun) { setExecutionPage(null); return }
    let cancelled = false
    void invoke<ExecutionRowsResponse>('get_last_run_executions', {
      runId: displayedRun.run_id, offset: executionOffset, limit: EXECUTION_WINDOW_SIZE,
    }).then(response => {
      if (!cancelled && response.run_id === runIdRef.current) setExecutionPage(response)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [displayedRun?.run_id, displayedRun?.execution_revision, executionOffset])
  const executionTotal = executionPage?.total_executions ?? displayedRun?.execution_count ?? 0
  const executions = {
    items: executionPage?.executions ?? [], offset: executionOffset, total: executionTotal,
    start: executionTotal === 0 ? 0 : executionOffset + 1,
    end: Math.min(executionTotal, executionOffset + (executionPage?.executions.length ?? 0)),
    hasNewer: executionOffset > 0,
    hasOlder: executionOffset + (executionPage?.executions.length ?? 0) < executionTotal,
  }

  // Only the active Message tab is pulled, and only while the panel is expanded.
  // A window belonging to another run or tab is ignored rather than shown.
  const messageCounts = runMetadata?.messages ?? EMPTY_MESSAGE_COUNTS
  const messageWindow = visibleMessageWindow(
    messagePage === null ? null
      : { runId: messagePage.run_id, target: messagePage.target, messages: messagePage.messages },
    { runId: displayedRun?.run_id ?? null, target: messageTarget, counts: messageCounts })
  useEffect(() => {
    if (!displayedRun || !messagesExpanded) return
    let cancelled = false
    void invoke<MessageRowsResponse>('get_last_run_messages', {
      runId: displayedRun.run_id, target: messageTarget, offset: 0, limit: MESSAGE_WINDOW_SIZE,
    }).then(response => {
      if (!cancelled && response.run_id === runIdRef.current) setMessagePage(response)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [displayedRun?.run_id, messageWindow.revision, messageTarget, messagesExpanded])
  const messages = messageWindow

  useEffect(() => {
    setExportError(null)
    setExportMessage(null)
  }, [workflowDraft, runMetadata, runStatus])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const statuses = await invoke<ToolStatus[]>('get_tool_status')
      setTools(statuses)
      setToolRefreshRevision(current => current + 1)
      const [resources, identities, backends] = await Promise.all([
        invoke<Record<string, string>>('get_live_resources'),
        invoke<Record<string, ResourceIdentity>>('get_live_resource_identities'),
        invoke<Record<string, VisaBackend>>('get_live_backends'),
      ])
      for (const id of Object.keys(discoveryRequests.current)) discoveryRequests.current[id]++
      setDiscoveredResources({})
      setDiscoveryErrors({})
      setSavedBackends(backends)
      setBackendDrafts(backends)
      setResourceDrafts(resources)
      setSavedResources(resources)
      setResourceIdentities(identities)
      setResourceIdentityDrafts(identities)
      setError(null)
    } catch (message) {
      setError(String(message))
    } finally {
      setLoading(false)
    }
  }, [])

  const createDraft = useCallback(async () => {
    validationGenerationRef.current++
    setDraftLoading(true)
    try {
      const draft = await prepareLastRunReplacement(
        async () => JSON.parse(await invoke<string>('create_workflow_draft')) as WorkflowDraft,
        runIdRef.current,
        async runId => { await invoke('clear_last_run', { runId }) },
      )
      runGenerationRef.current += 1
      runIdRef.current = null
      setWorkflowDraft(workflowOnlyDraft(draft))
      setInteractionCommandDrafts({})
      setTemplateUiGeneration(current => current + 1)
      setUnavailableCategoriesExpanded(false)
      setExpandedToolIds([])
      setCollapsedStepIds(new Set())
      setCollapsedBranches(new Set())
      setSaveChartsWithTemplate(false)
      setExecutionMode(DEFAULT_EXECUTION_MODE)
      setPowersStatuses({})
      setSelectedStepId(null)
      setSelectedPaletteStep(null)
      setDraftCreationError(null)
      setRunMetadata(null)
      setLastRunExecutionMode(null)
      setExecutionPage(null)
      setMessagePage(null)
      setRunWorkflowSnapshot(null)
      setChartPanels([])
      setExecutionOffset(0)
      setWorkflowChangedSinceRun(false)
      setCsvStreamStatus(null)
      clearRunFeedback()
    } catch (message) {
      setDraftCreationError(String(message))
    } finally {
      setDraftLoading(false)
    }
  }, [clearRunFeedback])

  useEffect(() => {
    let secondFrame: number | null = null
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        void refresh()
        void createDraft()
      })
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) cancelAnimationFrame(secondFrame)
    }
  }, [createDraft, refresh])

  const updateSteps = useCallback(
    (update: (steps: WorkflowStep[]) => WorkflowStep[]) => {
      setWorkflowDraft((current) => {
        if (!current) {
          return current
        }

        return {
          ...current,
          workflow: {
            ...current.workflow,
            steps: update(current.workflow.steps),
          },
        }
      })
      setWorkflowChangedSinceRun(true)
      clearRunFeedback()
      clearValidation()
      setTemplateIoMessage(null)
    },
    [clearValidation, clearRunFeedback],
  )

  const updateToolInstances = useCallback((tool_instances: ToolInstance[]) => {
    if (!workflowDraft) return
    const previous = workflowDraft.tool_instances
    const executionChanged = previous.length !== tool_instances.length || tool_instances.some((instance, index) => {
      const current = previous[index]
      return instance.id !== current.id || instance.tool !== current.tool
        || JSON.stringify(instance.setup) !== JSON.stringify(current.setup)
    })
    if (!executionChanged && tool_instances.every((instance, index) => instance.display_name === previous[index].display_name)) return
    setWorkflowDraft((current) => current ? { ...current, tool_instances } : current)
    if (!executionChanged) return
    setPowersStatuses(current => Object.fromEntries(
      Object.entries(current).filter(([id]) => tool_instances.some(instance => instance.id === id)),
    ))
    for (const instance of previous) {
      if (!tool_instances.some(next => next.id === instance.id)) {
        discoveryRequests.current[instance.id] = (discoveryRequests.current[instance.id] ?? 0) + 1
        setDiscoveredResources(current => ({ ...current, [instance.id]: undefined }))
        setDiscoveryErrors(current => ({ ...current, [instance.id]: null }))
      }
    }
    setWorkflowChangedSinceRun(true)
    clearRunFeedback()
    clearValidation()
    setTemplateIoMessage(null)
  }, [workflowDraft, clearValidation, clearRunFeedback])

  const insertStepAt = useCallback((preset: StepPresetOption, location: SequenceDropTarget) => {
    if (!workflowDraft || stepEditingBusyRef.current || runInFlightRef.current) return
    const steps = workflowDraft.workflow.steps
    const { parentId, branch, index } = location
    const parent = parentId === null ? null : allWorkflowSteps(steps).find(step => step.id === parentId)
    if ((parentId === null && branch !== null) ||
        (parentId !== null && (!parent || (parent.type === 'if'
          ? branch !== 'then' && branch !== 'else'
          : (parent.type !== 'for' && parent.type !== 'while') || branch !== null)))) return
    const siblings = parent?.type === 'if'
      ? branch === 'else' ? parent.else_steps : parent.then_steps
      : parent?.type === 'for' || parent?.type === 'while' ? parent.steps : steps
    if (!Number.isInteger(index) || index < 0 || index > siblings.length) return
    const isControl = preset.value === 'for' || preset.value === 'while' || preset.value === 'if'
    if (isControl && parentId && containerPath(steps, parentId).length + 1 >= 8) return
    if (preset.value.startsWith('bg-') && !workflowDraft.workflow.interaction.enabled) {
      setValidationError(uiMessage("app.enableFGBGInteractionInWorkflowSettingsBeforeAdding")); return
    }
    if (preset.value.startsWith('bg-get-buffer-') && !workflowDraft.workflow.interaction.buffer.enabled) {
      setValidationError(uiMessage('interactionEditor.enableBufferFirst')); return
    }
    const target = (preset.value.startsWith('background-') || preset.value.startsWith('bg-')) ? workflowDraft.backgrounds?.[0]?.id
      : workflowDraft.tool_instances.find(instance => instance.tool === preset.tool &&
          !workflowDraft.backgrounds?.some(background => background.tool_instance_id === instance.id))?.id
    if ((preset.value.startsWith('background-') || preset.value.startsWith('bg-')) && !target) {
      setValidationError(uiMessage("app.configureABackgroundInToolSetupBeforeAddingThis"))
      return
    }
    if (preset.tool && !target) {
      setValidationError(uiMessage("app.requireToolInstance", { value1: preset.tool }))
      return
    }
    const id = nextStepId(preset.prefix, steps)
    const newStep = createPresetStep(preset.value, id, target ?? '')
    if (newStep.type === 'bg-interaction' && newStep.operation.kind === 'command' &&
      workflowDraft.tool_instances.find(instance => instance.id === workflowDraft.backgrounds?.find(b => b.id === target)?.tool_instance_id)?.tool === 'serial') {
      newStep.operation = { kind: 'command', command: 'serial-send', wait_for_completion: false,
        arguments: { tx_format: 'text', tx_value: '' } }
    }
    updateSteps(current => {
      const currentParent = parentId === null ? null : allWorkflowSteps(current).find(step => step.id === parentId)
      const currentSiblings = currentParent?.type === 'if'
        ? branch === 'else' ? currentParent.else_steps : currentParent.then_steps
        : currentParent?.type === 'for' || currentParent?.type === 'while' ? currentParent.steps : current
      if (index > currentSiblings.length) return current
      return replaceSiblings(current, parentId,
        [...currentSiblings.slice(0, index), newStep, ...currentSiblings.slice(index)], branch)
    })
    setSelectedStepId(id)
    setSelectedPaletteStep(null)
    if (parentId) revealSequencePath(steps, parentId, true, branch)
  }, [workflowDraft, updateSteps, setSelectedStepId, revealSequencePath])

  const addStep = useCallback((preset: StepPresetOption) => {
    if (!workflowDraft) return
    const steps = workflowDraft.workflow.steps
    const selected = allWorkflowSteps(steps).find(step => step.id === selectedStepId)
    const container = selected?.type === 'if'
      ? { parentId: selected.id, branch: preferredIfBranch.id === selected.id ? preferredIfBranch.branch : 'then' as StepBranch }
      : selected?.type === 'for' || selected?.type === 'while'
        ? { parentId: selected.id, branch: null }
        : selectedStepId
          ? (stepContainer(steps, selectedStepId) ?? { parentId: null, branch: null })
          : { parentId: null, branch: null }
    const parent = container.parentId === null ? null : allWorkflowSteps(steps).find(step => step.id === container.parentId)
    const siblings = parent?.type === 'if'
      ? container.branch === 'else' ? parent.else_steps : parent.then_steps
      : parent?.type === 'for' || parent?.type === 'while' ? parent.steps : steps
    const selectedIndex = siblings.findIndex(step => step.id === selectedStepId)
    insertStepAt(preset, { ...container, index: selectedIndex < 0 ? siblings.length : selectedIndex + 1 })
  }, [workflowDraft, selectedStepId, preferredIfBranch, insertStepAt])

  const finishPaletteDrag = useCallback(() => {
    const drag = paletteDragRef.current
    paletteDragRef.current = null
    sequenceEditorRef.current?.clearPaletteDrop()
    if (drag?.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
  }, [])

  const deleteStep = useCallback(
    (stepId: string) => {
      if (stepEditingBusyRef.current || runInFlightRef.current || !workflowDraft) return
      const ids = selection.ids.includes(stepId) ? selection.ids : [stepId]
      updateSteps(steps => deleteSteps(steps, ids))
      setStepSelection(current => reconcileSelection(deleteSteps(workflowDraft.workflow.steps, ids), current))
    },
    [updateSteps, workflowDraft, selection],
  )

  const clearWorkflow = useCallback(async () => {
    if (!workflowDraft || workflowDraft.workflow.steps.length === 0 || stepEditingBusyRef.current || runInFlightRef.current) {
      return
    }

    const approved = await confirm(
      t("app.clearWorkflowConfirm"),
      { title: t("app.clearWorkflow"), kind: 'warning', okLabel: t("app.clear"), cancelLabel: t("app.cancel") },
    )
    if (!approved) {
      return
    }

    if (stepEditingBusyRef.current || runInFlightRef.current) return
    updateSteps(() => [])
    setSelectedStepId(null)
  }, [updateSteps, workflowDraft, t])

  const updateStep = useCallback(
    (stepId: string, update: (step: WorkflowStep) => WorkflowStep) => {
      updateSteps(steps => mapWorkflowSteps(steps, step => step.id === stepId ? update(step) : step))
    },
    [updateSteps],
  )

  const saveEditedStepId = useCallback((oldId: string) => {
    if (!workflowDraft || stepEditingBusyRef.current || runInFlightRef.current) return
    const result = renameStepId(workflowDraft.workflow.steps, oldId, stepIdDraft)
    if (result.error) {
      setStepIdEditError(result.error === 'duplicate' ? t("app.duplicateStepID")
        : result.error === 'invalid' ? t("app.invalidStepID") : t("app.missingStepID"))
      return
    }
    if (result.steps !== workflowDraft.workflow.steps) {
      updateSteps(() => result.steps)
      const mapped = (id: string | null) => id === oldId ? stepIdDraft : id
      setStepSelection(current => ({
        ids: current.ids.map(id => mapped(id)!),
        active: mapped(current.active),
        anchor: mapped(current.anchor),
      }))
      setCollapsedStepIds(current => new Set([...current].map(id => mapped(id)!)))
      setCollapsedBranches(current => new Set([...current].map(key => key.startsWith(`${oldId}:`)
        ? `${stepIdDraft}${key.slice(oldId.length)}` : key)))
      setPreferredIfBranch(current => current.id === oldId ? { ...current, id: stepIdDraft } : current)
      setInteractionCommandDrafts(current => {
        const renamed: Record<string, InteractionCommandDrafts> = {}
        for (const [id, commands] of Object.entries(current)) {
          renamed[id === oldId ? stepIdDraft : id] = Object.fromEntries(Object.entries(commands).map(([kind, operation]) => [
            kind,
            operation.command === 'software-trigger' || !operation.bindings ? operation : {
              ...operation,
              bindings: Object.fromEntries(Object.entries(operation.bindings).map(([key, value]) =>
                [key, renameStepReferenceInInput(value, oldId, stepIdDraft)])),
            },
          ]))
        }
        return renamed
      })
      if (pastedStepIdsRef.current.delete(oldId)) pastedStepIdsRef.current.add(stepIdDraft)
    }
    setEditingStepId(null)
    setStepIdEditError(null)
  }, [workflowDraft, stepIdDraft, updateSteps, t])

  const updateToolArgument = useCallback(
    (stepId: string, name: string, value: number | 'all') => {
      updateStep(stepId, (step) => {
        if (step.type !== 'tool-action') {
          return step
        }

        const bindings = { ...step.bindings }
        delete bindings[name]
        const updated: ToolActionStep = {
          ...step,
          arguments: {
            ...step.arguments,
            [name]: value,
          },
          bindings,
        }
        if (Object.keys(bindings).length === 0) delete updated.bindings
        return updated
      })
    },
    [updateStep],
  )

  const updateSetpointValue = useCallback(
    (stepId: string, name: PowerSetpoint, value: InputValueWire) => {
      updateStep(stepId, (step) => {
        if (step.type !== 'tool-action') {
          return step
        }
        const bindings = { ...step.bindings }
        const arguments_ = { ...step.arguments }
        if (value.source === 'literal' && typeof value.value === 'number') {
          arguments_[name] = value.value
          delete bindings[name]
        } else {
          bindings[name] = value
        }
        const updated: ToolActionStep = { ...step, arguments: arguments_, bindings }
        if (Object.keys(bindings).length === 0) {
          delete updated.bindings
        }
        return updated
      })
    },
    [updateStep],
  )

  const moveStep = useCallback(
    (stepId: string, offset: -1 | 1) => {
      if (stepEditingBusyRef.current || runInFlightRef.current || !workflowDraft) return
      const ids = selection.ids.includes(stepId) ? selection.ids : [stepId]
      if (!canMoveSteps(workflowDraft.workflow.steps, ids, offset)) return
      updateSteps(steps => moveSteps(steps, ids, offset))
    },
    [updateSteps, selection, workflowDraft],
  )

  const reorderStep = useCallback((ids: string[], parentId: string | null, index: number, branch: StepBranch | null = null) => {
    if (stepEditingBusyRef.current || runInFlightRef.current || !workflowDraft) return
    if (relocateSteps(workflowDraft.workflow.steps, ids, parentId, index, branch) === workflowDraft.workflow.steps) return
    updateSteps(steps => relocateSteps(steps, ids, parentId, index, branch))
  }, [updateSteps, workflowDraft])

  function handleStepClipboard(event: React.KeyboardEvent<HTMLElement>) {
    const shortcut = stepClipboardShortcut(event, activeTab === 'workflow', isEditableTarget(event.target))
    if (!shortcut || event.defaultPrevented || !workflowDraft) return
    if (shortcut === 'select-all') {
      event.preventDefault()
      setStepSelection(selectAllSteps(workflowDraft.workflow.steps, selection))
      return
    }
    if (shortcut === 'copy' || shortcut === 'cut') {
      if (!selection.ids.length || (shortcut === 'cut' && (stepEditingBusyRef.current || runInFlightRef.current))) return
      event.preventDefault()
      stepClipboardRef.current = copySteps(workflowDraft.workflow.steps, selection)
      stepClipboardCutRef.current = shortcut === 'cut'
      if (shortcut === 'cut') deleteStep(selection.active!)
    } else if (shortcut === 'delete') {
      if (!selection.active || stepEditingBusyRef.current || runInFlightRef.current) return
      event.preventDefault()
      deleteStep(selection.active)
    } else {
      if (stepEditingBusyRef.current || runInFlightRef.current || !stepClipboardRef.current.length) return
      event.preventDefault()
      const pasted = pasteSteps(workflowDraft.workflow.steps, stepClipboardRef.current, selection,
        pastedStepIdsRef.current, stepClipboardCutRef.current,
        preferredIfBranch.id === selection.active ? preferredIfBranch.branch : 'then')
      stepClipboardCutRef.current = false
      for (const step of allWorkflowSteps(pasted.steps)) pastedStepIdsRef.current.add(step.id)
      updateSteps(() => pasted.steps)
      setStepSelection(pasted.selection)
      if (pasted.selection.active) revealSequencePath(pasted.steps, pasted.selection.active)
    }
  }

  const validateDraft = useCallback(async () => {
    if (!workflowDraft) {
      return
    }

    clearRunFeedback()
    let templateJson: string
    try {
      templateJson = templateDraftJson(workflowDraft, chartPanels, saveChartsWithTemplate)
    } catch (error) {
      clearValidation()
      const message = error instanceof Error ? error.message : String(error)
      setValidationIssue({ step_id: null, message })
      setValidationError(message)
      return
    }
    const generation = validationGenerationRef.current + 1
    try {
      const canonicalJson = await validateTemplate(templateJson)
      if (generation !== validationGenerationRef.current) return
      const canonicalDraft = workflowOnlyDraft(JSON.parse(canonicalJson) as WorkflowDraft)
      setWorkflowDraft(canonicalDraft)
      setStepSelection(current => reconcileSelection(canonicalDraft.workflow.steps, current))
      setValidationStatus('valid')
    } catch {
      // validateTemplate presents the authoritative Core error.
    }
  }, [workflowDraft, chartPanels, saveChartsWithTemplate, validateTemplate, clearValidation, clearRunFeedback])

  const handleLoadTemplate = useCallback(async () => {
    validationGenerationRef.current++
    setTemplateIoStatus('loading')
    setTemplateIoError(null)
    setTemplateIoMessage(null)
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: t('app.jsonTemplate'), extensions: ['json'] }],
      })
      if (!path || Array.isArray(path)) {
        setTemplateIoStatus('idle')
        return
      }
      const loadedDraft = await prepareLastRunReplacement(
        async () => JSON.parse(await invoke<string>('load_workflow_template', { path })) as WorkflowDraft,
        runIdRef.current,
        async runId => { await invoke('clear_last_run', { runId }) },
      )
      runGenerationRef.current += 1
      runIdRef.current = null
      setWorkflowDraft(workflowOnlyDraft(loadedDraft))
      setInteractionCommandDrafts({})
      setTemplateUiGeneration(current => current + 1)
      setUnavailableCategoriesExpanded(false)
      setExpandedToolIds([])
      setCollapsedStepIds(new Set())
      setCollapsedBranches(new Set())
      setSaveChartsWithTemplate(loadedDraft.output_views !== undefined)
      setExecutionMode(DEFAULT_EXECUTION_MODE)
      setPowersStatuses({})
      setSelectedStepId(null)
      setSelectedPaletteStep(null)
      clearValidation()
      setValidationStatus('valid')
      setRunMetadata(null)
      setLastRunExecutionMode(null)
      setExecutionPage(null)
      setMessagePage(null)
      setRunWorkflowSnapshot(null)
      setChartPanels(loadedDraft.output_views ? savedChartsToPanels(loadedDraft.output_views.charts) : [])
      setExecutionOffset(0)
      setWorkflowChangedSinceRun(false)
      setCsvStreamStatus(null)
      clearRunFeedback()
      const fileErrors = allWorkflowSteps(loadedDraft.workflow.steps).some(step =>
        (step.type === 'tool-action' && step.action === 'send-file' &&
          loadedDraft.tool_instances.some(instance => instance.id === step.target && instance.tool === 'serial')) ||
        (step.type === 'bg-interaction' && step.operation.kind === 'command' && step.operation.command === 'serial-send-file'))
        ? await invoke<string[]>('check_serial_send_files', { templateJson: JSON.stringify(loadedDraft) }) ?? []
        : []
      setTemplateIoMessage(fileErrors.length > 0
        ? uiMessage("app.templateFileWarning", { value1: fileErrors.join('\n') })
        : uiMessage("app.templateLoaded"))
      setTemplateIoStatus('idle')
    } catch (message) {
      setTemplateIoError(String(message))
      setTemplateIoStatus('idle')
    }
  }, [clearValidation, clearRunFeedback, t])

  const handleSaveTemplate = useCallback(async () => {
    if (!workflowDraft) {
      return
    }

    setTemplateIoStatus('saving')
    setTemplateIoError(null)
    setTemplateIoMessage(null)
    try {
      const path = await save({
        filters: [{ name: t('app.jsonTemplate'), extensions: ['json'] }],
      })
      if (!path) {
        setTemplateIoStatus('idle')
        return
      }
      const canonicalJson = await invoke<string>('save_workflow_template', {
        path,
        templateJson: templateDraftJson(workflowDraft, chartPanels, saveChartsWithTemplate),
      })
      const canonicalDraft = workflowOnlyDraft(JSON.parse(canonicalJson) as WorkflowDraft)
      setWorkflowDraft(canonicalDraft)
      setStepSelection(current => reconcileSelection(canonicalDraft.workflow.steps, current))
      clearValidation()
      setValidationStatus('valid')
      setTemplateIoMessage(uiMessage("app.templateSaved"))
      setTemplateIoStatus('idle')
    } catch (message) {
      setTemplateIoError(String(message))
      setTemplateIoStatus('idle')
    }
  }, [workflowDraft, chartPanels, saveChartsWithTemplate, clearValidation, t])

  const handleBrowseToolExecutable = useCallback(
    async (toolId: string) => {
      if (toolConfigBusy !== null) {
        return
      }

      setToolConfigBusy(toolId)
      setToolConfigError(null)
      try {
        const selected = await open({
          multiple: false,
          directory: false,
          filters: [{ name: t('app.executables'), extensions: ['exe'] }],
        })
        if (!selected || Array.isArray(selected)) {
          return
        }
        await invoke('set_tool_executable', { toolId, path: selected })
        await refresh()
      } catch (message) {
        setToolConfigError(String(message))
      } finally {
        setToolConfigBusy(null)
      }
    },
    [refresh, toolConfigBusy, t],
  )

  const handleResetToolExecutable = useCallback(
    async (toolId: string) => {
      if (toolConfigBusy !== null) {
        return
      }

      setToolConfigBusy(toolId)
      setToolConfigError(null)
      try {
        await invoke('reset_tool_executable', { toolId })
        await refresh()
      } catch (message) {
        setToolConfigError(String(message))
      } finally {
        setToolConfigBusy(null)
      }
    },
    [refresh, toolConfigBusy],
  )

  const handleResource = useCallback(async (toolId: string, clear: boolean) => {
    if (toolConfigBusy !== null) {
      return
    }
    setToolConfigBusy(toolId)
    setToolConfigError(null)
    setPowersStatuses(current => {
      const next = { ...current }
      delete next[toolId]
      return next
    })
    try {
      await invoke(clear ? 'remove_live_resource' : 'set_live_resource', {
        instanceId: toolId, ...(clear ? {} : { resource: resourceDrafts[toolId] ?? '', identity: resourceIdentityDrafts[toolId] ?? null, backend: backendDrafts[toolId] ?? 'system' }),
      })
      const [resources, identities, backends] = await Promise.all([
        invoke<Record<string, string>>('get_live_resources'),
        invoke<Record<string, ResourceIdentity>>('get_live_resource_identities'),
        invoke<Record<string, VisaBackend>>('get_live_backends'),
      ])
      setSavedResources(resources)
      setResourceIdentities(identities)
      setSavedBackends(backends)
      setResourceDrafts(current => ({ ...current, [toolId]: resources[toolId] ?? '' }))
      setResourceIdentityDrafts(current => ({ ...current, [toolId]: identities[toolId] ?? null }))
      setBackendDrafts(current => ({ ...current, [toolId]: backends[toolId] ?? 'system' }))
    } catch (message) {
      setToolConfigError(String(message))
    } finally {
      setToolConfigBusy(null)
    }
  }, [resourceDrafts, resourceIdentityDrafts, backendDrafts, toolConfigBusy])

  const refreshPowersStatus = useCallback(async (instanceId: string) => {
    if (powersOperationBusy !== null) return
    setPowersOperationBusy(instanceId)
    setPowersStatuses(current => ({
      ...current,
      [instanceId]: { status: null, error: null, operation: 'refresh', clearPlan: null, clearCompleted: false },
    }))
    try {
      const status = await invoke<PowersProtectionStatus>('refresh_powers_status', { instanceId, executionMode })
      setPowersStatuses(current => ({
        ...current,
        [instanceId]: { status, error: null, operation: null, clearPlan: null, clearCompleted: false },
      }))
    } catch (message) {
      setPowersStatuses(current => ({
        ...current,
        [instanceId]: { status: null, error: String(message), operation: null, clearPlan: null, clearCompleted: false },
      }))
    } finally {
      setPowersOperationBusy(null)
    }
  }, [executionMode, powersOperationBusy])

  const clearPowersProtection = useCallback(async (
    instanceId: string,
    channel: PowersProtectionStatus['channels'][number],
  ) => {
    if (powersOperationBusy !== null) return
    const approved = executionMode === 'simulate'
      ? await confirm(
          t("app.simulationClearConfirmation", { value1: instanceId, value2: channel.channel }),
          { title: t("app.generateClearPlan2"), kind: 'info', okLabel: t("app.generatePlan"), cancelLabel: t("app.cancel") },
        )
      : await confirm(
          t("app.liveClearConfirmation", { value1: instanceId, value2: channel.channel, value3: channel.over_voltage_tripped ? t("app.tripped") : t("app.oK"), value4: channel.over_current_tripped ? t("app.tripped") : t("app.oK") }),
          { title: t("app.clearProtection2"), kind: 'warning', okLabel: t("app.clearProtection2"), cancelLabel: t("app.cancel") },
        )
    if (!approved) return
    setPowersOperationBusy(instanceId)
    setPowersStatuses(current => ({
      ...current,
      [instanceId]: { status: current[instanceId]?.status ?? null, error: null, operation: 'clear', clearPlan: null, clearCompleted: false },
    }))
    try {
      const result = await invoke<PowersClearResult>('clear_powers_protection', {
        instanceId, channel: channel.channel, executionMode,
      })
      setPowersStatuses(current => ({
        ...current,
        [instanceId]: result.mode === 'simulate'
          ? { status: current[instanceId]?.status ?? null, error: null, operation: null, clearPlan: { channel: channel.channel }, clearCompleted: false }
          : { status: result.status, error: null, operation: null, clearPlan: null, clearCompleted: true },
      }))
    } catch (message) {
      setPowersStatuses(current => ({
        ...current,
        [instanceId]: { status: current[instanceId]?.status ?? null, error: String(message), operation: null, clearPlan: null, clearCompleted: false },
      }))
    } finally {
      setPowersOperationBusy(null)
    }
  }, [executionMode, powersOperationBusy, t])

  const handleErrorQueue = useCallback(async (toolId: ErrorQueueTool, instanceId: string, savedResource: string | undefined) => {
    if (errorQueueInFlight.current || runInFlightRef.current || stepEditingBusyRef.current || toolConfigBusy !== null) return null
    errorQueueInFlight.current = true
    setErrorQueueBusy(true)
    try {
      if (executionMode === 'live') {
        if (!savedResource?.trim()) return null
        const approved = await confirm(t('app.errorQueueLiveConfirm', { instance: instanceId, resource: savedResource }), {
          title: t('app.readAndDrainErrors'), kind: 'warning', okLabel: t('app.readAndDrainErrors'), cancelLabel: t('app.cancel'),
        })
        if (!approved || runInFlightRef.current) return null
      }
      return await invoke<ErrorQueueResult>('read_and_drain_errors', { toolId, instanceId, executionMode })
    } finally {
      errorQueueInFlight.current = false
      setErrorQueueBusy(false)
    }
  }, [executionMode, toolConfigBusy, t])

  const handleListResources = useCallback(async (instance: ToolInstance) => {
    if (toolConfigBusy !== null) return
    const id = instance.id
    const backend = backendDrafts[id] ?? 'system'
    const request = (discoveryRequests.current[id] ?? 0) + 1
    discoveryRequests.current[id] = request
    setToolConfigBusy(id)
    setDiscoveryErrors(current => ({ ...current, [id]: null }))
    setDiscoveredResources(current => ({ ...current, [id]: undefined }))
    try {
      const resources = await invoke<LiveResourceCandidate[]>('list_live_resources', { toolId: instance.tool, backend })
      if (discoveryRequests.current[id] === request) setDiscoveredResources(current => ({ ...current, [id]: resources }))
    } catch (message) {
      if (discoveryRequests.current[id] === request) setDiscoveryErrors(current => ({ ...current, [id]: String(message) }))
    } finally {
      setToolConfigBusy(null)
    }
  }, [toolConfigBusy, backendDrafts])

  useEffect(() => {
    for (const id of Object.keys(discoveryRequests.current)) discoveryRequests.current[id]++
    setDiscoveredResources({})
    setDiscoveryErrors({})
  }, [templateUiGeneration])

  useEffect(() => () => {
    if (progressChannelRef.current) progressChannelRef.current.onmessage = () => {}
  }, [])

  const receiveRunProgress = useCallback((event: DesktopRunEvent, generation = runGenerationRef.current) => {
    if (!isCurrentRunGeneration(generation, runGenerationRef.current)) return
    if (event.type === 'csv-stream') {
      setCsvStreamStatus(event.status)
      return
    }
    if (runIdRef.current !== null && event.run.run_id !== runIdRef.current) return
    runIdRef.current = event.run.run_id
    if (event.run.status === 'running') void sendWorkflowStop()
    setRunMetadata(event.run)
    setStopRequest(current => current && event.completed_step_ids.includes(current.loopId) ? null : current)
  }, [sendWorkflowStop])

  const runLive = useCallback(async () => {
    if (!workflowDraft || !claimRunGate(runInFlightRef)) {
      return
    }
    setLiveConfirmationPending(true)
    clearRunFeedback()
    const validationGeneration = validationGenerationRef.current + 1
    let started = false
    let generation: number | null = null
    let onProgress: Channel<DesktopRunEvent> | undefined
    try {
      if (livePreflight.blocked) return
      try {
        await validateTemplate(JSON.stringify(workflowDraft))
        if (validationGeneration !== validationGenerationRef.current) return
      } catch {
        // validateTemplate presents this error; finally still releases the run gate.
        return
      }
      // Validate before any Last Run state is replaced, so an invalid threshold cannot
      // discard the previous run.
      const chartSampling = chartSamplingOptions.enabled
        ? chartSamplingSnapshot(chartSamplingOptions) : null
      const fitData = chartFitData
      const statuses = await invoke<ToolStatus[]>('get_tool_status')
      setTools(statuses)
      const [bindings, persistedIdentities, persistedBackends] = await Promise.all([
        invoke<Record<string, string>>('get_live_resources'),
        invoke<Record<string, ResourceIdentity>>('get_live_resource_identities'),
        invoke<Record<string, VisaBackend>>('get_live_backends'),
      ])
      const referenced = workflowDraft.tool_instances.filter(instance =>
        workflowDraft.backgrounds?.some(background => background.tool_instance_id === instance.id) ||
        allWorkflowSteps(workflowDraft.workflow.steps).some(step => step.type === 'tool-action' && step.target === instance.id))
      const confirmedResources: Record<string, string> = {}
      const confirmedBackends: Record<string, VisaBackend> = {}
      const resources = referenced.map(instance => {
        if (instance.tool !== 'powers' && instance.tool !== 'meters' && instance.tool !== 'scopes' && instance.tool !== 'serial') throw new Error(`Unsupported tool ${instance.tool} for instance ${instance.id}.`)
        const draftResource = resourceDrafts[instance.id]
        const persistedResource = bindings[instance.id]
        if ((draftResource ?? '') !== (persistedResource ?? '') ||
          (backendDrafts[instance.id] ?? 'system') !== (persistedBackends[instance.id] ?? 'system')) {
          throw new Error(`${instance.id} has unsaved Live Resource or backend changes. Save Resource before running Live.`)
        }
        const resource = bindings[instance.id]
        if (!resource?.trim()) throw new Error(`${instance.id} (${instance.tool}) live resource is not configured.`)
        confirmedResources[instance.id] = resource
        const backend = persistedBackends[instance.id] ?? 'system'
        confirmedBackends[instance.id] = backend
        return formatLiveResourceConfirmation(instance, resource, backend, persistedIdentities[instance.id], t)
      })
      const confirmation = [...resources, t("app.thisWorkflowWillRunExternalToolsInLiveMode")]
      for (const instance of referenced) {
        if (instance.tool === 'meters' && instance.setup.measurement === 'current-dc' && instance.setup.current_terminal === 10) {
          confirmation.push(t("app.currentTerminalWarning", { value1: instance.id }))
        }
      }
      const approved = await confirm(
        confirmation.join('\n\n'),
        { title: t("app.liveExecution"), kind: 'warning', okLabel: t("app.runLive"), cancelLabel: t("app.cancel") },
      )
      if (!approved || validationGeneration !== validationGenerationRef.current) {
        return
      }
      const streamOptions = streamingOptions(
        streamCsv && hasWorkflowOutputs, streamOutputFolder, streamingPage, streamAllPages,
      )
      generation = ++runGenerationRef.current
      const acceptRun = () => {
        if (started) return
        runIdRef.current = null
        const snapshotPages = outputPages(workflowDraft.workflow.steps)
        setRunWorkflowSnapshot(workflowDraft)
        setLastRunExecutionMode('live')
        setRunChartSampling(chartSampling)
        setRunChartFitData(fitData)
        setWorkflowChangedSinceRun(false)
        setSelectedRunPage(snapshotPages[0]?.name ?? 'Results')
        started = true
        setLiveConfirmationPending(false)
        setStopRequest(null)
        resetWorkflowStop()
        setCsvStreamStatus(null)
        setExecutionOffset(0)
        setRunStatus('running')
        setRunMetadata(null)
        setExecutionPage(null)
        setMessagePage(null)
        setRunError(null)
        setShowLastRunError(true)
        setClearLastRunError(null)
      }
      onProgress = new Channel<DesktopRunEvent>(event => {
        if (!isCurrentRunGeneration(generation, runGenerationRef.current)) return
        acceptRun()
        receiveRunProgress(event, generation!)
      })
      progressChannelRef.current = onProgress
      const results = await invoke<RunMetadataDto>('run_workflow_live', {
        templateJson: JSON.stringify(workflowDraft),
        onProgress,
        streamCsv: streamOptions,
        scopesOutputFolder,
        backgroundCsv: backgroundCsvEnabled && workflowDraft.backgrounds?.length ? { output_folder: backgroundCsvFolder ?? 'data', background_id: backgroundCsvTarget === 'all' ? null : backgroundCsvTarget, scopes_format: backgroundCsvMode, serial_format: serialCsvMode } : null,
        confirmedResources,
        confirmedBackends,
      })
      if (isCurrentRunGeneration(generation, runGenerationRef.current)) {
        acceptRun()
        runIdRef.current = results.run_id
        setRunMetadata(results)
      }
    } catch (message) {
      if (generation === null ? validationGeneration === validationGenerationRef.current : isCurrentRunGeneration(generation, runGenerationRef.current)) {
        if (started) setRunError(String(message))
        else if (String(message).startsWith('Live Preflight failed:')) livePreflight.reject(String(message))
        else setLiveStartError(String(message))
      }
    } finally {
      if (onProgress) {
        onProgress.onmessage = () => {}
        if (progressChannelRef.current === onProgress) progressChannelRef.current = null
      }
      if (started && isCurrentRunGeneration(generation, runGenerationRef.current)) {
        setStopRequest(null)
        resetWorkflowStop()
        setRunStatus('idle')
      }
      releaseRunGate(runInFlightRef)
      setLiveConfirmationPending(false)
    }
  }, [resetWorkflowStop, validateTemplate, clearRunFeedback, livePreflight, scopesOutputFolder, resourceDrafts, backendDrafts, workflowDraft, chartSamplingOptions, chartFitData, receiveRunProgress, streamCsv, hasWorkflowOutputs, streamOutputFolder, streamingPage, streamAllPages, backgroundCsvEnabled, backgroundCsvTarget, backgroundCsvFolder, backgroundCsvMode, serialCsvMode, t])

  const runSimulation = useCallback(async () => {
    if (!workflowDraft || !claimRunGate(runInFlightRef)) {
      return
    }

    clearRunFeedback()
    const validationGeneration = validationGenerationRef.current + 1
    const isPreparationCurrent = () => validationGeneration === validationGenerationRef.current
    let started = false
    let generation: number | null = null
    let onProgress: Channel<DesktopRunEvent> | undefined
    try {
      try {
        await validateTemplate(JSON.stringify(workflowDraft))
        if (validationGeneration !== validationGenerationRef.current) return
      } catch {
        // validateTemplate presents this error; finally still releases the run gate.
        return
      }
      const sampleOverrides = await simulationSamples.request(JSON.stringify(workflowDraft), isPreparationCurrent)
      if (sampleOverrides === null || !isPreparationCurrent()) return
      // Validate before any Last Run state is replaced, matching the Live path.
      const chartSampling = chartSamplingOptions.enabled
        ? chartSamplingSnapshot(chartSamplingOptions) : null
      const fitData = chartFitData
      const streamOptions = streamingOptions(
        streamCsv && hasWorkflowOutputs, streamOutputFolder, streamingPage, streamAllPages,
      )
      runIdRef.current = null
      generation = ++runGenerationRef.current
      onProgress = new Channel<DesktopRunEvent>(event => receiveRunProgress(event, generation!))
      progressChannelRef.current = onProgress
      const snapshotPages = outputPages(workflowDraft.workflow.steps)
      setRunWorkflowSnapshot(workflowDraft)
      setLastRunExecutionMode('simulate')
      setRunChartSampling(chartSampling)
      setRunChartFitData(fitData)
      setWorkflowChangedSinceRun(false)
      setSelectedRunPage(snapshotPages[0]?.name ?? 'Results')
      started = true
      setStopRequest(null)
      resetWorkflowStop()
      setCsvStreamStatus(null)
      setExecutionOffset(0)
      setRunStatus('running')
      setRunMetadata(null)
      setExecutionPage(null)
      setMessagePage(null)
      setRunError(null)
      setShowLastRunError(true)
      setClearLastRunError(null)
      const results = await invoke<RunMetadataDto>('run_workflow_simulation', {
        templateJson: JSON.stringify(workflowDraft),
        onProgress,
        streamCsv: streamOptions,
        scopesOutputFolder,
        simulationSamples: sampleOverrides,
        backgroundCsv: backgroundCsvEnabled && workflowDraft.backgrounds?.length ? { output_folder: backgroundCsvFolder ?? 'data', background_id: backgroundCsvTarget === 'all' ? null : backgroundCsvTarget, scopes_format: backgroundCsvMode, serial_format: serialCsvMode } : null,
      })
      if (isCurrentRunGeneration(generation, runGenerationRef.current)) {
        runIdRef.current = results.run_id
        setRunMetadata(results)
      }
    } catch (message) {
      if (generation === null ? validationGeneration === validationGenerationRef.current : isCurrentRunGeneration(generation, runGenerationRef.current)) setRunError(String(message))
    } finally {
      if (onProgress) {
        onProgress.onmessage = () => {}
        if (progressChannelRef.current === onProgress) progressChannelRef.current = null
      }
      if (started && isCurrentRunGeneration(generation, runGenerationRef.current)) {
        setStopRequest(null)
        resetWorkflowStop()
        setRunStatus('idle')
      }
      releaseRunGate(runInFlightRef)
    }
  }, [resetWorkflowStop, validateTemplate, clearRunFeedback, workflowDraft, chartSamplingOptions, chartFitData, receiveRunProgress, streamCsv, hasWorkflowOutputs, streamOutputFolder, streamingPage, streamAllPages, simulationSamples, backgroundCsvEnabled, backgroundCsvTarget, backgroundCsvFolder, backgroundCsvMode, serialCsvMode, scopesOutputFolder])

  const runSelectedMode = useCallback(() => {
    const command = workflowRunCommand(executionMode)
    return command === 'run_workflow_live' ? runLive() : runSimulation()
  }, [executionMode, runLive, runSimulation])

  // Uses the same parser as both run paths, so the button gate and the run-time
  // rejection can never disagree.
  const chartThresholdInvalid = chartSamplingOptions.enabled &&
    Number.isNaN(parseChartThresholdPercent(chartSamplingOptions.threshold))

  const workflowBusy =
    simulationSamples.pending || choosingStreamOutputFolder || chartSaving || liveConfirmationPending || validationStatus === 'validating' || templateIoStatus !== 'idle' || runStatus === 'running' || powersOperationBusy !== null || errorQueueBusy || exporting
  stepEditingBusyRef.current = workflowBusy

  const handleClearLastRun = useCallback(async () => {
    if (!runWorkflowSnapshot || workflowBusy) return
    const approved = await confirm(
      t("app.clearRunConfirmation"),
      { title: t("app.clearLastRun"), kind: 'warning', okLabel: t("app.clear"), cancelLabel: t("app.cancel") },
    )
    if (!approved) return

    setClearLastRunError(null)
    try {
      const runId = runMetadata?.run_id ?? runIdRef.current
      if (runId !== null) await invoke('clear_last_run', { runId })
      runGenerationRef.current += 1
      runIdRef.current = null
      setRunWorkflowSnapshot(null)
      if (!saveChartsWithTemplate) setChartPanels([])
      setRunChartSampling(null)
      setRunChartFitData(false)
      setRunMetadata(null)
      setLastRunExecutionMode(null)
      setExecutionPage(null)
      setMessagePage(null)
      setExecutionOffset(0)
      clearRunFeedback()
      setStopRequest(null)
      resetWorkflowStop()
      setCsvStreamStatus(null)
      setExportError(null)
      setExportMessage(null)
      setWorkflowChangedSinceRun(false)
    } catch (message) {
      setClearLastRunError(uiMessage("app.clearRunFailed", { error: String(message) }))
    }
  }, [runWorkflowSnapshot, runMetadata, workflowBusy, saveChartsWithTemplate, clearRunFeedback, t])

  const csvStreamFeedback = csvStreamStatus && (
    <div className="csv-stream-feedback" role="status">
      <strong>{t("app.streamingCSV")}</strong>
      <p>{csvStreamStatus.path}</p>
      {csvStreamStatus.error ? <p className="error">{t("app.cSVStreamingFailed")}{csvStreamStatus.error}</p>
        : csvStreamStatus.finished && <p className={csvStreamStatus.workflow_succeeded ? 'validation-success' : 'feedback-warning'}>{csvStreamStatus.workflow_succeeded
          ? t("app.cSVStreamedSuccessfully")
          : csvStreamStatus.rows > 0
            ? t("app.streamedCSVContainsCommittedRowsFromThisPartialRun", { value1: runMetadata?.status === 'stopped' ? t("app.workflowStopped") : t("app.workflowDidNotComplete") })
            : t("app.noRowsWereStreamed", { value1: runMetadata?.status === 'stopped' ? t("app.workflowStopped") : t("app.workflowDidNotComplete") })}</p>}
    </div>
  )

  async function selectScopesOutputFolder() {
    setScopesOutputError(null)
    try {
      const folder = await open({ directory: true, multiple: false, title: t("app.selectScopesOutputFolder") })
      if (typeof folder === 'string') setScopesOutputFolder(folder)
    } catch (message) {
      setScopesOutputError(uiMessage("app.couldNotSelectScopesOutputFolderDiagnostic", { error: String(message) }))
    }
  }

  async function selectOutputFolder() {
    setStreamOutputFolderError(null)
    setChoosingStreamOutputFolder(true)
    try {
      const folder = await open({ directory: true, multiple: false, title: t("app.selectCSVOutputFolder") })
      if (typeof folder === 'string') setStreamOutputFolder(folder)
    } catch (message) {
      setStreamOutputFolderError(uiMessage("app.couldNotSelectCSVOutputFolderDiagnostic", { error: String(message) }))
    } finally {
      setChoosingStreamOutputFolder(false)
    }
  }

  const handleExport = useCallback(async () => {
    if (!runMetadata || !hasRunOutputs || !runExportable || !hasExportableOutputRows || workflowBusy) {
      return
    }

    setExporting(true)
    setExportError(null)
    setExportMessage(null)
    try {
      const selectedPath = exportAllPages && exportFormat === 'csv'
        ? await open({ directory: true, multiple: false, title: t("app.exportAllPagesAsCSV") })
        : await save({ filters: [{ name: exportFormat.toUpperCase(), extensions: [exportFormat] }] })
      if (typeof selectedPath !== 'string') {
        return
      }
      await invoke('export_last_run_pages', {
        runId: runMetadata.run_id,
        destinationPath: selectedPath,
        page: exportAllPages ? null : runPage?.name,
        format: exportFormat,
      })
      setExportMessage(partialRun ? uiMessage("app.partialResultsExportedSuccessfully") : uiMessage("app.pagesExportedSuccessfully"))
    } catch (message) {
      setExportError(String(message))
    } finally {
      setExporting(false)
    }
  }, [runMetadata, hasRunOutputs, runExportable, hasExportableOutputRows, workflowBusy, exportAllPages, exportFormat, runPage?.name, partialRun, t])

  const selectedStep = allWorkflowSteps(workflowDraft?.workflow.steps ?? []).find(
    (step) => step.id === selectedStepId,
  )
  const outputNameError = selectedStep?.type === 'output'
    ? selectedStep.name.trim().length === 0
      ? t("app.outputNameMustNotBeBlank")
      : outputSteps.some((step) => step !== selectedStep && step.name === selectedStep.name)
        ? t("app.outputNameMustBeUnique")
        : null
    : null
  const { earlierSteps, earlierVariables } = inputScope(workflowDraft?.workflow.steps ?? [], selectedStepId)
  const selectedParent = enclosingLoop(workflowDraft?.workflow.steps ?? [], selectedStepId)
  const selectedEnclosingForVariables = enclosingForVariables(workflowDraft?.workflow.steps ?? [], selectedStepId)
  const selectedForInsertion = allWorkflowSteps(workflowDraft?.workflow.steps ?? []).find(step => step.id === selectedStepId)
  const insertionContainer = selectedForInsertion?.type === 'if'
    ? { parentId: selectedForInsertion.id,
        branch: preferredIfBranch.id === selectedForInsertion.id ? preferredIfBranch.branch : 'then' as StepBranch }
    : selectedForInsertion?.type === 'for' || selectedForInsertion?.type === 'while'
      ? { parentId: selectedForInsertion.id, branch: null }
      : selectedStepId ? stepContainer(workflowDraft?.workflow.steps ?? [], selectedStepId) : null
  const addingToParent = insertionContainer?.parentId
    ? allWorkflowSteps(workflowDraft?.workflow.steps ?? []).find(step => step.id === insertionContainer.parentId)
    : null
  const insertionTargetId = addingToParent
    ? addingToParent.id.match(new RegExp(`^${addingToParent.type}-(\\d+)$`))?.[1] ?? addingToParent.id
    : null
  const insertionTargetLabel = addingToParent
    ? `${addingToParent.type.toUpperCase()} ${insertionTargetId}${addingToParent.type === 'if'
      ? ` → ${insertionContainer?.branch === 'else' ? 'ELSE' : 'THEN'}` : ''}`
    : t("app.rootWorkflow")
  const insertionDepth = addingToParent ? containerPath(workflowDraft?.workflow.steps ?? [], addingToParent.id).length + 1 : 0
  const selectedPalettePreset = STEP_PRESETS.find(preset => preset.value === selectedPaletteStep)
  const selectedPaletteLocked = selectedPalettePreset?.category === 'Background Workflow'
    ? !workflowDraft?.backgrounds?.length
    : selectedPalettePreset?.category === 'FG/BG Interaction'
      ? !workflowDraft?.backgrounds?.length || !workflowDraft?.workflow.interaction.enabled ||
        (selectedPalettePreset.value.startsWith('bg-get-buffer-') && !workflowDraft?.workflow.interaction.buffer.enabled)
      : selectedPalettePreset?.tool
      ? !workflowDraft?.tool_instances.some(instance => instance.tool === selectedPalettePreset.tool)
      : false
  const selectedPaletteTooDeep = insertionDepth >= 8 && (selectedPaletteStep === 'for' ||
    selectedPaletteStep === 'while' || selectedPaletteStep === 'if')
  const selectedValue = selectedStep?.type === 'output' || selectedStep?.type === 'set-variable'
    ? selectedStep.value : null
  const selectedCompatiblePages = selectedStep?.type === 'output'
    ? compatibleOutputPages(workflowDraft?.workflow.steps ?? [], selectedStep.id) : []
  const selectedToolAction = selectedStep?.type === 'tool-action' ? selectedStep : null
  const selectedAction = selectedToolAction
    ? `${workflowDraft?.tool_instances.find(instance => instance.id === selectedToolAction.target)?.tool}/${selectedToolAction.action}`
    : null
  const paletteCategories = STEP_CATEGORIES.map(({ category, tool }) => ({
    category,
    locked: category === 'Background Workflow' ? !workflowDraft?.backgrounds?.length
      : category === 'FG/BG Interaction'
        ? !workflowDraft?.backgrounds?.length || !workflowDraft?.workflow.interaction.enabled
        : tool !== null && !workflowDraft?.tool_instances.some(instance => instance.tool === tool),
  }))
  const availablePaletteCategories = paletteCategories.filter(item => !item.locked)
  const unavailablePaletteCategories = paletteCategories.filter(item => item.locked)

  function renderPaletteCategories(categories: typeof paletteCategories) {
    return categories.map(({ category, locked }) => {
      const presets = STEP_PRESETS.filter(preset => preset.category === category)
      const expanded = !locked && expandedStepCategories[category]
      return (
        <section key={category}>
          <h4>
            <button type="button" className="step-category-header"
              disabled={locked}
              aria-expanded={expanded}
              aria-describedby={locked ? `step-category-${category}-hint` : undefined}
              onClick={() => setExpandedStepCategories(current => ({
                ...current, [category]: !current[category],
              }))}>
              {t(STEP_CATEGORY_KEYS[category])}
              <span aria-hidden="true">{locked ? '🔒' : expanded ? '−' : '+'}</span>
            </button>
          </h4>
          {locked && <p className="step-category-hint" id={`step-category-${category}-hint`}>
            {category === 'Background Workflow'
               ? t("app.noBackgroundBindingEnableABackgroundInToolSetup")
               : category === 'FG/BG Interaction'
                 ? !workflowDraft?.backgrounds?.length
                   ? t("app.noBackgroundBindingEnableBackgroundStreamingInSetup")
                   : t("app.enableFGBGInteractionInTheWorkflowSidebar")
                 : t("app.noToolInstanceAddOneInSetup", { value1: category })}
          </p>}
          {expanded && <div className="step-palette-items">
            {presets.map((preset) => (
              <button
                key={preset.value}
                className="action-button step-palette-button"
                type="button"
                title={`${preset.fullLabel ?? preset.label}\n${t(`steps.hint.${preset.value}`)}`}
                aria-pressed={selectedPaletteStep === preset.value}
                onPointerDown={event => {
                  if (workflowBusy || event.button !== 0 || paletteDragRef.current) return
                  suppressPaletteClickRef.current = null
                  event.currentTarget.setPointerCapture(event.pointerId)
                  paletteDragRef.current = {
                    preset: preset.value, pointerId: event.pointerId, handle: event.currentTarget,
                    startX: event.clientX, startY: event.clientY, started: false,
                  }
                }}
                onPointerMove={event => {
                  const drag = paletteDragRef.current
                  if (!drag || drag.pointerId !== event.pointerId || workflowBusy) return
                  if (!drag.started && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 5) {
                    drag.started = true
                  }
                  if (drag.started) sequenceEditorRef.current?.updatePaletteDrop(event.clientX, event.clientY,
                    drag.preset === 'for' || drag.preset === 'while' || drag.preset === 'if')
                }}
                onPointerUp={event => {
                  const drag = paletteDragRef.current
                  if (!drag || drag.pointerId !== event.pointerId) return
                  const location = drag.started && !workflowBusy
                    ? sequenceEditorRef.current?.finishPaletteDrop(event.clientX, event.clientY,
                        drag.preset === 'for' || drag.preset === 'while' || drag.preset === 'if') : null
                  if (drag.started) suppressPaletteClickRef.current = drag.preset
                  finishPaletteDrag()
                  if (location) insertStepAt(preset, location)
                }}
                onPointerCancel={finishPaletteDrag}
                onLostPointerCapture={finishPaletteDrag}
                onClick={event => {
                  if (event?.detail === 0 || suppressPaletteClickRef.current !== preset.value) {
                    setSelectedPaletteStep(preset.value)
                  }
                  suppressPaletteClickRef.current = null
                }}
                disabled={workflowBusy || (preset.value.startsWith('bg-get-buffer-') && !workflowDraft?.workflow.interaction.buffer.enabled)}
              >
                {preset.label}
              </button>
            ))}
          </div>}
        </section>
      )

    })
  }

  const selectedPowersAction =
    selectedAction === 'powers/set-output' ||
    selectedAction === 'powers/measure' ||
    selectedAction === 'powers/output-on' ||
    selectedAction === 'powers/output-off'
  const selectedPowersModel = executionMode === 'simulate' ? 'simulator'
    : selectedToolAction ? resourceIdentityDrafts[selectedToolAction.target]?.model_id : undefined
  const selectedPowersCapabilities = powersCapabilityChannels?.key === powersCapabilityKey && selectedPowersModel
    ? powersCapabilityChannels.models[selectedPowersModel] : undefined
  const selectedPowersChannels = selectedPowersCapabilities?.status === 'ready' ? selectedPowersCapabilities.channels : []
  const powersChannelHint = !selectedPowersModel
    ? t("app.channelCapabilitiesUnavailableSelectOrRefreshASupportedLive")
    : !selectedPowersCapabilities ? t("app.loadingChannelCapabilities")
    : selectedPowersCapabilities.status === 'error' ? t("app.channelCapabilitiesQueryFailedCheckTheConfiguredPowersTool")
    : selectedPowersChannels.length === 0 ? t("app.noSupportedChannelsWereReturnedForTheCurrentModel") : null
  const channelBound = selectedToolAction?.bindings?.channel !== undefined
  const savedChannel = selectedToolAction?.arguments.channel
  const savedChannelSupported = typeof savedChannel === 'number' && selectedPowersChannels.includes(savedChannel)
  const powersChannelSelector = selectedToolAction && <>
    <label className="step-property-field">
      <span className="step-property-label">{t("app.channel")}</span>
      <select aria-label={t("app.channel")} value={channelBound || savedChannel === undefined ? '' : String(savedChannel)}
        disabled={workflowBusy || selectedPowersChannels.length === 0}
        onChange={event => {
          const channel = Number(event.target.value)
          if (isPositiveInteger(channel) && selectedPowersChannels.includes(channel)) {
            updateToolArgument(selectedToolAction.id, 'channel', channel)
          }
        }}>
        <option value="" disabled>{channelBound ? t("app.boundChannelPreserved") : t("app.selectAChannel")}</option>
        {!channelBound && savedChannel !== undefined && !savedChannelSupported && (
          <option value={String(savedChannel)} disabled>
            {t("app.cH")}{String(savedChannel)} ({selectedPowersCapabilities?.status === 'ready' ? t("app.notSupported") : t("app.unconfirmed")})
          </option>
        )}
        {selectedPowersChannels.map(channel => <option key={channel} value={channel}>{t("app.cH")}{channel}</option>)}
      </select>
    </label>
    {powersChannelHint && <p className="value-source-help">{powersChannelHint}</p>}
    {channelBound
      ? <p className="value-source-help">{t("app.channelBindingPreservedSelectAFixedChannelToReplace")}</p>
      : savedChannel !== undefined && !savedChannelSupported && <p className="value-source-help">
          {t("app.savedChannel")}{String(savedChannel)} {t("app.preserved")}{selectedPowersCapabilities?.status === 'ready'
            ? t("app.notSupportedByTheCurrentModel") : t("app.supportCannotBeConfirmed")}
        </p>}
  </>

  return (
    <main className="app">
      <header className="app-header">
        <div className="app-brand">
          <h1>{t("app.orchestratorTool")}</h1>
          {applicationVersion && (
            <p className="app-version">{t("app.v")}{applicationVersion}</p>
          )}
        </div>
        <div className="appearance-control" role="group" aria-label={t("app.interfacePreferences")}>
          <div className="header-control">
            <span>{t("app.appearance")}</span>
            <button className="action-button" type="button"
              aria-label={t("app.switchThemeTo", { value1: nextThemeLabel })} title={t("app.switchThemeTo", { value1: nextThemeLabel })}
              onClick={() => setThemePreference(nextThemePreference)}>
              ◐ {themeLabel(themePreference)}
            </button>
          </div>
          <div className="header-control">
            <span>{t("app.language")}</span>
            <button className="action-button locale-button" type="button" data-locale-switch
              aria-label={t('preferences.switchLanguage')} title={t('preferences.switchLanguage')}
              onClick={() => setLocale(locale === 'en' ? 'zh-TW' : 'en')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" />
              </svg>
              {locale === 'en' ? 'English' : '繁體中文'}
            </button>
          </div>
          <div className="header-control">
            <span>{t("app.helpSection")}</span>
            <button className="action-button" type="button" onClick={() => void handleOpenHelp()}>
              {t("app.help")}
            </button>
          </div>
        </div>
      </header>

      <div className="template-toolbar" role="group" aria-label={t("app.applicationActions")}>
        <div className="template-actions" role="group" aria-label={t("app.templateActions")}>
          <span className="toolbar-group-label">{t("app.templateActions")}</span>
          <div className="template-action-buttons">
            <button
              className="action-button"
              type="button"
              onClick={() => void createDraft()}
              disabled={workflowBusy}
            >
              {t("app.newTemplate")}</button>
            <button
              className="action-button"
              type="button"
              onClick={() => void handleLoadTemplate()}
              disabled={workflowBusy}
            >
              {t("app.openTemplate")}</button>
            <button
              className="action-button"
              type="button"
              onClick={() => void handleSaveTemplate()}
              disabled={!workflowDraft || workflowBusy}
            >
              {t("app.saveTemplate")}</button>
          </div>
        </div>
        <div className="execution-mode-control" aria-label={t("app.desktopExecutionMode")}>
          <span>{t("app.executionMode")}</span>
          <div className="execution-mode-options" role="group" aria-label={t("app.executionMode")}>
            {(['simulate', 'live'] as const).map(mode => (
              <button
                key={mode}
                className={`execution-mode-button execution-mode-${mode} ${executionMode === mode ? 'execution-mode-selected' : ''}`}
                type="button"
                aria-pressed={executionMode === mode}
                disabled={workflowBusy}
                onClick={() => {
                  if (mode !== executionMode) validationGenerationRef.current++
                  setExecutionMode(mode)
                  setPowersStatuses({})
                }}
              >
                {mode === 'simulate' ? t("app.simulation") : t("app.live")}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className={`execution-mode-banner execution-mode-${executionMode}`} role="status">
        {executionModeLabel(executionMode, t)}
      </p>

      {helpError && <p className="error" role="alert">{t("app.failedToOpenHelp")}{helpError}</p>}

      {templateIoStatus === 'saving' && <p role="status">{t("app.saving")}</p>}
      {templateIoStatus === 'loading' && <p role="status">{t("app.loading")}</p>}

      {templateIoMessage && templateIoStatus === 'idle' && (
        <p className="validation-success" role="status">
          {templateIoMessage}
        </p>
      )}

      {templateIoError && (
        <p className="error" role="alert">
          {t("app.templateIOFailed")}{templateIoError}
        </p>
      )}

      {draftLoading && <p>{t("app.creatingTemplateDraft")}</p>}

      {draftCreationError && (
        <p className="error" role="alert">
          {t("app.failedToCreateTemplateDraft")}{draftCreationError}
        </p>
      )}

      <nav className="tabs" role="tablist" aria-label={t("app.desktopSections")}>
        <button
          id="tools-tab"
          className={`tab ${activeTab === 'tools' ? 'tab-active' : ''}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'tools'}
          aria-controls="tools-panel"
          disabled={chartSaving}
          onClick={() => setActiveTab('tools')}
        >
          {t("app.tools")}</button>
        <button
          id="setup-tab"
          className={`tab ${activeTab === 'setup' ? 'tab-active' : ''}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'setup'}
          aria-controls="setup-panel"
          disabled={chartSaving}
          onClick={() => setActiveTab('setup')}
        >
          {t("app.setup")}</button>
        <button
          id="workflow-tab"
          className={`tab ${activeTab === 'workflow' ? 'tab-active' : ''}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'workflow'}
          aria-controls="workflow-panel"
          disabled={chartSaving}
          onClick={() => setActiveTab('workflow')}
        >
          {t("app.workflow")}</button>
        <button
          id="output-tab"
          className={`tab ${activeTab === 'output' ? 'tab-active' : ''}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'output'}
          aria-controls="output-panel"
          disabled={chartSaving}
          onClick={() => setActiveTab('output')}
        >
          {t("app.output")}</button>
      </nav>

      {activeTab === 'tools' && (
        <section id="tools-panel" role="tabpanel" aria-labelledby="tools-tab">
          <div className="section-header">
            <h2>{t("app.externalTools")}</h2>
            <div className="tool-actions">
              <div className="tool-action-choice">
              <label className="step-property-label" htmlFor="tool-to-add">{t("app.toolToAdd")}</label>
              <select id="tool-to-add" value={selectedToolToAdd}
                onChange={event => setToolToAdd(event.target.value)}
                disabled={loading || toolConfigBusy !== null || workflowBusy || unconfiguredTools.length === 0}>
                {unconfiguredTools.length === 0 && <option value="">{t("app.noToolsToAdd")}</option>}
                {unconfiguredTools.map(tool => <option key={tool.tool_id} value={tool.tool_id}>{tool.tool_id[0].toUpperCase() + tool.tool_id.slice(1)}</option>)}
              </select>
              </div>
              <button className="action-button" type="button"
                disabled={loading || toolConfigBusy !== null || workflowBusy || !selectedToolToAdd}
                onClick={() => { if (selectedToolToAdd) void handleBrowseToolExecutable(selectedToolToAdd) }}>
                {t("app.add")}</button>
              <button
                className="action-button"
                type="button"
                onClick={() => void refresh()}
                disabled={loading || toolConfigBusy !== null}
              >
                {t("app.refresh")}</button>
            </div>
          </div>

          {error && (
            <p className="error" role="alert">
              {t("app.failedToLoadToolStatus")}{error}
            </p>
          )}

          {toolConfigError && (
            <p className="error" role="alert">
              {t("app.failedToUpdateToolConfiguration")}{toolConfigError}
            </p>
          )}

          {loading && tools.length === 0 && !error && <p>{t("app.loadingToolStatus")}</p>}

          {!error && !loading && configuredTools.length === 0 && <p>{t("app.noExternalToolsConfigured")}</p>}

          {!error && configuredTools.length > 0 && (
            <ul className="tool-list">
              {configuredTools.map((tool) => (
                <li key={tool.tool_id} className="tool-card">
                  <div className="tool-title">
                    <span>
                      <button type="button" className="action-button tool-setup-toggle"
                        aria-expanded={expandedToolIds.includes(tool.tool_id)}
                        aria-label={t("app.details", { value1: expandedToolIds.includes(tool.tool_id) ? t("app.collapse") : t("app.expand"), value2: tool.tool_id })}
                        onClick={() => setExpandedToolIds(current => current.includes(tool.tool_id)
                          ? current.filter(id => id !== tool.tool_id) : [...current, tool.tool_id])}>
                        {expandedToolIds.includes(tool.tool_id) ? '−' : '+'}
                      </button><span className="tool-id">{tool.tool_id}</span>
                    </span>
                    <span className={`status status-${tool.executable_status}`}>
                      {EXECUTABLE_LABELS[tool.executable_status] ?? tool.executable_status}
                    </span>
                  </div>
                  <div hidden={!expandedToolIds.includes(tool.tool_id)}>
                  <dl className="tool-details">
                    <div className="detail-row">
                      <dt className="detail-label">{t("app.executable")}</dt>
                      <dd className="detail-value">
                        {EXECUTABLE_LABELS[tool.executable_status] ?? tool.executable_status}
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt className="detail-label">{t("app.compatibility")}</dt>
                      <dd className={`detail-value compatibility-${tool.compatibility}`}>
                        {COMPATIBILITY_LABELS[tool.compatibility] ?? tool.compatibility}
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt className="detail-label">{t("app.version")}</dt>
                      <dd className="detail-value">{tool.tool_version ?? '—'}</dd>
                    </div>
                    <div className="detail-row">
                      <dt className="detail-label">{t("app.workerSchema")}</dt>
                      <dd className="detail-value">
                        {formatWorkerSchemas(tool.worker_schema_versions)}
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt className="detail-label">{t("app.source")}</dt>
                      <dd className="detail-value">
                        {tool.source ? (SOURCE_LABELS[tool.source] ?? tool.source) : '—'}
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt className="detail-label">{t("app.path")}</dt>
                      <dd className="detail-value tool-path">{tool.path ?? '—'}</dd>
                    </div>
                    {tool.reason && (
                      <div className="detail-row">
                        <dt className="detail-label">{t("app.reason")}</dt>
                        <dd className="detail-value tool-reason">{tool.reason}</dd>
                      </div>
                    )}
                  </dl>
                  <div className="tool-actions">
                    <button
                      className="action-button"
                      type="button"
                      onClick={() => void handleBrowseToolExecutable(tool.tool_id)}
                      disabled={toolConfigBusy !== null || workflowBusy || loading}
                    >
                      {t("app.changePath")}</button>
                    <button
                      className="action-button"
                      type="button"
                      onClick={() => void handleResetToolExecutable(tool.tool_id)}
                      disabled={toolConfigBusy !== null || workflowBusy || loading}
                    >
                      {t("app.removeTool")}</button>
                  </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

        <section id="setup-panel" role="tabpanel" aria-labelledby="setup-tab" hidden={activeTab !== 'setup'}>
          <div className="section-header">
            <h2>{t("app.setup")}</h2>
          </div>
          {error && <p className="error" role="alert">{t("app.failedToLoadToolConfiguration")}{error}</p>}
          {workflowDraft && (
            <>
              {toolConfigError && <p className="error" role="alert">{t("app.failedToUpdateToolConfiguration2")}{toolConfigError}</p>}
              <ToolSetupEditor
                key={templateUiGeneration}
                value={workflowDraft.tool_instances}
                backgrounds={workflowDraft.backgrounds}
                onBackgroundsChange={backgrounds => {
                  setWorkflowDraft(current => current ? {
                    ...current,
                    backgrounds,
                    workflow: current.backgrounds?.length && !backgrounds.length
                      ? { ...current.workflow, interaction: { ...current.workflow.interaction, enabled: false, buffer: { ...current.workflow.interaction.buffer, enabled: false } } }
                      : current.workflow,
                  } : current)
                  setWorkflowChangedSinceRun(true)
                  clearRunFeedback()
                  clearValidation()
                }}
                configuredToolTypes={configuredToolTypes}
                executionMode={executionMode}
                resourceIdentities={resourceIdentityDrafts}
                metersExecutableKey={metersExecutableKey}
                powersExecutableKey={powersExecutableKey}
                scopesExecutableKey={scopesExecutableKey}
                steps={allWorkflowSteps(workflowDraft.workflow.steps).filter(step => (step.type !== 'for' && step.type !== 'while' && step.type !== 'if'))}
                renderPowersDeviceStatus={instance => {
                  const deviceStatus = powersStatuses[instance.id]
                  const clearPlan = deviceStatus?.clearPlan ?? null
                  const savedResource = savedResources[instance.id]
                  const draftResource = resourceDrafts[instance.id]
                  const resourceReady = !manualOperationRequiresSavedResource(executionMode) ||
                    (Boolean(savedResource?.trim()) && draftResource === savedResource &&
                      (backendDrafts[instance.id] ?? 'system') === (savedBackends[instance.id] ?? 'system'))
                  const operationBusy = powersOperationBusy !== null
                  const unresolved = deviceStatus?.status?.channels.some(channel =>
                    (channel.over_voltage_tripped || channel.over_current_tripped))
                  const outputOn = deviceStatus?.status?.channels.some(channel => channel.output_enabled)
                  const capabilityModel = executionMode === 'simulate' ? 'simulator' : resourceIdentityDrafts[instance.id]?.model_id
                  const capabilityResult = powersCapabilityChannels?.key === powersCapabilityKey && capabilityModel
                    ? powersCapabilityChannels.models[capabilityModel] : undefined
                  const capabilityChannels = capabilityResult?.status === 'ready' ? capabilityResult.channels : []
                  const statusChannels = protectionChannelNumbers(
                    capabilityChannels, instance.setup.protection?.channels ?? [], deviceStatus?.status?.channels ?? [],
                  )
                  return <div className="live-resource powers-device-status">
                    <h5>{t("app.deviceStatus")}</h5>
                    <p className="tool-setup-hint">{t("app.notSavedInTemplateStatusIsReadOnlyWhen")}</p>
                    {executionMode === 'simulate'
                      ? <p className="tool-setup-hint">{t("app.usesTheSimulatorModelNoSavedLiveResourceIs")}</p>
                      : !resourceReady && <p className="tool-setup-hint">{t("app.saveTheLiveResourceBelowBeforeUsingDeviceStatus")}</p>}
                    <button className="action-button" type="button"
                      disabled={!resourceReady || workflowBusy || operationBusy}
                      onClick={() => void refreshPowersStatus(instance.id)}>
                      {deviceStatus?.operation === 'refresh' ? t("app.refreshing") : t("app.refreshStatus")}
                    </button>
                    {deviceStatus?.operation === 'clear' && <p role="status">{executionMode === 'simulate' ? t("app.generatingClearPlan") : t("app.clearingProtection")}</p>}
                    {deviceStatus?.error && <p className="error" role="alert">{deviceStatus.error}</p>}
                    {clearPlan !== null && <div className="simulation-plan-result" role="status">
                      <strong>{t("app.pLANGENERATEDSIMULATION")}</strong>
                      <p>{t("app.nOHARDWAREIO")}</p>
                      <p>{t("app.noRealProtectionLatchWasChanged")}</p>
                      <details><summary>{t("app.showPlan")}</summary>
                        <strong>{t("app.cLEARPROTECTIONPLANSIMULATION")}</strong>
                        <dl className="tool-details">
                          <div className="detail-row"><dt className="detail-label">{t("app.target")}</dt><dd className="detail-value">{instance.id} {t("app.channel2")}{clearPlan.channel}</dd></div>
                          <div className="detail-row"><dt className="detail-label">{t("app.safety")}</dt><dd className="detail-value">{t("app.allPowerOutputsWillBeTurnedOFFFirst")}</dd></div>
                          <div className="detail-row"><dt className="detail-label">{t("app.action")}</dt><dd className="detail-value">{t("app.clearChannel")}{clearPlan.channel} {t("app.protection")}</dd></div>
                          <div className="detail-row"><dt className="detail-label">{t("app.finalOutput")}</dt><dd className="detail-value">{t("app.remainsOFF")}</dd></div>
                          <div className="detail-row"><dt className="detail-label">{t("app.hardwareIO")}</dt><dd className="detail-value">{t("app.none")}</dd></div>
                        </dl>
                      </details>
                    </div>}
                    {deviceStatus?.clearCompleted && <p className="validation-success" role="status">{t("app.protectionClearCompletedInLIVEModeRealHardwareWas")}</p>}
                    <section className="powers-protection-summary" aria-label={t("app.protectionSummary")}>
                      <h6>{t("app.protectionSummary")}</h6>
                      <dl>
                        {([
                          [t("app.protection2"), deviceStatus?.status?.protection_tripped, t("app.cLEAR")],
                          ['OVP', deviceStatus?.status?.over_voltage_tripped, t("app.oK")],
                          ['OCP', deviceStatus?.status?.over_current_tripped, t("app.oK")],
                        ] as const).map(([label, tripped, clearLabel]) => <div key={label}>
                          <dt>{label}</dt>
                          <dd className={tripped === undefined ? 'powers-status-unknown'
                            : tripped ? 'powers-status-tripped' : 'powers-status-clear'}>
                            {tripped === undefined ? '—' : tripped ? t("app.tripped") : clearLabel}
                          </dd>
                        </div>)}
                      </dl>
                    </section>
                    <div className="powers-table-scroll">
                      <table className="powers-status-table">
                        <thead><tr><th scope="col">{t("app.channel")}</th><th scope="col">{t("app.output")}</th><th scope="col">{t("app.oVP")}</th><th scope="col">{t("app.oCP")}</th><th scope="col">{t("app.action")}</th></tr></thead>
                        <tbody>{statusChannels.map(channel => {
                          const status = deviceStatus?.status?.channels.find(record => record.channel === channel)
                          const canClear = executionMode === 'simulate'
                            ? capabilityChannels.includes(channel)
                            : Boolean(status && (status.over_voltage_tripped || status.over_current_tripped))
                          return <tr key={channel}>
                            <th scope="row">{channel}</th>
                            <td>{status ? status.output_enabled ? t("app.oN") : t("app.oFF") : '—'}</td>
                            <td>{status ? status.over_voltage_tripped ? t("app.tripped") : t("app.oK") : '—'}</td>
                            <td>{status ? status.over_current_tripped ? t("app.tripped") : t("app.oK") : '—'}</td>
                            <td><button className={`action-button ${executionMode === 'live' ? 'action-button-danger' : ''}`} type="button"
                              disabled={!resourceReady || workflowBusy || operationBusy || toolConfigBusy !== null || !canClear}
                              onClick={() => void clearPowersProtection(instance.id, status ?? {
                                channel, output_enabled: false, over_voltage_tripped: false, over_current_tripped: false,
                              })}>
                              {executionMode === 'simulate' ? t("app.generateClearPlan") : t("app.clearProtection")}
                            </button></td>
                          </tr>
                        })}</tbody>
                      </table>
                    </div>
                    {deviceStatus?.status && <>
                      {unresolved && <p className="error" role="alert">{t("app.protectionRemainsTripped")}</p>}
                      {outputOn && <p className="error" role="alert">{t("app.warningPostOperationStatusReportsAnOutputIsStill")}</p>}
                    </>}
                    {executionMode === 'live' && <p className="tool-setup-hint">{t("app.ifRemoteClearIsUnsupportedForThisModelClear")}</p>}
                  </div>
                }}
                renderResource={instance => {
                  const { id, tool } = instance
                  if (tool === 'wavegen') return null
                  const savedResource = savedResources[id]
                  const identity = resourceIdentities[id]
                  const savedModelId = tool === 'meters'
                    ? identity?.model_id?.trim() || identity?.model?.trim() || null
                    : identity?.model_id ?? null
                  const externalTool = tools.find(status => status.tool_id === tool)
                  const executableKey = JSON.stringify([externalTool?.source, externalTool?.path, externalTool?.tool_version])
                  const errorQueue = tool === 'serial' ? undefined : {
                    tool, instanceId: id, executionMode, savedResource, savedModelId, executableKey,
                    toolRefreshRevision,
                    bindingKey: JSON.stringify([executionMode, executableKey,
                      ...(executionMode === 'live' ? [savedResource, savedBackends[id], savedModelId] : [])]),
                    available: externalTool?.executable_status === 'available',
                    disabled: workflowBusy || loading || toolConfigBusy !== null,
                    onRead: () => handleErrorQueue(tool, id, savedResource),
                  }
                  return <LiveDeviceSetup errorQueue={errorQueue}>
                        <div className="live-device">
                          {deviceName(resourceIdentityDrafts[instance.id]) && <span>{deviceName(resourceIdentityDrafts[instance.id])}</span>}
                          {resourceIdentityDrafts[instance.id]?.serial?.trim() && <span>{t("app.sN")}{resourceIdentityDrafts[instance.id]?.serial?.trim()}</span>}
                          <code>{resourceDrafts[instance.id] || t("app.noResourceConfigured")}</code>
                          <span className="tool-setup-hint">{t("app.lastKnownIdentityNotAConnectionCheck")}</span>
                        </div>
                        <p className="tool-setup-hint">{t("app.storedLocallyNotIncludedInTemplateSaveResourceTo")}</p>
                        {executionMode === 'simulate' && <p className="tool-setup-hint">{t("app.storedForLiveModeCurrentExecutionModeIsSimulation")}</p>}
                        {instance.tool !== 'serial' && <label className="step-property-field">
                          <span className="step-property-label">{t("app.vISABackend")}</span>
                          <select value={backendDrafts[instance.id] ?? 'system'}
                            disabled={toolConfigBusy !== null || workflowBusy || loading || powersOperationBusy !== null}
                            onChange={event => {
                              const backend = event.target.value as VisaBackend
                              if (backend === (backendDrafts[instance.id] ?? 'system')) return
                              discoveryRequests.current[instance.id] = (discoveryRequests.current[instance.id] ?? 0) + 1
                              setBackendDrafts(current => ({ ...current, [instance.id]: backend }))
                              setResourceDrafts(current => ({ ...current, [instance.id]: '' }))
                              setResourceIdentityDrafts(current => ({ ...current, [instance.id]: null }))
                              setDiscoveredResources(current => ({ ...current, [instance.id]: undefined }))
                              setDiscoveryErrors(current => ({ ...current, [instance.id]: null }))
                              setPowersStatuses(current => {
                                const next = { ...current }; delete next[instance.id]; return next
                              })
                            }}>
                            <option value="system">{t("app.systemVISA")}</option>
                            <option value="@py">{t("app.pyVISAPyPy")}</option>
                          </select>
                        </label>}
                        {instance.tool === 'serial' && instance.setup.transport === 'tcp' ? <>
                          <label className="step-property-field">
                            <span className="step-property-label">{t("app.tCPHost")}</span>
                            <input type="text" value={tcpEndpointParts(resourceDrafts[instance.id] ?? '').host}
                              disabled={toolConfigBusy !== null || workflowBusy || loading}
                              onChange={event => {
                                setResourceDrafts(current => ({
                                  ...current, [instance.id]: formatTcpEndpoint(
                                    event.target.value, tcpEndpointParts(current[instance.id] ?? '').port),
                                }))
                                setResourceIdentityDrafts(current => ({ ...current, [instance.id]: null }))
                              }} />
                          </label>
                          <label className="step-property-field">
                            <span className="step-property-label">{t("app.tCPPort")}</span>
                            <input type="number" min={1} max={65535} step={1}
                              value={tcpEndpointParts(resourceDrafts[instance.id] ?? '').port}
                              disabled={toolConfigBusy !== null || workflowBusy || loading}
                              onChange={event => {
                                setResourceDrafts(current => ({
                                  ...current, [instance.id]: formatTcpEndpoint(
                                    tcpEndpointParts(current[instance.id] ?? '').host, event.target.value),
                                }))
                                setResourceIdentityDrafts(current => ({ ...current, [instance.id]: null }))
                              }} />
                          </label>
                          <p className="tool-setup-hint">{t("app.enterTCPHostAndTCPPortAndSaveResource")}</p>
                        </> : <label className="step-property-field">
                          <span className="step-property-label">{instance.tool === 'serial' ? t("app.cOMPort") : t("app.liveResource")}</span>
                          <input
                            type="text"
                            value={resourceDrafts[instance.id] ?? ''}
                            disabled={toolConfigBusy !== null || workflowBusy || loading}
                            onChange={(event) => {
                              setResourceDrafts((current) => ({ ...current, [instance.id]: event.target.value }))
                              setPowersStatuses(current => {
                                const next = { ...current }
                                delete next[instance.id]
                                return next
                              })
                              setResourceIdentityDrafts((current) => ({ ...current, [instance.id]: null }))
                            }}
                          />
                        </label>}
                        <div className="tool-actions">
                          {(instance.tool !== 'serial' || instance.setup.transport !== 'tcp') && <button
                            className="action-button"
                            type="button"
                            disabled={toolConfigBusy !== null || workflowBusy || loading}
                            onClick={() => void handleListResources(instance)}
                          >
                            {instance.tool === 'serial' ? t("app.listPorts") : t("app.listResources")}
                          </button>}
                          <button
                            className="action-button"
                            type="button"
                            disabled={toolConfigBusy !== null || workflowBusy || loading ||
                              (instance.tool === 'serial' && instance.setup.transport === 'tcp' && (
                                !tcpEndpointParts(resourceDrafts[instance.id] ?? '').host.trim()
                                || !Number.isInteger(Number(tcpEndpointParts(resourceDrafts[instance.id] ?? '').port))
                                || Number(tcpEndpointParts(resourceDrafts[instance.id] ?? '').port) < 1
                                || Number(tcpEndpointParts(resourceDrafts[instance.id] ?? '').port) > 65535
                              ))}
                            onClick={() => void handleResource(instance.id, false)}
                          >
                            {t("app.saveResource")}</button>
                          <button
                            className="action-button"
                            type="button"
                            disabled={toolConfigBusy !== null || workflowBusy || loading}
                            onClick={() => void handleResource(instance.id, true)}
                          >
                            {t("app.clearResource")}</button>
                        </div>
                        {(instance.tool !== 'serial' || instance.setup.transport !== 'tcp') && discoveryErrors[instance.id] && (
                          <p className="error" role="alert">
                            {discoveryErrors[instance.id]}
                          </p>
                        )}
                        {(instance.tool !== 'serial' || instance.setup.transport !== 'tcp') && discoveredResources[instance.id]?.length === 0 && (
                          <p role="status">{t("app.noLiveResourcesFound")}</p>
                        )}
                        {(instance.tool !== 'serial' || instance.setup.transport !== 'tcp') && (discoveredResources[instance.id]?.length ?? 0) > 0 && (
                          <label className="step-property-field discovered-resources">
                            <span className="step-property-label">{t("app.discoveredResources")}</span>
                            <select
                              value=""
                              disabled={toolConfigBusy !== null || workflowBusy || loading}
                              onChange={(event) => {
                                const resource = event.target.value
                                if (resource) {
                                  const candidate = discoveredResources[instance.id]?.find(item => item.resource === resource)
                                  setResourceDrafts((current) => ({ ...current, [instance.id]: resource }))
                                  setPowersStatuses(current => {
                                    const next = { ...current }
                                    delete next[instance.id]
                                    return next
                                  })
                                  setResourceIdentityDrafts((current) => ({ ...current, [instance.id]: candidate ? {
                                    manufacturer: candidate.manufacturer, model: candidate.model,
                                    model_id: candidate.model_id,
                                    serial: candidate.serial, identity: candidate.identity,
                                  } : null }))
                                }
                              }}
                            >
                              <option value="">{t("app.selectDiscoveredResource")}</option>
                              {discoveredResources[instance.id]?.map((candidate, index) => (
                                <option key={index} value={candidate.resource}>{formatResourceCandidate(candidate)}</option>
                              ))}
                            </select>
                          </label>
                        )}
                  </LiveDeviceSetup>
                }}
                onChange={updateToolInstances}
                disabled={workflowBusy}
              />

            </>
          )}
        </section>

      {activeTab === 'workflow' && (
        <section id="workflow-panel" role="tabpanel" aria-labelledby="workflow-tab" tabIndex={0} onKeyDown={handleStepClipboard}>
          <div className="section-header">
            <h2>{t("app.workflow")}</h2>
          </div>

          {workflowDraft && (
            <div className="workflow-summary">
              <WorkflowRunSummary
                workflowDraft={workflowDraft} workflowBusy={workflowBusy}
                toolConfigBusy={toolConfigBusy} loading={loading} chartThresholdInvalid={chartThresholdInvalid}
                executionMode={executionMode} validationStatus={validationStatus} validationError={validationError}
                runStatus={runStatus} runningText={runningText} runError={runError}
                displayedRun={displayedRun} showLastRunError={showLastRunError} livePreflight={livePreflight} liveStartError={liveStartError}
                validateDraft={validateDraft} runSelectedMode={runSelectedMode}
                stopControls={stopControls} stopFeedback={stopFeedback}
              />

              <div className="workflow-builder">
                <aside className="workflow-sidebar">
                  <section className="step-palette" aria-labelledby="step-palette-title">
                    <h3 id="step-palette-title">
                      <button type="button" className="collapsible-header"
                        aria-expanded={stepsExpanded}
                        onClick={() => setStepsExpanded(current => !current)}>
                        {t("app.steps")}<span aria-hidden="true">{stepsExpanded ? '−' : '+'}</span>
                      </button>
                    </h3>
                    {stepsExpanded && <>
                    <div className="step-insertion-target" role="status" aria-label={t("app.stepInsertionTarget")}>
                      <span className="step-insertion-target-label">{t("app.aDDINGSTEPTO")}</span>
                      <strong className="step-insertion-target-value">{insertionTargetLabel}</strong>
                    </div>
                    {addingToParent && <button className="action-button step-insertion-root-button" type="button" disabled={workflowBusy}
                      onClick={() => setSelectedStepId(null)}>{t("app.setTargetToRoot")}</button>}
                    <p className="step-palette-selected">{t("app.selectedStep")}<strong>{selectedPalettePreset?.label ?? t("app.none")}</strong></p>
                    <button className="action-button action-button-primary step-palette-add" type="button"
                      disabled={!selectedPalettePreset || workflowBusy || selectedPaletteLocked || selectedPaletteTooDeep}
                      onClick={() => { if (selectedPalettePreset) addStep(selectedPalettePreset) }}>
                      {t("app.addStep")}</button>
                    <div className="step-palette-items step-palette-scroll" role="region" aria-label={t("app.stepCategories")} tabIndex={0}>
                      {renderPaletteCategories(availablePaletteCategories)}
                      {unavailablePaletteCategories.length > 0 && (
                        <section className="step-category-unavailable">
                          <h4>
                            <button type="button" className="step-category-header"
                              aria-expanded={unavailableCategoriesExpanded}
                              onClick={() => setUnavailableCategoriesExpanded(current => !current)}>
                              {t('steps.category.unavailable', { value1: unavailablePaletteCategories.length })}
                              <span aria-hidden="true">{unavailableCategoriesExpanded ? '−' : '+'}</span>
                            </button>
                          </h4>
                          {unavailableCategoriesExpanded && <div className="step-palette-items">
                            {renderPaletteCategories(unavailablePaletteCategories)}
                          </div>}
                        </section>
                      )}
                    </div>
                    </>}
                  </section>
                  <section className="streaming-panel" aria-labelledby="scopes-output-title">
                    <h3 id="scopes-output-title"><button className="collapsible-header" type="button"
                      disabled={scopesOutputLocked}
                      aria-expanded={scopesOutputVisible}
                      aria-describedby={scopesOutputLocked ? 'scopes-output-hint' : undefined}
                      onClick={() => setScopesOutputExpanded(value => !value)}>
                      {t("app.scopesFileOutput")}<span aria-hidden="true">{scopesOutputLocked ? '🔒' : scopesOutputVisible ? '−' : '+'}</span>
                    </button></h3>
                    {scopesOutputLocked && <p className="step-category-hint" id="scopes-output-hint">
                      {t("app.noScopesToolInstanceAddOneInSetup")}</p>}
                    {scopesOutputVisible && <>
                      <p className="tool-setup-hint">{t("app.captureCSVMetadataAndScreenshotsUseThisFolderEach")}</p>
                      <span className="streaming-destination">{scopesOutputFolder ?? t("app.defaultOrchestratorApplicationFolderData")}</span>
                      <button className="action-button" type="button" disabled={workflowBusy} onClick={() => void selectScopesOutputFolder()}>{t("app.selectFolder")}</button>
                      <button className="action-button" type="button" disabled={workflowBusy || scopesOutputFolder === null}
                        onClick={() => { setScopesOutputFolder(null); setScopesOutputError(null) }}>{t("app.useDefault")}</button>
                      {scopesOutputError && <p role="alert">{scopesOutputError}</p>}
                    </>}
                  </section>
                  <section className="streaming-panel" aria-labelledby="streaming-panel-title">
                    <h3 id="streaming-panel-title">
                      <button type="button" className="collapsible-header"
                        aria-expanded={streamingExpanded}
                        onClick={() => setStreamingExpanded(current => !current)}>
                        {t("app.cSVExport")}<span aria-hidden="true">{streamingExpanded ? '−' : '+'}</span>
                      </button>
                    </h3>
                    {streamingExpanded && <>
                    <label><input type="checkbox" checked={backgroundCsvEnabled} disabled={workflowBusy || !workflowDraft.backgrounds?.length}
                      onChange={event => setBackgroundCsvEnabled(event.target.checked)} /> {t("app.streamBackgroundCSVDuringCapture")}</label>
                    <p className="value-source-help">{t('app.workflowHelp.backgroundCsv')}</p>
                    {backgroundCsvEnabled && <>
                      <select aria-label={t("app.backgroundCSVSelection")} value={backgroundCsvTarget} disabled={workflowBusy} onChange={event => setBackgroundCsvTarget(event.target.value)}>
                        <option value="all">{t("app.allBackgrounds")}</option>{workflowDraft.backgrounds?.map(background => <option key={background.id} value={background.id}>{background.id}</option>)}
                      </select>
                      <p className="value-source-help">{t(backgroundCsvTarget === 'all' ? 'app.workflowHelp.backgroundCsvAll' : 'app.workflowHelp.backgroundCsvOne')}</p>
                      <label>{t("app.scopesCSVColumns")}<select aria-label={t("app.scopesStreamingCSVColumns")} value={backgroundCsvMode}
                        disabled={workflowBusy} onChange={event => setBackgroundCsvMode(event.target.value as 'values-only' | 'values-quality')}>
                        <option value="values-only">{t("app.valuesUnits")}</option>
                        <option value="values-quality">{t("app.valuesUnitsValidityReason")}</option>
                      </select></label>
                      <p className="value-source-help">{t(`app.workflowHelp.scopeCsv.${backgroundCsvMode}`)}</p>
                        <label>{t("app.serialStreamingCSVData")}<select aria-label={t("app.serialStreamingCSVData")}
                          value={serialCsvMode} disabled={workflowBusy}
                          onChange={event => setSerialCsvMode(event.target.value as 'hex' | 'text')}>
                          <option value="hex">{t("app.hex")}</option><option value="text">{t("app.textUTF8")}</option>
                        </select></label>
                      <p className="value-source-help">{t(`app.workflowHelp.serialCsv.${serialCsvMode}`)}</p>
                      <p>{backgroundCsvFolder ?? t("app.defaultApplicationFolderData")}</p>
                      <button type="button" className="action-button" disabled={workflowBusy} onClick={() => void (async () => {
                        setChoosingStreamOutputFolder(true)
                        try { const folder = await open({ directory: true, multiple: false, title: t("app.backgroundCSVFolder") }); if (typeof folder === 'string') setBackgroundCsvFolder(folder); setBackgroundCsvError(null) }
                        catch (reason) { setBackgroundCsvError(String(reason)) }
                        finally { setChoosingStreamOutputFolder(false) }
                      })()}>{t("app.selectBackgroundFolder")}</button>
                      <button type="button" disabled={workflowBusy} onClick={() => setBackgroundCsvFolder(null)}>{t("app.useDefaultBackgroundFolder")}</button>
                      {backgroundCsvError && <p role="alert">{backgroundCsvError}</p>}
                    </>}
                    <label className="streaming-toggle">
                      <input type="checkbox" checked={streamCsv && hasWorkflowOutputs}
                        disabled={workflowBusy || !hasWorkflowOutputs}
                        onChange={event => setStreamCsv(event.target.checked)} />
                      {t("app.streamCSVDuringRun")}</label>
                    <p className="value-source-help">{t('app.workflowHelp.foregroundCsv')}</p>
                    {!hasWorkflowOutputs && <p>{t("app.streamingCSVRequiresAtLeastOneOutput")}</p>}
                    {streamCsv && hasWorkflowOutputs && <div className="streaming-fields">
                      <select aria-label={t("app.cSVStreamingMode")} disabled={workflowBusy} value={streamAllPages ? 'all' : 'selected'}
                        onChange={event => setStreamAllPages(event.target.value === 'all')}>
                        <option value="selected">{t("app.selectedPage")}</option><option value="all">{t("app.allPages")}</option>
                      </select>
                      {!streamAllPages && <select aria-label={t("app.streamingPage")} value={streamingPage} disabled={workflowBusy}
                        onChange={event => setStreamPage(event.target.value)}>{pages.map(page => <option key={page.name}>{page.name}</option>)}</select>}
                      <span className="streaming-destination">{streamOutputFolder ?? t("app.defaultApplicationFolderData2")}</span>
                      <button className="action-button" type="button" disabled={workflowBusy} onClick={() => void selectOutputFolder()}>{t("app.selectFolder")}</button>
                      {streamOutputFolder !== null && <button className="action-button" type="button" disabled={workflowBusy} onClick={() => {
                        setStreamOutputFolder(null)
                        setStreamOutputFolderError(null)
                      }}>{t("app.useDefault")}</button>}
                    </div>}
                    {streamCsv && hasWorkflowOutputs && streamOutputFolderError && (
                      <p className="error" role="alert">{streamOutputFolderError}</p>
                    )}
                    {csvStreamFeedback}
                    </>}
                  </section>
                  <section className="chart-options" aria-labelledby="chart-options-title">
                    <h3 id="chart-options-title">
                      <button type="button" className="collapsible-header"
                        aria-expanded={chartOptionsExpanded}
                        onClick={() => setChartOptionsExpanded(current => !current)}>
                        {t("app.chartOptions")}<span aria-hidden="true">{chartOptionsExpanded ? '−' : '+'}</span>
                      </button>
                    </h3>
                    {chartOptionsExpanded && <div className="chart-options-sections">
                      <section className="chart-option-section">
                        <h4>
                          <button type="button" className="step-category-header"
                            aria-expanded={chartSamplingExpanded}
                            onClick={() => setChartSamplingExpanded(current => !current)}>
                            {t("app.sampling")}<span aria-hidden="true">{chartSamplingExpanded ? '−' : '+'}</span>
                          </button>
                        </h4>
                        {chartSamplingExpanded && <fieldset className="chart-sampling-fields" disabled={workflowBusy}>
                          <label><input type="checkbox" checked={chartSamplingOptions.enabled}
                            onChange={event => setChartSamplingOptions(current => ({ ...current, enabled: event.target.checked }))} />
                            {t("app.preserveSignificantChanges")}</label>
                          <p className="value-source-help">{t('app.workflowHelp.sampling')}</p>
                          <label className="chart-sampling-threshold">{t("app.changeThreshold")}<input aria-label={t("app.changeThreshold")} type="number" min="0" step="any"
                              disabled={!chartSamplingOptions.enabled} value={chartSamplingOptions.threshold}
                              onChange={event => setChartSamplingOptions(current => ({ ...current, threshold: event.target.value }))} />
                          </label>
                          <p className="value-source-help">{t('app.workflowHelp.threshold')}</p>
                          <label><input type="checkbox" checked={chartSamplingOptions.showMarkers}
                            disabled={!chartSamplingOptions.enabled}
                            onChange={event => setChartSamplingOptions(current => ({ ...current, showMarkers: event.target.checked }))} />
                            {t("app.showSignificantChangeMarkers")}</label>
                          <p className="tool-setup-hint">{t("app.simulationAmpLiveLineChartsMarkersHighlightOnlyQualifying")}</p>
                          {chartThresholdInvalid && <p className="error" role="alert">
                            {t("app.changeThresholdMustBeAFiniteNumberGreaterThan")}</p>}
                        </fieldset>}
                      </section>
                      <section className="chart-option-section">
                        <h4>
                          <button type="button" className="step-category-header"
                            aria-expanded={chartYAxisExpanded}
                            onClick={() => setChartYAxisExpanded(current => !current)}>
                            {t("app.yAxis")}<span aria-hidden="true">{chartYAxisExpanded ? '−' : '+'}</span>
                          </button>
                        </h4>
                        {chartYAxisExpanded && <fieldset className="chart-y-axis-fields" disabled={workflowBusy}>
                          <label><input type="checkbox" checked={chartFitData}
                            onChange={event => setChartFitData(event.target.checked)} />
                            {t("app.fitData")}</label>
                          <p className="tool-setup-hint">{t("app.simulationAmpLiveLineChartsAutoYAxisFollows")}</p>
                        </fieldset>}
                      </section>
                    </div>}
                  </section>
                  <InteractionSettingsEditor key={templateUiGeneration}
                    value={workflowDraft.workflow.interaction}
                    hasBackground={Boolean(workflowDraft.backgrounds?.length)}
                    disabled={workflowBusy} onChange={interaction => {
                      setWorkflowDraft(current => current ? { ...current, workflow: { ...current.workflow, interaction } } : current)
                      setWorkflowChangedSinceRun(true); clearRunFeedback(); setTemplateIoMessage(null)
                    }} />
                </aside>

                <SequenceEditor
                  paletteDropRef={sequenceEditorRef}
                  steps={workflowDraft.workflow.steps}
                  selectedStepIds={selectedStepIds}
                  onSelectStep={(id, modifiers) => setStepSelection(current => selectStep(workflowDraft.workflow.steps, current, id, modifiers))}
                  onReorderSteps={reorderStep}
                  validationIssue={validationIssue}
                  stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                  instances={workflowDraft.tool_instances}
                  runResults={runWorkflowSnapshot && !workflowChangedSinceRun ? displayedRun?.step_summaries ?? null : null}
                  formatMeasurement={formatMeasurement}
                  workflowBusy={workflowBusy}
                  onMoveStep={moveStep}
                  onDeleteStep={deleteStep}
                  onClearWorkflow={() => void clearWorkflow()}
                  density={stepDensity}
                  onDensityChange={setStepDensity}
                  collapsedStepIds={collapsedStepIds}
                  collapsedBranches={collapsedBranches}
                  onToggleContainer={toggleSequenceContainer}
                  onToggleBranch={toggleSequenceBranch}
                  onSetAllExpanded={setAllSequenceExpanded}
                />

                <section className="step-properties" aria-labelledby="step-properties-title">
                  <h3 id="step-properties-title">{t("app.properties")}</h3>
                  {validationIssue?.step_id && selectedStepIds.includes(validationIssue.step_id) && (
                    <p className="error" role="alert">{validationIssue.message}</p>
                  )}

                  {selectedStepIds.length > 1 && (
                    <p className="step-properties-empty">{selectedStepIds.length} {t("app.stepsSelectedSelectASingleStepToEditIts")}</p>
                  )}

                  {selectedStepIds.length <= 1 && !selectedStep && (
                    <p className="step-properties-empty">{t("app.selectAStepToEditItsProperties")}</p>
                  )}

                  {selectedStepIds.length === 1 && selectedStep && (
                    <div className="step-properties-fields">
                      <div>
                        <h4 className="step-properties-step-title">{propertiesTitle(selectedStep, workflowDraft.tool_instances)}</h4>
                        {stepHelpKey(selectedStep, workflowDraft.tool_instances) && (
                          <p className="step-context-help">{t(`steps.hint.${stepHelpKey(selectedStep, workflowDraft.tool_instances)}`)}</p>
                        )}
                      </div>
                      <div className="step-property-readonly">
                        <span className="step-property-label">{t("app.stepID")}</span>
                        {editingStepId === selectedStep.id ? <>
                          <div className="step-id-editor">
                            <input type="text" autoFocus aria-label={t("app.stepID")} value={stepIdDraft}
                              disabled={workflowBusy} onChange={event => {
                                setStepIdDraft(event.target.value)
                                setStepIdEditError(null)
                              }} onKeyDown={event => {
                                if (event.key === 'Enter') { event.preventDefault(); saveEditedStepId(selectedStep.id) }
                                if (event.key === 'Escape') {
                                  event.preventDefault()
                                  setEditingStepId(null)
                                  setStepIdEditError(null)
                                }
                              }} />
                            <button type="button" className="step-id-icon-button"
                              aria-label={t("app.saveStepID")} title={t("app.saveStepID")} disabled={workflowBusy}
                              onClick={() => saveEditedStepId(selectedStep.id)}>✓</button>
                            <button type="button" className="step-id-icon-button"
                              aria-label={t("app.cancelStepID")} title={t("app.cancelStepID")}
                              onClick={() => { setEditingStepId(null); setStepIdEditError(null) }}>×</button>
                          </div>
                          {stepIdEditError && <p className="step-property-error" role="alert">{stepIdEditError}</p>}
                        </> : <div className="step-id-display">
                          <code className="workflow-step-id">{selectedStep.id}</code>
                          <button type="button" className="step-id-icon-button"
                            disabled={workflowBusy} aria-label={t("app.editStepID")} title={t("app.editStepID")}
                            onClick={() => {
                              setStepIdDraft(selectedStep.id)
                              setStepIdEditError(null)
                              setEditingStepId(selectedStep.id)
                            }}>
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M4 20h4l11-11-4-4L4 16v4Z" /><path d="m13 7 4 4" />
                            </svg>
                          </button>
                        </div>}
                      </div>

                      {selectedToolAction && <label className="step-property-field">
                        <span className="step-property-label">{t("app.targetInstance")}</span>
                        <select disabled={workflowBusy} value={selectedToolAction.target} onChange={event => {
                          const target = event.target.value
                          updateStep(selectedToolAction.id, step => step.type === 'tool-action' ? { ...step, target } : step)
                        }}>
                          {workflowDraft.tool_instances.filter(instance => instance.tool === workflowDraft.tool_instances.find(item => item.id === selectedToolAction.target)?.tool)
                            .map(instance => <option key={instance.id} value={instance.id}>{targetLabel(instance, resourceIdentityDrafts[instance.id])}</option>)}
                        </select>
                      </label>}
                      {selectedStep.type === 'bg-interaction' && <InteractionEditor step={selectedStep}
                        key={`${templateUiGeneration}:${selectedStep.id}`}
                        instances={workflowDraft.tool_instances}
                        savedCommands={interactionCommandDrafts[selectedStep.id] ?? {}}
                        onSaveCommand={operation => setInteractionCommandDrafts(current => ({ ...current,
                          [selectedStep.id]: { ...current[selectedStep.id], [operation.command]: operation },
                        }))}
                        steps={workflowDraft.workflow.steps} backgrounds={workflowDraft.backgrounds ?? []} disabled={workflowBusy}
                        onChange={next => updateStep(selectedStep.id, () => next)} />}
                      {selectedStep.type === 'background' && <>
                        <label className="step-property-field"><span className="step-property-label">{t("app.background")}</span><select value={selectedStep.background_id} disabled={workflowBusy} onChange={event => updateStep(selectedStep.id, step => step.type === 'background' ? { ...step, background_id: event.target.value } : step)}>
                          {workflowDraft.backgrounds?.map(background => <option key={background.id} value={background.id}>{background.id} · {background.tool_instance_id}</option>)}
                        </select></label>
                        {(selectedStep.action === 'worker-on' || selectedStep.action === 'worker-off') && <label className="step-property-field step-property-checkbox"><input type="checkbox" checked={selectedStep.capture} disabled={workflowBusy}
                          onChange={event => updateStep(selectedStep.id, step => step.type === 'background' ? { ...step, capture: event.target.checked } : step)} />
                          <span className="step-property-label">{t("app.simultaneousCapture")}{selectedStep.action === 'worker-on' ? t("app.oN") : t("app.oFF")}</span></label>}
                        {selectedStep.action === 'worker-on' && <p className="value-source-help">{t('app.workflowHelp.captureOn')}</p>}
                        {selectedStep.action === 'worker-off' && <p className="value-source-help">{t("app.ifCaptureWasAlreadyExplicitlySwitchedOFFUncheckSimultaneous")}</p>}
                      </>}
                      {selectedStep.type === 'for' && <>
                        <label className="step-property-field">
                          <span className="step-property-label">{t("app.loopVariable")}</span>
                          <input type="text" required pattern="[a-z0-9]+(-[a-z0-9]+)*"
                            title={t("app.useLowercaseLettersDigitsAndSingleHyphensBetweenSegments")}
                            value={selectedStep.variable} disabled={workflowBusy} onChange={event => {
                              const variable = event.target.value
                              updateStep(selectedStep.id, step => step.type === 'for' ? { ...step, variable } : step)
                            }} />
                        </label>
                        <p className="value-source-help">{t('app.workflowHelp.loopVariable')}</p>
                        {(['start', 'stop', 'step'] as const).map(field => <div key={field} className="workflow-help-group"><label className="step-property-field">
                          <span className="step-property-label">{field === 'start' ? t("app.start") : field === 'stop' ? t("app.stop") : t("app.step")}</span>
                          <input type="text" required value={selectedStep.range[field]} disabled={workflowBusy}
                            onChange={event => {
                              const value = event.target.value
                              updateStep(selectedStep.id, step => step.type === 'for'
                                ? { ...step, range: { ...step.range, [field]: value } } : step)
                            }} />
                        </label><p className="value-source-help">{t(`app.workflowHelp.for.${field}`)}</p></div>)}
                        {(!selectedStep.variable.trim() || Object.values(selectedStep.range).some(value => !value.trim())) &&
                          <p className="error">{t("app.loopVariableAndRangeFieldsMustNotBeBlank")}</p>}
                      </>}
                      {selectedStep.type === 'set-variable' && selectedEnclosingForVariables.includes(selectedStep.variable) &&
                        <p className="error">{t("app.aBodySetVariableCannotWriteAnEnclosingFor")}</p>}
                      {selectedStep.type === 'set-variable' && (
                        <>
                          <label className="step-property-field">
                            <span className="step-property-label">{t("app.variable")}</span>
                            <input
                              type="text"
                              value={selectedStep.variable}
                              pattern="[a-z0-9]+(-[a-z0-9]+)*"
                              title={t("app.useLowercaseLettersDigitsAndSingleHyphensBetweenSegments")}
                              disabled={workflowBusy}
                              onChange={(event) => {
                                const variable = event.target.value
                                updateStep(selectedStep.id, (step) =>
                                  step.type === 'set-variable' ? { ...step, variable } : step,
                                )
                              }}
                            />
                          </label>
                        </>
                      )}

                      {selectedStep.type === 'output' && (
                        <>
                          <label className="step-property-field">
                            <span className="step-property-label">{t("app.outputName")}</span>
                            <input
                              type="text"
                              value={selectedStep.name}
                              disabled={workflowBusy}
                              aria-invalid={outputNameError !== null}
                              aria-describedby={outputNameError
                                ? 'output-name-help output-name-error' : 'output-name-help'}
                              onChange={(event) => updateStep(selectedStep.id, (step) =>
                                step.type === 'output' ? { ...step, name: event.target.value } : step,
                              )}
                            />
                          </label>
                          <p id="output-name-help" className="value-source-help">{t("app.editableColumnNameUsedInOutputDataCSVXLSX")}</p>
                          {outputNameError && <p id="output-name-error" className="step-property-error">{outputNameError}</p>}
                          <label className="step-property-field">
                            <span className="step-property-label">{t("app.existingCompatiblePage")}</span>
                            <select value={selectedCompatiblePages.includes(selectedStep.page) ? selectedStep.page : ''}
                              disabled={workflowBusy}
                              onChange={event => {
                                if (event.target.value) updateStep(selectedStep.id, step =>
                                  step.type === 'output' ? { ...step, page: event.target.value } : step)
                              }}>
                              <option value="">{t("app.selectExistingPage")}</option>
                              {selectedCompatiblePages.map(page => <option key={page} value={page}>{page}</option>)}
                            </select>
                          </label>
                          <label className="step-property-field">
                            <span className="step-property-label">{t("app.pageName")}</span>
                            <input value={selectedStep.page} disabled={workflowBusy} aria-describedby="output-page-help"
                              onChange={event => updateStep(selectedStep.id, step => step.type === 'output' ? { ...step, page: event.target.value } : step)} />
                          </label>
                          <p id="output-page-help" className="value-source-help">
                            {t("app.aPageIsAnIndependentTabularDatasetOnlyPages")}</p>
                          {pages.some(page => page.name === selectedStep.page && JSON.stringify(page.scope) !== JSON.stringify(loopPath(workflowDraft.workflow.steps, selectedStep.id).map(loop => loop.id))) &&
                            <p className="error">{t("app.thisPageBelongsToADifferentLoopPathChoose")}</p>}
                        </>
                      )}

                      {selectedValue && (
                        <InputValueEditor
                          key={selectedStep.id}
                          value={selectedValue}
                           allowStringLiteral={selectedStep.type === 'set-variable'}
                          allowBooleanLiteral={selectedStep.type === 'set-variable'}
                          allowNullLiteral={selectedStep.type === 'set-variable'}
                          timeFormat={selectedStep.type === 'output' ? selectedStep.time_format : undefined}
                          onTimeFormatChange={selectedStep.type === 'output' ? format => updateStep(selectedStep.id, step =>
                            step.type === 'output' ? { ...step, time_format: format } : step) : undefined}
                          earlierSteps={earlierSteps} backgrounds={workflowDraft.backgrounds ?? []}
                          instances={workflowDraft.tool_instances}
                          stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                          earlierVariables={earlierVariables}
                          disabled={workflowBusy}
                          onChange={(value) => updateStep(selectedStep.id, (step) =>
                            step.type === 'output' ? changeOutputValue(step, value) : step.type === 'set-variable'
                              ? { ...step, value } : step)}
                        />
                      )}

                      {(selectedStep.type === 'assert' || selectedStep.type === 'while' || selectedStep.type === 'if') && (
                        <div key={selectedStep.id} className="step-properties-fields">
                          <ExpressionOperandEditor
                            allowBooleanLiteral
                            allowStringLiteral
                            allowNullLiteral
                            side="Left" value={selectedStep.left}
                            earlierSteps={earlierSteps} backgrounds={workflowDraft.backgrounds ?? []} earlierVariables={earlierVariables}
                            instances={workflowDraft.tool_instances}
                            stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                            disabled={workflowBusy}
                            onChange={left => updateStep(selectedStep.id, step =>
                              (step.type === 'assert' || step.type === 'while' || step.type === 'if') ? { ...step, left } : step)}
                          />
                          <label className="step-property-field">
                            <span className="step-property-label">{t("app.operator")}</span>
                            <select value={selectedStep.operator} disabled={workflowBusy}
                              onChange={event => updateStep(selectedStep.id, step =>
                                (step.type === 'assert' || step.type === 'while' || step.type === 'if') ? { ...step, operator: event.target.value as ComparisonOperator } : step)}>
                              {Object.entries(COMPARISON_OPERATORS).map(([operator, symbol]) => (
                                <option key={operator} value={operator}>{symbol}</option>
                              ))}
                            </select>
                          </label>
                          <ExpressionOperandEditor
                            allowBooleanLiteral
                            allowStringLiteral
                            allowNullLiteral
                            side="Right" value={selectedStep.right}
                            earlierSteps={earlierSteps} backgrounds={workflowDraft.backgrounds ?? []} earlierVariables={earlierVariables}
                            instances={workflowDraft.tool_instances}
                            stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                            disabled={workflowBusy}
                            onChange={right => updateStep(selectedStep.id, step =>
                              (step.type === 'assert' || step.type === 'while' || step.type === 'if') ? { ...step, right } : step)}
                          />
                          {selectedStep.type === 'assert' && <label className="step-property-field">
                            <span className="step-property-label">{t("app.failureMessage")}</span>
                            <input type="text" value={selectedStep.message} placeholder={t("app.assertionFailed")}
                              disabled={workflowBusy}
                              onChange={event => updateStep(selectedStep.id, step =>
                                step.type === 'assert' ? { ...step, message: event.target.value } : step)} />
                          </label>}
                          {selectedStep.type === 'assert' && <p className="value-source-help">{t('app.workflowHelp.assertMessage')}</p>}
                          {selectedStep.type === 'while' && <div className="step-property-field">
                            <span className="step-property-label">{t("app.iterationLimit")}</span>
                            <select aria-label={t("app.iterationLimit")} value={selectedStep.max_iterations === null ? 'unlimited' : 'limited'} disabled={workflowBusy}
                              onChange={event => updateStep(selectedStep.id, step =>
                                step.type === 'while' ? { ...step, max_iterations: event.target.value === 'unlimited' ? null : 1000 } : step)}>
                              <option value="limited">{t("app.maxIterations")}</option>
                              <option value="unlimited" disabled={Boolean(selectedParent)}>{t("app.unlimited")}</option>
                            </select>
                            <p className="value-source-help">{t('app.workflowHelp.iterationLimit')}</p>
                            {selectedStep.max_iterations === null ? (
                              <p className="value-source-help">{t("app.runsUntilTheConditionBecomesFalseOrTheLoop")} {t('app.workflowHelp.unlimitedScope')}</p>
                            ) : <>
                              <input type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1"
                                aria-label={t("app.maxIterations")} value={selectedStep.max_iterations} disabled={workflowBusy}
                                onChange={event => {
                                  const limit = event.currentTarget.valueAsNumber
                                  if (!Number.isSafeInteger(limit) || limit <= 0) return
                                  updateStep(selectedStep.id, step =>
                                    step.type === 'while' ? { ...step, max_iterations: limit } : step)
                                }} />
                              {(!Number.isSafeInteger(selectedStep.max_iterations) || selectedStep.max_iterations <= 0) &&
                                <span className="error">{t("app.maxIterationsMustBeAPositiveSafeInteger")}</span>}
                            </>}
                            {selectedParent && <p className="value-source-help">{t('app.workflowHelp.unlimitedNested')}</p>}
                          </div>}
                        </div>
                      )}

                      {selectedStep.type === 'if' && <label className="step-property-field">
                        <span className="step-property-label">{t("app.addNewStepsTo")}</span>
                        <select aria-label={t("app.ifBranchForNewSteps")} disabled={workflowBusy}
                          value={preferredIfBranch.id === selectedStep.id ? preferredIfBranch.branch : 'then'}
                          onChange={event => setPreferredIfBranch({
                            id: selectedStep.id, branch: event.target.value as StepBranch,
                          })}>
                          <option value="then">{t("app.tHEN")}</option>
                          <option value="else">{t("app.eLSE")}</option>
                        </select>
                      </label>}
                      {selectedStep.type === 'if' && <p className="value-source-help">{t('app.workflowHelp.ifBranch')}</p>}
                      {selectedStep.type === 'wait' && (
                        <label className="step-property-field">
                          <span className="step-property-label">{t("app.durationMs")}</span>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={selectedStep.duration_ms}
                            disabled={workflowBusy}
                            onChange={(event) => {
                              const durationMs = event.currentTarget.valueAsNumber
                              if (!isNonNegativeInteger(durationMs)) {
                                return
                              }

                              updateStep(selectedStep.id, (step) =>
                                step.type === 'wait'
                                  ? { ...step, duration_ms: durationMs }
                                  : step,
                              )
                            }}
                          />
                        </label>
                      )}

                      {selectedStep.type === 'wait' && <p className="value-source-help">{t('app.workflowHelp.wait')}</p>}
                      {(selectedStep.type === 'string-process' || selectedStep.type === 'byte-process' || selectedStep.type === 'array-process') && (
                        <ProcessEditor key={selectedStep.id} step={selectedStep}
                          earlierSteps={earlierSteps} earlierVariables={earlierVariables}
                          instances={workflowDraft.tool_instances} backgrounds={workflowDraft.backgrounds ?? []}
                          stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                          disabled={workflowBusy}
                          onChange={update => updateStep(selectedStep.id, step => step.type === 'string-process' || step.type === 'byte-process' || step.type === 'array-process' ? update(step) : step)}
                        />
                      )}

                      {selectedStep.type === 'show-message' && (
                        <ShowMessageEditor
                          key={selectedStep.id}
                          step={selectedStep}
                          outputs={showMessageOutputCandidates(earlierSteps)}
                          disabled={workflowBusy}
                          onChange={(next) => updateStep(selectedStep.id, (step) =>
                            step.type === 'show-message' ? next : step)}
                        />
                      )}

                      {selectedToolAction && selectedAction?.startsWith('serial/') && (
                        <SerialActionEditor showStepHelp={false} step={selectedToolAction} instances={workflowDraft.tool_instances}
                          earlierSteps={earlierSteps} backgrounds={workflowDraft.backgrounds ?? []} earlierVariables={earlierVariables} disabled={workflowBusy}
                          stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                          onChange={serialStep => updateStep(selectedToolAction.id, () => serialStep)} />
                      )}
                      {selectedToolAction && selectedAction?.startsWith('scopes/') && (
                        <ScopesActionEditor step={selectedToolAction} instances={workflowDraft.tool_instances}
                          executionMode={executionMode} scopesExecutableKey={scopesExecutableKey}
                          modelId={executionMode === 'live' ? resourceIdentityDrafts[selectedToolAction.target]?.model_id : undefined}
                          earlierSteps={earlierSteps} backgrounds={workflowDraft.backgrounds ?? []} earlierVariables={earlierVariables} disabled={workflowBusy}
                          stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                          onChange={next => updateStep(selectedToolAction.id, () => next)} />
                      )}
                      {selectedToolAction && selectedPowersAction && (
                        powersChannelSelector
                      )}

                      {selectedToolAction && selectedAction === 'powers/protection-status' && (
                        <>
                          <label className="step-property-field">
                            <span className="step-property-label">{t("app.channelSelection")}</span>
                            <select
                              value={!channelBound && savedChannel === 'all' ? 'all' : 'specific'}
                              disabled={workflowBusy}
                              onChange={event => {
                                if (event.target.value === 'all') updateToolArgument(selectedToolAction.id, 'channel', 'all')
                                else if (selectedPowersChannels.length > 0) {
                                  updateToolArgument(selectedToolAction.id, 'channel', selectedPowersChannels[0])
                                }
                              }}
                            >
                              <option value="all">{t("app.all")}</option>
                              <option value="specific" disabled={selectedPowersChannels.length === 0}>{t("app.specificChannel")}</option>
                            </select>
                          </label>
                          {channelBound || savedChannel !== 'all' ? powersChannelSelector : powersChannelHint && (
                            <p className="value-source-help">{t("app.specificChannelIsUnavailable")}{powersChannelHint}</p>
                          )}
                        </>
                      )}

                      {selectedToolAction && selectedAction === 'powers/set-output' &&
                        (['voltage', 'current'] as const).map((name) => {
                            const active = hasPowerSetpoint(selectedToolAction, name)
                            const label = name === 'voltage' ? t("app.voltage") : t("app.currentLimit")
                            return <div className="step-properties-fields" key={`${selectedStep.id}-${name}`}>
                              {selectedAction === 'powers/set-output' && (
                                <label className="step-property-field step-property-checkbox">
                                  <input type="checkbox" checked={active}
                                    disabled={workflowBusy || (active && !hasPowerSetpoint(selectedToolAction, name === 'voltage' ? 'current' : 'voltage'))}
                                    onChange={(event) => updateStep(selectedToolAction.id, step =>
                                      step.type === 'tool-action'
                                        ? togglePowerSetpoint(step, name, event.target.checked)
                                        : step)} />
                                  <span className="step-property-label">{t("app.set")}{label}</span>
                                </label>
                              )}
                              {selectedAction === 'powers/set-output' && <p className="value-source-help">
                                {name === 'voltage'
                                  ? t("app.setTheChannelSOutputVoltageUncheckToLeave")
                                  : t("app.setTheMaximumAllowedOutputCurrentNotAForced")}
                              </p>}
                              {active && (
                                <InputValueEditor
                                  value={selectedToolAction.bindings?.[name] ?? { source: 'literal', value: numericArgument(selectedToolAction, name) }}
                                  sourceLabel={t("inputValueEditor.namedSource", { label })}
                                  literalLabel={`${label} (${name === 'voltage' ? 'V' : 'A'})`}
                                  literalDefault={powerSetpointLiteralDefault(selectedToolAction, name)}
                                  numericSetpoint
                                  earlierSteps={earlierSteps} backgrounds={workflowDraft.backgrounds ?? []}
                                  instances={workflowDraft.tool_instances}
                                  stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                                  earlierVariables={earlierVariables}
                                  disabled={workflowBusy}
                                  onChange={(value) => updateSetpointValue(selectedToolAction.id, name, value)}
                                />
                              )}
                            </div>
                          })}

                      {selectedAction === 'meters/measure' && (
                        <p className="step-properties-empty">{t("app.noEditableParameters")}</p>
                      )}
                      {selectedAction === 'meters/measure' && (
                        <p className="value-source-help">{t('app.workflowHelp.meterResult')}</p>
                      )}
                      {(() => {
                        if (selectedStep.type !== 'tool-action' && (selectedStep.type !== 'bg-interaction' ||
                          !['get-latest', 'wait-next', 'get-command-result'].includes(selectedStep.operation.kind))) return null
                        const fields = curatedResultFields(selectedStep, workflowDraft.tool_instances, t, workflowDraft.backgrounds ?? [], earlierSteps)
                        if (!fields.length) return null
                        const serialRead = selectedStep.type === 'tool-action' &&
                          (selectedAction === 'serial/receive' || selectedAction === 'serial/query')
                        const renderFields = (items: typeof fields, showHints = false) => items.map(field =>
                          <p key={field.pointer} className="value-source-help">{field.label}: <code>{field.pointer}</code>
                            {showHints && field.hint && <> — {field.hint}</>}</p>)
                        return <div className="workflow-help-group">
                          <span className="step-property-label">{t('app.workflowHelp.commonResults')}</span>
                          {serialRead ? <>
                            {renderFields(fields.filter(field => ['/outcome', '/timed_out'].includes(field.pointer)), selectedStep.arguments.fail_on_read_timeout !== true)}
                            <span className="step-property-label">{t('app.workflowHelp.serialCompletedResults')}</span>
                            {renderFields(fields.filter(field => ['/rx_hex', '/rx_bytes', '/rx_text'].includes(field.pointer)))}
                            {selectedStep.arguments.fail_on_read_timeout !== true && <>
                              <span className="step-property-label">{t('app.workflowHelp.serialTimeoutResults')}</span>
                              <p className="value-source-help">{t('app.workflowHelp.serialTimeoutResultHelp')}</p>
                              {renderFields(fields.filter(field => ['/partial_rx_hex', '/partial_rx_bytes', '/partial_rx_text'].includes(field.pointer)))}
                            </>}
                          </> : renderFields(fields.slice(0, 3), true)}
                          <p className="value-source-help">{t('app.workflowHelp.resultReference')}</p>
                        </div>
                      })()}

                      {selectedToolAction &&
                        !selectedPowersAction &&
                        selectedAction !== 'powers/protection-status' &&
                        selectedAction !== 'meters/measure' &&
                        !selectedAction?.startsWith('scopes/') &&
                         !selectedAction?.startsWith('serial/') && (
                          <p className="step-properties-empty">
                            {t("app.noEditablePropertiesAreAvailableForThisStep")}</p>
                        )}
                    </div>
                  )}
                </section>
              </div>

              {displayedRun && (
                <section className="run-messages" aria-labelledby="run-messages-title">
                  <h3 id="run-messages-title">
                    <button type="button" className="collapsible-header"
                      aria-expanded={messagesExpanded}
                      onClick={() => setMessagesExpanded(current => !current)}>
                      {t("app.messages")}<span aria-hidden="true">{messagesExpanded ? '−' : '+'}</span>
                    </button>
                  </h3>
                  <p className="run-result-count">
                    {t(messages.total === 1 ? 'app.messageCountOne' : 'app.messageCountMany', { count: messages.total.toLocaleString(locale) })} {t("app.oldestFirst")}{messages.discarded > 0 && messages.retained > 0 && t("app.showingTheMostRecent", { value1: messages.retained.toLocaleString(locale) })}
                  </p>
                  {messagesExpanded && <>
                    <div className="last-run-page-tabs" role="tablist" aria-label={t("app.messages")}>
                      {MESSAGE_TARGETS.map((target, index) => (
                        <button key={target} type="button" role="tab"
                          id={`message-tab-${index}`} aria-controls="run-messages-body"
                          aria-selected={target === messageTarget}
                          tabIndex={target === messageTarget ? 0 : -1}
                          onClick={() => setMessageTarget(target)}>
                          {t(`messages.${target}`)}
                        </button>
                      ))}
                    </div>
                    <div id="run-messages-body" role="tabpanel" aria-labelledby={`message-tab-${MESSAGE_TARGETS.indexOf(messageTarget)}`}>
                      {messages.items.length === 0
                        ? <p className="step-properties-empty">
                            {messages.total > 0 ? t("app.loadingMessages") : t("app.noMessagesWereProducedByThisRun")}
                          </p>
                        : <ol className="run-message-list" aria-label={t("app.messages2", { value1: t(`messages.${messageTarget}`) })}>
                            {messages.items.map((text, index) => (
                              <li className="run-message" key={`${messageTarget}:${index}`}>
                                <pre>{text}</pre>
                              </li>
                            ))}
                          </ol>}
                    </div>
                  </>}
                </section>
              )}

              {displayedRun && (
                <section className="run-results" aria-labelledby="run-results-title">
                  <h3 id="run-results-title">
                    <button type="button" className="collapsible-header"
                      aria-expanded={executionsExpanded}
                      onClick={() => setExecutionsExpanded(current => !current)}>
                      {t("app.lastRunExecutionResults")}{lastRunExecutionMode && <span className={`execution-mode-badge execution-mode-${lastRunExecutionMode}`}>{executionModeLabel(lastRunExecutionMode, t)}</span>}
                      <span aria-hidden="true">{executionsExpanded ? '−' : '+'}</span>
                    </button>
                  </h3>
                  <p className="run-result-count">
                    {t(executions.total === 1 ? 'app.executionCountOne' : 'app.executionCountMany', { count: executions.total.toLocaleString(locale) })} {t("app.latestFirst")}</p>
                  {executionsExpanded && <>
                  {executions.total > EXECUTION_WINDOW_SIZE && <div className="section-header">
                    <p aria-live="polite">
                      {t("app.showing")}{executions.start.toLocaleString(locale)}{t("app.ndash")}{executions.end.toLocaleString(locale)} {t("app.of")}{executions.total.toLocaleString(locale)}
                    </p>
                    <div className="result-chart-panel-actions">
                      <button className="action-button" type="button" disabled={!executions.hasNewer}
                        onClick={() => setExecutionOffset(Math.max(0, executions.offset - EXECUTION_WINDOW_SIZE))}>{t("app.newer")}</button>
                      <button className="action-button" type="button" disabled={!executions.hasOlder}
                        onClick={() => setExecutionOffset(executions.offset + EXECUTION_WINDOW_SIZE)}>{t("app.older")}</button>
                    </div>
                  </div>}
                  <ol key={executions.offset} className="run-result-list" aria-label={t("app.lastRunExecutionResults2")} tabIndex={0}>
                    {executions.items.map((result, executionIndex) => {
                      const resultStep = runStepsById.get(result.step_id)
                      const isOutput = resultStep?.type === 'output'
                      const formattedMeasurement = formatMeasurement(result.output)
                      const measurement = result.status !== 'succeeded'
                        ? null
                        : isOutput
                          ? result.output_omitted && result.output === null
                            ? t("app.previewOmitted")
                            : `${JSON.stringify(result.output)}${result.output_omitted ? ' …' : ''}`
                          : formattedMeasurement
                            ? `${formattedMeasurement}${result.output_omitted ? ' …' : ''}`
                            : result.output_omitted
                              ? t("app.previewOmitted")
                              : null
                      const statusLabel =
                        result.status === 'succeeded'
                          ? t("app.success")
                          : result.status === 'failed'
                            ? t("app.failed")
                            : t("app.cancelled")
                      const statusMark =
                        result.status === 'succeeded'
                          ? '✓'
                          : result.status === 'failed'
                            ? '✕'
                            : '—'

                      return (
                        <li key={`${executionIndex}:${occurrenceKey(result)}`} className="run-result-card">
                          <span
                            className={`run-result-mark run-result-${result.status}`}
                            aria-hidden="true"
                          >
                            {statusMark}
                          </span>
                          <div className="run-result-content">
                            <div className="run-result-summary">
                              <code className="workflow-step-id">{result.step_id}</code>
                              {result.for_iteration && <span>{t("app.for")}{result.for_iteration.for_step_id} {t("app.iteration")}{result.for_iteration.iteration_index + 1}</span>}
                              {result.while_iteration && <span>{t("app.while")}{result.while_iteration.while_step_id} {t("app.iteration")}{result.while_iteration.iteration_index + 1}</span>}
                              <span className={`run-result-status run-result-${result.status}`}>
                                {statusLabel}
                              </span>
                              {measurement && (
                                <span className="run-result-measurement">{measurement}</span>
                              )}
                            </div>
                            {result.status === 'failed' && result.message && (
                              <FailureDetails message={result.message} step={resultStep} />
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                  </>}
                </section>
              )}
            </div>
          )}
        </section>
      )}
      {activeTab === 'output' && (
        <section id="output-panel" role="tabpanel" aria-labelledby="output-tab">
          <div className="section-header">
            <h2>{t("app.output")}</h2>
          </div>
          {stopControls}
          {stopFeedback}
          {csvStreamFeedback}
          {!hasWorkflowOutputs && !workflowDraft?.backgrounds?.length && (
            <>
              <p>{t("app.noWorkflowOutputsDefined")}</p>
              <p>{t("app.addOutputStepsToTheWorkflowToPublishFinal")}</p>
            </>
          )}
          {!runWorkspace.visible ? (
            <>
              <p>{t("app.noRunResultsYet")}</p>
              <p>{t("app.runTheWorkflowToViewItsOutputs")}</p>
            </>
          ) : (
            <section aria-labelledby="last-run-title">
              <div className="section-header">
                <h3 id="last-run-title">{t("app.lastRun")}{lastRunExecutionMode && <span className={`execution-mode-badge execution-mode-${lastRunExecutionMode}`}>{executionModeLabel(lastRunExecutionMode, t)}</span>}</h3>
                {runWorkflowSnapshot && <button className="action-button action-button-danger" type="button"
                  disabled={workflowBusy} onClick={() => void handleClearLastRun()}>{t("app.clearLastRun")}</button>}
              </div>
              {clearLastRunError && <p className="error" role="alert">{clearLastRunError}</p>}
              {runStatus === 'running' && <p role="status">{runningText}</p>}
              {displayedRun?.status === 'stopped' && <p role="status">{t("app.runStopped")}</p>}
              {runWorkflowSnapshot && <OutputCharts key={`charts-${displayedRun?.run_id ?? 'starting'}`} runId={displayedRun?.run_id ?? null}
                pages={runPages} metadata={displayedRun?.pages ?? []} backgrounds={runWorkflowSnapshot.backgrounds ?? []}
                currentDraftBackgrounds={workflowDraft?.backgrounds ?? null}
                toolKinds={Object.fromEntries(runWorkflowSnapshot.tool_instances.map(instance => [instance.id, instance.tool]))}
                panels={chartPanels} onPanelsChange={setChartPanels} chartData={chartData} running={runStatus === 'running'}
                onSavingChange={handleChartSavingChange} changeSettings={runChartSampling} fitData={runChartFitData}
                saveChartsWithTemplate={saveChartsWithTemplate} onSaveChartsWithTemplateChange={setSaveChartsWithTemplate}
                selections={backgroundChartSelections} />}
              {runWorkflowSnapshot && <LiveMonitors key={`monitors-${displayedRun?.run_id ?? 'starting'}`}
                runId={displayedRun?.run_id ?? null} backgrounds={runWorkflowSnapshot.backgrounds ?? []}
                toolKinds={Object.fromEntries(runWorkflowSnapshot.tool_instances.map(instance => [instance.id, instance.tool]))}
                running={runStatus === 'running'} />}
              <Collapsible title={t("app.foregroundOutput")} framed>
              {runPage && <div className="output-source-card">
                <h4>{t("app.source")}</h4>
                <label>{t("app.outputPage")}<select value={runPage.name} disabled={chartSaving}
                    onChange={event => setSelectedRunPage(event.target.value)}>
                    {runPages.map(page => <option key={page.name} value={page.name}>{page.name}</option>)}
                  </select>
                </label>
                <p className="output-source-meta">{t("app.page")}{runPages.indexOf(runPage) + 1} {t("app.of")}{runPages.length}</p>
                <p className="output-source-help">{t("app.selectAnOutputPageFromThisRunToView")}</p>
              </div>}
              <div id="last-run-workspace" role="region" aria-label={t("app.outputPageResults")}>
                {!hasRunOutputs && <p>{t("app.noWorkflowOutputsWereDefinedForThisRun")}</p>}
                {partialRun && <p className="feedback-warning" role="status">{runMetadata.pages.some(page => page.row_count > 0)
                  ? t("app.runDidNotFullyCompleteCommittedRowsArePartial")
                  : t("app.runDidNotFullyCompleteNoCommittedOutputRows")}</p>}
                {displayedRun?.status === 'failed' && displayedRun.error && (
                  <div className="error" role="alert">
                    <p className="failure-run-title">{t("app.runFailed")}</p>
                    <FailureDetails message={displayedRun.error} />
                  </div>
                )}
                {(runPageMetadata?.row_count ?? 0) === 0 && <p>{t("app.noCommittedOutputRows")}</p>}
                {runPageMetadata && runPageMetadata.row_count > 0 && <div className="numeric-display-settings">
                  <label>{t("app.numberDisplay")}<select value={numericFormat.mode} onChange={event => setNumericFormat(current => ({
                      ...current, mode: event.target.value as NumericDisplayFormat['mode'],
                    }))}>
                      <option value="auto">{t("app.auto")}</option><option value="fixed">{t("app.fixed")}</option><option value="raw">{t("app.raw")}</option>
                    </select>
                  </label>
                  {numericFormat.mode === 'fixed' && <label>{t("app.decimalPlaces")}<select value={numericFormat.decimalPlaces} onChange={event => setNumericFormat(current => ({
                      ...current, decimalPlaces: Number(event.target.value),
                    }))}>
                      {Array.from({ length: 13 }, (_, places) => <option key={places} value={places}>{places}</option>)}
                    </select>
                  </label>}
                </div>}
                {runPageMetadata && runPageMetadata.row_count > 0 && <PageResultSummary summaries={runPageMetadata.summaries} outputs={runOutputs} numericFormat={numericFormat} />}
                {displayedRun && runPage && runPageMetadata && runPageMetadata.row_count > 0 && (
                  <Collapsible className="output-data" title={t("app.outputData")}>
                    <p className="output-row-count">
                      {t(runPageMetadata.row_count === 1 ? "app.outputRowCountOne" : "app.outputRowCountOther", { count: runPageMetadata.row_count })}{t("app.latestFirst")}</p>
                    <VirtualizedOutputTable key={`${displayedRun.run_id}:${runPage.name}`} runId={displayedRun.run_id} page={runPage.name}
                      rowCount={runPageMetadata.row_count} revision={runPageMetadata.revision}
                      outputs={runOutputs} iterationRows={runPageMetadata.iteration_rows} numericFormat={numericFormat} />
                  </Collapsible>
                )}
              </div>

          <div className="output-export-settings">
            <h4>{t("app.exportSettings")}</h4>
            <div className="output-export-controls">
              <label>{t("app.pages")}<select aria-label={t("app.exportPages")} disabled={workflowBusy} value={exportAllPages ? 'all' : 'current'}
                  onChange={event => setExportAllPages(event.target.value === 'all')}>
                  <option value="current">{t("app.runPage")}</option><option value="all">{t("app.allRunPages")}</option>
                </select>
              </label>
              <label>{t("app.format")}<select aria-label={t("app.exportFormat")} disabled={workflowBusy} value={exportFormat}
                  onChange={event => setExportFormat(event.target.value as 'csv' | 'xlsx')}>
                  <option value="csv">{t("app.cSV")}</option><option value="xlsx">{t("app.xLSX")}</option>
                </select>
              </label>
              <button className="action-button" type="button" onClick={() => void handleExport()}
                disabled={!hasRunOutputs || !runExportable || !hasExportableOutputRows || workflowBusy}>
                {exporting ? t("app.exporting") : t("app.export", { value1: partialRun ? t("app.partial") : '', value2: exportFormat.toUpperCase() })}
              </button>
            </div>
            <p className="output-export-help">{exportAllPages && exportFormat === 'csv'
              ? t("app.exportAllOutputPagesAsSeparateCSVFilesChoose")
              : exportAllPages
                ? t("app.exportAllOutputPagesInOneXLSXFileChoose")
                : t("app.exportTheSelectedOutputPageChooseAFileName")}</p>
            {exportMessage && <p className="validation-success" role="status">{exportMessage}</p>}
            {exportError && <p className="error" role="alert">{t("app.exportFailed")}{exportError}</p>}
          </div>
              </Collapsible>
              {!!runWorkflowSnapshot?.backgrounds?.length && displayedRun && <BackgroundOutput key={`background-${displayedRun.run_id}`}
                runId={displayedRun.run_id} backgrounds={runWorkflowSnapshot.backgrounds} running={runStatus === 'running'}
                onExportingChange={setExporting} numericFormat={numericFormat} onNumericFormatChange={setNumericFormat} />}
            </section>
          )}

        </section>
      )}
      {simulationSamples.dialog}
    </main>
  )
}

export default App
