import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { EChartsType } from 'echarts/core'
import ChartPlot from './ChartPlot'
import ChartPanelView from './ChartPanelView'
import { createPageChartData } from './chartData'
import { backgroundAxisTitle, chartSupportsZoom, type ChartPanel } from './chartPanels'
import type { BackgroundConfig } from './workflow'
import { backgroundPlotData, type BackgroundChartSeries, type BackgroundDataset } from './backgroundChartData'

const EMPTY_DATA = createPageChartData()
type Selection = { backgroundId: string; datasetId: string }
export type BackgroundChartSelections = Map<number, Selection>

export default function BackgroundChartData({ panel, panels, onPanelsChange, runId, backgrounds, datasets,
  running, selections, onSavingChange }: {
  panel: ChartPanel; panels: ChartPanel[]; onPanelsChange: (panels: ChartPanel[]) => void
  runId: number; backgrounds: BackgroundConfig[]; datasets: BackgroundDataset[]; running: boolean
  selections: BackgroundChartSelections; onSavingChange: (saving: boolean) => void
}) {
  const source = panel.source!
  const charts = useRef(new Map<number, EChartsType>())
  const pendingQuery = useRef<Promise<BackgroundChartSeries> | null>(null)
  const [datasetId, setDatasetId] = useState(() => {
    const selected = selections.get(panel.id)
    return selected?.backgroundId === source.background_id ? selected.datasetId : null
  })
  const [range, setRange] = useState<{ min: number; max: number } | null>(null)
  const [series, setSeries] = useState<BackgroundChartSeries | null>(null)
  const [error, setError] = useState<string | null>(null)
  const available = datasets.filter(dataset => dataset.background_id === source.background_id)
  const waiting = running && panel.type !== 'line'
  const onRangeChange = useCallback((next: { min: number; max: number } | null) => {
    setRange(current => current?.min === next?.min && current?.max === next?.max ? current : next)
  }, [])
  function selectDataset(id: string | null) {
    if (id === datasetId) return
    setDatasetId(id); setSeries(null); setRange(null)
    if (id) selections.set(panel.id, { backgroundId: source.background_id, datasetId: id })
    else selections.delete(panel.id)
  }
  useEffect(() => {
    if (datasetId === null && available.length > 0) selectDataset(available.at(-1)!.id)
  }, [datasetId, datasets, source.background_id])
  const minimum = (chartSupportsZoom(panel.type) ? range?.min : undefined) ?? panel.xAxis.min
  const maximum = (chartSupportsZoom(panel.type) ? range?.max : undefined) ?? panel.xAxis.max
  // Backend validates a finite query. Open bounds are represented by finite numeric extremes.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setSeries(current => current ? { ...current, points: [], returned_count: 0, raw_limit_exceeded: false } : null); setError(null)
    if (!datasetId || waiting) return
    const query = async () => {
      try {
        // Let an older request finish before asking for the latest viewport.
        // Rapid Zoom changes must not queue obsolete scans behind other Charts.
        await pendingQuery.current?.catch(() => undefined)
        if (cancelled) return
        const request = invoke<BackgroundChartSeries>('get_background_chart_series', {
          runId, backgroundId: source.background_id, datasetId,
          query: { x_axis: source.x_axis, chart_type: panel.type, point_budget: 2000,
            raw: panel.type === 'line' && panel.showAllRawData,
            range: minimum === null && maximum === null ? null : { min: minimum ?? -Number.MAX_VALUE, max: maximum ?? Number.MAX_VALUE } },
        })
        pendingQuery.current = request
        const result = await request
        if (cancelled) return
        setSeries(result); setError(null)
      } catch (reason) { if (!cancelled) { setSeries(null); setError(String(reason)) } }
      if (!cancelled && running) timer = setTimeout(() => void query(), 250)
    }
    void query()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [runId, source.background_id, source.x_axis, datasetId, panel.type, panel.showAllRawData, minimum, maximum, running, waiting])
  const bounded = useMemo(() => ({ ...backgroundPlotData(series?.points ?? [], series?.domain ?? null), onRangeChange }), [series, onRangeChange])
  return <ChartPanelView panel={panel} panels={panels} onPanelsChange={onPanelsChange} charts={charts.current}
    numericNames={['value']} running={running} hasRows={(series?.total_count ?? 0) > 0}
    rawLimit={series?.raw_limit} canExport={!waiting && !error && !!series?.returned_count && !series.raw_limit_exceeded}
    onSavingChange={onSavingChange}>
    <div className="result-chart-sources">
    <label>Background<select value={source.background_id} onChange={event => {
      if (event.target.value === source.background_id) return
      selectDataset(null)
      onPanelsChange(panels.map(item => item.id === panel.id ? { ...item, source: { ...source, background_id: event.target.value } } : item))
    }}>
      {!backgrounds.some(background => background.id === source.background_id) && <option value={source.background_id}>{source.background_id} (unavailable in this run)</option>}
      {backgrounds.map(background => <option key={background.id} value={background.id}>{background.id}</option>)}
    </select></label>
    <label>Capture Dataset<select value={datasetId ?? ''} onChange={event => selectDataset(event.target.value || null)}>
      <option value="">Waiting for captured data</option>
      {available.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.id} · {dataset.row_count} samples</option>)}
    </select></label>
    <label>X axis<select value={source.x_axis} onChange={event => {
      const axis = event.target.value as typeof source.x_axis
      if (axis === source.x_axis) return
      setRange(null); setSeries(null)
      onPanelsChange(panels.map(item => item.id === panel.id ? { ...item, source: { ...source, x_axis: axis },
        xAxis: { ...item.xAxis, min: null, max: null, interval: null,
          title: item.xAxis.title === backgroundAxisTitle(source.x_axis) ? backgroundAxisTitle(axis) : item.xAxis.title } } : item))
    }}><option value="elapsed">Elapsed Time</option><option value="timestamp">Timestamp</option><option value="index">Sample Index</option></select></label>
    </div>
    {waiting ? <p role="status">Waiting for run to finish. Only Line updates during a run.</p>
      : !datasetId ? <p role="status">Waiting for captured data.</p>
      : <>
        {error && <p role="alert">Could not prepare chart: {error}</p>}
        {series && <p>{series.total_count.toLocaleString()} dataset samples · {series.visible_count.toLocaleString()} in visible range · {series.returned_count.toLocaleString()} displayed{series.sampled ? ' · Representative samples' : series.raw_limit_exceeded ? '' : ' · All samples in range'}</p>}
        {series?.raw_limit_exceeded && <p role="alert">This range contains {series.visible_count.toLocaleString()} samples; Show All Raw Data supports at most {series.raw_limit.toLocaleString()}. Narrow Zoom or turn off Show All Raw Data.</p>}
        {!series && !error && <p role="status">Preparing chart data...</p>}
        <ChartPlot key={`${runId}:${source.background_id}:${datasetId}:${source.x_axis}`} panel={panel} data={EMPTY_DATA}
          numericNames={['value']} charts={charts.current} bounded={bounded} />
      </>}
  </ChartPanelView>
}
