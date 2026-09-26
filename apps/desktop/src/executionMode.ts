export type ExecutionMode = 'simulate' | 'live'

export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'simulate'

export function workflowRunCommand(mode: ExecutionMode): 'run_workflow_simulation' | 'run_workflow_live' {
  return mode === 'simulate' ? 'run_workflow_simulation' : 'run_workflow_live'
}

export function executionModeLabel(mode: ExecutionMode): string {
  return mode === 'simulate' ? 'SIMULATION · NO HARDWARE I/O' : 'LIVE · REAL HARDWARE'
}

export function manualOperationRequiresSavedResource(mode: ExecutionMode): boolean {
  return mode === 'live'
}
