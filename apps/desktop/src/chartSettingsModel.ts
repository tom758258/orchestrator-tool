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
  scatter: { display: ChartPanel['scatter']['display']; markerSize: string; lineWidth: string }
  showLegend: boolean
  legendPosition: ChartPanel['legendPosition']
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
    scatter: { display: panel.scatter.display, markerSize: String(panel.scatter.markerSize),
      lineWidth: String(panel.scatter.lineWidth) },
    showLegend: panel.showLegend, legendPosition: panel.legendPosition,
    imageBackground: panel.imageBackground,
    zoom: { ...panel.zoom },
    xAxis: axisDraft(panel.xAxis), yAxis: axisDraft(panel.yAxis),
    combo: { series: { ...panel.combo.series }, rightAxis: axisDraft(panel.combo.rightAxis) },
    histogram: { mode: panel.histogram.mode, value: panel.histogram.value?.toString() ?? '' },
    boxPlot: { ...panel.boxPlot } }
}

function automaticXAxisTitle(draft: ChartSettingsDraft, type: ChartPanel['type'],
  histogramOutput: string): string {
  if (type === 'scatter') return draft.scatterXOutput ?? 'Iteration'
  if (type === 'histogram') return histogramOutput
  if (type === 'boxplot') return ''
  return 'Iteration'
}

export function chartTypeAxisTitles(draft: ChartSettingsDraft, nextType: ChartPanel['type'],
  histogramOutput: string): { x: string; y: string } {
  const currentX = automaticXAxisTitle(draft, draft.type, histogramOutput)
  const nextX = automaticXAxisTitle(draft, nextType, histogramOutput)
  const currentY = draft.type === 'histogram' ? 'Count' : ''
  const nextY = nextType === 'histogram' ? 'Count' : ''
  return {
    x: draft.xAxis.title === currentX ? nextX : draft.xAxis.title,
    y: draft.yAxis.title === currentY ? nextY : draft.yAxis.title,
  }
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

function normalizeInactiveAxis(axis: AxisDraft): AxisSettings {
  const numberOrAuto = (raw: string): number | null => {
    const text = raw.trim()
    if (text === '') return null
    const value = Number(text)
    return Number.isFinite(value) ? value : null
  }
  let min = numberOrAuto(axis.min)
  let max = numberOrAuto(axis.max)
  let interval = numberOrAuto(axis.interval)
  if (min !== null && max !== null && min >= max) {
    min = null
    max = null
  }
  if (interval !== null && interval <= 0) interval = null
  return { ...axis, min, max, interval }
}

function inactiveHistogramValue(mode: ChartSettingsDraft['histogram']['mode'], raw: string): number | null {
  if (mode === 'auto') return null
  const value = Number(raw.trim())
  if (mode === 'count') return Number.isInteger(value) && value >= 1 && value <= 200 ? value : 20
  return raw.trim() !== '' && Number.isFinite(value) && value > 0 ? value : 0.5
}

export function validateChartSettingsDraft(draft: ChartSettingsDraft):
  { settings: Pick<ChartPanel, 'title' | 'type' | 'scatterXOutput' | 'scatter' | 'showLegend' | 'legendPosition' | 'imageBackground' | 'zoom' | 'xAxis' | 'yAxis' | 'combo' | 'histogram' | 'boxPlot'>; error?: never } |
  { settings?: never; error: string } {
  const xAxis = draft.type === 'histogram' || draft.type === 'boxplot'
    ? normalizeInactiveAxis(draft.xAxis)
    : parseAxis(draft.xAxis, draft.type === 'bar' ? 'Y Axis' : 'X Axis')
  if (typeof xAxis === 'string') return { error: xAxis }
  const yAxis = parseAxis(draft.yAxis, draft.type === 'bar' ? 'X Axis' : 'Y Axis')
  if (typeof yAxis === 'string') return { error: yAxis }
  const rightAxis = draft.type === 'combo'
    ? parseAxis(draft.combo.rightAxis, 'Right Y Axis')
    : normalizeInactiveAxis(draft.combo.rightAxis)
  if (typeof rightAxis === 'string') return { error: rightAxis }
  const markerText = draft.scatter.markerSize.trim()
  const markerValue = Number(markerText)
  const markerSize = markerText !== '' && Number.isFinite(markerValue) && markerValue > 0 ? markerValue : null
  const lineText = draft.scatter.lineWidth.trim()
  const lineValue = Number(lineText)
  const lineWidth = lineText !== '' && Number.isFinite(lineValue) && lineValue > 0 ? lineValue : null
  const markerRequired = draft.type === 'scatter' && draft.scatter.display !== 'lines'
  const lineRequired = draft.type === 'scatter' && draft.scatter.display !== 'markers'
  if (markerRequired && markerSize === null) {
    return { error: 'Marker size must be a finite number greater than zero.' }
  }
  if (lineRequired && lineWidth === null) {
    return { error: 'Line width must be a finite number greater than zero.' }
  }
  const mode = draft.histogram.mode
  const parsedHistogramValue = mode === 'auto' ? null : Number(draft.histogram.value.trim())
  if (draft.type === 'histogram' && mode === 'count' &&
    (!Number.isInteger(parsedHistogramValue) || parsedHistogramValue! < 1 || parsedHistogramValue! > 200)) {
    return { error: 'Histogram bin count must be an integer from 1 to 200.' }
  }
  if (draft.type === 'histogram' && mode === 'width' &&
    (draft.histogram.value.trim() === '' || !Number.isFinite(parsedHistogramValue) ||
      parsedHistogramValue! <= 0)) {
    return { error: 'Histogram bin width must be a finite number greater than zero.' }
  }
  const histogramValue = draft.type === 'histogram'
    ? parsedHistogramValue : inactiveHistogramValue(mode, draft.histogram.value)
  return { settings: { title: draft.title, type: draft.type, scatterXOutput: draft.scatterXOutput,
    scatter: { display: draft.scatter.display, markerSize: markerSize ?? 4, lineWidth: lineWidth ?? 2 },
    showLegend: draft.showLegend, legendPosition: draft.legendPosition,
    imageBackground: draft.imageBackground, zoom: { ...draft.zoom }, xAxis, yAxis,
    combo: { series: { ...draft.combo.series }, rightAxis },
    histogram: { mode, value: histogramValue }, boxPlot: { ...draft.boxPlot } } }
}
