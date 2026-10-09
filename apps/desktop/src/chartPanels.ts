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

export type ChartImageBackground = 'light' | 'dark'
export type LegendPosition = 'top' | 'bottom' | 'left' | 'right'
export type ScatterSettings = { display: 'markers' | 'lines' | 'lines-markers'; markerSize: number; lineWidth: number }
export type ChartType = 'line' | 'scatter' | 'column' | 'area' | 'bar' | 'combo' | 'histogram' | 'boxplot'
export type MarkerShape = 'circle' | 'square' | 'diamond' | 'triangle'
export type MarkerStyleSettings = {
  shape: MarkerShape
  size: number
  fillColor: string | null
  borderColor: string | null
}
export type LineSeriesSettings = { markers: boolean }
export type ComboSeriesSettings = { kind: 'line' | 'column'; axis: 'left' | 'right'; markers: boolean }
export type HistogramSettings = { mode: 'auto' | 'count' | 'width'; value: number | null;
  showNormalCurve: boolean; mean: number | null; stdDev: number | null }

export type ChartPanel = {
  page: string
  id: number
  title: string
  outputs: string[]
  type: ChartType
  scatterXOutput: string | null
  scatter: ScatterSettings
  line: { series: Record<string, LineSeriesSettings> }
  markerStyles: Record<string, MarkerStyleSettings>
  seriesColors: Record<string, string>
  showLegend: boolean
  legendPosition: LegendPosition
  imageBackground: ChartImageBackground
  showAllRawData: boolean
  zoom: ZoomSettings
  xAxis: AxisSettings
  yAxis: AxisSettings
  combo: { series: Record<string, ComboSeriesSettings>; rightAxis: AxisSettings }
  histogram: HistogramSettings
  boxPlot: { showOutliers: boolean }
}

export type SavedAxisSettings = {
  title: string
  min: number | null
  max: number | null
  interval: number | null
  show_labels: boolean
  show_ticks: boolean
  show_major_grid: boolean
}

export type SavedChart = {
  page: string
  title: string
  outputs: string[]
  type: ChartType
  scatter_x_output: string | null
  scatter: { display: ScatterSettings['display']; marker_size: number; line_width: number }
  line: { series: Record<string, LineSeriesSettings> }
  marker_styles: Record<string, {
    shape: MarkerShape
    size: number
    fill_color: string | null
    border_color: string | null
  }>
  series_colors: Record<string, string>
  show_legend: boolean
  legend_position: LegendPosition
  image_background: ChartImageBackground
  show_all_raw_data: boolean
  zoom: { enabled: boolean; show_slider: boolean }
  x_axis: SavedAxisSettings
  y_axis: SavedAxisSettings
  combo: { series: Record<string, ComboSeriesSettings>; right_axis: SavedAxisSettings }
  histogram: {
    mode: HistogramSettings['mode']
    value: number | null
    show_normal_curve: boolean
    mean: number | null
    std_dev: number | null
  }
  box_plot: { show_outliers: boolean }
}

export type SavedOutputViews = { charts: SavedChart[] }

function axisToSaved(axis: AxisSettings): SavedAxisSettings {
  return {
    title: axis.title, min: axis.min, max: axis.max, interval: axis.interval,
    show_labels: axis.showLabels, show_ticks: axis.showTicks, show_major_grid: axis.showMajorGrid,
  }
}

function savedToAxis(axis: SavedAxisSettings): AxisSettings {
  return {
    title: axis.title, min: axis.min, max: axis.max, interval: axis.interval,
    showLabels: axis.show_labels, showTicks: axis.show_ticks, showMajorGrid: axis.show_major_grid,
  }
}

export function chartPanelToSavedChart(panel: ChartPanel): SavedChart {
  return {
    page: panel.page,
    title: panel.title,
    outputs: [...panel.outputs],
    type: panel.type,
    scatter_x_output: panel.scatterXOutput,
    scatter: {
      display: panel.scatter.display,
      marker_size: panel.scatter.markerSize,
      line_width: panel.scatter.lineWidth,
    },
    line: { series: { ...panel.line.series } },
    marker_styles: Object.fromEntries(Object.entries(panel.markerStyles).map(([name, style]) =>
      [name, {
        shape: style.shape,
        size: style.size,
        fill_color: style.fillColor,
        border_color: style.borderColor,
      }])),
    series_colors: { ...panel.seriesColors },
    show_legend: panel.showLegend,
    legend_position: panel.legendPosition,
    image_background: panel.imageBackground,
    show_all_raw_data: panel.showAllRawData,
    zoom: { enabled: panel.zoom.enabled, show_slider: panel.zoom.showSlider },
    x_axis: axisToSaved(panel.xAxis),
    y_axis: axisToSaved(panel.yAxis),
    combo: {
      series: Object.fromEntries(Object.entries(panel.combo.series).map(([name, settings]) =>
        [name, { ...settings }])),
      right_axis: axisToSaved(panel.combo.rightAxis),
    },
    histogram: {
      mode: panel.histogram.mode,
      value: panel.histogram.value,
      show_normal_curve: panel.histogram.showNormalCurve,
      mean: panel.histogram.mean,
      std_dev: panel.histogram.stdDev,
    },
    box_plot: { show_outliers: panel.boxPlot.showOutliers },
  }
}

