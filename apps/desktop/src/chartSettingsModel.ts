import type { AxisSettings, ChartPanel } from './chartPanels.ts'

type AxisDraft = Omit<AxisSettings, 'min' | 'max' | 'interval'> & {
  min: string
  max: string
  interval: string
}

export type ChartSettingsDraft = {
  title: string
  type: ChartPanel['type']
  scatterXOutput: string | null
  showLegend: boolean
  imageBackground: ChartPanel['imageBackground']
  zoom: ChartPanel['zoom']
  xAxis: AxisDraft
  yAxis: AxisDraft
}

function axisDraft(axis: AxisSettings): AxisDraft {
  return {
    ...axis,
    min: axis.min?.toString() ?? '',
    max: axis.max?.toString() ?? '',
    interval: axis.interval?.toString() ?? '',
  }
}

export function createChartSettingsDraft(panel: ChartPanel): ChartSettingsDraft {
  return { title: panel.title, type: panel.type, scatterXOutput: panel.scatterXOutput,
    showLegend: panel.showLegend, imageBackground: panel.imageBackground,
    zoom: { ...panel.zoom },
    xAxis: axisDraft(panel.xAxis), yAxis: axisDraft(panel.yAxis) }
}

function parseAxis(axis: AxisDraft, label: string): AxisSettings | string {
  const numbers: Pick<AxisSettings, 'min' | 'max' | 'interval'> = {
    min: null, max: null, interval: null,
  }
  for (const field of ['min', 'max', 'interval'] as const) {
    const raw = axis[field].trim()
    const value = raw === '' ? null : Number(raw)
    if (value !== null && !Number.isFinite(value)) return `${label} ${field} must be a finite number.`
    numbers[field] = value
  }
  if (numbers.min !== null && numbers.max !== null && numbers.min >= numbers.max) {
    return `${label} minimum must be less than maximum.`
  }
  if (numbers.interval !== null && numbers.interval <= 0) {
    return `${label} major unit must be greater than zero.`
  }
  return { ...axis, ...numbers }
}

export function validateChartSettingsDraft(draft: ChartSettingsDraft):
  { settings: Pick<ChartPanel, 'title' | 'type' | 'scatterXOutput' | 'showLegend' | 'imageBackground' | 'zoom' | 'xAxis' | 'yAxis'>; error?: never } |
  { settings?: never; error: string } {
  const xAxis = parseAxis(draft.xAxis, draft.type === 'bar' ? 'Y Axis' : 'X Axis')
  if (typeof xAxis === 'string') return { error: xAxis }
  const yAxis = parseAxis(draft.yAxis, draft.type === 'bar' ? 'X Axis' : 'Y Axis')
  if (typeof yAxis === 'string') return { error: yAxis }
  return { settings: { title: draft.title, type: draft.type, scatterXOutput: draft.scatterXOutput,
    showLegend: draft.showLegend,
    imageBackground: draft.imageBackground, zoom: { ...draft.zoom }, xAxis, yAxis } }
}
