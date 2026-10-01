import { chartSupportsZoom, comboSeriesSettings, lineSeriesSettings, markerStyleSettings, seriesColor,
  type AxisSettings, type ChartPanel, type MarkerShape } from './chartPanels.ts'

type ChartColors = { ink: string; axis: string; grid: string }
export const CHART_GRID = { left: 80, right: 24, bottom: 64 }
const SIDE_LEGEND_SPACE = 120
const SIDE_LEGEND_WIDTH = 100
const BOTTOM_LEGEND_SPACE = 40
export const chartHasLegend = (panel: ChartPanel): boolean =>
  panel.type !== 'histogram' && panel.type !== 'boxplot' && panel.showLegend
export const chartGridBottom = (panel: ChartPanel, includeSlider = true): number =>
  (includeSlider && chartSupportsZoom(panel.type) && panel.zoom.enabled && panel.zoom.showSlider
    ? 112 : CHART_GRID.bottom) + (chartHasLegend(panel) && panel.legendPosition === 'bottom'
    ? BOTTOM_LEGEND_SPACE : 0)
export const chartGridLeft = (panel: ChartPanel): number =>
  CHART_GRID.left + (chartHasLegend(panel) && panel.legendPosition === 'left' ? SIDE_LEGEND_SPACE : 0)

export const comboHasRightAxis = (panel: ChartPanel): boolean => panel.type === 'combo' &&
  panel.outputs.some((name, index) => comboSeriesSettings(panel, name, index).axis === 'right')
export const chartGridRight = (panel: ChartPanel): number =>
  (comboHasRightAxis(panel) ? 96 : CHART_GRID.right) +
  (chartHasLegend(panel) && panel.legendPosition === 'right' ? SIDE_LEGEND_SPACE : 0)

export const chartZoomSliderBottom = (panel: ChartPanel): number =>
  chartHasLegend(panel) && panel.legendPosition === 'bottom' ? 52 : 12

export const chartLegendTextStyle = (panel: ChartPanel, color: string) => ({
  color,
  ...(panel.legendPosition === 'left' || panel.legendPosition === 'right'
    ? { width: SIDE_LEGEND_WIDTH - 32, overflow: 'truncate' as const } : {}),
})

export function markerSymbol(shape: MarkerShape): 'circle' | 'rect' | 'diamond' | 'triangle' {
  return shape === 'square' ? 'rect' : shape
}

export type ChartLegendItem = { name: string; icon: 'line'
  itemStyle: { color: string; borderColor: string; borderWidth: number } }

export function chartLegendData(panel: ChartPanel,
  seriesColors: Record<string, string> = {}): (string | ChartLegendItem)[] {
  return panel.outputs.map((name, index) => {
    const lineOnly = panel.type === 'area'
      || (panel.type === 'line' && !lineSeriesSettings(panel, name).markers)
      || (panel.type === 'scatter' && panel.scatter.display === 'lines')
      || (panel.type === 'combo' && (() => {
        const settings = comboSeriesSettings(panel, name, index)
        return settings.kind === 'line' && !settings.markers
      })())
    if (!lineOnly) return name
    // An explicit icon:'line' legend entry bypasses the series legend icon and is drawn by
    // ECharts as a zero-area path that only honors itemStyle. Stroke it with the resolved
    // series color so the legend line still matches the plotted line.
    const color = seriesColors[name]
    return { name, icon: 'line' as const, itemStyle: { color, borderColor: color, borderWidth: 2 } }
  })
}

function markerRendererStyle(panel: ChartPanel, name: string, color: string) {
  const marker = markerStyleSettings(panel, name)
  const fill = marker.fillColor ?? color
  const border = marker.borderColor ?? color
  return {
    marker,
    symbol: markerSymbol(marker.shape),
    itemStyle: { color: fill, borderColor: border, borderWidth: 1 },
  }
}

