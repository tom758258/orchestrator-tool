import type { OutputStep } from './workflow'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { EChartsType } from 'echarts/core'
import ChartPlot from './ChartPlot'
import ChartPanelView from './ChartPanelView'
import { chartLoadGroups, chartNeedsLoad, createPageChartData, type ChartChangeSettings, type PageChartData } from './chartData'
import { invoke } from '@tauri-apps/api/core'
import { chartSupportsLive, chartRawOutputs, chartRequiredOutputs, type ChartPanel } from './chartPanels'
import { statisticalRequestKey, type BoxPlotDto, type HistogramDto, type StatisticalDto } from './chartStatistics'

type ChartSeriesResponse = { run_id: number; page: string; start_row: number; row_count: number; series: Record<string, number[]> }

const CHART_SERIES_CHUNK_ROWS = 25_000
const EMPTY_DATA = createPageChartData()
type StatisticalState = { key: string; response?: StatisticalDto; error?: string }

export default function ResultChart({ runId, revision, rowCount, numericNames, timestampNames, outputs, panels, onPanelsChange, page, chartData, onSavingChange, running, changeSettings, fitData }: {
  runId: number | null
  revision: number
  rowCount: number
  page: string
  chartData: Map<string, PageChartData>
  onSavingChange: (saving: boolean) => void
  panels: ChartPanel[]
  onPanelsChange: (panels: ChartPanel[]) => void
  numericNames: string[]
  timestampNames: string[]
  outputs: OutputStep[]
  running: boolean
  changeSettings?: ChartChangeSettings | null
  fitData?: boolean
}) {
  const plots = useRef(new Map<number, EChartsType>())
  const [dataVersion, setDataVersion] = useState(0)
  const [statistical, setStatistical] = useState<Record<number, StatisticalState>>({})
  const scatterXNames = useMemo(() => [...numericNames, ...timestampNames], [numericNames, timestampNames])
  const waitingForRunData = runId === null || (running && rowCount === 0)
  const localPanels = useMemo(() => panels.filter(panel => !panel.source && panel.page === page), [panels, page])
  const loadingPanels = useMemo(() => localPanels.filter(panel =>
    runId !== null && (!running || chartSupportsLive(panel.type))), [localPanels, running, runId])
  const data = useMemo(() => {
    if (!loadingPanels.some(panel => chartRawOutputs(panel).some(name => scatterXNames.includes(name)))) return null
    let local = chartData.get(page)
    if (!local) {
      local = createPageChartData()
      chartData.set(page, local)
    }
    return local
  }, [chartData, page, loadingPanels, scatterXNames, dataVersion])
  const requestedNames = useMemo(() => [...new Set(loadingPanels.flatMap(chartRawOutputs))]
    .filter(name => scatterXNames.includes(name)), [loadingPanels, scatterXNames])
  const requestedKey = useMemo(() => JSON.stringify([...requestedNames].sort()), [requestedNames])
  const latestRowCountRef = useRef(rowCount)
  latestRowCountRef.current = rowCount
  const [loadGeneration, setLoadGeneration] = useState(0)
  const loaderActiveRef = useRef<object | null>(null)
  const statisticalRequests = useMemo(() => runId === null ? [] : localPanels.filter(panel =>
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

  return <div className="result-chart-page">
      {localPanels.map((panel) => {
        const waiting = running && !chartSupportsLive(panel.type)
        const selectedOutputs = panel.outputs.filter(name => numericNames.includes(name))
        const visiblePanel = selectedOutputs.length === panel.outputs.length ? panel : { ...panel, outputs: selectedOutputs }
        const xOutput = panel.type === 'scatter'
          ? outputs.find(output => output.name === panel.scatterXOutput) : undefined
        const xTimeFormat = xOutput?.value.source === xOutput?.time_format?.kind ? xOutput?.time_format : undefined
        const statisticKey = runId === null ? null : statisticalRequestKey(runId, visiblePanel)
        const statisticState = statistical[panel.id]
        const statisticReady = statisticKey !== null && statisticState?.key === statisticKey && !!statisticState.response
        const isStatistical = panel.type === 'histogram' || panel.type === 'boxplot'
        const analysisReady = runId !== null && !waitingForRunData && (isStatistical ? statisticReady : panel.type === 'line' ||
          (data !== null && data.commonLength(chartRequiredOutputs(visiblePanel)) >= rowCount))
        const enoughOutputs = panel.type !== 'combo' || selectedOutputs.length >= 2
        return <ChartPanelView key={panel.id} panel={panel} panels={panels} onPanelsChange={onPanelsChange}
          charts={plots.current} numericNames={numericNames} timestampNames={timestampNames} outputs={outputs}
          running={running} hasRows={rowCount > 0} onSavingChange={onSavingChange}
          canExport={!waiting && selectedOutputs.length > 0 && analysisReady && enoughOutputs}>
          <fieldset className="result-chart-outputs" disabled={waiting}>
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
          {waiting ? <div className="result-chart-waiting" role="status">
            <p>Waiting for run to finish</p>
            <p>This chart does not support live updates. It will update automatically when the run finishes.</p>
          </div> : waitingForRunData ? <p role="status">Waiting for run data</p>
            : selectedOutputs.length === 0 ? <p>Select at least one Output to display this chart.</p>
            : !enoughOutputs ? <p>Select at least two Outputs for Combo.</p>
              : isStatistical && statisticState?.key === statisticKey && statisticState.error
                ? <p role="alert">Could not prepare chart: {statisticState.error}</p>
                : !analysisReady ? <p role="status">Preparing chart data...</p> : (
            <ChartPlot panel={visiblePanel}
              data={data ?? EMPTY_DATA} numericNames={numericNames} charts={plots.current}
              statistical={isStatistical ? statisticState?.response : undefined}
              changeSettings={changeSettings} fitData={fitData} xTimeFormat={xTimeFormat} />
          )}
        </ChartPanelView>
      })}
    </div>
}
