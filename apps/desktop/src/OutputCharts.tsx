import { useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { EChartsType } from 'echarts/core'
import type { BackgroundConfig, OutputStep, RunPageMetadata } from './workflow'
import { addBackgroundChartPanel, addChartPanel, foregroundChartNames, MAX_CHARTS, type ChartPanel } from './chartPanels'
import { createPageChartData, type ChartChangeSettings, type PageChartData } from './chartData'
import { backgroundPlotData, type BackgroundOutputData, type BackgroundChartPoint } from './backgroundChartData'
import BackgroundChartPanel, { type BackgroundChartSelections } from './BackgroundChartPanel'
import ChartPlot from './ChartPlot'
import Collapsible from './Collapsible'
import ResultChart from './ResultChart'
import { serialContinuousView, type SerialDataFormat } from './serialDisplay'

function useBackgroundOutput(runId: number | null, backgroundId: string | undefined, running: boolean) {
  const [output, setOutput] = useState<BackgroundOutputData | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setOutput(null); setError(null)
    if (runId === null || !backgroundId) return
    const query = async () => {
      try {
        const result = await invoke<BackgroundOutputData>('get_background_output', { runId, backgroundId, datasetId: null, offset: 0, limit: 0 })
        if (!cancelled) { setOutput(result); setError(null) }
      } catch (reason) { if (!cancelled) setError(String(reason)) }
      if (!cancelled && running) timer = setTimeout(() => void query(), 250)
    }
    void query()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [runId, backgroundId, running])
  return { output, error }
}

function SerialLiveMonitor({ runId, background, running }: {
  runId: number; background: BackgroundConfig; running: boolean
}) {
  const { output, error } = useBackgroundOutput(runId, background.id, running)
  const [mode, setMode] = useState<SerialDataFormat>('hex')
  const display = useMemo(() => serialContinuousView(output?.monitor ?? [], mode), [output, mode])
  const rxView = useRef<HTMLPreElement>(null)
  const followLatest = useRef(true)
  const scrollToLatest = () => {
    const element = rxView.current
    if (element) element.scrollTop = element.scrollHeight
  }
  useLayoutEffect(() => {
    followLatest.current = true
    scrollToLatest()
  }, [mode, runId, background.id])
  useLayoutEffect(() => {
    if (followLatest.current) scrollToLatest()
  }, [display])
  const handleRxScroll = (event: UIEvent<HTMLPreElement>) => {
    const element = event.currentTarget
    followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
  }
  return <Collapsible title={`Live Monitor: ${background.id}`} className="result-chart-panel">
    <section className="chart-info-summary" aria-label="Monitor info">
      <h4>Monitor info</h4>
      <dl>
        <div><dt>Sample buffer</dt><dd>Latest bounded bytes</dd></div>
        <div><dt>Capture</dt><dd>Independent</dd></div>
      </dl>
      <p className="chart-info-note">Continuous Serial RX</p>
    </section>
    <label>Display<select aria-label={`Serial Live Monitor Display ${background.id}`} value={mode}
      onChange={event => setMode(event.target.value as SerialDataFormat)}>
      <option value="hex">Hex</option><option value="text">Text (UTF-8)</option></select></label>
    {error && <p role="alert">{error}</p>}
    <pre ref={rxView} className="serial-live-monitor" aria-label={`Serial RX ${background.id}`}
      onScroll={handleRxScroll}>{display}</pre>
  </Collapsible>
}