export function lineRendererSeries(panel: ChartPanel,
  series: { name: string; data: [number, number][]; significantMarkers?: [number, number][] }, color: string) {
  color = seriesColor(panel, series.name, color)
  const { significantMarkers, ...line } = series
  const markers = panel.type === 'line' && lineSeriesSettings(panel, series.name).markers
  const marker = markerRendererStyle(panel, series.name, color)
  // MarkPoint is separate from showSymbol: ordinary Line vertices stay marker-free
  // even when the user opts to highlight only threshold-qualified excursions.
  const qualifying = panel.type === 'line' && significantMarkers?.length ? {
    markPoint: { silent: true, symbol: marker.symbol, symbolSize: marker.marker.size,
      label: { show: false }, itemStyle: marker.itemStyle,
      data: significantMarkers.map(([iteration, value]) => ({ coord: [iteration, value], value })) },
  } : {}
  const common = { ...line, ...qualifying, type: 'line' as const, silent: true, emphasis: { disabled: true },
    lineStyle: { color } }
  if (markers) {
    return { ...common, showSymbol: true, symbol: marker.symbol, symbolSize: marker.marker.size,
      itemStyle: marker.itemStyle }
  }
  return { ...common, showSymbol: false, symbol: 'none' as const, itemStyle: { color },
    ...(panel.type === 'area' ? { areaStyle: { opacity: 0.18 } } : {}) }
}

export function chartLayout(panel: ChartPanel, includeSlider = true) {
  const bottom = chartGridBottom(panel, includeSlider)
  const hasTitle = panel.title.length > 0
  const position = panel.legendPosition
  const legend = position === 'top'
    ? { orient: 'horizontal' as const, left: 'center' as const, top: hasTitle ? 40 : 8 }
    : position === 'bottom'
      ? { orient: 'horizontal' as const, left: 'center' as const, bottom: 8 }
      : { orient: 'vertical' as const, [position]: 8, top: hasTitle ? 40 : 8,
        bottom, width: SIDE_LEGEND_WIDTH }
  return { grid: { left: chartGridLeft(panel), right: chartGridRight(panel),
    bottom, top: chartGridTop(panel) }, legend }
}

export function scatterRendererSeries(panel: ChartPanel, series: { name: string; data: [number, number][] },
  color: string) {
  color = seriesColor(panel, series.name, color)
  if (panel.scatter.display === 'lines') {
    return { ...series, type: 'line' as const, showSymbol: false, symbol: 'none' as const,
      itemStyle: { color }, lineStyle: { color, width: panel.scatter.lineWidth } }
  }
  const marker = markerRendererStyle(panel, series.name, color)
  if (panel.scatter.display === 'markers') {
    const useLarge = panel.scatter.markerSize >= 4
    return { ...series, type: 'scatter' as const, symbol: marker.symbol,
      symbolSize: panel.scatter.markerSize, itemStyle: marker.itemStyle,
      ...(useLarge ? { large: true, largeThreshold: 2000 } : {}) }
  }
  return { ...series, type: 'line' as const, showSymbol: true, symbol: marker.symbol,
    symbolSize: panel.scatter.markerSize, itemStyle: marker.itemStyle,
    lineStyle: { color, width: panel.scatter.lineWidth } }
}

export function comboRendererSeries(panel: ChartPanel,
  display: { name: string; data: [number, number][] }[], colors: string[]) {
  return display.map((series, index) => {
    const settings = comboSeriesSettings(panel, series.name, index)
    const color = seriesColor(panel, series.name, colors[index])
    const common = { ...series, yAxisIndex: settings.axis === 'right' ? 1 : 0, silent: true }
    if (settings.kind === 'line') {
      if (settings.markers) {
        const marker = markerRendererStyle(panel, series.name, color)
        return { ...common, type: 'line' as const, showSymbol: true, symbol: marker.symbol,
          symbolSize: marker.marker.size, itemStyle: marker.itemStyle,
          lineStyle: { color }, emphasis: { disabled: true } }
      }
      return { ...common, type: 'line' as const, showSymbol: false, symbol: 'none' as const,
        itemStyle: { color }, lineStyle: { color }, emphasis: { disabled: true } }
    }
    return { ...common, type: 'bar' as const, large: true, largeThreshold: 2000,
      itemStyle: { color } }
  })
}

