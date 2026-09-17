export type ChartPanel = {
  page: string
  id: number
  outputs: string[]
  xAxisTitle: string
  yAxisTitle: string
}

export function nextChartPanelId(panels: ChartPanel[]): number {
  return Math.max(-1, ...panels.map(panel => panel.id)) + 1
}

export function reconcileChartPanels(
  panels: ChartPanel[],
  pages: { name: string; outputs: { name: string }[] }[],
  currentPage: string,
  numericNames: string[] | null,
): ChartPanel[] {
  return panels.flatMap(panel => {
    const page = pages.find(page => page.name === panel.page)
    if (!page) return []
    const names = panel.page === currentPage && numericNames !== null
      ? numericNames : page.outputs.map(output => output.name)
    return [{ ...panel, outputs: panel.outputs.filter(name => names.includes(name)) }]
  })
}
