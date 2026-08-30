import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

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

type WaitStep = {
  type: 'wait'
  id: string
  duration_ms: number
}

type ToolActionStep = {
  type: 'tool-action'
  id: string
  tool: string
  action: string
  arguments: Record<string, unknown>
}

type WorkflowStep = WaitStep | ToolActionStep

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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [workflowDraft, setWorkflowDraft] = useState<WorkflowDraft | null>(null)
  const [draftLoading, setDraftLoading] = useState(true)
  const [draftCreationError, setDraftCreationError] = useState<string | null>(null)
  const [validationStatus, setValidationStatus] = useState<ValidationStatus>('idle')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [selectedPreset, setSelectedPreset] = useState<StepPreset>('power-set-voltage')
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [templateIoStatus, setTemplateIoStatus] = useState<TemplateIoStatus>('idle')
  const [templateIoError, setTemplateIoError] = useState<string | null>(null)
  const [templateIoMessage, setTemplateIoMessage] = useState<string | null>(null)
  const [runStatus, setRunStatus] = useState<RunStatus>('idle')
  const [runResults, setRunResults] = useState<StepResultDto[] | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const statuses = await invoke<ToolStatus[]>('get_tool_status')
      setTools(statuses)
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
    },
    [],
  )

  const addStep = useCallback(() => {
    updateSteps((steps) => {
      const preset = STEP_PRESETS.find((option) => option.value === selectedPreset)
      if (!preset) {
        return steps
      }

      const id = nextStepId(preset.prefix, steps)
      return [...steps, createPresetStep(selectedPreset, id)]
    })
  }, [selectedPreset, updateSteps])

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

  const moveStep = useCallback(
    (index: number, offset: -1 | 1) => {
      updateSteps((steps) => {
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
  const selectedToolAction = selectedStep?.type === 'tool-action' ? selectedStep : null
  const selectedAction = selectedToolAction
    ? `${selectedToolAction.tool}/${selectedToolAction.action}`
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

              <div className="add-step-controls">
                <select
                  className="step-preset-select"
                  aria-label="Step type"
                  value={selectedPreset}
                  onChange={(event) => setSelectedPreset(event.target.value as StepPreset)}
                  disabled={workflowBusy}
                >
                  {STEP_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
                <button
                  className="action-button"
                  type="button"
                  onClick={addStep}
                  disabled={workflowBusy}
                >
                  Add Step
                </button>
              </div>

              {workflowDraft.workflow.steps.length === 0 && (
                <p className="empty-workflow">Empty workflow</p>
              )}

              {workflowDraft.workflow.steps.length > 0 && (
                <ol className="workflow-step-list">
                  {workflowDraft.workflow.steps.map((step, index) => (
                    <li
                      key={step.id}
                      className={`workflow-step-card ${
                        selectedStepId === step.id ? 'workflow-step-card-selected' : ''
                      }`}
                    >
                      <span className="workflow-step-number">{index + 1}.</span>
                      <div className="workflow-step-info">
                        <span className="workflow-step-label">{stepLabel(step)}</span>
                        <code className="workflow-step-id">{step.id}</code>
                      </div>
                      <div className="workflow-step-actions">
                        <button
                          className="action-button"
                          type="button"
                          aria-pressed={selectedStepId === step.id}
                          onClick={() => setSelectedStepId(step.id)}
                        >
                          Edit
                        </button>
                        <button
                          className="action-button"
                          type="button"
                          onClick={() => moveStep(index, -1)}
                          disabled={index === 0 || workflowBusy}
                        >
                          Move Up
                        </button>
                        <button
                          className="action-button"
                          type="button"
                          onClick={() => moveStep(index, 1)}
                          disabled={
                            index === workflowDraft.workflow.steps.length - 1 || workflowBusy
                          }
                        >
                          Move Down
                        </button>
                        <button
                          className="action-button"
                          type="button"
                          onClick={() => deleteStep(step.id)}
                          disabled={workflowBusy}
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}

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
                  {runStatus === 'running' ? 'Running…' : 'Run Simulation'}
                </button>
              </div>

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
                  Simulation failed: {runError}
                </p>
              )}

              {runResults && (
                <section className="simulation-results" aria-labelledby="simulation-results-title">
                  <h3 id="simulation-results-title">Simulation Results</h3>
                  <ol className="simulation-result-list">
                    {runResults.map((result) => {
                      const measurement = formatMeasurement(result.output)
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
                        <li key={result.step_id} className="simulation-result-card">
                          <span
                            className={`simulation-result-mark simulation-result-${result.status}`}
                            aria-hidden="true"
                          >
                            {statusMark}
                          </span>
                          <div className="simulation-result-content">
                            <div className="simulation-result-summary">
                              <code className="workflow-step-id">{result.step_id}</code>
                              <span className={`simulation-result-status simulation-result-${result.status}`}>
                                {statusLabel}
                              </span>
                              {measurement && (
                                <span className="simulation-result-measurement">{measurement}</span>
                              )}
                            </div>
                            {result.status === 'failed' && result.message && (
                              <p className="simulation-result-message">{result.message}</p>
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
