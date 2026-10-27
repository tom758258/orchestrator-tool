import type { ToolInstance } from './ToolSetupEditor'
import type { BackgroundConfig, WorkflowStep } from './workflow'
import { chartPanelToSavedChart, type ChartPanel, type SavedOutputViews } from './chartPanels.ts'

export type WorkflowDraft = {
  schema_version: number
  name: string
  tool_instances: ToolInstance[]
  backgrounds?: BackgroundConfig[]
  workflow: {
    steps: WorkflowStep[]
  }
  output_views?: SavedOutputViews
}

export function workflowOnlyDraft(draft: WorkflowDraft): WorkflowDraft {
  const workflowOnly = { ...draft }
  delete workflowOnly.output_views
  return workflowOnly
}

export function templateDraftJson(draft: WorkflowDraft, panels: readonly ChartPanel[], includeCharts: boolean): string {
  return JSON.stringify(includeCharts
    ? { ...draft, output_views: { charts: panels.map(chartPanelToSavedChart) } }
    : { ...workflowOnlyDraft(draft), backgrounds: draft.backgrounds?.map(background => {
        const { chart: _chart, ...setup } = background
        return setup
      }) })
}

