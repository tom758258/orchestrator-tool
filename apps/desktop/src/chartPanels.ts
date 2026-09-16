export type ChartPanel = { id: number; outputs: string[] }

export function nextChartPanelId(panels: ChartPanel[]): number {
  return Math.max(-1, ...panels.map(panel => panel.id)) + 1
}
