import type { EChartsType } from 'echarts/core'
import type { ChartPanel } from './chartPanels'
import { chartLayout, chartLegendTextStyle, chartVisualOptions, comboHasRightAxis } from './chartOptions.ts'

const exportPalettes = {
  light: { background: '#ffffff', ink: '#18202a', axis: '#5e6e7e', grid: '#e5e9ef' },
  dark: { background: '#222326', ink: '#f2f2f4', axis: '#a8a8ae', grid: '#414348' },
}

export async function chartPng(chart: EChartsType | undefined, panel: ChartPanel): Promise<Uint8Array> {
  if (!chart || chart.isDisposed()) throw new Error('No rendered chart is available to export.')
  const style = getComputedStyle(document.documentElement)
  const color = (token: string) => style.getPropertyValue(token).trim()
  const screen = { background: color('--chart-surface'), ink: color('--ink'),
    axis: color('--chart-axis'), grid: color('--chart-grid') }
  const palette = exportPalettes[panel.imageBackground]
  const visual = (colors: typeof screen) => {
    const options = chartVisualOptions(colors)
    return { ...options, yAxis: comboHasRightAxis(panel) ? [options.yAxis, options.yAxis] : options.yAxis }
  }
  let url: string
  try {
    const layout = chartLayout(panel, false)
    chart.setOption({ backgroundColor: palette.background,
      ...visual(palette), grid: layout.grid, legend: { ...layout.legend,
        textStyle: chartLegendTextStyle(panel, palette.ink) } })
    url = chart.getDataURL({ type: 'png', pixelRatio: 2,
      backgroundColor: palette.background, excludeComponents: ['dataZoom'] })
  } finally {
    const layout = chartLayout(panel)
    chart.setOption({ backgroundColor: screen.background,
      ...visual(screen), grid: layout.grid, legend: { ...layout.legend,
        textStyle: chartLegendTextStyle(panel, screen.ink) } })
  }
  const base64 = url.slice(url.indexOf(',') + 1)
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0))
}
