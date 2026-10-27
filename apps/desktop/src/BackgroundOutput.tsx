import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { init, use, type EChartsType } from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, DataZoomComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { BackgroundConfig } from './workflow'

use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer])
type Sample = { timestamp_utc: string; elapsed_s: number; captured: number; value: number; unit: string }
type Dataset = { id: string; background_id: string; worker_run_id: string; status: string; quality: string; row_count: number;
  min: number | null; max: number | null; avg: number | null; csv_path: string | null; error: string | null }
type Output = { datasets: Dataset[]; workers: { id: string; state: string; stream_state: string | null; live_monitor: boolean; error: string | null }[];
  rows: Sample[]; chart: Sample[]; monitor: Sample[] }
type XAxis = 'elapsed' | 'timestamp' | 'index'

function BackgroundLine({ samples, xAxis, label }: { samples: Sample[]; xAxis: XAxis; label: string }) {
  const element = useRef<HTMLDivElement>(null)
  const instance = useRef<EChartsType | null>(null)
  useEffect(() => {
    if (!element.current) return
    const chart = init(element.current)
    instance.current = chart
    const textColor = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()
    chart.setOption({ animation: false, grid: { left: 70, right: 25, bottom: 70 },
      tooltip: { trigger: 'axis' }, textStyle: { color: textColor },
      dataZoom: [{ type: 'inside' }, { type: 'slider' }] })
    const resize = new ResizeObserver(() => chart.resize())
    resize.observe(element.current)
    return () => { resize.disconnect(); chart.dispose(); instance.current = null }
  }, [])
  useEffect(() => {
    instance.current?.setOption({
      xAxis: { type: xAxis === 'timestamp' ? 'time' : 'value', name: xAxis === 'elapsed' ? 'Elapsed time (s)' : xAxis === 'timestamp' ? 'Timestamp' : 'Sample index' },
      yAxis: { type: 'value', scale: true, name: samples[0]?.unit ?? '' },
      series: [{ type: 'line', showSymbol: false, connectNulls: false,
        data: samples.map(sample => [xAxis === 'timestamp' ? Date.parse(sample.timestamp_utc) : xAxis === 'elapsed' ? sample.elapsed_s : sample.captured, sample.value]) }] })
  }, [samples, xAxis])
  return <div ref={element} role="img" aria-label={label} style={{ width: '100%', height: 280 }} />
}

