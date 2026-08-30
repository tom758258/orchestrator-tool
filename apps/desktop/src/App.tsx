import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

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
      setDraftCreationError(null)
    } catch (message) {
      setWorkflowDraft(null)
      setDraftCreationError(String(message))
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
    (index: number) => {
      updateSteps((steps) => steps.filter((_, stepIndex) => stepIndex !== index))
    },
    [updateSteps],
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
      setValidationStatus('valid')
    } catch (message) {
      setValidationStatus('idle')
      setValidationError(String(message))
    }
  }, [workflowDraft])

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
                  disabled={validationStatus === 'validating'}
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
                  disabled={validationStatus === 'validating'}
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
                    <li key={step.id} className="workflow-step-card">
                      <span className="workflow-step-number">{index + 1}.</span>
                      <div className="workflow-step-info">
                        <span className="workflow-step-label">{stepLabel(step)}</span>
                        <code className="workflow-step-id">{step.id}</code>
                      </div>
                      <div className="workflow-step-actions">
                        <button
                          className="action-button"
                          type="button"
                          onClick={() => moveStep(index, -1)}
                          disabled={index === 0 || validationStatus === 'validating'}
                        >
                          Move Up
                        </button>
                        <button
                          className="action-button"
                          type="button"
                          onClick={() => moveStep(index, 1)}
                          disabled={
                            index === workflowDraft.workflow.steps.length - 1 ||
                            validationStatus === 'validating'
                          }
                        >
                          Move Down
                        </button>
                        <button
                          className="action-button"
                          type="button"
                          onClick={() => deleteStep(index)}
                          disabled={validationStatus === 'validating'}
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              <div className="workflow-actions">
                <button
                  className="action-button"
                  type="button"
                  onClick={() => void validateDraft()}
                  disabled={validationStatus === 'validating'}
                >
                  {validationStatus === 'validating' ? 'Validating…' : 'Validate'}
                </button>
              </div>

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
            </div>
          )}
        </section>
      )}
    </main>
  )
}

export default App
