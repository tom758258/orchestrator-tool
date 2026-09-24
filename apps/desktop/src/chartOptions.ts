import { chartSupportsZoom, comboSeriesSettings, type AxisSettings, type ChartPanel } from './chartPanels.ts'

type ChartColors = { ink: string; axis: string; grid: string }
export const CHART_GRID = { left: 80, right: 24, bottom: 64 }
export const chartGridBottom = (panel: ChartPanel): number =>
  chartSupportsZoom(panel.type) && panel.zoom.enabled && panel.zoom.showSlider ? 112 : CHART_GRID.bottom

export const comboHasRightAxis = (panel: ChartPanel): boolean => panel.type === 'combo' &&
  panel.outputs.some((name, index) => comboSeriesSettings(panel, name, index).axis === 'right')
export const chartGridRight = (panel: ChartPanel): number =>
  comboHasRightAxis(panel) ? 96 : CHART_GRID.right

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

export function chartPresentationOptions(panel: ChartPanel, seriesCount: number, colors: ChartColors,
  fullDomain?: { min: number; max: number }, iterations?: Float64Array, categories?: string[]) {
  const hasTitle = panel.title.length > 0
  const hasLegend = panel.type !== 'histogram' && panel.type !== 'boxplot' && panel.showLegend && seriesCount > 1
  const visual = chartVisualOptions(colors)
  const xAxis = panel.type === 'bar' ? panel.yAxis : panel.xAxis
  const yAxis = panel.type === 'bar' ? panel.xAxis : panel.yAxis
  return {
    title: { text: panel.title, left: 'center' as const, top: 8,
      textStyle: { ...visual.title.textStyle, fontSize: 16 } },
    legend: { show: hasLegend, top: hasTitle ? 40 : 8, type: 'plain' as const,
      selectedMode: false, textStyle: visual.legend.textStyle },
    grid: { ...CHART_GRID, right: chartGridRight(panel),
      bottom: chartGridBottom(panel), top: chartGridTop(panel, seriesCount) },
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

export function chartGridTop(panel: ChartPanel, seriesCount: number): number {
  if (panel.title.length === 0) return 48
  return panel.showLegend && panel.type !== 'histogram' && panel.type !== 'boxplot' && seriesCount > 1 ? 88 : 64
}
