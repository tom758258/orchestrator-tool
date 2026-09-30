import type { AxisSettings, ChartPanel, MarkerStyleSettings } from './chartPanels.ts'

type AxisDraft = Omit<AxisSettings, 'min' | 'max' | 'interval'> & {
  min: string
  max: string
  interval: string
}

type MarkerStyleDraft = Omit<MarkerStyleSettings, 'size'> & { size: string }

export type ChartSettingsDraft = {
  title: string
  type: ChartPanel['type']
  scatterXOutput: string | null
  scatter: { display: ChartPanel['scatter']['display']; markerSize: string; lineWidth: string }
  line: ChartPanel['line']
  markerStyles: Record<string, MarkerStyleDraft>
  seriesColors: ChartPanel['seriesColors']
  showLegend: boolean
  legendPosition: ChartPanel['legendPosition']
  imageBackground: ChartPanel['imageBackground']
  showAllRawData: boolean
  zoom: ChartPanel['zoom']
  xAxis: AxisDraft
  yAxis: AxisDraft
  combo: { series: ChartPanel['combo']['series']; rightAxis: AxisDraft }
  histogram: { mode: ChartPanel['histogram']['mode']; value: string;
    showNormalCurve: boolean; mean: string; stdDev: string }
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
    line: { series: { ...(panel.line?.series ?? {}) } },
    markerStyles: Object.fromEntries(Object.entries(panel.markerStyles ?? {}).map(([name, style]) =>
      [name, { ...style, size: String(style.size) }])),
    seriesColors: { ...panel.seriesColors },
    showLegend: panel.showLegend, legendPosition: panel.legendPosition,
    imageBackground: panel.imageBackground,
    showAllRawData: panel.showAllRawData === true,
    zoom: { ...panel.zoom },
    xAxis: axisDraft(panel.xAxis), yAxis: axisDraft(panel.yAxis),
    combo: { series: { ...panel.combo.series }, rightAxis: axisDraft(panel.combo.rightAxis) },
    histogram: { mode: panel.histogram.mode, value: panel.histogram.value?.toString() ?? '',
      showNormalCurve: panel.histogram.showNormalCurve, mean: panel.histogram.mean?.toString() ?? '',
      stdDev: panel.histogram.stdDev?.toString() ?? '' },
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

function normalizedMarkerStyles(draft: ChartSettingsDraft):
  { styles: ChartPanel['markerStyles'] } | { error: string } {
  const active = new Set<string>()
  if (draft.type === 'line') {
    // Marker appearance is editable even for a plain Line, because optional
    // Significant Change Markers reuse the same per-Output style.
    Object.keys(draft.markerStyles).forEach(name => active.add(name))
  }
  if (draft.type === 'combo') {
    Object.entries(draft.combo.series).forEach(([name, settings]) => {
      if (settings.kind === 'line' && settings.markers) active.add(name)
    })
  }
  const styles: ChartPanel['markerStyles'] = {}
  for (const [name, style] of Object.entries(draft.markerStyles)) {
    const text = style.size.trim()
    const value = Number(text)
    const valid = text !== '' && Number.isFinite(value) && value > 0
    if (active.has(name) && !valid) {
      return { error: `${name} marker size must be a finite number greater than zero.` }
    }
    styles[name] = { ...style, size: valid ? value : 4 }
  }
  return { styles }
}

export function validateChartSettingsDraft(draft: ChartSettingsDraft):
  { settings: Pick<ChartPanel, 'title' | 'type' | 'scatterXOutput' | 'scatter' | 'line' | 'markerStyles' | 'seriesColors' | 'showLegend' | 'legendPosition' | 'imageBackground' | 'showAllRawData' | 'zoom' | 'xAxis' | 'yAxis' | 'combo' | 'histogram' | 'boxPlot'>; error?: never } |
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
  const markerStyles = normalizedMarkerStyles(draft)
  if ('error' in markerStyles) return { error: markerStyles.error }
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
  const meanText = draft.histogram.mean.trim()
  const stdDevText = draft.histogram.stdDev.trim()
  const mean = meanText === '' ? null : Number(meanText)
  const stdDev = stdDevText === '' ? null : Number(stdDevText)
  if (draft.type === 'histogram') {
    if (mean !== null && !Number.isFinite(mean)) {
      return { error: 'Normal curve mean must be a finite number.' }
    }
    if (stdDev !== null && (!Number.isFinite(stdDev) || stdDev <= 0)) {
      return { error: 'Normal curve standard deviation must be a finite number greater than zero.' }
    }
  }
  return { settings: { title: draft.title, type: draft.type, scatterXOutput: draft.scatterXOutput,
    scatter: { display: draft.scatter.display, markerSize: markerSize ?? 4, lineWidth: lineWidth ?? 2 },
    line: { series: { ...draft.line.series } },
    markerStyles: markerStyles.styles,
    seriesColors: { ...draft.seriesColors },
    showLegend: draft.showLegend, legendPosition: draft.legendPosition,
    imageBackground: draft.imageBackground, showAllRawData: draft.showAllRawData,
    zoom: { ...draft.zoom }, xAxis, yAxis,
    combo: { series: { ...draft.combo.series }, rightAxis },
    histogram: { mode, value: histogramValue, showNormalCurve: draft.histogram.showNormalCurve,
      mean: mean !== null && Number.isFinite(mean) ? mean : null,
      stdDev: stdDev !== null && Number.isFinite(stdDev) && stdDev > 0 ? stdDev : null }, boxPlot: { ...draft.boxPlot } } }
}
