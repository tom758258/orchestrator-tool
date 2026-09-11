import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { confirm, open, save } from '@tauri-apps/plugin-dialog'
import SequenceEditor from './SequenceEditor'
import ToolSetupEditor from './ToolSetupEditor'
import type { ToolInstance } from './ToolSetupEditor'
import InputValueEditor from './InputValueEditor'
import type { InputValueWire } from './inputValue'

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
  serial: string | null
  identity: string | null
}

type LiveResourceCandidate = ResourceIdentity & { resource: string }

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

type ToolActionStep = {
  type: 'tool-action'
  id: string
  target: string
  action: string
  arguments: Record<string, unknown>
  bindings?: Record<string, InputValueWire>
}

export type WorkflowStep = WaitStep | ToolActionStep | SetVariableStep | OutputStep

type WorkflowDraft = {
  schema_version: number
  name: string
  tool_instances: ToolInstance[]
  workflow: {
    steps: WorkflowStep[]
  }
}

type ActiveTab = 'tools' | 'setup' | 'workflow'
type ValidationStatus = 'idle' | 'validating' | 'valid'
type TemplateIoStatus = 'idle' | 'loading' | 'saving'
type RunStatus = 'idle' | 'running'
type StepResultStatus = 'succeeded' | 'failed' | 'cancelled'
export type StepResultDto = {
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
  category: string
  tool?: ToolInstance['tool']
}

