import type { ReactNode } from 'react'
import FailureDetails from './FailureDetails'
import { allWorkflowSteps, type RunMetadataDto } from './workflow'
import type { ExecutionMode } from './executionMode'
import type { WorkflowDraft } from './templateDraft'

type Props = {
  workflowDraft: WorkflowDraft
  workflowBusy: boolean
  toolConfigBusy: string | null
  loading: boolean
  chartThresholdInvalid: boolean
  executionMode: ExecutionMode
  validationStatus: 'idle' | 'validating' | 'valid'
  validationError: string | null
  runStatus: 'idle' | 'running'
  runningText: string
  runError: string | null
  displayedRun: Pick<RunMetadataDto, 'status' | 'error'> | null
  livePreflight: { status: string; blocked: boolean; errors: string[] }
  liveStartError: string | null
  validateDraft: () => void
  runSelectedMode: () => void
  stopControls: ReactNode
  stopFeedback: ReactNode
}

export default function WorkflowRunSummary({
  workflowDraft, workflowBusy, toolConfigBusy, loading, chartThresholdInvalid,
  executionMode, validationStatus, validationError, runStatus, runningText, runError,
  displayedRun, livePreflight, liveStartError, validateDraft, runSelectedMode,
  stopControls, stopFeedback,
}: Props) {
  return (
    <>
      <div className="workflow-summary-header">
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
            disabled={workflowBusy || toolConfigBusy !== null || loading || chartThresholdInvalid || livePreflight.blocked}
          >
            Run {executionMode === 'simulate' ? 'Simulation' : 'Live'}
          </button>
          {stopControls}
        </div>
      </div>
      {stopFeedback}
      {executionMode === 'live' && livePreflight.status === 'checking' && <p role="status">Live Preflight: Checking…</p>}
      {executionMode === 'live' && livePreflight.status === 'passed' && <p className="validation-success" role="status">Live Preflight: Passed</p>}
      {executionMode === 'live' && livePreflight.status === 'failed' && <div className="error" role="alert">
        <p>Live Preflight failed — Live run has not started.</p>
        {livePreflight.errors.map((error, index) => <p key={index}>{error}</p>)}
      </div>}
      {executionMode === 'live' && liveStartError && <div className="error" role="alert">
        <p>Live run did not start</p><FailureDetails message={liveStartError} />
      </div>}
      {runStatus === 'running' && <p role="status">{runningText}</p>}
      {displayedRun?.status === 'stopped' && <p role="status">Run stopped</p>}

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
        <div className="error" role="alert">
          <p className="failure-run-title">Run failed</p>
          <FailureDetails message={runError} />
        </div>
      )}
      {displayedRun?.status === 'failed' && displayedRun.error && displayedRun.error !== runError && (
        <div className="error" role="alert">
          <p className="failure-run-title">Run failed</p>
          <FailureDetails message={displayedRun.error} />
        </div>
      )}
    </>
  )
}
