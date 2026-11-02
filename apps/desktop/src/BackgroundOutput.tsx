import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { BackgroundConfig } from './workflow'
import type { BackgroundOutputData as Output } from './backgroundChartData'
import Collapsible from './Collapsible'
import { serialEventViews, type SerialDataFormat } from './serialDisplay'

export default function BackgroundOutput({ runId, backgrounds, running, onExportingChange }: { runId: number; backgrounds: BackgroundConfig[]; running: boolean;
  onExportingChange?: (value: boolean) => void }) {
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
  return <Collapsible className="background-output" title="Background Output">
    <label>Background<select value={background} disabled={exporting} onChange={event => { setBackground(event.target.value); setDatasetId(null); setOutput(null); setOffset(0) }}>
      {backgrounds.map(config => <option key={config.id} value={config.id}>{config.id} · {config.tool_instance_id}</option>)}
    </select></label>
    <p role="status">Worker: {worker?.state ?? 'off'}{worker?.stream_state ? ` · Source: ${worker.stream_state}` : ''}</p>
    {worker?.error && <p role="alert">{worker.error}</p>}
    <label>Capture Dataset<select aria-label="Background Dataset" value={datasetId ?? ''} disabled={exporting} onChange={event => { setDatasetId(event.target.value || null); setOffset(0) }}>
      <option value="">Select Dataset</option>{datasets.map(item => <option key={item.id} value={item.id}>{item.id} · {item.row_count} {item.tool_kind === 'serial' ? 'RX events' : 'samples'} · {item.status}</option>)}
    </select></label>
    {dataset && <>
      <Collapsible title="Summary"><p>{dataset.row_count} {serial ? 'RX events' : 'samples'} · {dataset.status} · Quality: {dataset.quality}</p>
        {serial && <p>Captured bytes: {dataset.rx_bytes ?? 0}</p>}
        {serial ? null : fields.length ? <dl>{fields.map(field => {
          const stats = dataset.field_stats?.[field]
          return <div key={field}><dt>{field} · Valid {stats?.valid ?? 0} · Invalid {stats?.invalid ?? 0}</dt>
            <dd>Min {stats?.min ?? '—'} · Max {stats?.max ?? '—'} · Avg {stats?.avg ?? '—'}</dd></div>
        })}</dl> : <dl><dt>Minimum</dt><dd>{dataset.min ?? '—'}</dd><dt>Maximum</dt><dd>{dataset.max ?? '—'}</dd><dt>Average</dt><dd>{dataset.avg ?? '—'}</dd></dl>}
        {dataset.csv_path && <p>Streaming CSV: {dataset.csv_path}</p>}{dataset.error && <p role="alert">{dataset.error}</p>}
      </Collapsible>
      <Collapsible title="Output Data"><p>{dataset.row_count} {serial ? 'RX events' : 'samples'} · rows {offset+1}–{Math.min(offset+100,dataset.row_count)}</p>
        {serial && <label>Serial Data View<select aria-label="Serial Data View" value={serialMode} onChange={e => setSerialMode(e.target.value as SerialDataFormat)}>
          <option value="hex">Hex</option><option value="text">Text (UTF-8)</option></select></label>}
        <div className="output-table-scroll"><table><thead><tr><th>Timestamp</th><th>Elapsed (s)</th><th>Sample</th>
          {serial ? <><th>Data</th><th>Bytes</th></> : fields.length ? fields.map(field => <th key={field}>{field}</th>) : <><th>Value</th><th>Unit</th></>}
          </tr></thead>
          <tbody>{output?.rows.map((sample,index) => <tr key={offset+index}>
            <td>{sample.timestamp_utc}</td><td>{sample.elapsed_s}</td><td>{sample.captured}</td>
            {serial ? <><td className="serial-rx-data">{serialViews[index]}</td><td>{sample.rx_bytes ?? 0}</td></> : fields.length ? fields.map(field => {
              const reading = sample.values?.[field]
              return <td key={field} title={reading?.valid === false ? reading.reason ?? 'Invalid measurement' : reading?.unit ?? ''}>
                {reading?.valid && reading.value != null ? reading.value : '—'}{reading?.unit ? ' ' + reading.unit : ''}
              </td>
            }) : <><td>{sample.value}</td><td>{sample.unit}</td></>}
          </tr>)}</tbody>
        </table></div>
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0,offset-100))}>Previous</button>
        <button type="button" disabled={offset+100 >= dataset.row_count} onClick={() => setOffset(offset+100)}>Next</button>
      </Collapsible>
    </>}
    {hasScopesDataset && <label>Scopes export columns<select aria-label="Scopes export columns" value={scopesMode}
      onChange={event => setScopesMode(event.target.value as 'values-only' | 'values-quality')}>
      <option value="values-only">Values + units</option>
      <option value="values-quality">Values + units + validity + reason</option>
    </select></label>}
    <label>Export datasets<select value={all ? 'all' : 'selected'} onChange={event => setAll(event.target.value === 'all')}>
      <option value="selected">Selected Dataset</option><option value="all">All Datasets</option></select></label>
    <label>Background export format<select value={format} onChange={event => setFormat(event.target.value as 'csv' | 'xlsx' | 'bin')}><option value="csv">CSV</option><option value="xlsx">XLSX</option><option value="bin">BIN (Serial RX)</option></select></label>
    {format === 'bin' && !binAllowed && <p role="alert">BIN requires Serial-only selected datasets.</p>}
    {format === 'xlsx' && <><label>Samples per XLSX file<input type="number" min={1} max={1048575} step={1} value={rowsPerFile} onChange={event => setRowsPerFile(event.target.value)} /></label>
      {large && <p role="status">More than 300,000 samples. XLSX export may take time; data will be split into files using the count above.</p>}
      {!validRows && <p role="alert">Enter 1 to 1,048,575 samples per file.</p>}</>}
    <button type="button" disabled={running || exporting || selected.length === 0 || (format === 'bin' && !binAllowed) || (format === 'xlsx' && !validRows)} onClick={() => void exportData()}>{exporting ? 'Exporting…' : 'Export Background'}</button>
    {error && <p role="alert">{error}</p>}{exported.length > 0 && <p role="status">Exported: {exported.join(', ')}</p>}
  </Collapsible>
}
