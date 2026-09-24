import { useEffect, useMemo, useRef, useState } from 'react'
import { init, use, type EChartsType } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { DataZoomComponent, GridComponent, LegendComponent, TitleComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { exactHoverIndex, minMaxDecimateRange, type PageChartData } from './chartData'
import type { ChartPanel } from './chartPanels'
import { CHART_GRID, chartGridBottom, chartGridTop, chartPresentationOptions } from './chartOptions'

use([LineChart, DataZoomComponent, GridComponent, LegendComponent, TitleComponent, CanvasRenderer])

type ZoomRange = { min: number; max: number } | null

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
  const [zoomRange, setZoomRange] = useState<ZoomRange>(null)
  const rawRowCount = useMemo(() => data.commonLength(panel.outputs),
    [data, data.version, panel.outputs])
  const rawIteration = useMemo(() => data.iteration.subarray(0, rawRowCount),
    [data, data.version, rawRowCount])
  const rawSeries = useMemo(() => panel.outputs.map(name => ({
    name,
    values: data.getSeries(name).subarray(0, rawRowCount),
  })), [data, data.version, panel.outputs, rawRowCount])
  const rawMin = rawRowCount > 0 ? rawIteration[0] : 0
  const rawMax = rawRowCount > 0 ? rawIteration[rawRowCount - 1] : 1
  const fullDomain = useMemo(() => {
    let min = panel.xAxis.min ?? rawMin
    let max = panel.xAxis.max ?? rawMax
    if (max <= min) {
      if (panel.xAxis.max === null) max = min + 1
      else min = max - 1
    }
    return { min, max }
  }, [panel.xAxis.min, panel.xAxis.max, rawMin, rawMax])
  const visibleRange = panel.zoom.enabled
    ? zoomRange ?? fullDomain
    : { min: panel.xAxis.min ?? rawMin, max: panel.xAxis.max ?? rawMax }
  const display = useMemo(() => rawSeries.map(series => ({
    name: series.name,
    data: minMaxDecimateRange(rawIteration, series.values,
      Math.max(1, width - CHART_GRID.left - CHART_GRID.right), visibleRange),
  })), [rawIteration, rawSeries, width, visibleRange.min, visibleRange.max])
  const rendererSeries = useMemo(() => {
    const style = getComputedStyle(document.documentElement)
    return display.map(series => ({ ...series, type: 'line', showSymbol: false,
      silent: true, emphasis: { disabled: true },
      itemStyle: { color: style.getPropertyValue(
        `--chart-series-${numericNames.indexOf(series.name) % 6 + 1}`).trim() } }))
  }, [display, numericNames, themeRevision])

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
    if (!panel.zoom.enabled) setZoomRange(null)
  }, [panel.zoom.enabled])

  useEffect(() => {
    if (!panel.zoom.enabled) return
    const chart = instance.current!
    const onZoom = (payload: unknown) => {
      const event = payload as { start?: number; end?: number;
        batch?: { start: number; end: number }[] }
      const range = event.batch?.[0] ?? event
      if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return
      const start = range.start!
      const end = range.end!
      if (end <= start) return
      const next = start <= 0.000001 && end >= 99.999999 ? null : {
        min: fullDomain.min + (fullDomain.max - fullDomain.min) * start / 100,
        max: fullDomain.min + (fullDomain.max - fullDomain.min) * end / 100,
      }
      setZoomRange(previous => previous?.min === next?.min && previous?.max === next?.max
        ? previous : next)
    }
    chart.on('datazoom', onZoom)
    return () => { chart.off('datazoom', onZoom) }
  }, [panel.zoom.enabled, fullDomain])

  useEffect(() => {
    const style = getComputedStyle(document.documentElement)
    const color = (token: string) => style.getPropertyValue(token).trim()
    const presentation = chartPresentationOptions(panel, display.length,
      { ink: color('--ink'), axis: color('--chart-axis'), grid: color('--chart-grid') }, fullDomain)
    const range = zoomRange === null ? { start: 0, end: 100 }
      : { startValue: zoomRange.min, endValue: zoomRange.max }
    instance.current!.setOption({
      animation: false,
      backgroundColor: color('--chart-surface'),
      textStyle: { color: color('--ink') },
      ...presentation,
      dataZoom: panel.zoom.enabled ? [
        { type: 'inside', xAxisIndex: 0, filterMode: 'none', throttle: 80,
          zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false, ...range },
        ...(panel.zoom.showSlider ? [{ type: 'slider', xAxisIndex: 0, filterMode: 'none',
          throttle: 80, showDataShadow: false, showDetail: false, bottom: 12, height: 22,
          backgroundColor: color('--chart-surface'), borderColor: color('--chart-axis'),
          fillerColor: color('--surface-selected'),
          handleStyle: { color: color('--accent'), borderColor: color('--chart-axis') },
          ...range }] : []),
      ] : [],
      series: rendererSeries,
    }, { notMerge: true })
  }, [panel, themeRevision, fullDomain])

  useEffect(() => {
    instance.current!.setOption({ series: rendererSeries }, { replaceMerge: ['series'] })
  }, [rendererSeries])

  const previousXBounds = useRef({ min: panel.xAxis.min, max: panel.xAxis.max })
  useEffect(() => {
    const previous = previousXBounds.current
    if (previous.min === panel.xAxis.min && previous.max === panel.xAxis.max) return
    previousXBounds.current = { min: panel.xAxis.min, max: panel.xAxis.max }
    setZoomRange(null)
    if (panel.zoom.enabled) instance.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
  }, [panel.xAxis.min, panel.xAxis.max, panel.zoom.enabled])

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
      if (index === null) { hide(); return }
      // Never use renderer points: each selected series reads the coherent raw prefix.
      tip.textContent = [`Iteration ${rawIteration[index]}`,
        ...rawSeries.map(series => `${series.name} ${series.values[index]}`)].join('\n')
      tip.hidden = false
      line.hidden = false
      line.style.left = `${chart.convertToPixel({ xAxisIndex: 0 }, rawIteration[index])}px`
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

  return <><div className="result-chart-view">
    <div ref={container} className="result-chart-plot" role="img"
      aria-label={`Line chart: ${panel.outputs.join(', ')} versus Iteration, ${rawRowCount} raw rows per series`} />
    <div ref={pointer} className="result-chart-pointer" hidden style={{
      top: chartGridTop(panel, display.length),
      bottom: chartGridBottom(panel),
    }} />
    <div ref={tooltip} className="result-chart-tooltip" hidden />
  </div>
    {panel.zoom.enabled && zoomRange !== null && <div className="result-chart-zoom-controls">
      <button className="action-button" type="button" onClick={() => {
        instance.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
        setZoomRange(null)
      }}>Reset Zoom</button>
    </div>}
  </>
}
