import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { EChartsType } from 'echarts/core'
import type { BackgroundConfig, OutputStep, RunPageMetadata } from './workflow'
import { addBackgroundChartPanel, addChartPanel, foregroundChartNames, MAX_CHARTS, type ChartPanel } from './chartPanels'
import { createPageChartData, type ChartChangeSettings, type PageChartData } from './chartData'
import { backgroundPlotData, type BackgroundOutputData } from './backgroundChartData'
import BackgroundChartData, { type BackgroundChartSelections } from './BackgroundChartData'
import ChartPlot from './ChartPlot'
import Collapsible from './Collapsible'
import ResultChart from './ResultChart'

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

function LiveMonitor({ runId, background, running }: { runId: number; background: BackgroundConfig; running: boolean }) {
  const { output, error } = useBackgroundOutput(runId, background.id, running)
  const charts = useRef(new Map<number, EChartsType>())
  const panel = useMemo(() => addBackgroundChartPanel([], background.id)[0], [background.id])
  const empty = useMemo(createPageChartData, [])
  const samples = output?.monitor ?? []
  const bounded = useMemo(() => {
    const points = samples.map(sample => ({ ...sample, x: sample.elapsed_s, sample_index: sample.captured }))
    const x = points.map(point => point.x)
    return backgroundPlotData(points, x.length ? { min: Math.min(...x), max: Math.max(...x) } : null)
  }, [output])
  return <Collapsible title={`Live Monitor: ${background.id}`} className="result-chart-panel">
    <p>Latest 1,000 Worker samples · independent of Capture</p>
    {error && <p role="alert">{error}</p>}
    <ChartPlot panel={panel} data={empty} numericNames={['value']} charts={charts.current} bounded={bounded} />
  </Collapsible>
}

export default function OutputCharts({ runId, pages, metadata, backgrounds, panels, onPanelsChange, chartData, running,
  onSavingChange, changeSettings, fitData, saveChartsWithTemplate, onSaveChartsWithTemplateChange, selections }: {
  runId: number | null; pages: { name: string; outputs: OutputStep[] }[]; metadata: RunPageMetadata[]
  backgrounds: BackgroundConfig[]; panels: ChartPanel[]; onPanelsChange: (panels: ChartPanel[]) => void
  chartData: Map<string, PageChartData>; running: boolean; onSavingChange: (saving: boolean) => void
  changeSettings?: ChartChangeSettings | null; fitData?: boolean
  saveChartsWithTemplate: boolean; onSaveChartsWithTemplateChange: (checked: boolean) => void
  selections: BackgroundChartSelections
}) {
  const [selectedSource, setSelectedSource] = useState('')
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
    ...backgrounds.map(background => ({ key: `background:${background.id}`, label: `Background: ${background.id}`, background })),
  ]
  const selected = sources.find(source => source.key === selectedSource) ?? sources[0]
  return <Collapsible title="Charts" className="result-chart" actions={<div className="result-chart-header-actions">
    <label><input type="checkbox" checked={saveChartsWithTemplate} onChange={event => onSaveChartsWithTemplateChange(event.target.checked)} />Save charts with template</label>
    <span>Charts: {panels.length} / {MAX_CHARTS}</span>
    <label>Chart source<select value={selected?.key ?? ''} onChange={event => setSelectedSource(event.target.value)}>
      {sources.map(source => <option key={source.key} value={source.key}>{source.label}</option>)}
    </select></label>
    <button className="action-button" type="button" disabled={!selected || panels.length >= MAX_CHARTS || ('names' in selected && selected.names.length === 0)}
      onClick={() => {
        if (!selected) return
        updatePanels('background' in selected ? addBackgroundChartPanel(panels, selected.background.id)
          : addChartPanel(panels, selected.page.name, selected.names))
      }}>+ Add Chart</button>
  </div>}>
    {panels.length >= MAX_CHARTS && <p>Maximum 8 charts.</p>}
    {panels.length === 0 && <p>No charts. Choose a source and Add Chart.</p>}
    {error && <p role="alert">Could not load Background datasets: {error}</p>}
    <div className="result-charts-grid">
    {pages.map(page => {
      const pageMetadata = metadata.find(item => item.name === page.name)
      const numericNames = foregroundChartNames(panels, page, pageMetadata, running)
      return <ResultChart key={page.name} runId={runId} page={page.name} outputs={page.outputs}
        revision={pageMetadata?.revision ?? 0} rowCount={pageMetadata?.row_count ?? 0}
        numericNames={numericNames} timestampNames={running && (pageMetadata?.row_count ?? 0) === 0
          ? page.outputs.filter(output => output.value.source === 'timestamp').map(output => output.name)
          : pageMetadata?.timestamp_outputs ?? []}
        panels={panels} onPanelsChange={updatePanels} chartData={chartData} running={running}
        onSavingChange={onSavingChange} changeSettings={changeSettings} fitData={fitData} />
    })}
    {runId !== null && panels.filter(panel => panel.source).map(panel => <BackgroundChartData key={panel.id}
      panel={panel} panels={panels} onPanelsChange={updatePanels} runId={runId} backgrounds={backgrounds}
      datasets={output?.datasets ?? []} running={running} selections={selections} onSavingChange={onSavingChange} />)}
    {runId !== null && backgrounds.filter(background => background.live_monitor).map(background => <LiveMonitor key={background.id}
      runId={runId} background={background} running={running} />)}
    </div>
  </Collapsible>
}
