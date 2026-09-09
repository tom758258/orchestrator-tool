import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { confirm, open, save } from '@tauri-apps/plugin-dialog'
import SequenceEditor from './SequenceEditor'
import WorkflowCanvas, {
  createCanvasPositions,
  reconcileCanvasPositions,
  type CanvasPositionChange,
  type CanvasPositionMap,
} from './WorkflowCanvas'

type ToolStatus = {
  tool_id: string
  path: string | null
  source: string | null
  executable_status: string
  compatibility: string
  tool_version: string | null
  worker_schema_versions: number[]
  reason: string | null
  live_resource: string | null
}

type LiveResourceCandidate = {
  resource: string
  manufacturer: string | null
  model: string | null
  serial: string | null
  identity: string | null
}

function formatResourceCandidate(candidate: LiveResourceCandidate): string {
  const manufacturer = candidate.manufacturer?.trim()
  const model = candidate.model?.trim()
  const serial = candidate.serial?.trim()
  if (manufacturer && model) {
    return `${manufacturer} ${model}${serial ? ` [${serial}]` : ''} — ${candidate.resource}`
  }
  return candidate.identity?.trim()
    ? `${candidate.identity} — ${candidate.resource}`
    : candidate.resource
}

type WaitStep = {
  type: 'wait'
  id: string
  duration_ms: number
}

type InputValueWire =
  | { source: 'literal'; value: unknown }
  | { source: 'variable'; variable: string }
  | { source: 'step-output'; step_id: string; pointer: string }

type SetVariableStep = {
  type: 'set-variable'
  id: string
  variable: string
  value: InputValueWire
}

type OutputStep = {
  type: 'output'
  id: string
  value: InputValueWire
}

type ToolActionStep = {
  type: 'tool-action'
  id: string
  tool: string
  action: string
  arguments: Record<string, unknown>
  bindings?: Record<string, InputValueWire>
}

export type WorkflowStep = WaitStep | ToolActionStep | SetVariableStep | OutputStep

type WorkflowDraft = {
  schema_version: number
  name: string
  workflow: {
    steps: WorkflowStep[]
  }
}

type ActiveTab = 'tools' | 'workflow'
type ValidationStatus = 'idle' | 'validating' | 'valid'
type TemplateIoStatus = 'idle' | 'loading' | 'saving'
type RunStatus = 'idle' | 'running'
type StepResultStatus = 'succeeded' | 'failed' | 'cancelled'
type StepResultDto = {
  step_id: string
  status: StepResultStatus
  output: unknown | null
  message: string | null
}
type StepPreset =
  | 'set-variable'
  | 'output'
  | 'power-set-voltage'
  | 'power-output-on'
  | 'wait'
  | 'meter-measure'
  | 'power-output-off'

type StepPresetOption = {
  value: StepPreset
  label: string
  prefix: string
}

const STEP_PRESETS: StepPresetOption[] = [
  { value: 'set-variable', label: 'Set Variable', prefix: 'set-variable' },
  { value: 'output', label: 'Output', prefix: 'output' },
  { value: 'power-set-voltage', label: 'Power Set Voltage', prefix: 'power-set' },
  { value: 'power-output-on', label: 'Power Output ON', prefix: 'power-on' },
  { value: 'wait', label: 'Wait', prefix: 'wait' },
  { value: 'meter-measure', label: 'Meter Measure', prefix: 'meter-read' },
  { value: 'power-output-off', label: 'Power Output OFF', prefix: 'power-off' },
]

const TOOL_ACTION_LABELS: Record<string, string> = {
  'powers/set-voltage': 'Power Set Voltage',
  'powers/output-on': 'Power Output ON',
  'meters/measure': 'Meter Measure',
  'powers/output-off': 'Power Output OFF',
}

const EXECUTABLE_LABELS: Record<string, string> = {
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
  portable: 'Portable',
}

function formatWorkerSchemas(versions: number[]): string {
  if (versions.length === 0) {
    return '—'
  }
  return versions.join(', ')
}

function nextStepId(prefix: string, steps: WorkflowStep[]): string {
  const existingIds = new Set(steps.map((step) => step.id))
  let sequence = 1

  while (existingIds.has(`${prefix}-${sequence}`)) {
    sequence += 1
  }

  return `${prefix}-${sequence}`
}

