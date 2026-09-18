import type { EChartsType } from 'echarts/core'

export async function chartPng(chart: EChartsType | undefined): Promise<Uint8Array> {
  if (!chart || chart.isDisposed()) throw new Error('No rendered chart is available to export.')
  const backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-surface').trim()
  const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor })
  const base64 = url.slice(url.indexOf(',') + 1)
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0))
}
