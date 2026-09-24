import { useEffect, useMemo, useRef, useState } from 'react'
import type { EChartsType } from 'echarts/core'
import ChartPlot from './ChartPlot'
import ChartSettings from './ChartSettings'
import { chartLoadGroups, chartNeedsLoad, createPageChartData, type PageChartData } from './chartData'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { addChartPanel, canRemoveChartPanel, chartRawOutputs, chartRequiredOutputs, MAX_CHARTS, type ChartPanel } from './chartPanels'
import { chartPng } from './chartPng'
import { statisticalRequestKey, type BoxPlotDto, type HistogramDto, type StatisticalDto } from './chartStatistics'

type ChartSeriesResponse = { run_id: number; page: string; start_row: number; row_count: number; series: Record<string, number[]> }

const CHART_SERIES_CHUNK_ROWS = 25_000
const EMPTY_DATA = createPageChartData()
type StatisticalState = { key: string; response?: StatisticalDto; error?: string }

export default function ResultChart({ runId, revision, rowCount, numericNames, panels, onPanelsChange, page, chartData, onSavingChange, running }: {
  runId: number
  revision: number
  rowCount: number
  page: string
  chartData: Map<string, PageChartData>
  onSavingChange: (saving: boolean) => void
  panels: ChartPanel[]
  onPanelsChange: (panels: ChartPanel[]) => void
  numericNames: string[]
  running: boolean
}) {
  const plots = useRef(new Map<number, EChartsType>())
  const saving = useRef(false)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<{ id: number; message: string } | null>(null)
  const [settingsId, setSettingsId] = useState<number | null>(null)
  const [dataVersion, setDataVersion] = useState(0)
  const [statistical, setStatistical] = useState<Record<number, StatisticalState>>({})
  const localPanels = useMemo(() => panels.filter(panel => panel.page === page), [panels, page])
  const data = useMemo(() => {
    if (!localPanels.some(panel => chartRawOutputs(panel).some(name => numericNames.includes(name)))) return null
    let local = chartData.get(page)
    if (!local) {
      local = createPageChartData()
      chartData.set(page, local)
    }
    return local
  }, [chartData, page, localPanels, numericNames, dataVersion])
  const requestedNames = useMemo(() => [...new Set(localPanels.flatMap(chartRawOutputs))]
    .filter(name => numericNames.includes(name)), [localPanels, numericNames])
  const requestedKey = useMemo(() => JSON.stringify([...requestedNames].sort()), [requestedNames])
  const latestRowCountRef = useRef(rowCount)
  latestRowCountRef.current = rowCount
  const [loadGeneration, setLoadGeneration] = useState(0)
  const loaderActiveRef = useRef<object | null>(null)
  const statisticalRequests = useMemo(() => localPanels.filter(panel =>
    !running && panel.outputs.every(name => numericNames.includes(name)))
    .map(panel => ({ panel, key: statisticalRequestKey(runId, panel) }))
    .filter((item): item is { panel: ChartPanel; key: string } => item.key !== null),
  [localPanels, numericNames, runId, running])
  const statisticalKey = JSON.stringify(statisticalRequests.map(({ panel, key }) => [panel.id, key]))

  useEffect(() => {
    let cancelled = false
    const requests = statisticalRequests
    for (const { panel, key } of requests) {
      setStatistical(current => ({ ...current, [panel.id]: { key } }))
      const command = panel.type === 'histogram' ? 'get_last_run_histogram' : 'get_last_run_box_plot'
      const args = panel.type === 'histogram'
        ? { runId, page, output: panel.outputs[0], mode: panel.histogram.mode, value: panel.histogram.value }
        : { runId, page, outputs: panel.outputs }
      void invoke<HistogramDto | BoxPlotDto>(command, args).then(response => {
        if (!cancelled && response.run_id === runId && response.page === page) {
          setStatistical(current => ({ ...current, [panel.id]: { key, response } }))
        }
      }).catch(error => {
        if (!cancelled) setStatistical(current => ({ ...current,
          [panel.id]: { key, error: String(error) } }))
      })
    }
    return () => { cancelled = true }
  }, [statisticalKey, runId, page])

  useEffect(() => {
    const outputs = JSON.parse(requestedKey) as string[]
    const existing = chartData.get(page)
    if (outputs.length === 0) {
      chartData.delete(page)
      loaderActiveRef.current = null
      return
    }

    let cancelled = false
    let caughtUp = false
    const token = {}
    loaderActiveRef.current = token
    const local = existing ?? createPageChartData()
    chartData.set(page, local)
    if (local.removeExcept(new Set(outputs))) {
      setDataVersion(version => version + 1)
    }

    async function runLoader() {
      try {
        while (!cancelled) {
          const target = latestRowCountRef.current
          const groups = chartLoadGroups(local, outputs, target, CHART_SERIES_CHUNK_ROWS)
          if (groups.length === 0) {
            caughtUp = true
            break
          }
          let progressed = false
          for (const { startRow, names, limit } of groups) {
            if (cancelled) break
            if (!names.every(name => local.length(name) === startRow)) return
            const response = await invoke<ChartSeriesResponse>('get_last_run_chart_series', {
              runId, page, outputs: names, startRow, limit,
            })
            if (cancelled || response.run_id !== runId || response.page !== page || response.start_row !== startRow) {
              return
            }
            const tails = names.map(name => response.series[name])
            if (tails.some(tail => !Array.isArray(tail))) return
            const tailLength = tails[0].length
            if (tailLength === 0 || tails.some(tail => tail.length !== tailLength)) return
            if (!names.every(name => local.length(name) === startRow)) return
            for (let index = 0; index < names.length; index++) {
              if (!local.append(names[index], startRow, tails[index])) return
            }
            setDataVersion(version => version + 1)
            progressed = true
          }
          if (!progressed) break
        }
      } finally {
        if (loaderActiveRef.current === token) {
          loaderActiveRef.current = null
          if (!cancelled && caughtUp) {
            const latest = latestRowCountRef.current
            if (chartNeedsLoad(local, outputs, latest)) {
              setLoadGeneration(generation => generation + 1)
            }
          }
        }
      }
    }

    void runLoader().catch(() => {})
    return () => { cancelled = true }
  }, [runId, page, requestedKey, chartData, loadGeneration])

  useEffect(() => {
    const outputs = JSON.parse(requestedKey) as string[]
    if (outputs.length === 0 || loaderActiveRef.current !== null) return
    const local = chartData.get(page)
    const behind = local ? chartNeedsLoad(local, outputs, rowCount) : rowCount > 0
    if (behind) setLoadGeneration(generation => generation + 1)
  }, [runId, page, requestedKey, revision, rowCount, chartData])

  async function saveImage(id: number, index: number) {
    if (saving.current) return
    saving.current = true
    setSavingId(id)
    onSavingChange(true)
    setFeedback(null)
    try {
      const destinationPath = await save({
        defaultPath: 'Chart-' + (index + 1) + '.png',
        filters: [{ name: 'PNG', extensions: ['png'] }],
      })
      if (!destinationPath) return
      const panel = panels.find(panel => panel.id === id)!
      const pngBytes = await chartPng(plots.current.get(id), panel)
      await invoke('save_chart_png', { destinationPath, pngBytes: Array.from(pngBytes) })
      setFeedback({ id, message: 'Chart image saved successfully.' })
    } catch (error) {
      setFeedback({ id, message: 'Could not save chart image: ' + String(error) })
    } finally {
      saving.current = false
      setSavingId(null)
      onSavingChange(false)
    }
  }

  function addChart() {
    if (saving.current) return
    onPanelsChange(addChartPanel(panels, page, numericNames))
  }

  return <section className="result-chart" aria-label="Charts">
    <div className="section-header">
      <h3>Charts</h3>
      <button className="action-button" type="button" onClick={addChart}
        disabled={savingId !== null || numericNames.length === 0 || panels.length >= MAX_CHARTS}>+ Add Chart</button>
    </div>
    {panels.length >= MAX_CHARTS && <p>Maximum 8 charts.</p>}
    {numericNames.length === 0 ? <p>No numeric Outputs are available for charts on this Page.</p>
      : localPanels.length === 0 ? <p>No charts for this Page.</p>
      : <p>Select multiple numeric Outputs to compare them on the same chart.</p>}
    <div className="result-charts-grid">
      {localPanels.map((panel, index) => {
        const selectedOutputs = panel.outputs.filter(name => numericNames.includes(name))
        const visiblePanel = selectedOutputs.length === panel.outputs.length ? panel : { ...panel, outputs: selectedOutputs }
        const statisticKey = statisticalRequestKey(runId, visiblePanel)
        const statisticState = statistical[panel.id]
        const statisticReady = statisticKey !== null && statisticState?.key === statisticKey && !!statisticState.response
        const isStatistical = panel.type === 'histogram' || panel.type === 'boxplot'
        const analysisReady = isStatistical ? statisticReady : panel.type === 'line' ||
          (data !== null && data.commonLength(chartRequiredOutputs(visiblePanel)) >= rowCount)
        const enoughOutputs = panel.type !== 'combo' || selectedOutputs.length >= 2
        return <section className="result-chart-panel" key={panel.id} aria-label={`Chart ${index + 1}`}>
          <div className="section-header">
            <h4>Chart {index + 1}</h4>
            <div className="result-chart-panel-actions">
              <button className="action-button" type="button" disabled={savingId !== null || selectedOutputs.length === 0 || !analysisReady || !enoughOutputs}
                onClick={() => void saveImage(panel.id, index)}>Save image</button>
              <button className="action-button" type="button" disabled={savingId !== null}
                onClick={() => setSettingsId(panel.id)}>Settings</button>
              <button className="action-button action-button-danger" type="button"
                aria-label={`Remove Chart ${index + 1}`} disabled={savingId !== null || !canRemoveChartPanel(panels)}
                onClick={() => {
                  if (saving.current) return
                  if (feedback?.id === panel.id) setFeedback(null)
                  onPanelsChange(panels.filter(item => item.id !== panel.id))
                }}>Remove</button>
            </div>
          </div>
          {feedback?.id === panel.id && <p role="status">{feedback.message}</p>}
          <fieldset className="result-chart-outputs" disabled={savingId !== null}>
            <legend>Outputs</legend>
            {numericNames.map(name => <label key={name}>
              <input type={panel.type === 'histogram' ? 'radio' : 'checkbox'}
                name={panel.type === 'histogram' ? `histogram-output-${panel.id}` : undefined}
                checked={panel.outputs.includes(name)} onChange={event => {
                const outputs = panel.type === 'histogram' ? [name] : event.target.checked
                  ? [...panel.outputs, name] : panel.outputs.filter(output => output !== name)
                onPanelsChange(panels.map(item => item.id === panel.id ? { ...item, outputs,
                  xAxis: panel.type === 'histogram' && item.xAxis.title === item.outputs[0]
                    ? { ...item.xAxis, title: name } : item.xAxis } : item))
              }} />
              {name}
            </label>)}
          </fieldset>
          {selectedOutputs.length === 0 ? <p>Select at least one Output to display this chart.</p>
            : !enoughOutputs ? <p>Select at least two Outputs for Combo.</p>
              : isStatistical && statisticState?.key === statisticKey && statisticState.error
                ? <p role="alert">Could not prepare chart: {statisticState.error}</p>
                : !analysisReady ? <p role="status">Preparing chart data...</p> : (
            <ChartPlot panel={visiblePanel}
              data={data ?? EMPTY_DATA} numericNames={numericNames} charts={plots.current}
              statistical={isStatistical ? statisticState?.response : undefined} />
          )}
          {settingsId === panel.id && <ChartSettings panel={panel} numericNames={numericNames}
            running={running} hasRows={rowCount > 0} onClose={() => setSettingsId(null)}
            onApply={settings => {
              onPanelsChange(panels.map(item => item.id === panel.id ? { ...item, ...settings,
                outputs: settings.type === 'histogram' ? item.outputs.slice(0, 1) : item.outputs } : item))
              setSettingsId(null)
            }} />}
        </section>
      })}
    </div>
  </section>
}