const STEP_PRESETS: StepPresetOption[] = [
  { value: 'set-variable', label: 'Set Variable', prefix: 'set-variable', category: 'Workflow' },
  { value: 'output', label: 'Output', prefix: 'output', category: 'Workflow' },
  { value: 'power-set-voltage', label: 'Power Set Voltage', prefix: 'power-set', category: 'Powers', tool: 'powers' },
  { value: 'power-output-on', label: 'Power Output ON', prefix: 'power-on', category: 'Powers', tool: 'powers' },
  { value: 'wait', label: 'Wait', prefix: 'wait', category: 'Workflow' },
  { value: 'meter-measure', label: 'Meter Measure', prefix: 'meter-read', category: 'Meters', tool: 'meters' },
  { value: 'power-output-off', label: 'Power Output OFF', prefix: 'power-off', category: 'Powers', tool: 'powers' },
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

function createPresetStep(preset: StepPreset, id: string, target: string): WorkflowStep {
  switch (preset) {
    case 'set-variable':
      return { type: 'set-variable', id, variable: 'x', value: { source: 'literal', value: 5.0 } }
    case 'output':
      return { type: 'output', id, name: id, value: { source: 'literal', value: null } }
    case 'power-set-voltage':
      return {
        type: 'tool-action',
        id,
        target,
        action: 'set-voltage',
        arguments: { channel: 1, voltage: 5.0 },
      }
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
  if (step.type === 'set-variable') {
    return 'Set Variable'
  }
  if (step.type === 'output') {
    return 'Output'
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

function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('tools')
  const [tools, setTools] = useState<ToolStatus[]>([])
  const [resourceIdentities, setResourceIdentities] = useState<Record<string, ResourceIdentity | null>>({})
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
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const hasWorkflowOutputs = workflowDraft?.workflow.steps.some((step) => step.type === 'output') ?? false

  useEffect(() => {
    setExportError(null)
    setExportMessage(null)
  }, [workflowDraft, runResults, runStatus])

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
      setResourceIdentities(identities)
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
      setSelectedStepId(null)
      setDraftCreationError(null)
      setRunResults(null)
      setRunError(null)
    } catch (message) {
      setWorkflowDraft(null)
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
      setTemplateIoMessage(null)
    },
    [],
  )

  const updateToolInstances = useCallback((tool_instances: ToolInstance[]) => {
    setWorkflowDraft((current) => current ? { ...current, tool_instances } : current)
    setValidationStatus('idle')
    setValidationError(null)
    setRunResults(null)
    setRunError(null)
    setTemplateIoMessage(null)
  }, [])

  const addStep = useCallback((preset: StepPresetOption) => {
    if (!workflowDraft) {
      return
    }
    const target = workflowDraft.tool_instances.find(instance => instance.tool === preset.tool)?.id
    if (preset.tool && !target) {
      setValidationError(`Create a ${preset.tool} Tool Instance on the Setup tab before adding this action.`)
      return
    }
    const id = nextStepId(preset.prefix, workflowDraft.workflow.steps)
    const newStep = createPresetStep(preset.value, id, target ?? '')
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
        instanceId: toolId, ...(clear ? {} : { resource: resourceDrafts[toolId] ?? '', identity: resourceIdentities[toolId] ?? null }),
      })
      await refresh()
    } catch (message) {
      setToolConfigError(String(message))
    } finally {
      setToolConfigBusy(null)
    }
  }, [refresh, resourceDrafts, resourceIdentities, toolConfigBusy])

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
      const [bindings, persistedIdentities] = await Promise.all([
        invoke<Record<string, string>>('get_live_resources'),
        invoke<Record<string, ResourceIdentity>>('get_live_resource_identities'),
      ])
      const referenced = workflowDraft.tool_instances.filter(instance =>
        workflowDraft.workflow.steps.some(step => step.type === 'tool-action' && step.target === instance.id))
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
      setRunResults(null)
      const results = await invoke<StepResultDto[]>('run_workflow_live', {
        templateJson: JSON.stringify(workflowDraft),
        confirmedResources,
      })
      setRunResults(results)
    } catch (message) {
      setRunError(String(message))
    } finally {
      setRunStatus('idle')
    }
  }, [resourceDrafts, workflowDraft])

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
    validationStatus === 'validating' || templateIoStatus !== 'idle' || runStatus === 'running' || exporting

  const handleExportCsv = useCallback(async () => {
    if (!workflowDraft || !runResults || !hasWorkflowOutputs || workflowBusy) {
      return
    }

    setExporting(true)
    setExportError(null)
    setExportMessage(null)
    try {
      const selectedPath = await save({
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      })
      if (!selectedPath) {
        return
      }
      await invoke('export_workflow_csv', {
        templateJson: JSON.stringify(workflowDraft),
        stepResults: runResults,
        destinationPath: selectedPath,
      })
      setExportMessage('CSV exported successfully.')
    } catch (message) {
      setExportError(String(message))
    } finally {
      setExporting(false)
    }
  }, [workflowDraft, runResults, hasWorkflowOutputs, workflowBusy])

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
  const selectedValue = selectedStep?.type === 'output' || selectedStep?.type === 'set-variable'
    ? selectedStep.value : null
  const selectedToolAction = selectedStep?.type === 'tool-action' ? selectedStep : null
  const voltageBinding = selectedToolAction?.bindings?.voltage
  const selectedAction = selectedToolAction
    ? `${workflowDraft?.tool_instances.find(instance => instance.id === selectedToolAction.target)?.tool}/${selectedToolAction.action}`
    : null
  const selectedPowersAction =
    selectedAction === 'powers/set-voltage' ||
    selectedAction === 'powers/output-on' ||
    selectedAction === 'powers/output-off'

  return (
    <main className="app">
      <header className="app-header">
        <h1>orchestrator-tool</h1>
      </header>

      <div className="template-toolbar" aria-label="Template actions">
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
      </div>

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
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {activeTab === 'setup' && (
        <section id="setup-panel" role="tabpanel" aria-labelledby="setup-tab">
          <div className="section-header">
            <h2>Setup</h2>
          </div>
          {error && <p className="error" role="alert">Failed to load tool configuration: {error}</p>}
          {workflowDraft && (
            <>
              {toolConfigError && <p className="error" role="alert">Failed to update tool configuration: {toolConfigError}</p>}
              <ToolSetupEditor
                value={workflowDraft.tool_instances}
                steps={workflowDraft.workflow.steps}
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
                        <label className="step-property-field">
                          <span className="step-property-label">Live Resource</span>
                          <input
                            type="text"
                            value={resourceDrafts[instance.id] ?? ''}
                            disabled={toolConfigBusy !== null || workflowBusy}
                            onChange={(event) => {
                              setResourceDrafts((current) => ({ ...current, [instance.id]: event.target.value }))
                              setResourceIdentities((current) => ({ ...current, [instance.id]: null }))
                            }}
                          />
                        </label>
                        <div className="tool-actions">
                          <button
                            className="action-button"
                            type="button"
                            disabled={toolConfigBusy !== null || workflowBusy}
                            onClick={() => void handleListResources(instance.tool)}
                          >
                            List Resources
                          </button>
                          <button
                            className="action-button"
                            type="button"
                            disabled={toolConfigBusy !== null || workflowBusy}
                            onClick={() => void handleResource(instance.id, false)}
                          >
                            Save Resource
                          </button>
                          <button
                            className="action-button"
                            type="button"
                            disabled={toolConfigBusy !== null || workflowBusy}
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
                              disabled={toolConfigBusy !== null || workflowBusy}
                              onChange={(event) => {
                                const resource = event.target.value
                                if (resource) {
                                  const candidate = discoveredResources[instance.tool]?.find(item => item.resource === resource)
                                  setResourceDrafts((current) => ({ ...current, [instance.id]: resource }))
                                  setResourceIdentities((current) => ({ ...current, [instance.id]: candidate ? {
                                    manufacturer: candidate.manufacturer, model: candidate.model,
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
                  </>
                )}
                onChange={updateToolInstances}
                disabled={workflowBusy}
              />

            </>
          )}
        </section>
      )}

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
                  <dd className="detail-value">{workflowDraft.workflow.steps.length}</dd>
                </div>
              </dl>

              <div className="workflow-builder">
                <aside className="step-palette" aria-labelledby="step-palette-title">
                  <h3 id="step-palette-title">Steps</h3>
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
                              disabled={workflowBusy}
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                </aside>

                <SequenceEditor
                  steps={workflowDraft.workflow.steps}
                  selectedStepId={selectedStepId}
                  onSelectStep={setSelectedStepId}
                  stepLabel={step => stepLabel(step, workflowDraft.tool_instances)}
                  instances={workflowDraft.tool_instances}
                  runResults={runResults}
                  formatMeasurement={formatMeasurement}
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
                        <label className="step-property-field">
                          <span className="step-property-label">Output name</span>
                          <input
                            type="text"
                            value={selectedStep.name}
                            disabled={workflowBusy}
                            onChange={(event) => updateStep(selectedStep.id, (step) =>
                              step.type === 'output' ? { ...step, name: event.target.value } : step,
                            )}
                          />
                        </label>
                      )}

                      {selectedValue && (
                        <InputValueEditor
                          value={selectedValue}
                          earlierSteps={earlierSteps}
                          earlierVariables={earlierVariables}
                          disabled={workflowBusy}
                          onChange={(value) => updateStep(selectedStep.id, (step) =>
                            step.type === 'output' || step.type === 'set-variable'
                              ? { ...step, value } : step)}
                        />
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
                        <InputValueEditor
                          value={voltageBinding ?? { source: 'literal', value: numericArgument(selectedToolAction, 'voltage') }}
                          sourceLabel="Voltage Source"
                          literalLabel="Voltage"
                          literalDefault={numericArgument(selectedToolAction, 'voltage') || 0}
                          earlierSteps={earlierSteps}
                          earlierVariables={earlierVariables}
                          disabled={workflowBusy}
                          onChange={(value) => {
                            if (value.source === 'literal' && voltageBinding?.source !== 'literal') {
                              updateVoltageBinding(selectedToolAction.id)
                              if (typeof value.value === 'number') {
                                updateToolArgument(selectedToolAction.id, 'voltage', value.value)
                              }
                            } else {
                              updateVoltageBinding(selectedToolAction.id, value)
                            }
                          }}
                        />
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
                  <button
                    className="action-button"
                    type="button"
                    onClick={() => void handleExportCsv()}
                    disabled={!hasWorkflowOutputs || workflowBusy}
                  >
                    {exporting ? 'Exporting…' : 'Export CSV'}
                  </button>
                  {!hasWorkflowOutputs && (
                    <p>No workflow outputs available for export.</p>
                  )}
                  {exportMessage && (
                    <p className="validation-success" role="status">{exportMessage}</p>
                  )}
                  {exportError && (
                    <p className="error" role="alert">CSV export failed: {exportError}</p>
                  )}
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