export default function BackgroundOutput({ runId, backgrounds, running, onChartChange, onExportingChange }: { runId: number; backgrounds: BackgroundConfig[]; running: boolean;
  onChartChange?: (id: string, chart: NonNullable<BackgroundConfig['chart']>) => boolean; onExportingChange?: (value: boolean) => void }) {
  const [background, setBackground] = useState(backgrounds[0]?.id ?? '')
  const [datasetId, setDatasetId] = useState<string | null>(null)
  const [output, setOutput] = useState<Output | null>(null)
  const [offset, setOffset] = useState(0)
  const [axes, setAxes] = useState<Record<string, XAxis>>(() => Object.fromEntries(
    backgrounds.map(config => [config.id, config.chart?.x_axis ?? 'elapsed'])))
  const xAxis = axes[background] ?? 'elapsed'
  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx')
  const [all, setAll] = useState(false)
  const [rowsPerFile, setRowsPerFile] = useState('300000')
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exported, setExported] = useState<string[]>([])
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const query = async () => {
      try {
        const result = await invoke<Output>('get_background_output', { runId, backgroundId: background, datasetId, offset, limit: 100 })
        if (disposed) return
        setOutput(result)
        setError(null)
        if (datasetId === null) setDatasetId(result.datasets.filter(dataset => dataset.background_id === background).at(-1)?.id ?? null)
      } catch (reason) { if (!disposed) setError(String(reason)) }
      if (!disposed && running) timer = setTimeout(() => void query(), 250)
    }
    void query()
    return () => { disposed = true; clearTimeout(timer) }
  }, [runId, background, datasetId, offset, running])
  const datasets = output?.datasets.filter(dataset => dataset.background_id === background) ?? []
  const dataset = datasets.find(item => item.id === datasetId)
  const worker = output?.workers.find(item => item.id === background)
  const selected = all ? output?.datasets.filter(item => item.status !== 'recording') ?? [] : dataset ? [dataset] : []
  const large = selected.some(item => item.row_count > 300000)
  const validRows = /^\d+$/.test(rowsPerFile) && Number(rowsPerFile) >= 1 && Number(rowsPerFile) <= 1048575
  async function exportData() {
    setExporting(true); onExportingChange?.(true); setError(null); setExported([])
    try {
      const folder = await open({ directory: true, multiple: false, title: 'Export Background datasets' })
      if (typeof folder !== 'string') return
      setExported(await invoke<string[]>('export_background_datasets', { runId, datasetIds: selected.map(item => item.id),
        outputFolder: folder, format, rowsPerFile: format === 'csv' ? 300000 : Number(rowsPerFile) }))
    } catch (reason) { setError(String(reason)) }
    finally { setExporting(false); onExportingChange?.(false) }
  }
  return <section className="background-output" aria-label="Background Results">
    <h3>Background Results</h3>
    <label>Background<select value={background} disabled={exporting} onChange={event => { setBackground(event.target.value); setDatasetId(null); setOutput(null); setOffset(0) }}>
      {backgrounds.map(config => <option key={config.id} value={config.id}>{config.id} · {config.tool_instance_id}</option>)}
    </select></label>
    <p role="status">Worker: {worker?.state ?? 'off'}{worker?.stream_state ? ` · Source: ${worker.stream_state}` : ''}</p>
    {worker?.error && <p role="alert">{worker.error}</p>}
    <label>Capture Dataset<select aria-label="Background Dataset" value={datasetId ?? ''} disabled={exporting} onChange={event => { setDatasetId(event.target.value || null); setOffset(0) }}>
      <option value="">Select Dataset</option>{datasets.map(item => <option key={item.id} value={item.id}>{item.id} · {item.row_count} samples · {item.status}</option>)}
    </select></label>
    <section><h4>Charts</h4>
      <label>X axis<select value={xAxis} onChange={event => {
        const x_axis = event.target.value as XAxis
        if (onChartChange?.(background, { x_axis }) === false) { setError('Maximum 8 charts.'); return }
        setError(null)
        setAxes(current => ({ ...current, [background]: x_axis }))
      }}>
        <option value="elapsed">Elapsed Time</option><option value="timestamp">Timestamp</option><option value="index">Sample Index</option>
      </select></label>
      {dataset ? <><p>Captured Dataset · Line · up to 2,000 representative points</p>
        <BackgroundLine samples={output?.chart ?? []} xAxis={xAxis} label="Background Dataset Line" /></> : <p>No captured Dataset selected.</p>}
    </section>
    {backgrounds.find(config => config.id === background)?.live_monitor && <section aria-label="Live Monitor"><h4>Live Monitor</h4>
      <p>Latest 1,000 Worker samples · Line · independent of Capture</p>
      <BackgroundLine samples={output?.monitor ?? []} xAxis="elapsed" label="Background Live Monitor Line" />
    </section>}
    {dataset && <>
      <section><h4>Summary</h4><p>{dataset.row_count} samples · {dataset.status} · Quality: {dataset.quality}</p>
        <dl><dt>Minimum</dt><dd>{dataset.min ?? '—'}</dd><dt>Maximum</dt><dd>{dataset.max ?? '—'}</dd><dt>Average</dt><dd>{dataset.avg ?? '—'}</dd></dl>
        {dataset.csv_path && <p>Streaming CSV: {dataset.csv_path}</p>}{dataset.error && <p role="alert">{dataset.error}</p>}
      </section>
      <section><h4>Output Data</h4><p>{dataset.row_count} samples · rows {offset+1}–{Math.min(offset+100,dataset.row_count)}</p>
        <div className="output-table-scroll"><table><thead><tr><th>Timestamp</th><th>Elapsed (s)</th><th>Sample</th><th>Value</th><th>Unit</th></tr></thead>
          <tbody>{output?.rows.map((sample,index) => <tr key={offset+index}><td>{sample.timestamp_utc}</td><td>{sample.elapsed_s}</td><td>{sample.captured}</td><td>{sample.value}</td><td>{sample.unit}</td></tr>)}</tbody>
        </table></div>
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0,offset-100))}>Previous</button>
        <button type="button" disabled={offset+100 >= dataset.row_count} onClick={() => setOffset(offset+100)}>Next</button>
      </section>
    </>}
    <label>Export datasets<select value={all ? 'all' : 'selected'} onChange={event => setAll(event.target.value === 'all')}>
      <option value="selected">Selected Dataset</option><option value="all">All Datasets</option></select></label>
    <label>Background export format<select value={format} onChange={event => setFormat(event.target.value as 'csv' | 'xlsx')}><option value="csv">CSV</option><option value="xlsx">XLSX</option></select></label>
    {format === 'xlsx' && <><label>Samples per XLSX file<input type="number" min={1} max={1048575} step={1} value={rowsPerFile} onChange={event => setRowsPerFile(event.target.value)} /></label>
      {large && <p role="status">More than 300,000 samples. XLSX export may take time; data will be split into files using the count above.</p>}
      {!validRows && <p role="alert">Enter 1 to 1,048,575 samples per file.</p>}</>}
    <button type="button" disabled={running || exporting || selected.length === 0 || (format === 'xlsx' && !validRows)} onClick={() => void exportData()}>{exporting ? 'Exporting…' : 'Export Background'}</button>
    {error && <p role="alert">{error}</p>}{exported.length > 0 && <p role="status">Exported: {exported.join(', ')}</p>}
  </section>
}
