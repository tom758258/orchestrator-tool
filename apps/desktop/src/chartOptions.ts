import { chartSupportsZoom, comboSeriesSettings, type AxisSettings, type ChartPanel } from './chartPanels.ts'

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
  const common = { ...series, itemStyle: { color } }
  if (panel.scatter.display === 'markers') {
    return { ...common, type: 'scatter' as const, large: true, largeThreshold: 2000,
      symbolSize: panel.scatter.markerSize }
  }
  return { ...common, type: 'line' as const, showSymbol: panel.scatter.display === 'lines-markers',
    symbolSize: panel.scatter.markerSize, lineStyle: { width: panel.scatter.lineWidth } }
}

export function comboRendererSeries(panel: ChartPanel,
  display: { name: string; data: [number, number][] }[], colors: string[]) {
  return display.map((series, index) => {
    const settings = comboSeriesSettings(panel, series.name, index)
    const common = { ...series, yAxisIndex: settings.axis === 'right' ? 1 : 0,
      silent: true, itemStyle: { color: colors[index] } }
    return settings.kind === 'line'
      ? { ...common, type: 'line' as const, showSymbol: false, emphasis: { disabled: true } }
      : { ...common, type: 'bar' as const, large: true, largeThreshold: 2000 }
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
  fullDomain?: { min: number; max: number }, iterations?: Float64Array, categories?: string[]) {
  const hasLegend = chartHasLegend(panel)
  const visual = chartVisualOptions(colors)
  const layout = chartLayout(panel)
  const xAxis = panel.type === 'bar' ? panel.yAxis : panel.xAxis
  const yAxis = panel.type === 'bar' ? panel.xAxis : panel.yAxis
  return {
    title: { text: panel.title, left: 'center' as const, top: 8,
      textStyle: { ...visual.title.textStyle, fontSize: 16 } },
    legend: { show: hasLegend, ...layout.legend, type: 'scroll' as const,
      selectedMode: false, textStyle: chartLegendTextStyle(panel, colors.ink) },
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
      : axisOption(yAxis, 56, visual.yAxis),
  }
}

export function chartGridTop(panel: ChartPanel): number {
  if (panel.title.length === 0) return 48
  return chartHasLegend(panel) && panel.legendPosition === 'top' ? 88 : 64
}
