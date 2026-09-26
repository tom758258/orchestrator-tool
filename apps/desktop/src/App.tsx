import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { Channel, invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { effectiveTheme, nextThemePreference, readThemePreference, writeThemePreference } from './theme'
import { confirm, open, save } from '@tauri-apps/plugin-dialog'
import SequenceEditor from './SequenceEditor'
import ResultChart from './ResultChart'
import { EXECUTION_WINDOW_SIZE } from './executionWindow'
import VirtualizedOutputTable from './VirtualizedOutputTable'
import PageResultSummary from './PageResultSummary'
import { reconcileRunChartPanels, type ChartPanel } from './chartPanels'
import { pruneChartData, type PageChartData } from './chartData'
import { claimRunGate, isCurrentRunGeneration, prepareLastRunReplacement, releaseRunGate } from './runLifecycle'
import ToolSetupEditor from './ToolSetupEditor'
import type { ToolInstance } from './ToolSetupEditor'
import InputValueEditor, { ExpressionOperandEditor } from './InputValueEditor'
import { COMPARISON_OPERATORS } from './inputValue'
import type { ComparisonOperator, InputValueWire } from './inputValue'
import { allWorkflowSteps, mapWorkflowSteps, loopPath, outputPages, outputPageContext, enclosingLoop, enclosingForVariables, insertionLoop, inputScope, outputDefinitions, occurrenceKey, compatibleOutputPages } from './workflow'
import type { WorkflowStep, ToolActionStep, WorkflowRunEventDto, StepExecutionDto, RunMetadataDto } from './workflow'
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
  clearPlan: unknown | null
  clearCompleted: boolean
}

type PowersClearResult =
  | { mode: 'simulate'; outcome: 'planned'; plan: unknown }
  | { mode: 'live'; outcome: 'completed'; status: PowersProtectionStatus }

function deviceName(identity: ResourceIdentity | null | undefined): string {
  return [identity?.manufacturer?.trim(), identity?.model?.trim()].filter(Boolean).join(' ')
    || identity?.identity?.trim() || ''
}

function targetLabel(id: string, identity: ResourceIdentity | null | undefined): string {
  const name = identity?.model?.trim() || deviceName(identity)
  const serial = identity?.serial?.trim()
  const detail = [name, serial ? `[${serial}]` : ''].filter(Boolean).join(' ')
  return detail ? `${id} — ${detail}` : id
}

function formatResourceCandidate(candidate: LiveResourceCandidate): string {
  const name = deviceName(candidate)
  const serial = candidate.serial?.trim()
  const detail = [name, serial ? `[${serial}]` : ''].filter(Boolean).join(' ')
  return detail ? `${detail} — ${candidate.resource}` : candidate.resource
}

function formatLiveResourceConfirmation(
  instance: ToolInstance,
  resource: string,
  identity: ResourceIdentity | null | undefined,
): string {
  const lines = [`${instance.id} (${instance.tool})`]
  const name = deviceName(identity)
  const serial = identity?.serial?.trim()
  if (name) {
    lines.push(name)
  }
  if (serial) {
    lines.push(`S/N: ${serial}`)
  }
  lines.push(resource)
  return lines.join('\n')
}

type WorkflowDraft = {
  schema_version: number
  name: string
  tool_instances: ToolInstance[]
  workflow: {
    steps: WorkflowStep[]
  }
}

type ActiveTab = 'tools' | 'setup' | 'workflow' | 'output'
type ValidationStatus = 'idle' | 'validating' | 'valid'
type TemplateIoStatus = 'idle' | 'loading' | 'saving'
type RunStatus = 'idle' | 'running'
type StepPreset =
  | 'for'
  | 'while'
  | 'assert'
  | 'set-variable'
  | 'output'
  | 'power-set-output'
  | 'power-protection-status'
  | 'power-output-on'
  | 'wait'
  | 'meter-measure'
  | 'power-output-off'

type StepPresetOption = {
  value: StepPreset
  label: string
  prefix: string
  category: string
  tool?: ToolInstance['tool']
}

const STEP_PRESETS: StepPresetOption[] = [
  { value: 'while', label: 'While', prefix: 'while', category: 'Workflow' },
  { value: 'for', label: 'For', prefix: 'for', category: 'Workflow' },
  { value: 'set-variable', label: 'Set Variable', prefix: 'set-variable', category: 'Workflow' },
  { value: 'output', label: 'Output', prefix: 'output', category: 'Workflow' },
  { value: 'power-set-output', label: 'Power Set Output', prefix: 'power-set', category: 'Powers', tool: 'powers' },
  { value: 'power-protection-status', label: 'Power Protection Status', prefix: 'power-protection', category: 'Powers', tool: 'powers' },
  { value: 'power-output-on', label: 'Power Output ON', prefix: 'power-on', category: 'Powers', tool: 'powers' },
  { value: 'wait', label: 'Wait', prefix: 'wait', category: 'Workflow' },
  { value: 'assert', label: 'Assert', prefix: 'assert', category: 'Workflow' },
  { value: 'meter-measure', label: 'Meter Measure', prefix: 'meter-read', category: 'Meters', tool: 'meters' },
  { value: 'power-output-off', label: 'Power Output OFF', prefix: 'power-off', category: 'Powers', tool: 'powers' },
]

const TOOL_ACTION_LABELS: Record<string, string> = {
  'powers/set-output': 'Power Set Output',
  'powers/protection-status': 'Power Protection Status',
  'powers/set-voltage': 'Power Set Voltage',
  'powers/output-on': 'Power Output ON',
  'meters/measure': 'Meter Measure',
  'powers/output-off': 'Power Output OFF',
}

const STEP_HELP: Record<string, string> = {
  while: 'Repeat while a comparison is true. Max iterations is a safety limit, not expected work.',
  for: 'Repeat these body steps over an exact decimal range. Loops can nest up to 5 levels.',
  assert: 'Fail the Workflow when this comparison is false.',
  'set-variable': 'Save a value or calculation result so later steps can reuse it.',
  output: 'Publish a value as a final Workflow result. This does not control a Power output.',
  wait: 'Pause before running the next step. Useful for DUT or signal settling time.',
  'powers/set-output': 'Set Voltage, Current Limit, or both for a Power channel. Current Limit is the power supply output current-limit setpoint. Specify at least one. This does not enable output; use Power Output ON separately.',
  'powers/protection-status': 'Power Protection Status reads the selected Power channel protection state without changing instrument settings. Use Protection Tripped with Assert when the Workflow should fail after detecting a protection trip.',
  'powers/set-voltage': 'Set the voltage for a Power channel. This does not enable the channel output.',
  'powers/output-on': 'Enable the selected Power channel.',
  'powers/output-off': 'Disable the selected Power channel.',
  'meters/measure': 'Acquire the next Meter reading or Custom batch using the trigger mode defined in Setup. The result can be used by later steps.',
}

const EXECUTABLE_LABELS: Record<string, string> = {
  'not-configured': 'Not configured',
  available: 'Available',
  missing: 'Missing',
  'not-file': 'Not a file',
  error: 'Error',
}

const COMPATIBILITY_LABELS: Record<string, string> = {
  compatible: 'Compatible',
  incompatible: 'Incompatible',
  'not-probed': '—',
  error: 'Error',
}

const SOURCE_LABELS: Record<string, string> = {
  configured: 'Configured',
  'not-configured': 'Not configured',
}

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
  switch (preset) {
    case 'while':
      return { type: 'while', id, left: { source: 'literal', value: 0 }, operator: 'less-than', right: { source: 'literal', value: 1 }, max_iterations: 1000, steps: [] }
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
  }
}

