import { seriesColor, type ChartPanel } from './chartPanels.ts'

export type HistogramDto = {
  run_id: number
  page: string
  output: string
  sample_count: number
  mean: number
  std_dev: number | null
  bins: { start: number; end: number; count: number }[]
}

export type BoxPlotDto = {
  run_id: number
  page: string
  items: { output: string; count: number; lower_whisker: number; q1: number;
    median: number; q3: number; upper_whisker: number; outliers: number[] }[]
}

export type StatisticalDto = HistogramDto | BoxPlotDto

export function statisticalRequestKey(runId: number, panel: ChartPanel): string | null {
  if (panel.type === 'histogram') return panel.outputs[0]
    ? JSON.stringify([runId, panel.page, panel.type, panel.outputs[0],
      panel.histogram.mode, panel.histogram.value]) : null
  if (panel.type === 'boxplot') return panel.outputs.length
    ? JSON.stringify([runId, panel.page, panel.type, panel.outputs]) : null
  return null
}

export function formatBinBoundary(value: number): string {
  return String(Number(value.toPrecision(6)))
}

export function statisticalChartSeries(panel: ChartPanel, response: StatisticalDto, color: string) {
  if (panel.type === 'histogram') {
    const histogram = response as HistogramDto
    const bins = histogram.bins
    const barColor = seriesColor(panel, histogram.output, color)
    const mean = panel.histogram.mean ?? histogram.mean
    const stdDev = panel.histogram.stdDev ?? histogram.std_dev
    const normal = panel.histogram.showNormalCurve && Number.isFinite(mean) &&
      stdDev !== null && Number.isFinite(stdDev) && stdDev > 0 &&
      (panel.histogram.stdDev !== null || histogram.sample_count >= 2)
      ? bins.map(bin => {
        const center = bin.start + (bin.end - bin.start) / 2
        const z = (center - mean) / stdDev
        return histogram.sample_count * Math.exp(-0.5 * z * z) /
          (stdDev * Math.sqrt(2 * Math.PI)) * (bin.end - bin.start)
      }) : null
    return { categories: bins.map(bin => `${formatBinBoundary(bin.start)}–${formatBinBoundary(bin.end)}`),
      series: [{ name: histogram.output, type: 'bar' as const,
        data: bins.map(bin => bin.count), itemStyle: { color: barColor } },
      ...(normal && normal.every(Number.isFinite) ? [{ name: 'Normal', type: 'line' as const,
        data: normal, showSymbol: false, silent: true, emphasis: { disabled: true },
        lineStyle: { color: barColor }, itemStyle: { color: barColor } }] : [])] }
  }
  const items = (response as BoxPlotDto).items
  return { categories: items.map(item => item.output), series: [
    { name: 'Box', type: 'boxplot' as const,
      data: items.map(item => [item.lower_whisker, item.q1, item.median, item.q3, item.upper_whisker]),
      itemStyle: { color } },
    ...(panel.boxPlot.showOutliers ? [{ name: 'Outliers', type: 'scatter' as const,
      data: items.flatMap((item, index) => item.outliers.map(value => [index, value])),
      itemStyle: { color } }] : []),
  ] }
}
