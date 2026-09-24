import type { RunPageMetadata } from './workflow'

export type AxisSettings = {
  title: string
  min: number | null
  max: number | null
  interval: number | null
  showLabels: boolean
  showTicks: boolean
  showMajorGrid: boolean
}

export type ZoomSettings = {
  enabled: boolean
  showSlider: boolean
}

export type ChartPanel = {
  page: string
  id: number
  title: string
  outputs: string[]
  showLegend: boolean
  zoom: ZoomSettings
  xAxis: AxisSettings
  yAxis: AxisSettings
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
  let reconciled: ChartPanel[] | undefined
  panels.forEach((panel, index) => {
    const page = pages.find(page => page.name === panel.page)
    if (!page) {
      reconciled ??= panels.slice(0, index)
      return
    }
    const names = panel.page === currentPage && numericNames !== null
      ? numericNames : page.outputs.map(output => output.name)
    if (panel.outputs.every(name => names.includes(name))) {
      reconciled?.push(panel)
      return
    }
    reconciled ??= panels.slice(0, index)
    reconciled.push({ ...panel, outputs: panel.outputs.filter(name => names.includes(name)) })
  })
  return reconciled ?? panels
}

export const MAX_CHARTS = 8

export function addChartPanel(panels: ChartPanel[], page: string, numericNames: string[]): ChartPanel[] {
  if (panels.length >= MAX_CHARTS || numericNames.length === 0) return panels
  const name = numericNames.find(name => !panels.some(panel => panel.page === page && panel.outputs.includes(name)))
    ?? numericNames[0]
  return [...panels, {
    id: nextChartPanelId(panels), page, title: '', outputs: [name], showLegend: true,
    zoom: { enabled: false, showSlider: true },
    xAxis: { title: 'Iteration', min: null, max: null, interval: null,
      showLabels: true, showTicks: true, showMajorGrid: false },
    yAxis: { title: '', min: null, max: null, interval: null,
      showLabels: true, showTicks: true, showMajorGrid: true },
  }]
}

export function reconcileRunChartPanels(
  panels: ChartPanel[],
  pages: { name: string; outputs: { name: string }[] }[],
  metadata: readonly RunPageMetadata[],
): ChartPanel[] {
  let reconciled = reconcileChartPanels(panels, pages, '', null)
  const firstNumeric: string[] = metadata.find(page => page.name === pages[0]?.name)?.numeric_outputs ?? []
  for (const page of pages) {
    const current = metadata.find(item => item.name === page.name)
    reconciled = reconcileChartPanels(reconciled, pages, page.name, current?.row_count ? current.numeric_outputs : null)
  }
  return reconciled.length === 0 && pages[0]
    ? addChartPanel(reconciled, pages[0].name, firstNumeric) : reconciled
}

export function canRemoveChartPanel(panels: readonly ChartPanel[]): boolean {
  return panels.length > 1
}