function LiveMonitor({ runId, background, running }: { runId: number; background: BackgroundConfig; running: boolean }) {
  const { output, error } = useBackgroundOutput(runId, background.id, running)
  const charts = useRef(new Map<number, EChartsType>())
  const fields = background.scopes_measurements ?? []
  const [field, setField] = useState(fields[0]?.id ?? 'value')
  const panel = useMemo(() => addBackgroundChartPanel([], background.id, field)[0], [background.id, field])
  const empty = useMemo(createPageChartData, [])
  const samples = output?.monitor ?? []
  const bounded = useMemo(() => {
    const points: BackgroundChartPoint[] = samples.flatMap(sample => {
      const reading = field === 'value' ? null : sample.values?.[field]
      if (field !== 'value' && (!reading || !reading.valid || reading.value === null)) return []
      const value = reading?.value ?? sample.value
      if (typeof value !== 'number' || !Number.isFinite(value)) return []
      return [{ x: sample.elapsed_s, value, sample_index: sample.captured,
        timestamp_utc: sample.timestamp_utc, elapsed_s: sample.elapsed_s, unit: reading?.unit ?? sample.unit ?? '' }]
    })
    const x = points.map(point => point.x)
    return backgroundPlotData(points, x.length ? { min: Math.min(...x), max: Math.max(...x) } : null)
  }, [output, field])
  return <Collapsible title={`Live Monitor: ${background.id}`} className="result-chart-panel">
    <section className="chart-info-summary" aria-label="Monitor info">
      <h4>Monitor info</h4>
      <dl>
        <div><dt>Sample buffer</dt><dd>Latest 1,000 Worker samples</dd></div>
        <div><dt>Capture</dt><dd>Independent</dd></div>
      </dl>
    </section>
    {fields.length > 0 && <label>Measurement<select aria-label={'Live Monitor Measurement ' + background.id} value={field}
      onChange={event => setField(event.target.value)}>
      {fields.map(measurement => <option key={measurement.id} value={measurement.id}>{measurement.id}</option>)}
    </select></label>}
    {error && <p role="alert">{error}</p>}
    <ChartPlot panel={panel} data={empty} numericNames={['value']} charts={charts.current} bounded={bounded} />
  </Collapsible>
}

export function LiveMonitors({ runId, backgrounds, toolKinds, running }: {
  runId: number | null; backgrounds: BackgroundConfig[]; toolKinds: Record<string, string>; running: boolean
}) {
  const enabled = backgrounds.filter(background => background.live_monitor)
  if (runId === null || enabled.length === 0) return null
  return <Collapsible title="Live Monitors" className="live-monitors" framed>
    <div className="result-charts-grid">
      {enabled.map(background => toolKinds[background.tool_instance_id] === 'serial'
        ? <SerialLiveMonitor key={background.id} runId={runId} background={background} running={running} />
        : <LiveMonitor key={background.id} runId={runId} background={background} running={running} />)}
    </div>
  </Collapsible>
}

