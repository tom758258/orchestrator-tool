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

export function savedChartCount(panels: readonly ChartPanel[]): number {
  return panels.length
}

export function templateDraftJson(draft: WorkflowDraft, panels: readonly ChartPanel[], includeCharts: boolean): string {
  if (includeCharts) {
    for (const [index, panel] of panels.entries()) {
      if (panel.source && !draft.backgrounds?.some(background => background.id === panel.source!.background_id)) {
        throw new Error(`Chart ${index + 1} references Background ${panel.source.background_id}, which is missing from the current Workflow. Remove the chart, select a valid source, or turn off Save charts with template.`)
      }
    }
  }
  return JSON.stringify(includeCharts
    ? { ...draft, output_views: { charts: panels.map(chartPanelToSavedChart) } }
    : workflowOnlyDraft(draft))
}
