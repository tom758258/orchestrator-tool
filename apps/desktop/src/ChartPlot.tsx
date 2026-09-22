import { useEffect, useMemo, useRef, useState } from 'react'
import { init, use, type EChartsType } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { exactHoverIndex, minMaxDecimate, type PageChartData } from './chartData'
import type { ChartPanel } from './chartPanels'

use([LineChart, GridComponent, LegendComponent, CanvasRenderer])

const GRID = { left: 80, right: 24, top: 48, bottom: 64 }

export default function ChartPlot({ panel, data, numericNames, charts }: {
  panel: ChartPanel
  data: PageChartData
  numericNames: string[]
  charts: Map<number, EChartsType>
}) {
  const container = useRef<HTMLDivElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const pointer = useRef<HTMLDivElement>(null)
  const instance = useRef<EChartsType | null>(null)
  const lastValidSizeRef = useRef<{ width: number; height: number } | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  const [width, setWidth] = useState(0)
  const [themeRevision, setThemeRevision] = useState(0)
  const rawRowCount = useMemo(() => data.commonLength(panel.outputs),
    [data, data.version, panel.outputs])
  const rawIteration = useMemo(() => data.iteration.subarray(0, rawRowCount),
    [data, data.version, rawRowCount])
  const rawSeries = useMemo(() => panel.outputs.map(name => ({
    name,
    values: data.getSeries(name).subarray(0, rawRowCount),
  })), [data, data.version, panel.outputs, rawRowCount])
  const display = useMemo(() => rawSeries.map(series => ({
    name: series.name,
    data: minMaxDecimate(rawIteration, series.values, Math.max(1, width - GRID.left - GRID.right)),
  })), [rawIteration, rawSeries, width])

  useEffect(() => {
    const chart = init(container.current!, undefined, { renderer: 'canvas' })
    instance.current = chart
    charts.set(panel.id, chart)
    const initialWidth = Math.floor(chart.getWidth())
    const initialHeight = Math.floor(chart.getHeight())
    if (initialWidth > 0 && initialHeight > 0) {
      lastValidSizeRef.current = { width: initialWidth, height: initialHeight }
      setWidth(initialWidth)
    }
    const resize = new ResizeObserver(() => {
      if (resizeFrameRef.current !== null) return
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null
        const rect = container.current!.getBoundingClientRect()
        const width = Math.floor(rect.width)
        const height = Math.floor(rect.height)
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
        const previous = lastValidSizeRef.current
        if (previous?.width === width && previous.height === height) return
        lastValidSizeRef.current = { width, height }
        chart.resize({ width, height })
        if (previous?.width !== width) setWidth(width)
        tooltip.current!.hidden = true
        pointer.current!.hidden = true
      })
    })
    resize.observe(container.current!)
    const theme = new MutationObserver(() => setThemeRevision(value => value + 1))
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      resize.disconnect()
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = null
      lastValidSizeRef.current = null
      theme.disconnect()
      charts.delete(panel.id)
      instance.current = null
      chart.dispose()
    }
  }, [charts, panel.id])

  useEffect(() => {
    const style = getComputedStyle(document.documentElement)
    const color = (token: string) => style.getPropertyValue(token).trim()
    instance.current!.setOption({
      animation: false,
      backgroundColor: color('--chart-surface'),
      textStyle: { color: color('--ink') },
      grid: GRID,
      legend: { show: display.length > 1, top: 8, type: 'plain', selectedMode: false,
        textStyle: { color: color('--ink') } },
      xAxis: { type: 'value', min: 1, max: Math.max(2, rawRowCount), minInterval: 1,
        name: panel.xAxisTitle, nameLocation: 'middle', nameGap: 36,
        axisLine: { lineStyle: { color: color('--chart-axis') } },
        axisLabel: { color: color('--chart-axis') }, splitLine: { show: false } },
      yAxis: { type: 'value', name: panel.yAxisTitle, nameLocation: 'middle', nameGap: 56,
        axisLabel: { color: color('--chart-axis') },
        nameTextStyle: { color: color('--chart-axis') },
        splitLine: { lineStyle: { color: color('--chart-grid'), type: 'dashed' } } },
      series: display.map(series => ({ ...series, type: 'line', showSymbol: false,
        silent: true, emphasis: { disabled: true },
        itemStyle: { color: color(`--chart-series-${numericNames.indexOf(series.name) % 6 + 1}`) } })),
    }, { notMerge: true })
  }, [display, rawRowCount, numericNames, panel.xAxisTitle, panel.yAxisTitle, themeRevision])

  useEffect(() => {
    const chart = instance.current!
    const zr = chart.getZr()
    const tip = tooltip.current!
    const line = pointer.current!
    const hide = () => { tip.hidden = true; line.hidden = true }
    const move = (event: { offsetX: number; offsetY: number }) => {
      const point = [event.offsetX, event.offsetY]
      if (rawRowCount === 0 || !chart.containPixel({ gridIndex: 0 }, point)) { hide(); return }
      const x = chart.convertFromPixel({ xAxisIndex: 0 }, event.offsetX)
      const index = exactHoverIndex(x, rawRowCount)
      // Never use renderer points: each selected series reads the coherent raw prefix.
      tip.textContent = [`Iteration ${rawIteration[index]}`,
        ...rawSeries.map(series => `${series.name} ${series.values[index]}`)].join('\n')
      tip.hidden = false
      line.hidden = false
      line.style.left = `${chart.convertToPixel({ xAxisIndex: 0 }, index + 1)}px`
      tip.style.left = `${Math.max(0, Math.min(event.offsetX + 12, chart.getWidth() - tip.offsetWidth))}px`
      tip.style.top = `${Math.max(0, Math.min(event.offsetY + 12, chart.getHeight() - tip.offsetHeight))}px`
    }
    zr.on('mousemove', move)
    zr.on('globalout', hide)
    hide()
    return () => {
      zr.off('mousemove', move)
      zr.off('globalout', hide)
    }
  }, [rawIteration, rawRowCount, rawSeries])

  return <div className="result-chart-view">
    <div ref={container} className="result-chart-plot" role="img"
      aria-label={`Line chart: ${panel.outputs.join(', ')} versus Iteration, ${rawRowCount} raw rows per series`} />
    <div ref={pointer} className="result-chart-pointer" hidden style={{ top: GRID.top, bottom: GRID.bottom }} />
    <div ref={tooltip} className="result-chart-tooltip" hidden />
  </div>
}