function stepLabel(step: WorkflowStep, instances: ToolInstance[]): string {
  if (step.type === 'while') return 'While'
  if (step.type === 'for') return `For ${step.variable} = ${step.range.start}..${step.range.stop}`
  if (step.type === 'set-variable') {
    return 'Set Variable'
  }
  if (step.type === 'output') {
    return 'Output'
  }
  if (step.type === 'assert') {
    return 'Assert'
  }
  if (step.type === 'wait') {
    return 'Wait'
  }

  const tool = instances.find(instance => instance.id === step.target)?.tool
  return TOOL_ACTION_LABELS[`${tool}/${step.action}`] ?? `${step.target} / ${step.action}`
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

function streamingOptions(enabled: boolean, outputFolder: string | null, page: string, allPages: boolean) {
  if (!enabled) return null
  const timestamp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
    .slice(0, 19).replace(/[T:]/g, '-')
  return { output_folder: outputFolder, timestamp, page, all_pages: allPages }
}

function App() {
  const [themePreference, setThemePreference] = useState(readThemePreference)
  const [applicationVersion, setApplicationVersion] = useState<string | null>(null)
  const [helpError, setHelpError] = useState<string | null>(null)
  async function handleOpenHelp() {
    setHelpError(null)
    try {
      await invoke('open_help', { theme: themePreference })
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

  const themeLabel = (value: string) => value[0].toUpperCase() + value.slice(1)
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
  const [streamPage, setStreamPage] = useState('Results')
  const [streamAllPages, setStreamAllPages] = useState(false)
  const [streamOutputFolder, setStreamOutputFolder] = useState<string | null>(null)
  const [chartSaving, setChartSaving] = useState(false)
  const [choosingStreamOutputFolder, setChoosingStreamOutputFolder] = useState(false)
  const [exportAllPages, setExportAllPages] = useState(false)
  const [exportFormat, setExportFormat] = useState<'csv' | 'xlsx'>('csv')
  const [chartPanels, setChartPanels] = useState<ChartPanel[]>([])
  const [activeTab, setActiveTab] = useState<ActiveTab>('tools')
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(DEFAULT_EXECUTION_MODE)
  const [lastRunExecutionMode, setLastRunExecutionMode] = useState<ExecutionMode | null>(null)
  const [tools, setTools] = useState<ToolStatus[]>([])
  const metersTool = tools.find(tool => tool.tool_id === 'meters')
  const metersExecutableKey = JSON.stringify([metersTool?.source ?? null, metersTool?.path ?? null])
  const powersTool = tools.find(status => status.tool_id === 'powers')
  const powersExecutableKey = JSON.stringify([powersTool?.source ?? null, powersTool?.path ?? null])
  const [resourceIdentities, setResourceIdentities] = useState<Record<string, ResourceIdentity | null>>({})
  const [resourceIdentityDrafts, setResourceIdentityDrafts] = useState<Record<string, ResourceIdentity | null>>({})
  const [resourceDrafts, setResourceDrafts] = useState<Record<string, string>>({})
  const [savedResources, setSavedResources] = useState<Record<string, string>>({})
  const [powersStatuses, setPowersStatuses] = useState<Record<string, PowersStatusState>>({})
  const [powersOperationBusy, setPowersOperationBusy] = useState<string | null>(null)
  const [powersSimulationChannels, setPowersSimulationChannels] = useState<number[]>([])
  const [discoveredResources, setDiscoveredResources] = useState<Record<string, LiveResourceCandidate[] | undefined>>({})
  const [discoveryErrors, setDiscoveryErrors] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toolConfigBusy, setToolConfigBusy] = useState<string | null>(null)
  const [toolConfigError, setToolConfigError] = useState<string | null>(null)
  const [workflowDraft, setWorkflowDraft] = useState<WorkflowDraft | null>(null)
  const [draftLoading, setDraftLoading] = useState(true)
  const [draftCreationError, setDraftCreationError] = useState<string | null>(null)
  const [validationStatus, setValidationStatus] = useState<ValidationStatus>('idle')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [templateIoStatus, setTemplateIoStatus] = useState<TemplateIoStatus>('idle')
  const [templateIoError, setTemplateIoError] = useState<string | null>(null)
  const [templateIoMessage, setTemplateIoMessage] = useState<string | null>(null)
  const runInFlightRef = useRef(false)
  const runGenerationRef = useRef(0)
  const [liveConfirmationPending, setLiveConfirmationPending] = useState(false)
  const [runStatus, setRunStatus] = useState<RunStatus>('idle')
  const [runWorkflowSnapshot, setRunWorkflowSnapshot] = useState<WorkflowDraft | null>(null)
  const [workflowChangedSinceRun, setWorkflowChangedSinceRun] = useState(false)
  const [executionOffset, setExecutionOffset] = useState(0)
  const [runMetadata, setRunMetadata] = useState<RunMetadataDto | null>(null)
  const runIdRef = useRef<number | null>(null)
  const [executionPage, setExecutionPage] = useState<ExecutionRowsResponse | null>(null)
  const progressChannelRef = useRef<Channel<DesktopRunEvent> | null>(null)
  const [stopRequest, setStopRequest] = useState<{ loopId: string, error?: string } | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [streamCsv, setStreamCsv] = useState(false)
  const [csvStreamStatus, setCsvStreamStatus] = useState<CsvStreamStatus | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  useEffect(() => {
    if (executionMode !== 'simulate') {
      setPowersSimulationChannels([])
      return
    }
    let cancelled = false
    void invoke<{ channels: number[] }>('get_powers_capabilities', { executionMode: 'simulate' }).then(
      capabilities => { if (!cancelled) setPowersSimulationChannels(capabilities.channels) },
      () => { if (!cancelled) setPowersSimulationChannels([]) },
    )
    return () => { cancelled = true }
  }, [executionMode, powersExecutableKey])
  const outputSteps = outputDefinitions(workflowDraft?.workflow.steps ?? [])
  const pages = outputPages(workflowDraft?.workflow.steps ?? [])
  const streamingPage = pages.some(page => page.name === streamPage) ? streamPage : pages[0]?.name ?? 'Results'
  const hasWorkflowOutputs = outputSteps.length > 0
  const runWorkflowSteps = runWorkflowSnapshot?.workflow.steps ?? []
  const { pages: runPages, page: runPage, outputs: runOutputs } = useMemo(() =>
    outputPageContext(runWorkflowSnapshot?.workflow.steps ?? [], selectedRunPage), [runWorkflowSnapshot, selectedRunPage])
  const hasRunOutputs = outputDefinitions(runWorkflowSteps).length > 0
  const runSucceeded = runMetadata?.status === 'succeeded'
  const runExportable = runMetadata?.manual_exportable === true
  const runPageMetadata = runMetadata?.pages.find(page => page.name === runPage?.name)
  const hasExportableOutputRows = exportAllPages
    ? runMetadata?.pages.some(page => page.row_count > 0) ?? false
    : (runPageMetadata?.row_count ?? 0) > 0
  const latestExecution = runMetadata?.latest_execution
  const activeLoop = runStatus !== 'running' ? null : latestExecution?.for_iteration
    ? { kind: 'For', id: latestExecution.for_iteration.for_step_id, index: latestExecution.for_iteration.iteration_index }
    : latestExecution?.while_iteration
      ? { kind: 'While', id: latestExecution.while_iteration.while_step_id, index: latestExecution.while_iteration.iteration_index }
      : null
  const stopping = activeLoop !== null && stopRequest?.loopId === activeLoop.id && !stopRequest.error
  const runningText = activeLoop
    ? `${activeLoop.kind} ${activeLoop.id} · Iteration ${activeLoop.index + 1} · ${stopping ? 'Stopping…' : 'Running'}`
    : 'Running…'
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
    {activeLoop && <>
      {activeAncestors.map(loop => <button className="action-button action-button-danger" type="button" key={loop.id}
        disabled={stopRequest !== null && !stopRequest.error} onClick={() => void requestStop(loop.id)}>Stop {loop.id}</button>)}
      <button className="action-button action-button-danger" type="button" onClick={() => void requestStop()} disabled={stopRequest !== null && !stopRequest.error}>
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
    </>}
  </>
  const stopFeedback = <>
    {activeLoop && <p>Finishes the current innermost iteration, then stops the selected loop.</p>}
    {stopRequest?.error && <p className="error" role="alert">Stop request failed: {stopRequest.error}</p>}
  </>
  const displayedRun = runWorkflowSnapshot ? runMetadata : null
  // Numeric arrays survive Page/Output tab switches, but never cross a run ID.
  const chartData = useMemo(() => new Map<string, PageChartData>(), [runMetadata?.run_id])
  useEffect(() => {
    if (!runWorkflowSnapshot || !displayedRun) return
    setChartPanels(panels => reconcileRunChartPanels(
      panels, outputPages(runWorkflowSnapshot.workflow.steps), displayedRun.pages,
    ))
  }, [runWorkflowSnapshot, displayedRun])
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

  useEffect(() => {
    setExportError(null)
    setExportMessage(null)
  }, [workflowDraft, runMetadata, runStatus])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const statuses = await invoke<ToolStatus[]>('get_tool_status')
      setTools(statuses)
      const [resources, identities] = await Promise.all([
        invoke<Record<string, string>>('get_live_resources'),
        invoke<Record<string, ResourceIdentity>>('get_live_resource_identities'),
      ])
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
    setDraftLoading(true)
    try {
      const draft = await prepareLastRunReplacement(
        async () => JSON.parse(await invoke<string>('create_workflow_draft')) as WorkflowDraft,
        runIdRef.current,
        async runId => { await invoke('clear_last_run', { runId }) },
      )
      runGenerationRef.current += 1
      runIdRef.current = null
      setWorkflowDraft(draft)
      setExecutionMode(DEFAULT_EXECUTION_MODE)
      setPowersStatuses({})
      setSelectedStepId(null)
      setDraftCreationError(null)
      setRunMetadata(null)
      setLastRunExecutionMode(null)
      setExecutionPage(null)
      setRunWorkflowSnapshot(null)
      setChartPanels([])
      setExecutionOffset(0)
      setWorkflowChangedSinceRun(false)
      setCsvStreamStatus(null)
      setRunError(null)
    } catch (message) {
      setDraftCreationError(String(message))
    } finally {
      setDraftLoading(false)
    }
  }, [])

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
      setValidationStatus('idle')
      setValidationError(null)
      setTemplateIoMessage(null)
    },
    [],
  )

  const updateToolInstances = useCallback((tool_instances: ToolInstance[]) => {
    setPowersStatuses(current => Object.fromEntries(
      Object.entries(current).filter(([id]) => tool_instances.some(instance => instance.id === id)),
    ))
    setWorkflowDraft((current) => current ? { ...current, tool_instances } : current)
    setWorkflowChangedSinceRun(true)
    setValidationStatus('idle')
    setValidationError(null)
    setTemplateIoMessage(null)
  }, [])

  const addStep = useCallback((preset: StepPresetOption) => {
    if (!workflowDraft) {
      return
    }
    const parent = insertionLoop(workflowDraft.workflow.steps, selectedStepId)
    if (parent && (preset.value === 'for' || preset.value === 'while') && loopPath(workflowDraft.workflow.steps, parent.id).length >= 4) return
    const target = workflowDraft.tool_instances.find(instance => instance.tool === preset.tool)?.id
    if (preset.tool && !target) {
      setValidationError(`Create a ${preset.tool} Tool Instance on the Setup tab before adding this action.`)
      return
    }
    const id = nextStepId(preset.prefix, workflowDraft.workflow.steps)
    const newStep = createPresetStep(preset.value, id, target ?? '')
    updateSteps((steps) => {
      if (parent) {
        return mapWorkflowSteps(steps, step => {
          if (step.id !== parent.id || (step.type !== 'for' && step.type !== 'while')) return step
          const index = step.steps.findIndex(body => body.id === selectedStepId)
          const insertIndex = index < 0 ? step.steps.length : index + 1
          return { ...step, steps: [...step.steps.slice(0, insertIndex), newStep, ...step.steps.slice(insertIndex)] }
        })
      }
      const selectedIndex = steps.findIndex((step) => step.id === selectedStepId)
      const insertIndex = selectedIndex < 0 ? steps.length : selectedIndex + 1
      return [...steps.slice(0, insertIndex), newStep, ...steps.slice(insertIndex)]
    })
    setSelectedStepId(id)
  }, [workflowDraft, selectedStepId, updateSteps])

  const deleteStep = useCallback(
    (stepId: string) => {
      updateSteps((steps) => mapWorkflowSteps(steps, step => step.id === stepId ? null : step))
      setSelectedStepId(current => current === stepId ||
        loopPath(workflowDraft?.workflow.steps ?? [], current).some(loop => loop.id === stepId) ? null : current)
    },
    [updateSteps, workflowDraft],
  )

  const clearWorkflow = useCallback(async () => {
    if (!workflowDraft || workflowDraft.workflow.steps.length === 0) {
      return
    }

    const approved = await confirm(
      'Clear all workflow steps?\n\nThis action cannot be undone.',
      { title: 'Clear Workflow', kind: 'warning', okLabel: 'Clear', cancelLabel: 'Cancel' },
    )
    if (!approved) {
      return
    }

    updateSteps(() => [])
    setSelectedStepId(null)
  }, [updateSteps, workflowDraft])

  const updateStep = useCallback(
    (stepId: string, update: (step: WorkflowStep) => WorkflowStep) => {
      updateSteps(steps => mapWorkflowSteps(steps, step => step.id === stepId ? update(step) : step))
    },
    [updateSteps],
  )

  const updateToolArgument = useCallback(
    (stepId: string, name: string, value: number | 'all') => {
      updateStep(stepId, (step) => {
        if (step.type !== 'tool-action') {
          return step
        }

        return {
          ...step,
          arguments: {
            ...step.arguments,
            [name]: value,
          },
        }
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
      updateSteps((steps) => {
        const parent = enclosingLoop(steps, stepId)
        const siblings = parent?.steps ?? steps
        const index = siblings.findIndex(step => step.id === stepId)
        const targetIndex = index + offset
        if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) return steps
        const reordered = [...siblings]
        const currentStep = reordered[index]
        reordered[index] = reordered[targetIndex]
        reordered[targetIndex] = currentStep
        return parent
          ? mapWorkflowSteps(steps, step => step.id === parent.id ? { ...parent, steps: reordered } : step)
          : reordered
      })
    },
    [updateSteps],
  )

  const validateDraft = useCallback(async () => {
    if (!workflowDraft) {
      return
    }

    setValidationStatus('validating')
    setValidationError(null)
    try {
      const canonicalJson = await invoke<string>('validate_workflow_draft', {
        templateJson: JSON.stringify(workflowDraft),
      })
      const canonicalDraft = JSON.parse(canonicalJson) as WorkflowDraft
      setWorkflowDraft(canonicalDraft)
      setSelectedStepId((current) =>
        current && allWorkflowSteps(canonicalDraft.workflow.steps).some((step) => step.id === current)
          ? current
          : null,
      )
      setValidationStatus('valid')
    } catch (message) {
      setValidationStatus('idle')
      setValidationError(String(message))
    }
  }, [workflowDraft])

  const handleLoadTemplate = useCallback(async () => {
    setTemplateIoStatus('loading')
    setTemplateIoError(null)
    setTemplateIoMessage(null)
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'JSON Template', extensions: ['json'] }],
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
      setWorkflowDraft(loadedDraft)
      setExecutionMode(DEFAULT_EXECUTION_MODE)
      setPowersStatuses({})
      setSelectedStepId(null)
      setValidationStatus('valid')
      setValidationError(null)
      setRunMetadata(null)
      setLastRunExecutionMode(null)
      setExecutionPage(null)
      setRunWorkflowSnapshot(null)
      setChartPanels([])
      setExecutionOffset(0)
      setWorkflowChangedSinceRun(false)
      setCsvStreamStatus(null)
      setRunError(null)
      setTemplateIoMessage('Template loaded.')
      setTemplateIoStatus('idle')
    } catch (message) {
      setTemplateIoError(String(message))
      setTemplateIoStatus('idle')
    }
  }, [])

  const handleSaveTemplate = useCallback(async () => {
    if (!workflowDraft) {
      return
    }

    setTemplateIoStatus('saving')
    setTemplateIoError(null)
    setTemplateIoMessage(null)
    try {
      const path = await save({
        filters: [{ name: 'JSON Template', extensions: ['json'] }],
      })
      if (!path) {
        setTemplateIoStatus('idle')
        return
      }
      const canonicalJson = await invoke<string>('save_workflow_template', {
        path,
        templateJson: JSON.stringify(workflowDraft),
      })
      const canonicalDraft = JSON.parse(canonicalJson) as WorkflowDraft
      setWorkflowDraft(canonicalDraft)
      setSelectedStepId((current) =>
        current && allWorkflowSteps(canonicalDraft.workflow.steps).some((step) => step.id === current)
          ? current
          : null,
      )
      setValidationStatus('valid')
      setValidationError(null)
      setTemplateIoMessage('Template saved.')
      setTemplateIoStatus('idle')
    } catch (message) {
      setTemplateIoError(String(message))
      setTemplateIoStatus('idle')
    }
  }, [workflowDraft])

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
          filters: [{ name: 'Executables', extensions: ['exe'] }],
        })
        if (!selected || Array.isArray(selected)) {
          return
        }
        await invoke('set_tool_executable', { toolId, path: selected })
        setDiscoveredResources((current) => ({ ...current, [toolId]: undefined }))
        setDiscoveryErrors((current) => ({ ...current, [toolId]: null }))
        await refresh()
      } catch (message) {
        setToolConfigError(String(message))
      } finally {
        setToolConfigBusy(null)
      }
    },
    [refresh, toolConfigBusy],
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
        setDiscoveredResources((current) => ({ ...current, [toolId]: undefined }))
        setDiscoveryErrors((current) => ({ ...current, [toolId]: null }))
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
        instanceId: toolId, ...(clear ? {} : { resource: resourceDrafts[toolId] ?? '', identity: resourceIdentityDrafts[toolId] ?? null }),
      })
      await refresh()
    } catch (message) {
      setToolConfigError(String(message))
    } finally {
      setToolConfigBusy(null)
    }
  }, [refresh, resourceDrafts, resourceIdentityDrafts, toolConfigBusy])

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
          `SIMULATION\n\nGenerate a Clear Protection plan for ${instanceId} CH${channel.channel}?\n\nNo hardware command will be executed.\nNo real protection latch will be changed.`,
          { title: 'Generate Clear Plan', kind: 'info', okLabel: 'Generate Plan', cancelLabel: 'Cancel' },
        )
      : await confirm(
          `Clear protection for ${instanceId} CH${channel.channel}?\n\nOVP: ${channel.over_voltage_tripped ? 'TRIPPED' : 'OK'}\nOCP: ${channel.over_current_tripped ? 'TRIPPED' : 'OK'}\n\nThis does not fix the cause of the trip.\nAll power outputs will be turned OFF first.\nThe selected protection latch will be cleared and output will remain OFF.`,
          { title: 'Clear Protection', kind: 'warning', okLabel: 'Clear Protection', cancelLabel: 'Cancel' },
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
          ? { status: current[instanceId]?.status ?? null, error: null, operation: null, clearPlan: result.plan, clearCompleted: false }
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
  }, [executionMode, powersOperationBusy])

  const handleListResources = useCallback(async (toolId: string) => {
    if (toolConfigBusy !== null) {
      return
    }
    setToolConfigBusy(toolId)
    setDiscoveryErrors((current) => ({ ...current, [toolId]: null }))
    setDiscoveredResources((current) => ({ ...current, [toolId]: undefined }))
    try {
      const resources = await invoke<LiveResourceCandidate[]>('list_live_resources', { toolId })
      setDiscoveredResources((current) => ({ ...current, [toolId]: resources }))
    } catch (message) {
      setDiscoveryErrors((current) => ({ ...current, [toolId]: String(message) }))
    } finally {
      setToolConfigBusy(null)
    }
  }, [toolConfigBusy])

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
    setRunMetadata(event.run)
    setStopRequest(current => current && event.completed_step_ids.includes(current.loopId) ? null : current)
  }, [])

  const runLive = useCallback(async () => {
    if (!workflowDraft || !claimRunGate(runInFlightRef)) {
      return
    }
    setLiveConfirmationPending(true)
    let started = false
    let generation: number | null = null
    let onProgress: Channel<DesktopRunEvent> | undefined
    try {
      const statuses = await invoke<ToolStatus[]>('get_tool_status')
      setTools(statuses)
      const [bindings, persistedIdentities] = await Promise.all([
        invoke<Record<string, string>>('get_live_resources'),
        invoke<Record<string, ResourceIdentity>>('get_live_resource_identities'),
      ])
      const referenced = workflowDraft.tool_instances.filter(instance =>
        allWorkflowSteps(workflowDraft.workflow.steps).some(step => step.type === 'tool-action' && step.target === instance.id))
      const confirmedResources: Record<string, string> = {}
      const resources = referenced.map(instance => {
        if (instance.tool !== 'powers' && instance.tool !== 'meters') throw new Error(`Unsupported tool ${instance.tool} for instance ${instance.id}.`)
        const draftResource = resourceDrafts[instance.id]
        const persistedResource = bindings[instance.id]
        if ((draftResource?.trim() || persistedResource?.trim()) && draftResource !== persistedResource) {
          throw new Error(`${instance.id} has unsaved Live Resource changes. Save Resource before running Live.`)
        }
        const resource = bindings[instance.id]
        if (!resource?.trim()) throw new Error(`${instance.id} (${instance.tool}) live resource is not configured.`)
        confirmedResources[instance.id] = resource
        return formatLiveResourceConfirmation(instance, resource, persistedIdentities[instance.id])
      })
      const confirmation = [...resources, 'This workflow will run external tools in Live mode and may change power outputs.']
      for (const instance of referenced) {
        if (instance.tool === 'meters' && instance.setup.measurement === 'current-dc' && instance.setup.current_terminal === 10) {
          confirmation.push(`WARNING: ${instance.id}: Confirm that the measurement leads are physically connected to the instrument's 10 A current terminal.`)
        }
      }
      const approved = await confirm(
        confirmation.join('\n\n'),
        { title: 'Live Execution', kind: 'warning', okLabel: 'Run Live', cancelLabel: 'Cancel' },
      )
      if (!approved) {
        return
      }
      const streamOptions = streamingOptions(
        streamCsv && hasWorkflowOutputs, streamOutputFolder, streamingPage, streamAllPages,
      )
      runIdRef.current = null
      generation = ++runGenerationRef.current
      onProgress = new Channel<DesktopRunEvent>(event => receiveRunProgress(event, generation!))
      progressChannelRef.current = onProgress
      const snapshotPages = outputPages(workflowDraft.workflow.steps)
      setRunWorkflowSnapshot(workflowDraft)
      setLastRunExecutionMode('live')
      setChartPanels([])
      setWorkflowChangedSinceRun(false)
      setSelectedRunPage(snapshotPages[0]?.name ?? 'Results')
      started = true
      setLiveConfirmationPending(false)
      setStopRequest(null)
      setCsvStreamStatus(null)
      setExecutionOffset(0)
      setRunStatus('running')
      setRunMetadata(null)
      setExecutionPage(null)
      setRunError(null)
      const results = await invoke<RunMetadataDto>('run_workflow_live', {
        templateJson: JSON.stringify(workflowDraft),
        onProgress,
        streamCsv: streamOptions,
        confirmedResources,
      })
      if (isCurrentRunGeneration(generation, runGenerationRef.current)) {
        runIdRef.current = results.run_id
        setRunMetadata(results)
      }
    } catch (message) {
      if (generation === null || isCurrentRunGeneration(generation, runGenerationRef.current)) setRunError(String(message))
    } finally {
      if (onProgress) {
        onProgress.onmessage = () => {}
        if (progressChannelRef.current === onProgress) progressChannelRef.current = null
      }
      if (started && isCurrentRunGeneration(generation, runGenerationRef.current)) {
        setStopRequest(null)
        setRunStatus('idle')
      }
      releaseRunGate(runInFlightRef)
      setLiveConfirmationPending(false)
    }
  }, [resourceDrafts, workflowDraft, receiveRunProgress, streamCsv, hasWorkflowOutputs, streamOutputFolder, streamingPage, streamAllPages])

  const runSimulation = useCallback(async () => {
    if (!workflowDraft || !claimRunGate(runInFlightRef)) {
      return
    }

    let started = false
    let generation: number | null = null
    let onProgress: Channel<DesktopRunEvent> | undefined
    try {
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
      setChartPanels([])
      setWorkflowChangedSinceRun(false)
      setSelectedRunPage(snapshotPages[0]?.name ?? 'Results')
      started = true
      setStopRequest(null)
      setCsvStreamStatus(null)
      setExecutionOffset(0)
      setRunStatus('running')
      setRunMetadata(null)
      setExecutionPage(null)
      setRunError(null)
      const results = await invoke<RunMetadataDto>('run_workflow_simulation', {
        templateJson: JSON.stringify(workflowDraft),
        onProgress,
        streamCsv: streamOptions,
      })
      if (isCurrentRunGeneration(generation, runGenerationRef.current)) {
        runIdRef.current = results.run_id
        setRunMetadata(results)
      }
    } catch (message) {
      if (generation === null || isCurrentRunGeneration(generation, runGenerationRef.current)) setRunError(String(message))
    } finally {
      if (onProgress) {
        onProgress.onmessage = () => {}
        if (progressChannelRef.current === onProgress) progressChannelRef.current = null
      }
      if (started && isCurrentRunGeneration(generation, runGenerationRef.current)) {
        setStopRequest(null)
        setRunStatus('idle')
      }
      releaseRunGate(runInFlightRef)
    }
  }, [workflowDraft, receiveRunProgress, streamCsv, hasWorkflowOutputs, streamOutputFolder, streamingPage, streamAllPages])

  const runSelectedMode = useCallback(() => {
    const command = workflowRunCommand(executionMode)
    return command === 'run_workflow_live' ? runLive() : runSimulation()
  }, [executionMode, runLive, runSimulation])

  const workflowBusy =
    choosingStreamOutputFolder || chartSaving || liveConfirmationPending || validationStatus === 'validating' || templateIoStatus !== 'idle' || runStatus === 'running' || powersOperationBusy !== null || exporting

  const handleClearLastRun = useCallback(async () => {
    if (!runWorkflowSnapshot || workflowBusy) return
    const approved = await confirm(
      'Clear the Last Run results?\n\nExecution Results and committed Output rows from the last run will be removed.\n\nThis action cannot be undone.',
      { title: 'Clear Last Run', kind: 'warning', okLabel: 'Clear', cancelLabel: 'Cancel' },
    )
    if (!approved) return

    try {
      const runId = runMetadata?.run_id ?? runIdRef.current
      if (runId !== null) await invoke('clear_last_run', { runId })
      runGenerationRef.current += 1
      runIdRef.current = null
      setRunWorkflowSnapshot(null)
      setChartPanels([])
      setRunMetadata(null)
      setLastRunExecutionMode(null)
      setExecutionPage(null)
      setExecutionOffset(0)
      setRunError(null)
      setStopRequest(null)
      setCsvStreamStatus(null)
      setExportError(null)
      setExportMessage(null)
      setWorkflowChangedSinceRun(false)
    } catch (message) {
      setRunError('Could not clear Last Run: ' + String(message))
    }
  }, [runWorkflowSnapshot, runMetadata, workflowBusy])

  const csvStreamFeedback = csvStreamStatus && (
    <div className="csv-stream-feedback" role="status">
      <strong>Streaming CSV</strong>
      <p>{csvStreamStatus.path}</p>
      {csvStreamStatus.error ? <p className="error">CSV streaming failed: {csvStreamStatus.error}</p>
        : csvStreamStatus.finished && <p className={csvStreamStatus.workflow_succeeded ? 'validation-success' : 'feedback-warning'}>{csvStreamStatus.workflow_succeeded
          ? 'CSV streamed successfully.'
          : csvStreamStatus.rows > 0
            ? 'Workflow failed. Streamed CSV contains committed rows from this partial run.'
            : 'Workflow failed. No rows were streamed.'}</p>}
    </div>
  )

  async function selectOutputFolder() {
    setChoosingStreamOutputFolder(true)
    try {
      const folder = await open({ directory: true, multiple: false, title: 'Select CSV output folder' })
      if (typeof folder === 'string') setStreamOutputFolder(folder)
    } catch (message) {
      setRunError('Could not select CSV output folder: ' + String(message))
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
        ? await open({ directory: true, multiple: false, title: 'Export all Pages as CSV' })
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
      setExportMessage('Pages exported successfully.')
    } catch (message) {
      setExportError(String(message))
    } finally {
      setExporting(false)
    }
  }, [runMetadata, hasRunOutputs, runExportable, hasExportableOutputRows, workflowBusy, exportAllPages, exportFormat, runPage?.name])

  const selectedStep = allWorkflowSteps(workflowDraft?.workflow.steps ?? []).find(
    (step) => step.id === selectedStepId,
  )
  const outputNameError = selectedStep?.type === 'output'
    ? selectedStep.name.trim().length === 0
      ? 'Output name must not be blank.'
      : outputSteps.some((step) => step !== selectedStep && step.name === selectedStep.name)
        ? 'Output name must be unique.'
        : null
    : null
  const { earlierSteps, earlierVariables } = inputScope(workflowDraft?.workflow.steps ?? [], selectedStepId)
  const selectedParent = enclosingLoop(workflowDraft?.workflow.steps ?? [], selectedStepId)
  const selectedEnclosingForVariables = enclosingForVariables(workflowDraft?.workflow.steps ?? [], selectedStepId)
  const addingToLoop = insertionLoop(workflowDraft?.workflow.steps ?? [], selectedStepId)
  const selectedValue = selectedStep?.type === 'output' || selectedStep?.type === 'set-variable'
    ? selectedStep.value : null
  const selectedCompatiblePages = selectedStep?.type === 'output'
    ? compatibleOutputPages(workflowDraft?.workflow.steps ?? [], selectedStep.id) : []
  const selectedToolAction = selectedStep?.type === 'tool-action' ? selectedStep : null
  const selectedAction = selectedToolAction
    ? `${workflowDraft?.tool_instances.find(instance => instance.id === selectedToolAction.target)?.tool}/${selectedToolAction.action}`
    : null
  const selectedPowersAction =
    selectedAction === 'powers/set-output' ||
    selectedAction === 'powers/set-voltage' ||
    selectedAction === 'powers/output-on' ||
    selectedAction === 'powers/output-off'

  return (
    <main className="app">
      <header className="app-header">
        <div className="app-brand">
          <h1>Orchestrator Tool</h1>
          {applicationVersion && (
            <p className="app-version">v{applicationVersion}</p>
          )}
        </div>
        <div className="appearance-control">
          <span>Appearance</span>
          <button className="action-button" type="button"
            aria-label={`Switch theme to ${nextThemeLabel}`} title={`Switch theme to ${nextThemeLabel}`}
            onClick={() => setThemePreference(nextThemePreference)}>
            ◐ {themeLabel(themePreference)}
          </button>
        </div>
      </header>

      <div className="template-toolbar" aria-label="Application actions">
        <button
          className="action-button"
          type="button"
          onClick={() => void createDraft()}
          disabled={workflowBusy}
        >
          New Template
        </button>
        <button
          className="action-button"
          type="button"
          onClick={() => void handleLoadTemplate()}
          disabled={workflowBusy}
        >
          Open Template
        </button>
        <button
          className="action-button"
          type="button"
          onClick={() => void handleSaveTemplate()}
          disabled={!workflowDraft || workflowBusy}
        >
          Save Template
        </button>
        <button className="action-button" type="button" onClick={() => void handleOpenHelp()}>
          Help
        </button>
        <div className="execution-mode-control" aria-label="Desktop Execution Mode">
          <span>Execution Mode</span>
          <div className="execution-mode-options" role="group" aria-label="Execution Mode">
            {(['simulate', 'live'] as const).map(mode => (
              <button
                key={mode}
                className={`execution-mode-button execution-mode-${mode} ${executionMode === mode ? 'execution-mode-selected' : ''}`}
                type="button"
                aria-pressed={executionMode === mode}
                disabled={workflowBusy}
                onClick={() => {
                  setExecutionMode(mode)
                  setPowersStatuses({})
                }}
              >
                {mode === 'simulate' ? 'Simulation' : 'Live'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className={`execution-mode-banner execution-mode-${executionMode}`} role="status">
        {executionModeLabel(executionMode)}
      </p>

      {helpError && <p className="error" role="alert">Failed to open Help: {helpError}</p>}

      {templateIoStatus === 'saving' && <p role="status">Saving…</p>}
      {templateIoStatus === 'loading' && <p role="status">Loading…</p>}

      {templateIoMessage && templateIoStatus === 'idle' && (
        <p className="validation-success" role="status">
          {templateIoMessage}
        </p>
      )}

      {templateIoError && (
        <p className="error" role="alert">
          Template I/O failed: {templateIoError}
        </p>
      )}

      {draftLoading && <p>Creating template draft…</p>}

      {draftCreationError && (
        <p className="error" role="alert">
          Failed to create template draft: {draftCreationError}
        </p>
      )}

      <nav className="tabs" role="tablist" aria-label="Desktop sections">
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
          Tools
        </button>
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
          Setup
        </button>
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
          Workflow
        </button>
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
          Output
        </button>
      </nav>

      {activeTab === 'tools' && (
        <section id="tools-panel" role="tabpanel" aria-labelledby="tools-tab">
          <div className="section-header">
            <h2>External Tools</h2>
            <button
              className="action-button"
              type="button"
              onClick={() => void refresh()}
              disabled={loading || toolConfigBusy !== null}
            >
              Refresh
            </button>
          </div>

          {error && (
            <p className="error" role="alert">
              Failed to load tool status: {error}
            </p>
          )}

          {toolConfigError && (
            <p className="error" role="alert">
              Failed to update tool configuration: {toolConfigError}
            </p>
          )}

          {loading && tools.length === 0 && !error && <p>Loading tool status…</p>}

          {!error && tools.length > 0 && (
            <ul className="tool-list">
              {tools.map((tool) => (
                <li key={tool.tool_id} className="tool-card">
                  <div className="tool-title">
                    <span className="tool-id">{tool.tool_id}</span>
                    <span className={`status status-${tool.executable_status}`}>
                      {EXECUTABLE_LABELS[tool.executable_status] ?? tool.executable_status}
                    </span>
                  </div>
                  <dl className="tool-details">
                    <div className="detail-row">
                      <dt className="detail-label">Executable</dt>
                      <dd className="detail-value">
                        {EXECUTABLE_LABELS[tool.executable_status] ?? tool.executable_status}
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt className="detail-label">Compatibility</dt>
                      <dd className={`detail-value compatibility-${tool.compatibility}`}>
                        {COMPATIBILITY_LABELS[tool.compatibility] ?? tool.compatibility}
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt className="detail-label">Version</dt>
                      <dd className="detail-value">{tool.tool_version ?? '—'}</dd>
                    </div>
                    <div className="detail-row">
                      <dt className="detail-label">Worker Schema</dt>
                      <dd className="detail-value">
                        {formatWorkerSchemas(tool.worker_schema_versions)}
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt className="detail-label">Source</dt>
                      <dd className="detail-value">
                        {tool.source ? (SOURCE_LABELS[tool.source] ?? tool.source) : '—'}
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt className="detail-label">Path</dt>
                      <dd className="detail-value tool-path">{tool.path ?? '—'}</dd>
                    </div>
                    {tool.reason && (
                      <div className="detail-row">
                        <dt className="detail-label">Reason</dt>
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
                      Browse...
                    </button>
                    <button
                      className="action-button"
                      type="button"
                      onClick={() => void handleResetToolExecutable(tool.tool_id)}
                      disabled={toolConfigBusy !== null || workflowBusy || loading || tool.source !== 'configured'}
                    >
                      Clear Path
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

        <section id="setup-panel" role="tabpanel" aria-labelledby="setup-tab" hidden={activeTab !== 'setup'}>
          <div className="section-header">
            <h2>Setup</h2>
          </div>
          {error && <p className="error" role="alert">Failed to load tool configuration: {error}</p>}
          {workflowDraft && (
            <>
              {toolConfigError && <p className="error" role="alert">Failed to update tool configuration: {toolConfigError}</p>}
              <ToolSetupEditor
                value={workflowDraft.tool_instances}
                executionMode={executionMode}
                resourceIdentities={resourceIdentities}
                metersExecutableKey={metersExecutableKey}
                powersExecutableKey={powersExecutableKey}
                steps={allWorkflowSteps(workflowDraft.workflow.steps).filter(step => (step.type !== 'for' && step.type !== 'while'))}
                renderResource={instance => (
                  <>
                    {(instance.tool === 'powers' || instance.tool === 'meters') && (
                      <div className="live-resource">
                        <div className="live-device">
                          <strong>Live Device</strong>
                          {deviceName(resourceIdentities[instance.id]) && <span>{deviceName(resourceIdentities[instance.id])}</span>}
                          {resourceIdentities[instance.id]?.serial?.trim() && <span>S/N: {resourceIdentities[instance.id]?.serial?.trim()}</span>}
                          <code>{resourceDrafts[instance.id] || 'No resource configured'}</code>
                          <span className="tool-setup-hint">Last-known identity; not a connection check.</span>
                        </div>
                        <p className="tool-setup-hint">Stored locally; not included in Template. Save Resource to apply changes.</p>
                        {executionMode === 'simulate' && <p className="tool-setup-hint">Stored for Live mode. Current execution mode is Simulation.</p>}
                        <label className="step-property-field">
                          <span className="step-property-label">Live Resource</span>
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
                        </label>
                        <div className="tool-actions">
                          <button
                            className="action-button"
                            type="button"
                            disabled={toolConfigBusy !== null || workflowBusy || loading}
                            onClick={() => void handleListResources(instance.tool)}
                          >
                            List Resources
                          </button>
                          <button
                            className="action-button"
                            type="button"
                            disabled={toolConfigBusy !== null || workflowBusy || loading}
                            onClick={() => void handleResource(instance.id, false)}
                          >
                            Save Resource
                          </button>
                          <button
                            className="action-button"
                            type="button"
                            disabled={toolConfigBusy !== null || workflowBusy || loading}
                            onClick={() => void handleResource(instance.id, true)}
                          >
                            Clear Resource
                          </button>
                        </div>
                        {discoveryErrors[instance.tool] && (
                          <p className="error" role="alert">
                            {discoveryErrors[instance.tool]}
                          </p>
                        )}
                        {discoveredResources[instance.tool]?.length === 0 && (
                          <p role="status">No live resources found.</p>
                        )}
                        {(discoveredResources[instance.tool]?.length ?? 0) > 0 && (
                          <label className="step-property-field discovered-resources">
                            <span className="step-property-label">Discovered Resources</span>
                            <select
                              value=""
                              disabled={toolConfigBusy !== null || workflowBusy || loading}
                              onChange={(event) => {
                                const resource = event.target.value
                                if (resource) {
                                  const candidate = discoveredResources[instance.tool]?.find(item => item.resource === resource)
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
                              <option value="">Select discovered resource...</option>
                              {discoveredResources[instance.tool]?.map((candidate, index) => (
                                <option key={index} value={candidate.resource}>{formatResourceCandidate(candidate)}</option>
                              ))}
                            </select>
                          </label>
                        )}
                      </div>
                    )}
                    {instance.tool === 'powers' && (() => {
                      const deviceStatus = powersStatuses[instance.id]
                      const savedResource = savedResources[instance.id]
                      const draftResource = resourceDrafts[instance.id]
                      const resourceReady = !manualOperationRequiresSavedResource(executionMode) ||
                        (Boolean(savedResource?.trim()) && draftResource === savedResource)
                      const operationBusy = powersOperationBusy !== null
                      const unresolved = deviceStatus?.status?.channels.some(channel =>
                        (channel.over_voltage_tripped || channel.over_current_tripped))
                      const outputOn = deviceStatus?.status?.channels.some(channel => channel.output_enabled)
                      const statusChannels = executionMode === 'simulate'
                        ? powersSimulationChannels.map(channel =>
                            deviceStatus?.status?.channels.find(status => status.channel === channel) ?? {
                              channel, output_enabled: false, over_voltage_tripped: false, over_current_tripped: false,
                            })
                        : deviceStatus?.status?.channels ?? []
                      return <div className="live-resource">
                        <h4>Device Status <span className={`execution-mode-badge execution-mode-${executionMode}`}>{executionModeLabel(executionMode)}</span></h4>
                        <p className="tool-setup-hint">Not saved in Template. Status is read only when you select Refresh Status; there is no background polling.</p>
                        {executionMode === 'simulate'
                          ? <p className="tool-setup-hint">Uses the simulator model. No saved Live Resource is required and no hardware I/O occurs.</p>
                          : !resourceReady && <p className="tool-setup-hint">Save the Live Resource before using Device Status in Live mode.</p>}
                        <button className="action-button" type="button"
                          disabled={!resourceReady || workflowBusy || operationBusy}
                          onClick={() => void refreshPowersStatus(instance.id)}>
                          {deviceStatus?.operation === 'refresh' ? 'Refreshing...' : 'Refresh Status'}
                        </button>
                        {deviceStatus?.operation === 'clear' && <p role="status">{executionMode === 'simulate' ? 'Generating clear plan...' : 'Clearing protection...'}</p>}
                        {deviceStatus?.error && <p className="error" role="alert">{deviceStatus.error}</p>}
                        {deviceStatus?.clearPlan !== null && <div className="simulation-plan-result" role="status">
                          <strong>PLAN GENERATED · SIMULATION</strong>
                          <p>NO HARDWARE I/O</p>
                          <p>No real protection latch was changed.</p>
                          <details><summary>Show Plan</summary><pre>{JSON.stringify(deviceStatus.clearPlan, null, 2)}</pre></details>
                        </div>}
                        {deviceStatus?.clearCompleted && <p className="validation-success" role="status">Protection clear completed in LIVE mode. Real hardware was addressed and outputs remain OFF.</p>}
                        {deviceStatus?.status && <>
                          <dl className="tool-details">
                            <div className="detail-row"><dt className="detail-label">Protection</dt><dd className="detail-value">{deviceStatus.status.protection_tripped ? 'TRIPPED' : 'CLEAR'}</dd></div>
                            <div className="detail-row"><dt className="detail-label">OVP</dt><dd className="detail-value">{deviceStatus.status.over_voltage_tripped ? 'TRIPPED' : 'OK'}</dd></div>
                            <div className="detail-row"><dt className="detail-label">OCP</dt><dd className="detail-value">{deviceStatus.status.over_current_tripped ? 'TRIPPED' : 'OK'}</dd></div>
                          </dl>
                        </>}
                        {statusChannels.map(channel => <div key={channel.channel} className="meters-setup-fields">
                            <strong>CH{channel.channel}</strong>
                            {deviceStatus?.status && <dl className="tool-details">
                              <div className="detail-row"><dt className="detail-label">Output</dt><dd className="detail-value">{channel.output_enabled ? 'ON' : 'OFF'}</dd></div>
                              <div className="detail-row"><dt className="detail-label">OVP</dt><dd className="detail-value">{channel.over_voltage_tripped ? 'TRIPPED' : 'OK'}</dd></div>
                              <div className="detail-row"><dt className="detail-label">OCP</dt><dd className="detail-value">{channel.over_current_tripped ? 'TRIPPED' : 'OK'}</dd></div>
                            </dl>}
                            {(executionMode === 'simulate' || channel.over_voltage_tripped || channel.over_current_tripped) && <button
                              className={`action-button ${executionMode === 'live' ? 'action-button-danger' : ''}`} type="button"
                              disabled={!resourceReady || workflowBusy || operationBusy}
                              onClick={() => void clearPowersProtection(instance.id, channel)}>
                              {executionMode === 'simulate' ? 'Generate Clear Plan...' : 'Clear Protection...'}
                            </button>}
                          </div>)}
                        {deviceStatus?.status && <>
                          {unresolved && <p className="error" role="alert">Protection remains tripped.</p>}
                          {outputOn && <p className="error" role="alert">Warning: post-operation status reports an output is still ON.</p>}
                        </>}
                        {executionMode === 'live' && <p className="tool-setup-hint">If remote clear is unsupported for this model, clear the protection latch from the instrument front panel, then use Refresh Status.</p>}
                      </div>
                    })()}
                  </>
                )}
                onChange={updateToolInstances}
                disabled={workflowBusy}
              />

            </>
          )}
        </section>

      {activeTab === 'workflow' && (
        <section id="workflow-panel" role="tabpanel" aria-labelledby="workflow-tab">
          <div className="section-header">
            <h2>Workflow</h2>
          </div>

          {workflowDraft && (
            <div className="workflow-summary">
              <dl className="workflow-details">
                <div className="detail-row">
                  <dt className="detail-label">Template</dt>
                  <dd className="detail-value">{workflowDraft.name}</dd>
                </div>
                <div className="detail-row">
                  <dt className="detail-label">Steps</dt>
                  <dd className="detail-value">{allWorkflowSteps(workflowDraft.workflow.steps).length}</dd>
                </div>
              </dl>

              <div className="workflow-builder">
                <aside className="workflow-sidebar">
                  <section className="step-palette" aria-labelledby="step-palette-title">
                    <h3 id="step-palette-title">Steps</h3>
                    <p>Adding to: {addingToLoop ? `${addingToLoop.type === 'for' ? 'For' : 'While'} "${addingToLoop.id}" body` : 'Root workflow'}</p>
                    {addingToLoop && <button className="action-button" type="button" disabled={workflowBusy}
                      onClick={() => setSelectedStepId(null)}>Add to root</button>}
                    <div className="step-palette-items">
                      {[...new Set(STEP_PRESETS.map(preset => preset.category))].map(category => (
                        <section key={category}>
                          <h4>{category}</h4>
                          <div className="step-palette-items">
                            {STEP_PRESETS.filter(preset => preset.category === category).map((preset) => (
                              <button
                                key={preset.value}
                                className="action-button step-palette-button"
                                type="button"
                                onClick={() => addStep(preset)}
                                disabled={workflowBusy || (Boolean(addingToLoop) && loopPath(workflowDraft.workflow.steps, addingToLoop!.id).length >= 4 && (preset.value === 'for' || preset.value === 'while'))}
                              >
                                {preset.label}
                              </button>
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  </section>
                  <section className="streaming-panel" aria-labelledby="streaming-panel-title">
                    <h3 id="streaming-panel-title">Streaming</h3>
                    <label className="streaming-toggle">
                      <input type="checkbox" checked={streamCsv && hasWorkflowOutputs}
                        disabled={workflowBusy || !hasWorkflowOutputs}
                        onChange={event => setStreamCsv(event.target.checked)} />
                      Stream CSV during run
                    </label>
                    {!hasWorkflowOutputs && <p>Streaming CSV requires at least one Output.</p>}
                    {streamCsv && hasWorkflowOutputs && <div className="streaming-fields">
                      <select aria-label="CSV streaming mode" disabled={workflowBusy} value={streamAllPages ? 'all' : 'selected'}
                        onChange={event => setStreamAllPages(event.target.value === 'all')}>
                        <option value="selected">Selected Page</option><option value="all">All Pages</option>
                      </select>
                      {!streamAllPages && <select aria-label="Streaming Page" value={streamingPage} disabled={workflowBusy}
                        onChange={event => setStreamPage(event.target.value)}>{pages.map(page => <option key={page.name}>{page.name}</option>)}</select>}
                      <span className="streaming-destination">{streamOutputFolder ?? 'Default: <application folder>/data'}</span>
                      <button className="action-button" type="button" disabled={workflowBusy} onClick={() => void selectOutputFolder()}>Select Folder</button>
                      {streamOutputFolder !== null && <button className="action-button" type="button" disabled={workflowBusy} onClick={() => setStreamOutputFolder(null)}>Use Default</button>}
                    </div>}
                    {csvStreamFeedback}
                  </section>
                </aside>

                <SequenceEditor
                  steps={workflowDraft.workflow.steps}
                  selectedStepId={selectedStepId}
                  onSelectStep={setSelectedStepId}
                  stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                  instances={workflowDraft.tool_instances}
                  runResults={runWorkflowSnapshot && !workflowChangedSinceRun ? displayedRun?.step_summaries ?? null : null}
                  formatMeasurement={formatMeasurement}
                  workflowBusy={workflowBusy}
                  onMoveStep={moveStep}
                  onDeleteStep={deleteStep}
                  onClearWorkflow={() => void clearWorkflow()}
                />

                <section className="step-properties" aria-labelledby="step-properties-title">
                  <h3 id="step-properties-title">Properties</h3>

                  {!selectedStep && (
                    <p className="step-properties-empty">Select a step to edit its properties.</p>
                  )}

                  {selectedStep && (
                    <div className="step-properties-fields">
                      <div>
                        <h4 className="step-properties-step-title">{stepLabel(selectedStep, workflowDraft.tool_instances)}</h4>
                        {STEP_HELP[selectedAction ?? selectedStep.type] && (
                          <p className="step-context-help">{STEP_HELP[selectedAction ?? selectedStep.type]}</p>
                        )}
                      </div>
                      <div className="step-property-readonly">
                        <span className="step-property-label">Step ID</span>
                        <code className="workflow-step-id">{selectedStep.id}</code>
                      </div>

                      {selectedToolAction && <label className="step-property-field">
                        <span className="step-property-label">Target instance</span>
                        <select disabled={workflowBusy} value={selectedToolAction.target} onChange={event => {
                          const target = event.target.value
                          updateStep(selectedToolAction.id, step => step.type === 'tool-action' ? { ...step, target } : step)
                        }}>
                          {workflowDraft.tool_instances.filter(instance => instance.tool === workflowDraft.tool_instances.find(item => item.id === selectedToolAction.target)?.tool)
                            .map(instance => <option key={instance.id} value={instance.id}>{targetLabel(instance.id, resourceIdentities[instance.id])}</option>)}
                        </select>
                      </label>}
                      {selectedStep.type === 'for' && <>
                        <label className="step-property-field">
                          <span className="step-property-label">Loop variable</span>
                          <input type="text" required pattern="[a-z0-9]+(-[a-z0-9]+)*"
                            title="Use lowercase letters, digits, and single hyphens between segments."
                            value={selectedStep.variable} disabled={workflowBusy} onChange={event => {
                              const variable = event.target.value
                              updateStep(selectedStep.id, step => step.type === 'for' ? { ...step, variable } : step)
                            }} />
                        </label>
                        {(['start', 'stop', 'step'] as const).map(field => <label key={field} className="step-property-field">
                          <span className="step-property-label">{field === 'start' ? 'Start' : field === 'stop' ? 'Stop' : 'Step'}</span>
                          <input type="text" required value={selectedStep.range[field]} disabled={workflowBusy}
                            onChange={event => {
                              const value = event.target.value
                              updateStep(selectedStep.id, step => step.type === 'for'
                                ? { ...step, range: { ...step.range, [field]: value } } : step)
                            }} />
                        </label>)}
                        {(!selectedStep.variable.trim() || Object.values(selectedStep.range).some(value => !value.trim())) &&
                          <p className="error">Loop variable and range fields must not be blank.</p>}
                      </>}
                      {selectedStep.type === 'set-variable' && selectedEnclosingForVariables.includes(selectedStep.variable) &&
                        <p className="error">A body Set Variable cannot write an enclosing For loop variable.</p>}
                      {selectedStep.type === 'set-variable' && (
                        <>
                          <label className="step-property-field">
                            <span className="step-property-label">Variable</span>
                            <input
                              type="text"
                              value={selectedStep.variable}
                              pattern="[a-z0-9]+(-[a-z0-9]+)*"
                              title="Use lowercase letters, digits, and single hyphens between segments."
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
                            <span className="step-property-label">Output name</span>
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
                          <label className="step-property-field">
                            <span className="step-property-label">Existing compatible Page</span>
                            <select value={selectedCompatiblePages.includes(selectedStep.page) ? selectedStep.page : ''}
                              disabled={workflowBusy}
                              onChange={event => {
                                if (event.target.value) updateStep(selectedStep.id, step =>
                                  step.type === 'output' ? { ...step, page: event.target.value } : step)
                              }}>
                              <option value="">Select existing Page...</option>
                              {selectedCompatiblePages.map(page => <option key={page} value={page}>{page}</option>)}
                            </select>
                          </label>
                          <label className="step-property-field">
                            <span className="step-property-label">Page name</span>
                            <input value={selectedStep.page} disabled={workflowBusy} aria-describedby="output-page-help"
                              onChange={event => updateStep(selectedStep.id, step => step.type === 'output' ? { ...step, page: event.target.value } : step)} />
                          </label>
                          <p id="output-page-help" className="value-source-help">
                            A Page is an independent tabular dataset. Only Pages in the same loop scope can be shared.
                            Choose an existing compatible Page, or enter a new name to create another Page in this scope
                            (1-31 filename-safe characters).
                          </p>
                          {pages.some(page => page.name === selectedStep.page && JSON.stringify(page.scope) !== JSON.stringify(loopPath(workflowDraft.workflow.steps, selectedStep.id).map(loop => loop.id))) &&
                            <p className="error">This Page belongs to a different loop path. Choose another Page.</p>}
                          <p id="output-name-help" className="value-source-help">
                            Editable column name used in Output Data, CSV/XLSX export, and Charts.
                          </p>
                          {outputNameError && (
                            <p id="output-name-error" className="step-property-error">{outputNameError}</p>
                          )}
                          <p className="step-context-help">Choose the value this Output publishes.</p>
                        </>
                      )}

                      {selectedValue && (
                        <InputValueEditor
                          key={selectedStep.id}
                          value={selectedValue}
                          earlierSteps={earlierSteps}
                          instances={workflowDraft.tool_instances}
                          stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                          earlierVariables={earlierVariables}
                          disabled={workflowBusy}
                          onChange={(value) => updateStep(selectedStep.id, (step) =>
                            step.type === 'output' || step.type === 'set-variable'
                              ? { ...step, value } : step)}
                        />
                      )}

                      {(selectedStep.type === 'assert' || selectedStep.type === 'while') && (
                        <div key={selectedStep.id} className="step-properties-fields">
                          <ExpressionOperandEditor
                            allowBooleanLiteral
                            side="Left" value={selectedStep.left}
                            earlierSteps={earlierSteps} earlierVariables={earlierVariables}
                            instances={workflowDraft.tool_instances}
                            stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                            disabled={workflowBusy}
                            onChange={left => updateStep(selectedStep.id, step =>
                              (step.type === 'assert' || step.type === 'while') ? { ...step, left } : step)}
                          />
                          <label className="step-property-field">
                            <span className="step-property-label">Operator</span>
                            <select value={selectedStep.operator} disabled={workflowBusy}
                              onChange={event => updateStep(selectedStep.id, step =>
                                (step.type === 'assert' || step.type === 'while') ? { ...step, operator: event.target.value as ComparisonOperator } : step)}>
                              {Object.entries(COMPARISON_OPERATORS).map(([operator, symbol]) => (
                                <option key={operator} value={operator}>{symbol}</option>
                              ))}
                            </select>
                          </label>
                          <ExpressionOperandEditor
                            allowBooleanLiteral
                            side="Right" value={selectedStep.right}
                            earlierSteps={earlierSteps} earlierVariables={earlierVariables}
                            instances={workflowDraft.tool_instances}
                            stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                            disabled={workflowBusy}
                            onChange={right => updateStep(selectedStep.id, step =>
                              (step.type === 'assert' || step.type === 'while') ? { ...step, right } : step)}
                          />
                          {selectedStep.type === 'assert' && <label className="step-property-field">
                            <span className="step-property-label">Failure message</span>
                            <input type="text" value={selectedStep.message} placeholder="Assertion failed."
                              disabled={workflowBusy}
                              onChange={event => updateStep(selectedStep.id, step =>
                                step.type === 'assert' ? { ...step, message: event.target.value } : step)} />
                          </label>}
                          {selectedStep.type === 'while' && <div className="step-property-field">
                            <span className="step-property-label">Iteration limit</span>
                            <select aria-label="Iteration limit" value={selectedStep.max_iterations === null ? 'unlimited' : 'limited'} disabled={workflowBusy}
                              onChange={event => updateStep(selectedStep.id, step =>
                                step.type === 'while' ? { ...step, max_iterations: event.target.value === 'unlimited' ? null : 1000 } : step)}>
                              <option value="limited">Max iterations</option>
                              <option value="unlimited" disabled={Boolean(selectedParent)}>Unlimited</option>
                            </select>
                            {selectedStep.max_iterations === null ? (
                              <span>Runs until the condition becomes false or the loop is stopped.</span>
                            ) : <>
                              <input type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1"
                                aria-label="Max iterations" value={selectedStep.max_iterations} disabled={workflowBusy}
                                onChange={event => {
                                  const limit = event.currentTarget.valueAsNumber
                                  if (!Number.isSafeInteger(limit) || limit <= 0) return
                                  updateStep(selectedStep.id, step =>
                                    step.type === 'while' ? { ...step, max_iterations: limit } : step)
                                }} />
                              {(!Number.isSafeInteger(selectedStep.max_iterations) || selectedStep.max_iterations <= 0) &&
                                <span className="error">Max iterations must be a positive safe integer.</span>}
                            </>}
                          </div>}
                        </div>
                      )}

                      {selectedStep.type === 'wait' && (
                        <label className="step-property-field">
                          <span className="step-property-label">Duration (ms)</span>
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

                      {selectedToolAction && selectedPowersAction && (
                        <label className="step-property-field">
                          <span className="step-property-label">Channel</span>
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={numericArgument(selectedToolAction, 'channel')}
                            disabled={workflowBusy}
                            onChange={(event) => {
                              const channel = event.currentTarget.valueAsNumber
                              if (isPositiveInteger(channel)) {
                                updateToolArgument(selectedToolAction.id, 'channel', channel)
                              }
                            }}
                          />
                        </label>
                      )}

                      {selectedToolAction && selectedAction === 'powers/protection-status' && (
                        <>
                          <label className="step-property-field">
                            <span className="step-property-label">Channel selection</span>
                            <select
                              value={selectedToolAction.arguments.channel === 'all' ? 'all' : 'specific'}
                              disabled={workflowBusy}
                              onChange={(event) => updateToolArgument(selectedToolAction.id, 'channel', event.target.value === 'all' ? 'all' : 1)}
                            >
                              <option value="all">All</option>
                              <option value="specific">Specific channel</option>
                            </select>
                          </label>
                          {selectedToolAction.arguments.channel !== 'all' && (
                            <label className="step-property-field">
                              <span className="step-property-label">Channel</span>
                              <input type="number" min="1" step="1"
                                value={numericArgument(selectedToolAction, 'channel')}
                                disabled={workflowBusy}
                                onChange={(event) => {
                                  const channel = event.currentTarget.valueAsNumber
                                  if (isPositiveInteger(channel)) updateToolArgument(selectedToolAction.id, 'channel', channel)
                                }}
                              />
                            </label>
                          )}
                        </>
                      )}

                      {selectedToolAction &&
                        (selectedAction === 'powers/set-output' || selectedAction === 'powers/set-voltage') &&
                        (selectedAction === 'powers/set-voltage' ? ['voltage'] as const : ['voltage', 'current'] as const)
                          .map((name) => {
                            const active = hasPowerSetpoint(selectedToolAction, name)
                            const label = name === 'voltage' ? 'Voltage' : 'Current Limit'
                            return <div className="step-properties-fields" key={`${selectedStep.id}-${name}`}>
                              {selectedAction === 'powers/set-output' && (
                                <label className="step-property-field">
                                  <span className="step-property-label">Set {label}</span>
                                  <input type="checkbox" checked={active}
                                    disabled={workflowBusy || (active && !hasPowerSetpoint(selectedToolAction, name === 'voltage' ? 'current' : 'voltage'))}
                                    onChange={(event) => updateStep(selectedToolAction.id, step =>
                                      step.type === 'tool-action'
                                        ? togglePowerSetpoint(step, name, event.target.checked)
                                        : step)} />
                                </label>
                              )}
                              {(active || selectedAction === 'powers/set-voltage') && (
                                <InputValueEditor
                                  value={selectedToolAction.bindings?.[name] ?? { source: 'literal', value: numericArgument(selectedToolAction, name) }}
                                  sourceLabel={`${label} Source`}
                                  literalLabel={label}
                                  literalDefault={powerSetpointLiteralDefault(selectedToolAction, name)}
                                  earlierSteps={earlierSteps}
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
                        <p className="step-properties-empty">No editable parameters.</p>
                      )}

                      {selectedToolAction &&
                        !selectedPowersAction &&
                        selectedAction !== 'powers/protection-status' &&
                        selectedAction !== 'meters/measure' && (
                          <p className="step-properties-empty">
                            No editable properties are available for this step.
                          </p>
                        )}
                    </div>
                  )}
                </section>
              </div>

              <div className="workflow-actions">
                <button
                  className="action-button"
                  type="button"
                  onClick={() => void validateDraft()}
                  disabled={workflowBusy}
                >
                  {validationStatus === 'validating' ? 'Validating…' : 'Validate'}
                </button>
                <button
                  className="action-button action-button-primary"
                  type="button"
                  onClick={() => void runSelectedMode()}
                  disabled={workflowBusy || toolConfigBusy !== null || loading}
                >
                  Run {executionMode === 'simulate' ? 'Simulation' : 'Live'}
                </button>
                {stopControls}
              </div>
              {stopFeedback}
              {runStatus === 'running' && <p role="status">{runningText}</p>}

              {validationStatus === 'valid' && (
                <p className="validation-success" role="status">
                  Valid
                </p>
              )}

              {validationError && (
                <p className="error" role="alert">
                  Validation failed: {validationError}
                </p>
              )}

              {runError && (
                <p className="error" role="alert">
                  Run failed: {runError}
                </p>
              )}
              {displayedRun?.status === 'failed' && displayedRun.error && (
                <p className="error" role="alert">
                  Run failed: {displayedRun.error}
                </p>
              )}

              {displayedRun && (
                <section className="run-results" aria-labelledby="run-results-title">
                  <h3 id="run-results-title">Last Run Execution Results {lastRunExecutionMode && <span className={`execution-mode-badge execution-mode-${lastRunExecutionMode}`}>{executionModeLabel(lastRunExecutionMode)}</span>}</h3>
                  <p className="run-result-count">
                    {executions.total.toLocaleString('en-US')} {executions.total === 1 ? 'execution' : 'executions'} · latest first
                  </p>
                  {executions.total > EXECUTION_WINDOW_SIZE && <div className="section-header">
                    <p aria-live="polite">
                      Showing {executions.start.toLocaleString('en-US')}&ndash;{executions.end.toLocaleString('en-US')} of {executions.total.toLocaleString('en-US')}
                    </p>
                    <div className="result-chart-panel-actions">
                      <button className="action-button" type="button" disabled={!executions.hasNewer}
                        onClick={() => setExecutionOffset(Math.max(0, executions.offset - EXECUTION_WINDOW_SIZE))}>Newer</button>
                      <button className="action-button" type="button" disabled={!executions.hasOlder}
                        onClick={() => setExecutionOffset(executions.offset + EXECUTION_WINDOW_SIZE)}>Older</button>
                    </div>
                  </div>}
                  <ol key={executions.offset} className="run-result-list" aria-label="Last Run Execution Results" tabIndex={0}>
                    {executions.items.map((result, executionIndex) => {
                      const isOutput = allWorkflowSteps(runWorkflowSteps).some((step) =>
                        step.id === result.step_id && step.type === 'output',
                      )
                      const formattedMeasurement = formatMeasurement(result.output)
                      const measurement = result.status !== 'succeeded'
                        ? null
                        : isOutput
                          ? result.output_omitted && result.output === null
                            ? 'Preview omitted'
                            : `${JSON.stringify(result.output)}${result.output_omitted ? ' …' : ''}`
                          : formattedMeasurement
                            ? `${formattedMeasurement}${result.output_omitted ? ' …' : ''}`
                            : result.output_omitted
                              ? 'Preview omitted'
                              : null
                      const statusLabel =
                        result.status === 'succeeded'
                          ? 'Success'
                          : result.status === 'failed'
                            ? 'Failed'
                            : 'Cancelled'
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
                              {result.for_iteration && <span>For {result.for_iteration.for_step_id} · Iteration {result.for_iteration.iteration_index + 1}</span>}
                              {result.while_iteration && <span>While {result.while_iteration.while_step_id} · Iteration {result.while_iteration.iteration_index + 1}</span>}
                              <span className={`run-result-status run-result-${result.status}`}>
                                {statusLabel}
                              </span>
                              {measurement && (
                                <span className="run-result-measurement">{measurement}</span>
                              )}
                            </div>
                            {result.status === 'failed' && result.message && (
                              <p className="run-result-message">{result.message}</p>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                </section>
              )}
            </div>
          )}
        </section>
      )}
      {activeTab === 'output' && (
        <section id="output-panel" role="tabpanel" aria-labelledby="output-tab">
          <div className="section-header">
            <h2>Output</h2>
          </div>
          {stopControls}
          {stopFeedback}
          {csvStreamFeedback}
          {!hasWorkflowOutputs && (
            <>
              <p>No workflow outputs defined.</p>
              <p>Add Output steps to the Workflow to publish final result values.</p>
            </>
          )}
          {!displayedRun ? (
            <>
              <p>No run results yet.</p>
              <p>Run the Workflow to view its outputs.</p>
            </>
          ) : (
            <section aria-labelledby="last-run-title">
              <div className="section-header">
                <h3 id="last-run-title">Last Run {lastRunExecutionMode && <span className={`execution-mode-badge execution-mode-${lastRunExecutionMode}`}>{executionModeLabel(lastRunExecutionMode)}</span>}</h3>
                {runWorkflowSnapshot && <button className="action-button action-button-danger" type="button"
                  disabled={workflowBusy} onClick={() => void handleClearLastRun()}>Clear Last Run</button>}
              </div>
              {runStatus === 'running' && <p role="status">{runningText}</p>}
              {runPage && <div className="last-run-page-tabs" role="tablist" aria-label="Last Run Pages">
                {runPages.map((page, index) => <button key={page.name} type="button" role="tab"
                  id={`last-run-page-${index}`} aria-controls="last-run-workspace"
                  aria-selected={page.name === runPage.name} disabled={chartSaving}
                  tabIndex={page.name === runPage.name ? 0 : -1}
                  onClick={() => setSelectedRunPage(page.name)} onKeyDown={event => {
                    const next = event.key === 'ArrowRight' ? (index + 1) % runPages.length
                      : event.key === 'ArrowLeft' ? (index + runPages.length - 1) % runPages.length
                      : event.key === 'Home' ? 0 : event.key === 'End' ? runPages.length - 1 : null
                    if (next === null) return
                    event.preventDefault()
                    setSelectedRunPage(runPages[next].name)
                    document.getElementById(`last-run-page-${next}`)?.focus()
                  }}>{page.name}</button>)}
              </div>}
              <div id="last-run-workspace" role="tabpanel"
                aria-labelledby={runPage ? `last-run-page-${runPages.indexOf(runPage)}` : 'last-run-title'}>
                {!hasRunOutputs && <p>No workflow outputs were defined for this run.</p>}
                {runStatus !== 'running' && !runSucceeded && <p className="error" role="status">Run did not complete successfully. Committed rows are shown for inspection and cannot be exported.</p>}
                {displayedRun.status === 'failed' && displayedRun.error && (
                  <p className="error" role="alert">{displayedRun.error}</p>
                )}
                {(runPageMetadata?.row_count ?? 0) === 0 && <p>No committed output rows.</p>}
                {displayedRun && runPageMetadata && <ResultChart key={runPage?.name} panels={chartPanels} onPanelsChange={setChartPanels}
                  runId={displayedRun.run_id} revision={runPageMetadata.revision} rowCount={runPageMetadata.row_count}
                  numericNames={runPageMetadata.numeric_outputs} page={runPage?.name ?? 'Results'}
                  chartData={chartData} onSavingChange={setChartSaving} running={runStatus === 'running'} />}
                {runPageMetadata && runPageMetadata.row_count > 0 && <PageResultSummary summaries={runPageMetadata.summaries} />}
                {displayedRun && runPage && runPageMetadata && runPageMetadata.row_count > 0 && (
                  <section className="output-data" aria-labelledby="output-data-title">
                    <h3 id="output-data-title">Output Data</h3>
                    <p className="output-row-count">
                      {runPageMetadata.row_count} {runPageMetadata.row_count === 1 ? 'row' : 'rows'} · latest first
                    </p>
                    <VirtualizedOutputTable key={`${displayedRun.run_id}:${runPage.name}`} runId={displayedRun.run_id} page={runPage.name}
                      rowCount={runPageMetadata.row_count} revision={runPageMetadata.revision}
                      outputs={runOutputs} iterationRows={runPageMetadata.iteration_rows} />
                  </section>
                )}
              </div>
            </section>
          )}
          <select aria-label="Export Pages" disabled={workflowBusy} value={exportAllPages ? 'all' : 'current'}
            onChange={event => setExportAllPages(event.target.value === 'all')}>
            <option value="current">Run Page</option><option value="all">All Run Pages</option>
          </select>
          <select aria-label="Export format" disabled={workflowBusy} value={exportFormat}
            onChange={event => setExportFormat(event.target.value as 'csv' | 'xlsx')}>
            <option value="csv">CSV</option><option value="xlsx">XLSX</option>
          </select>
          <button
            className="action-button"
            type="button"
            onClick={() => void handleExport()}
            disabled={!hasRunOutputs || !runExportable || !hasExportableOutputRows || workflowBusy}
          >
            {exporting ? 'Exporting…' : `Export ${exportFormat.toUpperCase()}`}
          </button>
          {exportMessage && (
            <p className="validation-success" role="status">{exportMessage}</p>
          )}
          {exportError && (
            <p className="error" role="alert">Export failed: {exportError}</p>
          )}
        </section>
      )}
    </main>
  )
}

export default App