export default function OutputCharts({ runId, pages, metadata, backgrounds, toolKinds, panels, onPanelsChange, chartData, running,
  onSavingChange, changeSettings, fitData, saveChartsWithTemplate, onSaveChartsWithTemplateChange, selections, currentDraftBackgrounds }: {
  runId: number | null; pages: { name: string; outputs: OutputStep[] }[]; metadata: RunPageMetadata[]
  backgrounds: BackgroundConfig[]; currentDraftBackgrounds: BackgroundConfig[] | null
  toolKinds: Record<string, string>; panels: ChartPanel[]; onPanelsChange: (panels: ChartPanel[]) => void
  chartData: Map<string, PageChartData>; running: boolean; onSavingChange: (saving: boolean) => void
  changeSettings?: ChartChangeSettings | null; fitData?: boolean
  saveChartsWithTemplate: boolean; onSaveChartsWithTemplateChange: (checked: boolean) => void
  selections: BackgroundChartSelections
}) {
  const [selectedSource, setSelectedSource] = useState('')
  const [selectedGround, setSelectedGround] = useState<'foreground' | 'background' | null>(null)
  // Keep source-specific loaders mounted once, while placing every Chart in panel order.
  const [chartSlots, setChartSlots] = useState<Map<number, HTMLDivElement>>(() => new Map())
  const slotRefs = useRef(new Map<number, (node: HTMLDivElement | null) => void>())
  const slotRef = (id: number) => {
    let callback = slotRefs.current.get(id)
    if (!callback) {
      callback = (node) => {
        setChartSlots(current => {
          if (current.get(id) === node || (node === null && !current.has(id))) return current
          const next = new Map(current)
          if (node) next.set(id, node)
          else next.delete(id)
          return next
        })
      }
      slotRefs.current.set(id, callback)
    }
    return callback
  }
  const { output, error } = useBackgroundOutput(runId, backgrounds[0]?.id, running)
  const updatePanels = (next: ChartPanel[]) => {
    for (const [id, selection] of selections) {
      if (!next.some(panel => panel.id === id && panel.source?.background_id === selection.backgroundId)) selections.delete(id)
    }
    onPanelsChange(next)
  }
  const sources = [
    ...pages.map(page => ({ key: `page:${page.name}`, label: `Foreground: ${page.name}`, page,
      names: metadata.find(item => item.name === page.name)?.numeric_outputs ?? [] })),
    ...backgrounds.filter(background => toolKinds[background.tool_instance_id] !== 'serial')
      .map(background => ({ key: `background:${background.id}`, label: `Background: ${background.id}`, background })),
  ]

  const foregroundSources = sources.filter(source => 'page' in source)
  const backgroundSources = sources.filter(source => 'background' in source)
  const validBackgrounds = backgrounds.filter(background =>
    toolKinds[background.tool_instance_id] !== 'serial' &&
    (currentDraftBackgrounds === null || currentDraftBackgrounds.some(draft => draft.id === background.id)))
  const ground = selectedGround ?? (foregroundSources.length ? 'foreground'
    : backgroundSources.length ? 'background' : 'foreground')
  const availableSources = ground === 'foreground' ? foregroundSources : backgroundSources
  const selected = availableSources.find(source => source.key === selectedSource) ?? availableSources[0]
  const visiblePanels = panels.filter(panel => panel.source ? runId !== null : pages.some(page => page.name === panel.page))
  return <Collapsible title="Charts" className="result-chart" framed headingActions={<div className="result-chart-header-actions">
    <label className="result-chart-template-option"><input type="checkbox" checked={saveChartsWithTemplate}
      onChange={event => onSaveChartsWithTemplateChange(event.target.checked)} />Save charts with template</label>
    <span>Charts: {panels.length} / {MAX_CHARTS}</span>
  </div>}>
    <div className="result-chart-create">
      <h4>Chart settings</h4>
      <div className="result-chart-create-row">
        <div className="result-chart-create-fields">
          <label>Ground<select value={ground} onChange={event => {
            setSelectedGround(event.target.value as 'foreground' | 'background')
            setSelectedSource('')
          }}>
            <option value="foreground">Foreground</option>
            <option value="background">Background</option>
          </select></label>
          <label>Page<select value={selected?.key ?? ''} onChange={event => setSelectedSource(event.target.value)}
            disabled={availableSources.length === 0}>
            {availableSources.length === 0 && <option value="">No available sources</option>}
            {availableSources.map(source => <option key={source.key} value={source.key}>
              {'page' in source ? source.page.name : source.background.id}
            </option>)}
          </select></label>
        </div>
        <div className="result-chart-create-action">
          <button className="action-button" type="button"
            disabled={!selected || panels.length >= MAX_CHARTS || ('names' in selected && selected.names.length === 0)}
            onClick={() => {
              if (!selected) return
              updatePanels('background' in selected ? addBackgroundChartPanel(panels, selected.background.id, selected.background.scopes_measurements?.[0]?.id ?? 'value')
                : addChartPanel(panels, selected.page.name, selected.names))
            }}>+ Add Chart</button>
        </div>
      </div>
      <p className="result-chart-create-help">Choose Foreground or Background, then select a page or background source for the new chart.</p>
    </div>
    {panels.length >= MAX_CHARTS && <p>Maximum 8 charts.</p>}
    {panels.length === 0 && <p>No charts. Choose Ground and Page above, then Add Chart.</p>}
    {error && <p role="alert">Could not load Background datasets: {error}</p>}
    <div className="result-charts-grid">
      {visiblePanels.map(panel => <div className="result-chart-slot" key={panel.id} ref={slotRef(panel.id)}>
        {panel.source && runId !== null && <BackgroundChartPanel
          panel={panel} panels={panels} onPanelsChange={updatePanels} runId={runId}
          backgrounds={backgrounds} validBackgrounds={validBackgrounds}
          datasets={output?.datasets ?? []} running={running} selections={selections}
          onSavingChange={onSavingChange} />}
      </div>)}
    </div>
    {pages.map(page => {
      const pageMetadata = metadata.find(item => item.name === page.name)
      const numericNames = foregroundChartNames(panels, page, pageMetadata, running)
      return <ResultChart key={page.name} runId={runId} page={page.name} outputs={page.outputs}
        revision={pageMetadata?.revision ?? 0} rowCount={pageMetadata?.row_count ?? 0}
        numericNames={numericNames} timestampNames={running && (pageMetadata?.row_count ?? 0) === 0
          ? page.outputs.filter(output => output.value.source === 'timestamp').map(output => output.name)
          : pageMetadata?.timestamp_outputs ?? []}
        panels={panels} onPanelsChange={updatePanels} chartData={chartData} portalSlots={chartSlots} running={running}
        onSavingChange={onSavingChange} changeSettings={changeSettings} fitData={fitData} />
    })}
  </Collapsible>
}