function createPresetStep(preset: StepPreset, id: string): WorkflowStep {
  switch (preset) {
    case 'set-variable':
      return { type: 'set-variable', id, variable: 'x', value: { source: 'literal', value: 5.0 } }
    case 'output':
      return { type: 'output', id, value: { source: 'literal', value: null } }
    case 'power-set-voltage':
      return {
        type: 'tool-action',
        id,
        tool: 'powers',
        action: 'set-voltage',
        arguments: { channel: 1, voltage: 5.0 },
      }
    case 'power-output-on':
      return {
        type: 'tool-action',
        id,
        tool: 'powers',
        action: 'output-on',
        arguments: { channel: 1 },
      }
    case 'wait':
      return { type: 'wait', id, duration_ms: 500 }
    case 'meter-measure':
      return {
        type: 'tool-action',
        id,
        tool: 'meters',
        action: 'measure',
        arguments: {},
      }
    case 'power-output-off':
      return {
        type: 'tool-action',
        id,
        tool: 'powers',
        action: 'output-off',
        arguments: { channel: 1 },
      }
  }
}

function stepLabel(step: WorkflowStep): string {
  if (step.type === 'set-variable') {
    return 'Set Variable'
  }
  if (step.type === 'output') {
    return 'Output'
  }
  if (step.type === 'wait') {
    return 'Wait'
  }

  return TOOL_ACTION_LABELS[`${step.tool}/${step.action}`] ?? `${step.tool} / ${step.action}`
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

function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('tools')
  const [tools, setTools] = useState<ToolStatus[]>([])
  const [resourceDrafts, setResourceDrafts] = useState<Record<string, string>>({})
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
  const [runStatus, setRunStatus] = useState<RunStatus>('idle')
  const [runResults, setRunResults] = useState<StepResultDto[] | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [canvasPositions, setCanvasPositions] = useState<CanvasPositionMap>({})
  const [canvasLayoutRevision, setCanvasLayoutRevision] = useState(0)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const statuses = await invoke<ToolStatus[]>('get_tool_status')
      setTools(statuses)
      setResourceDrafts(Object.fromEntries(statuses.map((tool) => [tool.tool_id, tool.live_resource ?? ''])))
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
      const canonicalJson = await invoke<string>('create_workflow_draft')
      const draft = JSON.parse(canonicalJson) as WorkflowDraft
      setWorkflowDraft(draft)
      setCanvasPositions(createCanvasPositions(draft.workflow.steps))
      setCanvasLayoutRevision((current) => current + 1)
      setSelectedStepId(null)
      setDraftCreationError(null)
      setRunResults(null)
      setRunError(null)
    } catch (message) {
      setWorkflowDraft(null)
      setCanvasPositions({})
      setSelectedStepId(null)
      setDraftCreationError(String(message))
      setRunResults(null)
      setRunError(null)
    } finally {
      setDraftLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void createDraft()
  }, [createDraft, refresh])

  useEffect(() => {
    setCanvasPositions((current) =>
      reconcileCanvasPositions(workflowDraft?.workflow.steps ?? [], current),
    )
  }, [workflowDraft?.workflow.steps])

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
      setValidationStatus('idle')
      setValidationError(null)
      setRunResults(null)
      setRunError(null)
    },
    [],
  )

  const addStep = useCallback((preset: StepPresetOption) => {
    if (!workflowDraft) {
      return
    }
    const id = nextStepId(preset.prefix, workflowDraft.workflow.steps)
    const newStep = createPresetStep(preset.value, id)
    updateSteps((steps) => {
      const selectedIndex = steps.findIndex((step) => step.id === selectedStepId)
      const insertIndex = selectedIndex < 0 ? steps.length : selectedIndex + 1
      return [...steps.slice(0, insertIndex), newStep, ...steps.slice(insertIndex)]
    })
    setSelectedStepId(id)
  }, [workflowDraft, selectedStepId, updateSteps])

  const deleteStep = useCallback(
    (stepId: string) => {
      updateSteps((steps) => steps.filter((step) => step.id !== stepId))
      setSelectedStepId((current) => (current === stepId ? null : current))
    },
    [updateSteps],
  )

  const updateStep = useCallback(
    (stepId: string, update: (step: WorkflowStep) => WorkflowStep) => {
      updateSteps((steps) =>
        steps.map((step) => (step.id === stepId ? update(step) : step)),
      )
    },
    [updateSteps],
  )

  const updateToolArgument = useCallback(
    (stepId: string, name: string, value: number) => {
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

  const updateVoltageBinding = useCallback(
    (stepId: string, binding?: InputValueWire) => {
      updateStep(stepId, (step) => {
        if (step.type !== 'tool-action') {
          return step
        }
        const bindings = { ...step.bindings }
        if (binding) {
          bindings.voltage = binding
        } else {
          delete bindings.voltage
        }
        const updated: ToolActionStep = { ...step, bindings }
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
        const index = steps.findIndex((step) => step.id === stepId)
        if (index < 0) {
          return steps
        }

        const targetIndex = index + offset
        if (targetIndex < 0 || targetIndex >= steps.length) {
          return steps
        }

        const reordered = [...steps]
        const currentStep = reordered[index]
        reordered[index] = reordered[targetIndex]
        reordered[targetIndex] = currentStep
        return reordered
      })
    },
    [updateSteps],
  )

  const updateCanvasPositions = useCallback((changes: CanvasPositionChange[]) => {
    setCanvasPositions((current) => {
      let next = current

      changes.forEach((change) => {
        const previous = next[change.id]
        if (previous?.x === change.position.x && previous.y === change.position.y) {
          return
        }

        if (next === current) {
          next = { ...current }
        }
        next[change.id] = change.position
      })

      return next
    })
  }, [])

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
        current && canonicalDraft.workflow.steps.some((step) => step.id === current)
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
      const canonicalJson = await invoke<string>('load_workflow_template', {
        path,
      })
      const loadedDraft = JSON.parse(canonicalJson) as WorkflowDraft
      setWorkflowDraft(loadedDraft)
      setCanvasPositions(createCanvasPositions(loadedDraft.workflow.steps))
      setCanvasLayoutRevision((current) => current + 1)
      setSelectedStepId(null)
      setValidationStatus('valid')
      setValidationError(null)
      setRunResults(null)
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
        current && canonicalDraft.workflow.steps.some((step) => step.id === current)
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
    try {
      await invoke(clear ? 'remove_live_resource' : 'set_live_resource', {
        toolId, ...(clear ? {} : { resource: resourceDrafts[toolId] ?? '' }),
      })
      await refresh()
    } catch (message) {
      setToolConfigError(String(message))
    } finally {
      setToolConfigBusy(null)
    }
  }, [refresh, resourceDrafts, toolConfigBusy])

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

  const runLive = useCallback(async () => {
    if (!workflowDraft) {
      return
    }
    setRunStatus('running')
    setRunError(null)
    try {
      const statuses = await invoke<ToolStatus[]>('get_tool_status')
      setTools(statuses)
      const referenced = ['powers', 'meters'].filter((toolId) =>
        workflowDraft.workflow.steps.some((step) => step.type === 'tool-action' && step.tool === toolId),
      )
      const confirmedResources: Record<string, string> = {}
      const resources = referenced.map((toolId) => {
        const resource = statuses.find((tool) => tool.tool_id === toolId)?.live_resource
        const label = toolId === 'powers' ? 'Powers' : 'Meters'
        if (!resource || !resource.trim()) {
          throw new Error(label + ' live resource is not configured.')
        }
        confirmedResources[toolId] = resource
        return label + ':\n' + resource
      })
      const approved = await confirm(
        [...resources, 'This workflow will control real instruments and may change power outputs.'].join('\n\n'),
        { title: 'Live Execution', kind: 'warning', okLabel: 'Run Live', cancelLabel: 'Cancel' },
      )
      if (!approved) {
        return
      }
      setRunResults(null)
      const results = await invoke<StepResultDto[]>('run_workflow_live', {
        templateJson: JSON.stringify(workflowDraft),
        confirmedPowersResource: confirmedResources.powers ?? null,
        confirmedMetersResource: confirmedResources.meters ?? null,
      })
      setRunResults(results)
    } catch (message) {
      setRunError(String(message))
    } finally {
      setRunStatus('idle')
    }
  }, [workflowDraft])

  const runSimulation = useCallback(async () => {
    if (!workflowDraft) {
      return
    }

    setRunStatus('running')
    setRunResults(null)
    setRunError(null)
    try {
      const results = await invoke<StepResultDto[]>('run_workflow_simulation', {
        templateJson: JSON.stringify(workflowDraft),
      })
      setRunResults(results)
    } catch (message) {
      setRunError(String(message))
    } finally {
      setRunStatus('idle')
    }
  }, [workflowDraft])

  const workflowBusy =
    validationStatus === 'validating' || templateIoStatus !== 'idle' || runStatus === 'running'

  const selectedStep = workflowDraft?.workflow.steps.find(
    (step) => step.id === selectedStepId,
  )
  const earlierSteps = selectedStep && workflowDraft
    ? workflowDraft.workflow.steps.slice(0, workflowDraft.workflow.steps.indexOf(selectedStep))
    : []
  const earlierVariables = [...new Set(earlierSteps.flatMap((step) =>
    step.type === 'set-variable' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(step.variable)
      ? [step.variable] : [],
  ))]
  const selectedOutput = selectedStep?.type === 'output' ? selectedStep.value : null
  const selectedToolAction = selectedStep?.type === 'tool-action' ? selectedStep : null
  const voltageBinding = selectedToolAction?.bindings?.voltage
  const selectedAction = selectedToolAction
    ? `${selectedToolAction.tool}/${selectedToolAction.action}`
    : null
  const selectedPowersAction =
    selectedAction === 'powers/set-voltage' ||
    selectedAction === 'powers/output-on' ||
    selectedAction === 'powers/output-off'
  const canvasResultsByStepId = new Map(
    (runResults ?? []).map((result) => [
      result.step_id,
      {
        status: result.status,
        measurement: formatMeasurement(result.output),
      },
    ]),
  )

  return (
    <main className="app">
      <header className="app-header">
        <h1>orchestrator-tool</h1>
      </header>

      <nav className="tabs" role="tablist" aria-label="Desktop sections">
        <button
          id="tools-tab"
          className={`tab ${activeTab === 'tools' ? 'tab-active' : ''}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'tools'}
          aria-controls="tools-panel"
          onClick={() => setActiveTab('tools')}
        >
          Tools
        </button>
        <button
          id="workflow-tab"
          className={`tab ${activeTab === 'workflow' ? 'tab-active' : ''}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'workflow'}
          aria-controls="workflow-panel"
          onClick={() => setActiveTab('workflow')}
        >
          Workflow
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
              disabled={loading}
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
                      disabled={toolConfigBusy !== null || workflowBusy}
                    >
                      Browse...
                    </button>
                    <button
                      className="action-button"
                      type="button"
                      onClick={() => void handleResetToolExecutable(tool.tool_id)}
                      disabled={toolConfigBusy !== null || workflowBusy || tool.source !== 'configured'}
                    >
                      Use Portable Default
                    </button>
                  </div>
                  {(tool.tool_id === 'powers' || tool.tool_id === 'meters') && (
                    <div className="live-resource">
                      <label className="step-property-field">
                        <span className="step-property-label">Live Resource</span>
                        <input
                          type="text"
                          value={resourceDrafts[tool.tool_id] ?? ''}
                          disabled={toolConfigBusy !== null || workflowBusy}
                          onChange={(event) => setResourceDrafts((current) => ({
                            ...current, [tool.tool_id]: event.target.value,
                          }))}
                        />
                      </label>
                      <div className="tool-actions">
                        <button
                          className="action-button"
                          type="button"
                          disabled={toolConfigBusy !== null || workflowBusy}
                          onClick={() => void handleListResources(tool.tool_id)}
                        >
                          List Resources
                        </button>
                        <button
                          className="action-button"
                          type="button"
                          disabled={toolConfigBusy !== null || workflowBusy}
                          onClick={() => void handleResource(tool.tool_id, false)}
                        >
                          Save Resource
                        </button>
                        <button
                          className="action-button"
                          type="button"
                          disabled={toolConfigBusy !== null || workflowBusy || tool.live_resource === null}
                          onClick={() => void handleResource(tool.tool_id, true)}
                        >
                          Clear Resource
                        </button>
                      </div>
                      {discoveryErrors[tool.tool_id] && (
                        <p className="error" role="alert">
                          {discoveryErrors[tool.tool_id]}
                        </p>
                      )}
                      {discoveredResources[tool.tool_id]?.length === 0 && (
                        <p role="status">No live resources found.</p>
                      )}
                      {(discoveredResources[tool.tool_id]?.length ?? 0) > 0 && (
                        <label className="step-property-field discovered-resources">
                          <span className="step-property-label">Discovered Resources</span>
                          <select
                            value=""
                            disabled={toolConfigBusy !== null || workflowBusy}
                            onChange={(event) => {
                              const resource = event.target.value
                              if (resource) {
                                setResourceDrafts((current) => ({ ...current, [tool.tool_id]: resource }))
                              }
                            }}
                          >
                            <option value="">Select discovered resource...</option>
                            {discoveredResources[tool.tool_id]?.map((candidate, index) => (
                              <option key={index} value={candidate.resource}>{formatResourceCandidate(candidate)}</option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {activeTab === 'workflow' && (
        <section id="workflow-panel" role="tabpanel" aria-labelledby="workflow-tab">
          <div className="section-header">
            <h2>Workflow</h2>
          </div>

          {draftLoading && <p>Creating workflow draft…</p>}

          {draftCreationError && (
            <p className="error" role="alert">
              Failed to create workflow draft: {draftCreationError}
            </p>
          )}

          {workflowDraft && (
            <div className="workflow-summary">
              <dl className="workflow-details">
                <div className="detail-row">
                  <dt className="detail-label">Template</dt>
                  <dd className="detail-value">{workflowDraft.name}</dd>
                </div>
                <div className="detail-row">
                  <dt className="detail-label">Steps</dt>
                  <dd className="detail-value">{workflowDraft.workflow.steps.length}</dd>
                </div>
              </dl>

              <div className="workflow-builder">
                <aside className="step-palette" aria-labelledby="step-palette-title">
                  <h3 id="step-palette-title">Steps</h3>
                  <div className="step-palette-items">
                    {STEP_PRESETS.map((preset) => (
                      <button
                        key={preset.value}
                        className="action-button step-palette-button"
                        type="button"
                        onClick={() => addStep(preset)}
                        disabled={workflowBusy}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </aside>

                <WorkflowCanvas
                  steps={workflowDraft.workflow.steps.map((step) => ({
                    id: step.id,
                    label: stepLabel(step),
                    result: canvasResultsByStepId.get(step.id) ?? null,
                  }))}
                  positions={canvasPositions}
                  selectedStepId={selectedStepId}
                  layoutRevision={canvasLayoutRevision}
                  workflowBusy={workflowBusy}
                  onPositionChanges={updateCanvasPositions}
                  onSelectStep={setSelectedStepId}
                  onMoveStep={moveStep}
                  onDeleteStep={deleteStep}
                />
              </div>

              <SequenceEditor
                steps={workflowDraft.workflow.steps}
                selectedStepId={selectedStepId}
                onSelectStep={setSelectedStepId}
                stepLabel={stepLabel}
                workflowBusy={workflowBusy}
                onMoveStep={moveStep}
                onDeleteStep={deleteStep}
              />

              <section className="step-properties" aria-labelledby="step-properties-title">
                <h3 id="step-properties-title">Properties</h3>

                {!selectedStep && (
                  <p className="step-properties-empty">Select a step to edit its properties.</p>
                )}

                {selectedStep && (
                  <div className="step-properties-fields">
                    <div className="step-property-readonly">
                      <span className="step-property-label">Step ID</span>
                      <code className="workflow-step-id">{selectedStep.id}</code>
                    </div>

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
                        {selectedStep.value.source === 'literal' && typeof selectedStep.value.value === 'number' ? (
                          <label className="step-property-field">
                            <span className="step-property-label">Value</span>
                            <input
                              type="number"
                              step="any"
                              value={selectedStep.value.value}
                              disabled={workflowBusy}
                              onChange={(event) => {
                                const value = event.currentTarget.valueAsNumber
                                if (Number.isFinite(value)) {
                                  updateStep(selectedStep.id, (step) => step.type === 'set-variable'
                                    ? { ...step, value: { source: 'literal', value } } : step)
                                }
                              }}
                            />
                          </label>
                        ) : (
                          <p className="step-properties-empty">
                            Value preserved (only numeric literals are editable): {JSON.stringify(selectedStep.value)}
                          </p>
                        )}
                      </>
                    )}

                    {selectedOutput && (
                      <>
                        <label className="step-property-field">
                          <span className="step-property-label">Source</span>
                          <select
                            value={selectedOutput.source === 'step-output' ? 'step-output' : 'preserved'}
                            disabled={workflowBusy}
                            onChange={() => {
                              const firstStep = earlierSteps[0]
                              if (firstStep) {
                                updateStep(selectedStep.id, (step) => step.type === 'output'
                                  ? { ...step, value: { source: 'step-output', step_id: firstStep.id, pointer: '/value' } }
                                  : step)
                              }
                            }}
                          >
                            {selectedOutput.source !== 'step-output' && (
                              <option value="preserved" disabled>Current {selectedOutput.source} (preserved)</option>
                            )}
                            <option value="step-output" disabled={earlierSteps.length === 0}>Step Output</option>
                          </select>
                        </label>
                        {selectedOutput.source !== 'step-output' && (
                          <p className="step-properties-empty">Current value: {JSON.stringify(selectedOutput)}</p>
                        )}
                        {earlierSteps.length === 0 && (
                          <p className="step-properties-empty">Add or move a source step before this Output to reference it.</p>
                        )}
                        {selectedOutput.source === 'step-output' && (
                          <>
                            <label className="step-property-field">
                              <span className="step-property-label">Step</span>
                              <select
                                value={earlierSteps.some((step) => step.id === selectedOutput.step_id) ? selectedOutput.step_id : ''}
                                disabled={workflowBusy || earlierSteps.length === 0}
                                onChange={(event) => {
                                  const stepId = event.target.value
                                  updateStep(selectedStep.id, (step) => step.type === 'output'
                                    ? { ...step, value: { ...selectedOutput, step_id: stepId } } : step)
                                }}
                              >
                                <option value="" disabled>Select an earlier step...</option>
                                {earlierSteps.map((step) => <option key={step.id} value={step.id}>{step.id}</option>)}
                              </select>
                            </label>
                            {!earlierSteps.some((step) => step.id === selectedOutput.step_id) && (
                              <p className="step-properties-empty">Reference preserved: {selectedOutput.step_id} is not an earlier step. Validate to check it.</p>
                            )}
                            <label className="step-property-field">
                              <span className="step-property-label">Pointer</span>
                              <input
                                type="text"
                                value={selectedOutput.pointer}
                                disabled={workflowBusy}
                                onChange={(event) => {
                                  const pointer = event.target.value
                                  updateStep(selectedStep.id, (step) => step.type === 'output'
                                    ? { ...step, value: { ...selectedOutput, pointer } } : step)
                                }}
                              />
                            </label>
                          </>
                        )}
                      </>
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

                    {selectedToolAction && selectedAction === 'powers/set-voltage' && (
                      <>
                        <label className="step-property-field">
                          <span className="step-property-label">Voltage Source</span>
                          <select
                            value={!voltageBinding ? 'literal' : voltageBinding.source === 'variable' ? 'variable' : 'preserved'}
                            disabled={workflowBusy}
                            onChange={(event) => {
                              if (event.target.value === 'literal') {
                                updateVoltageBinding(selectedToolAction.id)
                              } else if (earlierVariables.length > 0) {
                                updateVoltageBinding(selectedToolAction.id, { source: 'variable', variable: earlierVariables[0] })
                              }
                            }}
                          >
                            <option value="literal">Literal</option>
                            <option value="variable" disabled={earlierVariables.length === 0}>Variable</option>
                            {voltageBinding && voltageBinding.source !== 'variable' && (
                              <option value="preserved" disabled>Current binding (preserved)</option>
                            )}
                          </select>
                        </label>
                        {earlierVariables.length === 0 && (
                          <p className="step-properties-empty">Define a valid variable in an earlier Set Variable step to select it.</p>
                        )}
                        {voltageBinding?.source === 'variable' && (
                          <>
                            <label className="step-property-field">
                              <span className="step-property-label">Variable</span>
                              <select
                                value={earlierVariables.includes(voltageBinding.variable) ? voltageBinding.variable : ''}
                                disabled={workflowBusy || earlierVariables.length === 0}
                                onChange={(event) => updateVoltageBinding(selectedToolAction.id, {
                                  source: 'variable', variable: event.target.value,
                                })}
                              >
                                <option value="" disabled>Select an earlier variable...</option>
                                {earlierVariables.map((variable) => <option key={variable} value={variable}>{variable}</option>)}
                              </select>
                            </label>
                            {!earlierVariables.includes(voltageBinding.variable) && (
                              <p className="step-properties-empty">Reference preserved: {voltageBinding.variable} is not defined by an earlier Set Variable step.</p>
                            )}
                          </>
                        )}
                        {voltageBinding && voltageBinding.source !== 'variable' && (
                          <p className="step-properties-empty">Binding preserved: {JSON.stringify(voltageBinding)}</p>
                        )}
                        {!voltageBinding && (
                          <label className="step-property-field">
                            <span className="step-property-label">Voltage</span>
                            <input
                              type="number"
                              step="any"
                              value={numericArgument(selectedToolAction, 'voltage')}
                              disabled={workflowBusy}
                              onChange={(event) => {
                                const voltage = event.currentTarget.valueAsNumber
                                if (Number.isFinite(voltage)) {
                                  updateToolArgument(selectedToolAction.id, 'voltage', voltage)
                                }
                              }}
                            />
                          </label>
                        )}
                      </>
                    )}

                    {selectedAction === 'meters/measure' && (
                      <p className="step-properties-empty">No editable parameters.</p>
                    )}

                    {selectedToolAction &&
                      !selectedPowersAction &&
                      selectedAction !== 'meters/measure' && (
                        <p className="step-properties-empty">
                          No editable properties are available for this step.
                        </p>
                      )}
                  </div>
                )}
              </section>

              <div className="workflow-actions">
                <button
                  className="action-button"
                  type="button"
                  onClick={() => void handleLoadTemplate()}
                  disabled={workflowBusy}
                >
                  Load Template
                </button>
                <button
                  className="action-button"
                  type="button"
                  onClick={() => void handleSaveTemplate()}
                  disabled={!workflowDraft || workflowBusy}
                >
                  Save Template
                </button>
                <button
                  className="action-button"
                  type="button"
                  onClick={() => void validateDraft()}
                  disabled={workflowBusy}
                >
                  {validationStatus === 'validating' ? 'Validating…' : 'Validate'}
                </button>
                <button
                  className="action-button"
                  type="button"
                  onClick={() => void runSimulation()}
                  disabled={workflowBusy}
                >
                  Run Simulation
                </button>
                <button
                  className="action-button"
                  type="button"
                  onClick={() => void runLive()}
                  disabled={workflowBusy || toolConfigBusy !== null || loading}
                >
                  Run Live
                </button>
              </div>

              {runStatus === 'running' && <p role="status">Running…</p>}

              {templateIoStatus === 'saving' && (
                <p role="status">Saving…</p>
              )}
              {templateIoStatus === 'loading' && (
                <p role="status">Loading…</p>
              )}

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

              {runResults && (
                <section className="run-results" aria-labelledby="run-results-title">
                  <h3 id="run-results-title">Run Results</h3>
                  <ol className="run-result-list">
                    {runResults.map((result) => {
                      const isOutput = workflowDraft.workflow.steps.some((step) =>
                        step.id === result.step_id && step.type === 'output',
                      )
                      const measurement = isOutput && result.status === 'succeeded'
                        ? JSON.stringify(result.output)
                        : formatMeasurement(result.output)
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
                        <li key={result.step_id} className="run-result-card">
                          <span
                            className={`run-result-mark run-result-${result.status}`}
                            aria-hidden="true"
                          >
                            {statusMark}
                          </span>
                          <div className="run-result-content">
                            <div className="run-result-summary">
                              <code className="workflow-step-id">{result.step_id}</code>
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
    </main>
  )
}

export default App
