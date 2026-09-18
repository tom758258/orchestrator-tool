import { useMemo, useRef, useState } from 'react'
import type { EChartsType } from 'echarts/core'
import ChartPlot from './ChartPlot'
import { createPageChartData, numericOutputNames, type PageChartData } from './chartData'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { addChartPanel, MAX_CHARTS, type ChartPanel } from './chartPanels'
import { chartPng } from './chartPng'
import type { ResultRowDto } from './workflow'

export default function ResultChart({ rows, outputNames, panels, onPanelsChange, page, chartData, onSavingChange }: {
  page: string
  chartData: Map<string, PageChartData>
  onSavingChange: (saving: boolean) => void
  panels: ChartPanel[]
  onPanelsChange: (panels: ChartPanel[]) => void
  rows: ResultRowDto[]
  outputNames: string[]
}) {
  const plots = useRef(new Map<number, EChartsType>())
  const saving = useRef(false)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<{ id: number; message: string } | null>(null)
  const numericNames = useMemo(() => numericOutputNames(rows, outputNames), [rows, outputNames])
  const localPanels = useMemo(() => panels.filter(panel => panel.page === page), [panels, page])
  const data = useMemo(() => {
    if (!localPanels.some(panel => panel.outputs.some(name => numericNames.includes(name)))) return null
    let local = chartData.get(page)
    if (!local) {
      local = createPageChartData(rows)
      chartData.set(page, local)
    }
    return local
  }, [chartData, page, rows, localPanels, numericNames])

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
      const pngBytes = await chartPng(plots.current.get(id))
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
        return <section className="result-chart-panel" key={panel.id} aria-label={`Chart ${index + 1}`}>
          <div className="section-header">
            <h4>Chart {index + 1}</h4>
            <div className="result-chart-panel-actions">
              <button className="action-button" type="button" disabled={savingId !== null || selectedOutputs.length === 0}
                onClick={() => void saveImage(panel.id, index)}>Save image</button>
              <button className="action-button action-button-danger" type="button"
                aria-label={`Remove Chart ${index + 1}`} disabled={savingId !== null}
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
              <input type="checkbox" checked={panel.outputs.includes(name)} onChange={event => {
                const outputs = event.target.checked
                  ? [...panel.outputs, name] : panel.outputs.filter(output => output !== name)
                onPanelsChange(panels.map(item => item.id === panel.id ? { ...item, outputs } : item))
              }} />
              {name}
            </label>)}
          </fieldset>
          <fieldset className="result-chart-axis-titles" disabled={savingId !== null}>
            <legend>Axis titles</legend>
            <label>
              X-axis title
              <input type="text" value={panel.xAxisTitle} onChange={event =>
                onPanelsChange(panels.map(item => item.id === panel.id
                  ? { ...item, xAxisTitle: event.target.value } : item))} />
            </label>
            <label>
              Y-axis title
              <input type="text" value={panel.yAxisTitle} onChange={event =>
                onPanelsChange(panels.map(item => item.id === panel.id
                  ? { ...item, yAxisTitle: event.target.value } : item))} />
            </label>
          </fieldset>
          {selectedOutputs.length === 0 || !data ? <p>Select at least one Output to display this chart.</p> : (
            <ChartPlot panel={selectedOutputs.length === panel.outputs.length ? panel : { ...panel, outputs: selectedOutputs }}
              data={data} numericNames={numericNames} charts={plots.current} />
          )}
        </section>
      })}
    </div>
  </section>
}
