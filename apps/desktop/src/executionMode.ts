import { english, type Translate } from './i18n/index.ts'
export type ExecutionMode = 'simulate' | 'live'

export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'simulate'

export function workflowRunCommand(mode: ExecutionMode): 'run_workflow_simulation' | 'run_workflow_live' {
  return mode === 'simulate' ? 'run_workflow_simulation' : 'run_workflow_live'
}

export function executionModeLabel(mode: ExecutionMode, t: Translate = english): string {
  return mode === 'simulate' ? t("executionMode.sIMULATIONNOHARDWAREIO") : t("executionMode.lIVEREALHARDWARE")
}

export function manualOperationRequiresSavedResource(mode: ExecutionMode): boolean {
  return mode === 'live'
}
