import type { AxisSettings, ChartPanel } from './chartPanels'

type ChartColors = { ink: string; axis: string; grid: string }
export const CHART_GRID = { left: 80, right: 24, bottom: 64 }

function axisOption(axis: AxisSettings, nameGap: number, colors: ChartColors) {
  return {
    type: 'value' as const,
    ...(axis.min === null ? {} : { min: axis.min }),
    ...(axis.max === null ? {} : { max: axis.max }),
    ...(axis.interval === null ? {} : { interval: axis.interval }),
    name: axis.title,
    nameLocation: 'middle' as const,
    nameGap,
    nameTextStyle: { color: colors.axis },
    axisLine: { lineStyle: { color: colors.axis } },
    axisLabel: { show: axis.showLabels, color: colors.axis },
    axisTick: { show: axis.showTicks },
    splitLine: { show: axis.showMajorGrid, lineStyle: { color: colors.grid, type: 'dashed' as const } },
  }
}

export function chartPresentationOptions(panel: ChartPanel, seriesCount: number, colors: ChartColors) {
  const hasTitle = panel.title.length > 0
  const hasLegend = panel.showLegend && seriesCount > 1
  return {
    title: { text: panel.title, left: 'center' as const, top: 8,
      textStyle: { color: colors.ink, fontSize: 16 } },
    legend: { show: hasLegend, top: hasTitle ? 40 : 8, type: 'plain' as const,
      selectedMode: false, textStyle: { color: colors.ink } },
    grid: { ...CHART_GRID, top: chartGridTop(panel, seriesCount) },
    xAxis: axisOption(panel.xAxis, 36, colors),
    yAxis: axisOption(panel.yAxis, 56, colors),
  }
}

export function chartGridTop(panel: ChartPanel, seriesCount: number): number {
  if (panel.title.length === 0) return 48
  return panel.showLegend && seriesCount > 1 ? 88 : 64
}
