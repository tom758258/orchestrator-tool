import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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

function SourceSettingsDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => { if (element.open) element.close() }
  }, [])
  return <dialog ref={dialog} className="chart-settings-dialog source-settings-dialog"
    aria-label="Source settings" onClose={event => {
      // StrictMode effect cleanup may queue a close event before showModal reopens.
      if (!event.currentTarget.open && event.currentTarget.isConnected) onClose()
    }}>
    <div className="chart-settings-content">
      <h3>Source settings</h3>
      {children}
      <div className="chart-settings-actions">
        <button className="action-button" type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  </dialog>
}

export default function BackgroundChartPanel({ panel, panels, onPanelsChange, runId, backgrounds, validBackgrounds, datasets,
  running, selections, onSavingChange }: {
  panel: ChartPanel; panels: ChartPanel[]; onPanelsChange: (panels: ChartPanel[]) => void
  runId: number; backgrounds: BackgroundConfig[]; validBackgrounds: BackgroundConfig[]
  datasets: BackgroundDataset[]; running: boolean
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
  const [sourceSettingsOpen, setSourceSettingsOpen] = useState(false)
  const available = datasets.filter(dataset => dataset.background_id === source.background_id)
  const fields = backgrounds.find(background => background.id === source.background_id)?.scopes_measurements ?? []
  const sourceIsValid = validBackgrounds.some(background => background.id === source.background_id)
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
          query: { field: source.field, x_axis: source.x_axis, chart_type: panel.type, point_budget: 2000,
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
  }, [runId, source.background_id, source.field, source.x_axis, datasetId, panel.type, panel.showAllRawData, minimum, maximum, running, waiting])
  const bounded = useMemo(() => ({ ...backgroundPlotData(series?.points ?? [], series?.domain ?? null), onRangeChange }), [series, onRangeChange])
  return <ChartPanelView panel={panel} panels={panels} onPanelsChange={onPanelsChange} charts={charts.current}
    numericNames={['value']} running={running} hasRows={(series?.total_count ?? 0) > 0}
    rawLimit={series?.raw_limit} canExport={!waiting && !error && !!series?.returned_count && !series.raw_limit_exceeded}
    onSavingChange={onSavingChange} onSourceSettings={() => setSourceSettingsOpen(true)}>
    {sourceSettingsOpen && <SourceSettingsDialog onClose={() => setSourceSettingsOpen(false)}>
    <div className="result-chart-source-info source-settings-source">
      <strong>Data source</strong>
      <span className="result-chart-source-badge result-chart-source-background">Background</span>
      <span className="result-chart-page-badge">Source: {source.background_id}</span>
    </div>
    <p className="chart-settings-help">Choose a captured dataset and the X-axis data used by this chart. The Background source was selected when this Chart was created.</p>
    {!sourceIsValid && <>
      <p role="alert">This Background is no longer available in the current Draft or Last Run. {validBackgrounds.length
        ? 'Reassign it to a valid Background below.' : 'Remove this Chart or restore an available source for a future run.'}</p>
      {validBackgrounds.length > 0 && <label className="chart-settings-field">Reassign source
        <select value="" onChange={event => {
          const backgroundId = event.target.value
          if (!backgroundId) return
          selectDataset(null)
          onPanelsChange(panels.map(item => item.id === panel.id ? { ...item, source: { ...source,
            background_id: backgroundId, field: validBackgrounds.find(background => background.id === backgroundId)
              ?.scopes_measurements?.[0]?.id ?? 'value' } } : item))
        }}>
          <option value="">Choose an available Background</option>
          {validBackgrounds.map(background => <option key={background.id} value={background.id}>{background.id}</option>)}
        </select>
      </label>}
    </>}
    <label className="chart-settings-field">Capture Dataset<select value={datasetId ?? ''} onChange={event => selectDataset(event.target.value || null)}>
      <option value="">Waiting for captured data</option>
      {available.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.id} · {dataset.row_count} samples</option>)}
    </select></label>
    {fields.length > 0 && <label className="chart-settings-field">Measurement
      <select aria-label="Background Chart Measurement" value={source.field} onChange={event => {
        setRange(null); setSeries(null)
        onPanelsChange(panels.map(item => item.id === panel.id
          ? { ...item, source: { ...source, field: event.target.value } } : item))
      }}>
        {fields.map(field => <option key={field.id} value={field.id}>{field.id}</option>)}
      </select>
    </label>}
    <label className="chart-settings-field">X-axis data<select value={source.x_axis} onChange={event => {
      const axis = event.target.value as typeof source.x_axis
      if (axis === source.x_axis) return
      setRange(null); setSeries(null)
      onPanelsChange(panels.map(item => item.id === panel.id ? { ...item, source: { ...source, x_axis: axis },
        xAxis: { ...item.xAxis, min: null, max: null, interval: null,
          title: item.xAxis.title === backgroundAxisTitle(source.x_axis) ? backgroundAxisTitle(axis) : item.xAxis.title } } : item))
    }}><option value="elapsed">Elapsed Time</option><option value="timestamp">Timestamp</option><option value="index">Sample Index</option></select></label>
    </SourceSettingsDialog>}
    {waiting ? <p role="status">Waiting for run to finish. Only Line updates during a run.</p>
      : !datasetId ? <p role="status">Waiting for captured data.</p>
      : <>
        {error && <p role="alert">Could not prepare chart: {error}</p>}
        {series && <section className="chart-info-summary" aria-label="Data summary">
          <h4>Data summary</h4>
          <dl>
            <div><dt>Total samples</dt><dd>{series.total_count.toLocaleString()}</dd></div>
            <div><dt>In range</dt><dd>{series.visible_count.toLocaleString()}</dd></div>
            <div><dt>Plotted</dt><dd>{series.returned_count.toLocaleString()}</dd></div>
          </dl>
          {!series.raw_limit_exceeded && <p className="chart-info-note">{series.sampled
            ? 'Representative samples' : 'All visible samples plotted'}</p>}
        </section>
        {series?.raw_limit_exceeded && <p role="alert">This range contains {series.visible_count.toLocaleString()} samples; Show All Raw Data supports at most {series.raw_limit.toLocaleString()}. Narrow Zoom or turn off Show All Raw Data.</p>}
        {!series && !error && <p role="status">Preparing chart data...</p>}
        <ChartPlot key={`${runId}:${source.background_id}:${source.field}:${datasetId}:${source.x_axis}`} panel={panel} data={EMPTY_DATA}
          numericNames={['value']} charts={charts.current} bounded={bounded} />
      </>}
  </ChartPanelView>
}
