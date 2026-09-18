import type { ResultRowDto } from './workflow'
import { numericOutputNames } from './chartData.ts'

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
  return [...panels, { id: nextChartPanelId(panels), page, outputs: [name], xAxisTitle: 'Iteration', yAxisTitle: '' }]
}

export function reconcileRunChartPanels(
  panels: ChartPanel[],
  pages: { name: string; outputs: { name: string }[] }[],
  rows: readonly ResultRowDto[],
): ChartPanel[] {
  let reconciled = reconcileChartPanels(panels, pages, '', null)
  const neededPages = new Set(reconciled.map(panel => panel.page))
  if (pages[0]) neededPages.add(pages[0].name)
  const pageRows = new Map<string, ResultRowDto[]>()
  for (const row of rows) {
    if (!neededPages.has(row.page)) continue
    let local = pageRows.get(row.page)
    if (!local) { local = []; pageRows.set(row.page, local) }
    local.push(row)
  }
  let firstNumeric: string[] = []
  for (const page of pages) {
    if (!neededPages.has(page.name)) continue
    const localRows = pageRows.get(page.name) ?? []
    const numeric = numericOutputNames(localRows, page.outputs.map(output => output.name))
    if (page === pages[0]) firstNumeric = numeric
    reconciled = reconcileChartPanels(reconciled, pages, page.name, localRows.length > 0 ? numeric : null)
  }
  return reconciled.length === 0 && pages[0]
    ? addChartPanel(reconciled, pages[0].name, firstNumeric) : reconciled
}