export function chartVisualOptions(colors: ChartColors) {
  const axis = {
    nameTextStyle: { color: colors.axis },
    axisLine: { lineStyle: { color: colors.axis } },
    axisLabel: { color: colors.axis, hideOverlap: true },
    splitLine: { lineStyle: { color: colors.grid } },
  }
  return {
    textStyle: { color: colors.ink },
    title: { textStyle: { color: colors.ink } },
    legend: { textStyle: { color: colors.ink } },
    xAxis: axis,
    yAxis: axis,
  }
}

function axisOption(axis: AxisSettings, nameGap: number, visual: ReturnType<typeof chartVisualOptions>['xAxis']) {
  return {
    type: 'value' as const,
    ...(axis.min === null ? {} : { min: axis.min }),
    ...(axis.max === null ? {} : { max: axis.max }),
    ...(axis.interval === null ? {} : { interval: axis.interval }),
    name: axis.title,
    nameLocation: 'middle' as const,
    nameGap,
    nameTextStyle: visual.nameTextStyle,
    axisLine: visual.axisLine,
    axisLabel: { ...visual.axisLabel, show: axis.showLabels },
    axisTick: { show: axis.showTicks },
    splitLine: { show: axis.showMajorGrid,
      lineStyle: { ...visual.splitLine.lineStyle, type: 'dashed' as const } },
  }
}

export function chartPresentationOptions(panel: ChartPanel, _seriesCount: number, colors: ChartColors,
  fullDomain?: { min: number; max: number }, iterations?: Float64Array, categories?: string[],
  seriesColors: Record<string, string> = {}, fitData = false) {
  const hasLegend = chartHasLegend(panel)
  const visual = chartVisualOptions(colors)
  const layout = chartLayout(panel)
  const xAxis = panel.type === 'bar' ? panel.yAxis : panel.xAxis
  const yAxis = panel.type === 'bar' ? panel.xAxis : panel.yAxis
  return {
    title: { text: panel.title, left: 'center' as const, top: 8,
      textStyle: { ...visual.title.textStyle, fontSize: 16 } },
    legend: { show: hasLegend, ...layout.legend, type: 'scroll' as const,
      selectedMode: false, data: chartLegendData(panel, seriesColors),
      textStyle: chartLegendTextStyle(panel, colors.ink) },
    grid: layout.grid,
    xAxis: { ...axisOption(categories ? { ...xAxis, min: null, max: null, interval: null } : xAxis,
      36, visual.xAxis),
      ...(categories ? { type: 'category' as const, data: categories } : {}),
      ...(fullDomain && chartSupportsZoom(panel.type) && panel.zoom.enabled ? fullDomain : {}) },
    yAxis: panel.type === 'combo' && comboHasRightAxis(panel)
      ? [axisOption(panel.yAxis, 56, visual.yAxis),
        { ...axisOption(panel.combo.rightAxis, 64, visual.yAxis), position: 'right' as const }]
      : panel.type === 'bar'
      ? { ...axisOption(yAxis, 56, visual.yAxis), type: 'category' as const,
        data: iterations ? Array.from(iterations, String) : [],
        ...(yAxis.min === null ? {} : { min: yAxis.min - 1 }),
        ...(yAxis.max === null ? {} : { max: yAxis.max - 1 }),
        axisLabel: { ...visual.yAxis.axisLabel, show: yAxis.showLabels,
          ...(yAxis.interval === null ? {} : {
            interval: (_index: number, value: string) => Number(value) % yAxis.interval! === 0,
          }) } }
      : { ...axisOption(yAxis, 56, visual.yAxis),
        ...(fitData && panel.type === 'line' ? { scale: true } : {}) },
  }
}

export function chartGridTop(panel: ChartPanel): number {
  if (panel.title.length === 0) return 48
  return chartHasLegend(panel) && panel.legendPosition === 'top' ? 88 : 64
}
