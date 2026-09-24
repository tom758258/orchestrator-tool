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
  combo: { series: ChartPanel['combo']['series']; rightAxis: AxisDraft }
  histogram: { mode: ChartPanel['histogram']['mode']; value: string }
  boxPlot: ChartPanel['boxPlot']
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
    xAxis: axisDraft(panel.xAxis), yAxis: axisDraft(panel.yAxis),
    combo: { series: { ...panel.combo.series }, rightAxis: axisDraft(panel.combo.rightAxis) },
    histogram: { mode: panel.histogram.mode, value: panel.histogram.value?.toString() ?? '' },
    boxPlot: { ...panel.boxPlot } }
}

export function chartTypeAxisTitles(draft: ChartSettingsDraft, nextType: ChartPanel['type'],
  histogramOutput: string): { x: string; y: string } {
  const histogramTitle = draft.type === 'histogram' && draft.xAxis.title === histogramOutput
  const x = nextType === 'histogram' &&
    (draft.xAxis.title === '' || draft.xAxis.title === 'Iteration' || histogramTitle)
    ? histogramOutput
    : nextType === 'boxplot' && (draft.xAxis.title === 'Iteration' || histogramTitle)
      ? '' : draft.xAxis.title
  const y = nextType === 'histogram' && draft.yAxis.title === '' ? 'Count'
    : draft.type === 'histogram' && nextType !== 'histogram' && draft.yAxis.title === 'Count'
      ? '' : draft.yAxis.title
  return { x, y }
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
  { settings: Pick<ChartPanel, 'title' | 'type' | 'scatterXOutput' | 'showLegend' | 'imageBackground' | 'zoom' | 'xAxis' | 'yAxis' | 'combo' | 'histogram' | 'boxPlot'>; error?: never } |
  { settings?: never; error: string } {
  const xAxis = parseAxis(draft.xAxis, draft.type === 'bar' ? 'Y Axis' : 'X Axis')
  if (typeof xAxis === 'string') return { error: xAxis }
  const yAxis = parseAxis(draft.yAxis, draft.type === 'bar' ? 'X Axis' : 'Y Axis')
  if (typeof yAxis === 'string') return { error: yAxis }
  const rightAxis = parseAxis(draft.combo.rightAxis, 'Right Y Axis')
  if (typeof rightAxis === 'string') return { error: rightAxis }
  const mode = draft.histogram.mode
  const value = mode === 'auto' ? null : Number(draft.histogram.value.trim())
  if (draft.type === 'histogram' && mode === 'count' &&
    (!Number.isInteger(value) || value! < 1 || value! > 200)) {
    return { error: 'Histogram bin count must be an integer from 1 to 200.' }
  }
  if (draft.type === 'histogram' && mode === 'width' &&
    (draft.histogram.value.trim() === '' || !Number.isFinite(value) || value! <= 0)) {
    return { error: 'Histogram bin width must be a finite number greater than zero.' }
  }
  return { settings: { title: draft.title, type: draft.type, scatterXOutput: draft.scatterXOutput,
    showLegend: draft.showLegend,
    imageBackground: draft.imageBackground, zoom: { ...draft.zoom }, xAxis, yAxis,
    combo: { series: { ...draft.combo.series }, rightAxis },
    histogram: { mode, value }, boxPlot: { ...draft.boxPlot } } }
}