export function savedChartsToPanels(charts: readonly SavedChart[]): ChartPanel[] {
  return charts.map((chart, id) => ({
    page: chart.page,
    id,
    title: chart.title,
    outputs: [...chart.outputs],
    type: chart.type,
    scatterXOutput: chart.scatter_x_output,
    scatter: {
      display: chart.scatter.display,
      markerSize: chart.scatter.marker_size,
      lineWidth: chart.scatter.line_width,
    },
    line: { series: { ...chart.line.series } },
    markerStyles: Object.fromEntries(Object.entries(chart.marker_styles).map(([name, style]) =>
      [name, {
        shape: style.shape,
        size: style.size,
        fillColor: style.fill_color,
        borderColor: style.border_color,
      }])),
    seriesColors: { ...chart.series_colors },
    showLegend: chart.show_legend,
    legendPosition: chart.legend_position,
    imageBackground: chart.image_background,
    showAllRawData: chart.show_all_raw_data,
    zoom: { enabled: chart.zoom.enabled, showSlider: chart.zoom.show_slider },
    xAxis: savedToAxis(chart.x_axis),
    yAxis: savedToAxis(chart.y_axis),
    combo: {
      series: Object.fromEntries(Object.entries(chart.combo.series).map(([name, settings]) =>
        [name, { ...settings }])),
      rightAxis: savedToAxis(chart.combo.right_axis),
    },
    histogram: {
      mode: chart.histogram.mode,
      value: chart.histogram.value,
      showNormalCurve: chart.histogram.show_normal_curve,
      mean: chart.histogram.mean,
      stdDev: chart.histogram.std_dev,
    },
    boxPlot: { showOutliers: chart.box_plot.show_outliers },
  }))
}

export function seriesColor(panel: ChartPanel, output: string, autoColor: string): string {
  return Object.prototype.hasOwnProperty.call(panel.seriesColors, output)
    ? panel.seriesColors[output]
    : autoColor
}

export function lineSeriesSettings(panel: ChartPanel, name: string): LineSeriesSettings {
  const series = panel.line?.series
  return series && Object.prototype.hasOwnProperty.call(series, name) ? series[name] : { markers: false }
}

export function markerStyleSettings(panel: ChartPanel, name: string): MarkerStyleSettings {
  if (panel.markerStyles && Object.prototype.hasOwnProperty.call(panel.markerStyles, name)) {
    return panel.markerStyles[name]
  }
  return {
    shape: 'circle',
    size: 4,
    fillColor: null,
    borderColor: null,
  }
}

export function comboSeriesSettings(panel: ChartPanel, name: string, index: number): ComboSeriesSettings {
  const stored = Object.prototype.hasOwnProperty.call(panel.combo.series, name)
    ? panel.combo.series[name] : undefined
  if (stored) return { ...stored, markers: stored.markers ?? false }
  return index === 0
    ? { kind: 'column', axis: 'left', markers: false }
    : { kind: 'line', axis: 'right', markers: false }
}

export function chartRequiredOutputs(panel: Pick<ChartPanel, 'type' | 'scatterXOutput' | 'outputs'>): string[] {
  if (panel.type === 'histogram') return panel.outputs.slice(0, 1)
  return panel.type === 'scatter' && panel.scatterXOutput !== null
    ? [...new Set([panel.scatterXOutput, ...panel.outputs])]
    : panel.outputs
}

export function chartRawOutputs(panel: Pick<ChartPanel, 'type' | 'scatterXOutput' | 'outputs'>): string[] {
  return panel.type === 'histogram' || panel.type === 'boxplot' ? [] : chartRequiredOutputs(panel)
}

export function chartSupportsLive(type: ChartType): boolean {
  return type === 'line'
}

export function chartSupportsZoom(type: ChartType): boolean {
  return type === 'line' || type === 'area' || type === 'column' || type === 'combo'
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
    const scatterXOutput = panel.type === 'scatter' && panel.scatterXOutput !== null && !names.includes(panel.scatterXOutput)
      ? null : panel.scatterXOutput
    if (chartRequiredOutputs(panel).every(name => names.includes(name))) {
      reconciled?.push(panel)
      return
    }
    reconciled ??= panels.slice(0, index)
    reconciled.push({ ...panel, outputs: panel.outputs.filter(name => names.includes(name)), scatterXOutput })
  })
  return reconciled ?? panels
}

export const MAX_CHARTS = 8

export function addChartPanel(panels: ChartPanel[], page: string, numericNames: string[]): ChartPanel[] {
  if (panels.length >= MAX_CHARTS || numericNames.length === 0) return panels
  const name = numericNames.find(name => !panels.some(panel => panel.page === page && panel.outputs.includes(name)))
    ?? numericNames[0]
  return [...panels, {
    id: nextChartPanelId(panels), page, title: '', outputs: [name], type: 'line', scatterXOutput: null,
    scatter: { display: 'markers', markerSize: 4, lineWidth: 2 },
    line: { series: {} },
    markerStyles: {},
    seriesColors: {},
    showLegend: true, legendPosition: 'top',
    imageBackground: 'light',
    showAllRawData: false,
    zoom: { enabled: false, showSlider: true },
    xAxis: { title: 'Iteration', min: null, max: null, interval: null,
      showLabels: true, showTicks: true, showMajorGrid: false },
    yAxis: { title: '', min: null, max: null, interval: null,
      showLabels: true, showTicks: true, showMajorGrid: true },
    combo: { series: {}, rightAxis: { title: '', min: null, max: null, interval: null,
      showLabels: true, showTicks: true, showMajorGrid: false } },
    histogram: { mode: 'auto', value: null, showNormalCurve: false, mean: null, stdDev: null },
    boxPlot: { showOutliers: true },
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
