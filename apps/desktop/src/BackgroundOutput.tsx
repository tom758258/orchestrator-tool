import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { BackgroundConfig } from './workflow'
import type { BackgroundOutputData as Output } from './backgroundChartData'
import Collapsible from './Collapsible'
import { serialEventViews, type SerialDataFormat } from './serialDisplay'
import { formatNumber, type NumericDisplayFormat } from './outputTime'

type SummaryColumn = 'count' | 'min' | 'max' | 'avg' | 'valid' | 'invalid'
const summaryLabels: Record<SummaryColumn, string> = { count: 'Count', min: 'Min', max: 'Max', avg: 'Avg', valid: 'Valid', invalid: 'Invalid' }

export default function BackgroundOutput({ runId, backgrounds, running, onExportingChange, numericFormat, onNumericFormatChange }: {
  runId: number; backgrounds: BackgroundConfig[]; running: boolean
  onExportingChange?: (value: boolean) => void
  numericFormat: NumericDisplayFormat; onNumericFormatChange: (format: NumericDisplayFormat) => void
}) {
  const [background, setBackground] = useState(backgrounds[0]?.id ?? '')
  const [datasetId, setDatasetId] = useState<string | null>(null)
  const [output, setOutput] = useState<Output | null>(null)
  const [offset, setOffset] = useState(0)
  const [format, setFormat] = useState<'csv' | 'xlsx' | 'bin'>('xlsx')
  const [serialMode, setSerialMode] = useState<SerialDataFormat>('hex')
  const [scopesMode, setScopesMode] = useState<'values-only' | 'values-quality'>('values-only')
  const [all, setAll] = useState(false)
  const [rowsPerFile, setRowsPerFile] = useState('300000')
  const [exporting, setExporting] = useState(false)
  const [summaryColumns, setSummaryColumns] = useState<SummaryColumn[]>(['count', 'min', 'max', 'avg', 'valid', 'invalid'])
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
  const fields = dataset?.fields ?? []
  const serial = dataset?.tool_kind === 'serial'
  const serialViews = serialEventViews(output?.rows ?? [], serialMode, output?.text_prefix_hex ?? '')
  const hasScopesDataset = (output?.datasets ?? []).some(item => (item.fields?.length ?? 0) > 0)
  const worker = output?.workers.find(item => item.id === background)
  const selected = all ? output?.datasets.filter(item => item.status !== 'recording') ?? [] : dataset ? [dataset] : []
  const binAllowed = selected.length > 0 && selected.every(item => item.tool_kind === 'serial')
  const large = selected.some(item => item.row_count > 300000)
  const validRows = /^\d+$/.test(rowsPerFile) && Number(rowsPerFile) >= 1 && Number(rowsPerFile) <= 1048575
  const availableColumns: SummaryColumn[] = fields.length ? ['count', 'min', 'max', 'avg', 'valid', 'invalid'] : ['count', 'min', 'max', 'avg']
  const visibleColumns = availableColumns.filter(column => summaryColumns.includes(column))
  const displayStat = (value: number | null | undefined) => value == null ? '—' : formatNumber(value, numericFormat)
  const summaryValue = (column: SummaryColumn, field?: string) => {
    const stats = field ? dataset?.field_stats?.[field] : undefined
    switch (column) {
      case 'count': return field ? stats ? String(stats.valid + stats.invalid) : '—' : String(dataset?.row_count ?? 0)
      case 'valid': return stats ? String(stats.valid) : '—'
      case 'invalid': return stats ? String(stats.invalid) : '—'
      case 'min': return displayStat(field ? stats?.min : dataset?.min)
      case 'max': return displayStat(field ? stats?.max : dataset?.max)
      case 'avg': return displayStat(field ? stats?.avg : dataset?.avg)
    }
  }
  async function exportData() {
    setExporting(true); onExportingChange?.(true); setError(null); setExported([])
    try {
      const folder = await open({ directory: true, multiple: false, title: 'Export Background datasets' })
      if (typeof folder !== 'string') return
      setExported(await invoke<string[]>('export_background_datasets', { runId, datasetIds: selected.map(item => item.id),
        outputFolder: folder, format, scopesMode, serialFormat: serialMode, rowsPerFile: format !== 'xlsx' ? 300000 : Number(rowsPerFile) }))
    } catch (reason) { setError(String(reason)) }
    finally { setExporting(false); onExportingChange?.(false) }
  }
  return <Collapsible className="background-output" title="Background Output" framed>
    <div className="output-source-card">
      <h4>Source</h4>
      <label>Background
        <select value={background} disabled={exporting}
          onChange={event => { setBackground(event.target.value); setDatasetId(null); setOutput(null); setOffset(0) }}>
          {backgrounds.map(config => <option key={config.id} value={config.id}>{config.id} · {config.tool_instance_id}</option>)}
        </select>
      </label>
      <label>Capture Dataset
        <select aria-label="Background Dataset" value={datasetId ?? ''} disabled={exporting}
          onChange={event => { setDatasetId(event.target.value || null); setOutput(null); setOffset(0) }}>
          <option value="">Select Dataset</option>
          {datasets.map(item => <option key={item.id} value={item.id}>
            {item.id} · {item.row_count} {item.tool_kind === 'serial' ? 'RX events' : 'samples'} · {item.status}
          </option>)}
        </select>
      </label>
      <p className="output-source-meta" role="status">
        Worker: {worker?.state ?? 'off'}{worker?.stream_state ? ' · Source: ' + worker.stream_state : ''}
      </p>
      {worker?.error && <p role="alert">{worker.error}</p>}
    </div>
    {dataset && <>
      {!serial && <div className="numeric-display-settings">
        <label>Number display
          <select aria-label="Background Number display" value={numericFormat.mode}
            onChange={event => onNumericFormatChange({ ...numericFormat, mode: event.target.value as NumericDisplayFormat['mode'] })}>
            <option value="auto">Auto</option><option value="fixed">Fixed</option><option value="raw">Raw</option>
          </select>
        </label>
        {numericFormat.mode === 'fixed' && <label>Decimal places
          <select aria-label="Background Decimal places" value={numericFormat.decimalPlaces}
            onChange={event => onNumericFormatChange({ ...numericFormat, decimalPlaces: Number(event.target.value) })}>
            {Array.from({ length: 13 }, (_, places) => <option key={places} value={places}>{places}</option>)}
          </select>
        </label>}
      </div>}
      <Collapsible className="page-result-summary" title="Summary" actions={!serial && <details className="summary-columns">
        <summary>Columns ▾</summary>
        <div>{availableColumns.map(column => <label key={column}>
          <input type="checkbox" checked={summaryColumns.includes(column)}
            onChange={event => setSummaryColumns(current => event.target.checked
              ? [...current, column] : current.filter(key => key !== column))} />
          {summaryLabels[column]}
        </label>)}</div>
      </details>}>
        <p className="output-row-count">
          {dataset.row_count} {serial ? 'RX events' : 'samples'} · {dataset.status} · Quality: {dataset.quality}
        </p>
        <div className="output-table-scroll">
          {serial ? <table className="output-table" aria-label="Background Result Summary">
            <thead><tr><th>Metric</th><th>Value</th></tr></thead>
            <tbody>
              <tr><th scope="row">RX events</th><td>{dataset.row_count}</td></tr>
              <tr><th scope="row">Captured bytes</th><td>{dataset.rx_bytes ?? 0}</td></tr>
            </tbody>
          </table> : <table className="output-table" aria-label="Background Result Summary">
            <thead><tr><th>Output</th>{visibleColumns.map(column => <th key={column}>{summaryLabels[column]}</th>)}</tr></thead>
            <tbody>{(fields.length ? fields : ['Value']).map(field => <tr key={field}>
              <th scope="row">{field}</th>
              {visibleColumns.map(column => <td key={column}>{summaryValue(column, fields.length ? field : undefined)}</td>)}
            </tr>)}</tbody>
          </table>}
        </div>
        {dataset.csv_path && <p>Streaming CSV: {dataset.csv_path}</p>}
        {dataset.error && <p role="alert">{dataset.error}</p>}
      </Collapsible>
      <Collapsible title="Output Data" className="output-data">
        <p className="output-row-count">
          {dataset.row_count} {serial ? 'RX events' : 'samples'} · rows {dataset.row_count ? offset + 1 : 0}–{Math.min(offset + 100, dataset.row_count)} of {dataset.row_count}
        </p>
        {serial && <label>Serial Data View
          <select aria-label="Serial Data View" value={serialMode} onChange={event => setSerialMode(event.target.value as SerialDataFormat)}>
            <option value="hex">Hex</option><option value="text">Text (UTF-8)</option>
          </select>
        </label>}
        <div className="output-table-scroll"><table className="output-table background-data-table" aria-label="Background Output Data">
          <thead><tr><th>Timestamp</th><th>Elapsed (s)</th><th>{serial ? 'RX Event' : 'Sample'}</th>
            {serial ? <><th>Data</th><th>Bytes</th></> : fields.length
              ? fields.map(field => <th key={field}>{field}</th>) : <><th>Value</th><th>Unit</th></>}
          </tr></thead>
          <tbody>{output?.rows.map((sample, index) => <tr key={offset + index}>
            <td>{sample.timestamp_utc}</td><td>{sample.elapsed_s}</td><td>{sample.captured}</td>
            {serial ? <><td className="serial-rx-data">{serialViews[index]}</td><td>{sample.rx_bytes ?? 0}</td></>
              : fields.length ? fields.map(field => {
                const reading = sample.values?.[field]
                return <td key={field} title={reading?.valid === false ? reading.reason ?? 'Invalid measurement' : reading?.unit ?? ''}>
                  {reading?.valid && reading.value != null ? formatNumber(reading.value, numericFormat) : '—'}
                  {reading?.unit ? ' ' + reading.unit : ''}
                </td>
              }) : <><td>{sample.value == null ? '—' : formatNumber(sample.value, numericFormat)}</td><td>{sample.unit}</td></>}
          </tr>)}</tbody>
        </table></div>
        <div className="background-data-pagination">
          <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous</button>
          <span>Page {Math.floor(offset / 100) + 1} of {Math.max(1, Math.ceil(dataset.row_count / 100))}</span>
          <button type="button" disabled={offset + 100 >= dataset.row_count} onClick={() => setOffset(offset + 100)}>Next</button>
        </div>
      </Collapsible>
    </>}
    <div className="output-export-settings">
      <h4>Export settings</h4>
      <div className="output-export-controls">
        <label>Datasets
          <select aria-label="Export datasets" value={all ? 'all' : 'selected'} onChange={event => setAll(event.target.value === 'all')}>
            <option value="selected">Selected Dataset</option><option value="all">All Datasets</option>
          </select>
        </label>
        <label>Format
          <select aria-label="Background export format" value={format}
            onChange={event => setFormat(event.target.value as 'csv' | 'xlsx' | 'bin')}>
            <option value="csv">CSV</option><option value="xlsx">XLSX</option><option value="bin">BIN (Serial RX)</option>
          </select>
        </label>
        {hasScopesDataset && <label>Scopes export columns
          <select aria-label="Scopes export columns" value={scopesMode}
            onChange={event => setScopesMode(event.target.value as 'values-only' | 'values-quality')}>
            <option value="values-only">Values + units</option>
            <option value="values-quality">Values + units + validity + reason</option>
          </select>
        </label>}
        {format === 'xlsx' && <label>Samples per XLSX file
          <input type="number" min={1} max={1048575} step={1} value={rowsPerFile}
            onChange={event => setRowsPerFile(event.target.value)} />
        </label>}
        <button type="button" disabled={running || exporting || selected.length === 0 || (format === 'bin' && !binAllowed)
          || (format === 'xlsx' && !validRows)} onClick={() => void exportData()}>
          {exporting ? 'Exporting…' : 'Export Background'}
        </button>
      </div>
      {format === 'bin' && !binAllowed && <p role="alert">BIN requires Serial-only selected datasets.</p>}
      {format === 'xlsx' && large && <p role="status">
        More than 300,000 samples. XLSX export may take time; data will be split into files using the count above.
      </p>}
      {format === 'xlsx' && !validRows && <p role="alert">Enter 1 to 1,048,575 samples per file.</p>}
      {error && <p role="alert">{error}</p>}
      {exported.length > 0 && <p role="status">Exported: {exported.join(', ')}</p>}
    </div>
  </Collapsible>
}
