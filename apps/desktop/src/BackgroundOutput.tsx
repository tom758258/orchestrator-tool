import { enumLabel } from './i18n/presentation'
import { useI18n } from './i18n/I18nProvider'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { BackgroundConfig } from './workflow'
import type { BackgroundOutputData as Output } from './backgroundChartData'
import Collapsible from './Collapsible'
import { serialEventViews, type SerialDataFormat } from './serialDisplay'
import { formatNumber, type NumericDisplayFormat } from './outputTime'

type SummaryColumn = 'count' | 'min' | 'max' | 'avg' | 'valid' | 'invalid'


export default function BackgroundOutput({ runId, backgrounds, running, onExportingChange, numericFormat, onNumericFormatChange }: {
  runId: number; backgrounds: BackgroundConfig[]; running: boolean
  onExportingChange?: (value: boolean) => void
  numericFormat: NumericDisplayFormat; onNumericFormatChange: (format: NumericDisplayFormat) => void
}) {
  const { t } = useI18n()
  const summaryLabels: Record<SummaryColumn, string> = { count: t("backgroundOutput.count"), min: t("backgroundOutput.min"), max: t("backgroundOutput.max"), avg: t("backgroundOutput.avg"), valid: t("backgroundOutput.valid"), invalid: t("backgroundOutput.invalid") }

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
      const folder = await open({ directory: true, multiple: false, title: t("backgroundOutput.exportBackgroundDatasets") })
      if (typeof folder !== 'string') return
      setExported(await invoke<string[]>('export_background_datasets', { runId, datasetIds: selected.map(item => item.id),
        outputFolder: folder, format, scopesMode, serialFormat: serialMode, rowsPerFile: format !== 'xlsx' ? 300000 : Number(rowsPerFile) }))
    } catch (reason) { setError(String(reason)) }
    finally { setExporting(false); onExportingChange?.(false) }
  }
  return <Collapsible className="background-output" title={t("backgroundOutput.backgroundOutput")} framed>
    <div className="output-source-card">
      <h4>{t("backgroundOutput.source")}</h4>
      <div className="output-source-fields">
        <label>{t("backgroundOutput.background")}<select value={background} disabled={exporting}
            onChange={event => { setBackground(event.target.value); setDatasetId(null); setOutput(null); setOffset(0) }}>
            {backgrounds.map(config => <option key={config.id} value={config.id}>{config.id} · {config.tool_instance_id}</option>)}
          </select>
        </label>
        <label>{t("backgroundOutput.captureDataset")}<select aria-label={t("backgroundOutput.backgroundDataset")} value={datasetId ?? ''} disabled={exporting}
            onChange={event => { setDatasetId(event.target.value || null); setOutput(null); setOffset(0) }}>
            <option value="">{t("backgroundOutput.selectDataset")}</option>
            {datasets.map(item => <option key={item.id} value={item.id}>
              {item.id} · {item.row_count} {item.tool_kind === 'serial' ? t("backgroundOutput.rXEvents") : t("backgroundOutput.samples")} · {enumLabel(t, 'status', item.status)}
            </option>)}
          </select>
        </label>
      </div>
      <p className="output-source-help">{t("backgroundOutput.selectABackgroundAndCaptureDatasetFromThisRun")}</p>
      <p className="output-source-meta" role="status">
        {t("backgroundOutput.worker")}{enumLabel(t, 'status', worker?.state ?? 'off')}{worker?.stream_state ? t("backgroundOutput.source2") + enumLabel(t, 'status', worker.stream_state) : ''}
      </p>
      {worker?.error && <p role="alert">{worker.error}</p>}
    </div>
    {dataset && <>
      {!serial && <div className="numeric-display-settings">
        <label>{t("backgroundOutput.numberDisplay")}<select aria-label={t("backgroundOutput.backgroundNumberDisplay")} value={numericFormat.mode}
            onChange={event => onNumericFormatChange({ ...numericFormat, mode: event.target.value as NumericDisplayFormat['mode'] })}>
            <option value="auto">{t("backgroundOutput.auto")}</option><option value="fixed">{t("backgroundOutput.fixed")}</option><option value="raw">{t("backgroundOutput.raw")}</option>
          </select>
        </label>
        {numericFormat.mode === 'fixed' && <label>{t("backgroundOutput.decimalPlaces")}<select aria-label={t("backgroundOutput.backgroundDecimalPlaces")} value={numericFormat.decimalPlaces}
            onChange={event => onNumericFormatChange({ ...numericFormat, decimalPlaces: Number(event.target.value) })}>
            {Array.from({ length: 13 }, (_, places) => <option key={places} value={places}>{places}</option>)}
          </select>
        </label>}
      </div>}
      <Collapsible className="page-result-summary" title={t("backgroundOutput.summary")} actions={!serial && <details className="summary-columns">
        <summary>{t("backgroundOutput.columns")}</summary>
        <div>{availableColumns.map(column => <label key={column}>
          <input type="checkbox" checked={summaryColumns.includes(column)}
            onChange={event => setSummaryColumns(current => event.target.checked
              ? [...current, column] : current.filter(key => key !== column))} />
          {summaryLabels[column]}
        </label>)}</div>
      </details>}>
        <p className="output-row-count">
          {dataset.row_count} {serial ? t("backgroundOutput.rXEvents") : t("backgroundOutput.samples")} · {enumLabel(t, 'status', dataset.status)} {t("backgroundOutput.quality")}{enumLabel(t, 'status', dataset.quality)}
        </p>
        <div className="output-table-scroll">
          {serial ? <table className="output-table" aria-label={t("backgroundOutput.backgroundResultSummary")}>
            <thead><tr><th>{t("backgroundOutput.metric")}</th><th>{t("backgroundOutput.value")}</th></tr></thead>
            <tbody>
              <tr><th scope="row">{t("backgroundOutput.rXEvents")}</th><td>{dataset.row_count}</td></tr>
              <tr><th scope="row">{t("backgroundOutput.capturedBytes")}</th><td>{dataset.rx_bytes ?? 0}</td></tr>
            </tbody>
          </table> : <table className="output-table" aria-label={t("backgroundOutput.backgroundResultSummary")}>
            <thead><tr><th>{t("backgroundOutput.output")}</th>{visibleColumns.map(column => <th key={column}>{summaryLabels[column]}</th>)}</tr></thead>
            <tbody>{(fields.length ? fields : [t("backgroundOutput.value")]).map(field => <tr key={field}>
              <th scope="row">{field}</th>
              {visibleColumns.map(column => <td key={column}>{summaryValue(column, fields.length ? field : undefined)}</td>)}
            </tr>)}</tbody>
          </table>}
        </div>
        {dataset.csv_path && <p>{t("backgroundOutput.streamingCSV")}{dataset.csv_path}</p>}
        {dataset.error && <p role="alert">{dataset.error}</p>}
      </Collapsible>
      <Collapsible title={t("backgroundOutput.outputData")} className="output-data">
        <p className="output-row-count">
          {dataset.row_count} {serial ? t("backgroundOutput.rXEvents") : t("backgroundOutput.samples")} {t("backgroundOutput.rows")}{dataset.row_count ? offset + 1 : 0}–{Math.min(offset + 100, dataset.row_count)} {t("backgroundOutput.of")}{dataset.row_count}
        </p>
        {serial && <label>{t("backgroundOutput.serialDataView")}<select aria-label={t("backgroundOutput.serialDataView")} value={serialMode} onChange={event => setSerialMode(event.target.value as SerialDataFormat)}>
            <option value="hex">{t("backgroundOutput.hex")}</option><option value="text">{t("backgroundOutput.textUTF8")}</option>
          </select>
        </label>}
        <div className="output-table-scroll"><table className="output-table background-data-table" aria-label={t("backgroundOutput.backgroundOutputData")}>
          <thead><tr><th>{t("backgroundOutput.timestamp")}</th><th>{t("backgroundOutput.elapsedS")}</th><th>{serial ? t("backgroundOutput.rXEvent") : t("backgroundOutput.sample")}</th>
            {serial ? <><th>{t("backgroundOutput.data")}</th><th>{t("backgroundOutput.bytes")}</th></> : fields.length
              ? fields.map(field => <th key={field}>{field}</th>) : <><th>{t("backgroundOutput.value")}</th><th>{t("backgroundOutput.unit")}</th></>}
          </tr></thead>
          <tbody>{output?.rows.map((sample, index) => <tr key={offset + index}>
            <td>{sample.timestamp_utc}</td><td>{sample.elapsed_s}</td><td>{sample.captured}</td>
            {serial ? <><td className="serial-rx-data">{serialViews[index]}</td><td>{sample.rx_bytes ?? 0}</td></>
              : fields.length ? fields.map(field => {
                const reading = sample.values?.[field]
                return <td key={field} title={reading?.valid === false ? reading.reason ?? t("backgroundOutput.invalidMeasurement") : reading?.unit ?? ''}>
                  {reading?.valid && reading.value != null ? formatNumber(reading.value, numericFormat) : '—'}
                  {reading?.unit ? ' ' + reading.unit : ''}
                </td>
              }) : <><td>{sample.value == null ? '—' : formatNumber(sample.value, numericFormat)}</td><td>{sample.unit}</td></>}
          </tr>)}</tbody>
        </table></div>
        {dataset.row_count > 100 && <div className="background-data-pagination">
          <button className="action-button" type="button" disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 100))}>{t("backgroundOutput.previous")}</button>
          <span>{t("backgroundOutput.page")}{Math.floor(offset / 100) + 1} {t("backgroundOutput.of")}{Math.ceil(dataset.row_count / 100)}</span>
          <button className="action-button" type="button" disabled={offset + 100 >= dataset.row_count}
            onClick={() => setOffset(offset + 100)}>{t("backgroundOutput.next")}</button>
        </div>}
      </Collapsible>
    </>}
    <div className="output-export-settings">
      <h4>{t("backgroundOutput.exportSettings")}</h4>
      <div className="output-export-controls">
        <label>{t("backgroundOutput.datasets")}<select aria-label={t("backgroundOutput.exportDatasets")} value={all ? 'all' : 'selected'} onChange={event => setAll(event.target.value === 'all')}>
            <option value="selected">{t("backgroundOutput.selectedDataset")}</option><option value="all">{t("backgroundOutput.allDatasets")}</option>
          </select>
        </label>
        <label>{t("backgroundOutput.format")}<select aria-label={t("backgroundOutput.backgroundExportFormat")} value={format}
            onChange={event => setFormat(event.target.value as 'csv' | 'xlsx' | 'bin')}>
            <option value="csv">{t("backgroundOutput.cSV")}</option><option value="xlsx">{t("backgroundOutput.xLSX")}</option><option value="bin">{t("backgroundOutput.bINSerialRX")}</option>
          </select>
        </label>
        {hasScopesDataset && <label>{t("backgroundOutput.scopesExportColumns")}<select aria-label={t("backgroundOutput.scopesExportColumns")} value={scopesMode}
            onChange={event => setScopesMode(event.target.value as 'values-only' | 'values-quality')}>
            <option value="values-only">{t("backgroundOutput.valuesUnits")}</option>
            <option value="values-quality">{t("backgroundOutput.valuesUnitsValidityReason")}</option>
          </select>
        </label>}
        {format === 'xlsx' && <label>{t("backgroundOutput.samplesPerXLSXFile")}<input type="number" min={1} max={1048575} step={1} value={rowsPerFile}
            onChange={event => setRowsPerFile(event.target.value)} />
        </label>}
        <button className="action-button" type="button" disabled={running || exporting || selected.length === 0 || (format === 'bin' && !binAllowed)
          || (format === 'xlsx' && !validRows)} onClick={() => void exportData()}>
          {exporting ? t("backgroundOutput.exporting") : t("backgroundOutput.export", { value1: format.toUpperCase() })}
        </button>
      </div>
      <p className="output-export-help">{t("backgroundOutput.exportTheSelectedOrAllDatasetsChooseADestination")}</p>
      {format === 'bin' && !binAllowed && <p role="alert">{t("backgroundOutput.bINRequiresSerialOnlySelectedDatasets")}</p>}
      {format === 'xlsx' && large && <p role="status">
        {t("backgroundOutput.moreThan300000SamplesXLSXExportMayTake")}</p>}
      {format === 'xlsx' && !validRows && <p role="alert">{t("backgroundOutput.enter1To1048575SamplesPerFile")}</p>}
      {error && <p role="alert">{error}</p>}
      {exported.length > 0 && <p role="status">{t("backgroundOutput.exported")}{exported.join(', ')}</p>}
    </div>
  </Collapsible>
}
