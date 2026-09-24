import type { AxisSettings, ChartPanel } from './chartPanels'

type ChartColors = { ink: string; axis: string; grid: string }
export const CHART_GRID = { left: 80, right: 24, bottom: 64 }
export const chartGridBottom = (panel: ChartPanel): number =>
  panel.zoom.enabled && panel.zoom.showSlider ? 112 : CHART_GRID.bottom

export function chartVisualOptions(colors: ChartColors) {
  const axis = {
    nameTextStyle: { color: colors.axis },
    axisLine: { lineStyle: { color: colors.axis } },
    axisLabel: { color: colors.axis },
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
  fullDomain?: { min: number; max: number }) {
  const hasTitle = panel.title.length > 0
  const hasLegend = panel.showLegend && seriesCount > 1
  const visual = chartVisualOptions(colors)
  return {
    title: { text: panel.title, left: 'center' as const, top: 8,
      textStyle: { ...visual.title.textStyle, fontSize: 16 } },
    legend: { show: hasLegend, top: hasTitle ? 40 : 8, type: 'plain' as const,
      selectedMode: false, textStyle: visual.legend.textStyle },
    grid: { ...CHART_GRID, bottom: chartGridBottom(panel), top: chartGridTop(panel, seriesCount) },
    xAxis: { ...axisOption(panel.xAxis, 36, visual.xAxis),
      ...(fullDomain && panel.zoom.enabled ? fullDomain : {}) },
    yAxis: axisOption(panel.yAxis, 56, visual.yAxis),
  }
}

export function chartGridTop(panel: ChartPanel, seriesCount: number): number {
  if (panel.title.length === 0) return 48
  return panel.showLegend && seriesCount > 1 ? 88 : 64
}
