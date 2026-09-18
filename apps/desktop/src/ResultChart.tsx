import { useEffect, useRef, useState } from 'react'
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { reconcileChartPanels, nextChartPanelId, type ChartPanel } from './chartPanels'
import { chartPng } from './chartPng'
import type { ResultRowDto } from './workflow'

const MAX_CHARTS = 8
const SERIES_COLORS = ['#2563eb', '#dc2626', '#15803d', '#9333ea', '#b45309', '#0891b2']

export default function ResultChart({ rows, outputNames, panels, onPanelsChange, page, pages, onSavingChange }: {
  page: string
  pages: { name: string; outputs: { name: string }[] }[]
  onSavingChange: (saving: boolean) => void
  panels: ChartPanel[] | null
  onPanelsChange: (panels: ChartPanel[]) => void
  rows: ResultRowDto[]
  outputNames: string[]
}) {
  const plots = useRef(new Map<number, HTMLDivElement>())
  const saving = useRef(false)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<{ id: number; message: string } | null>(null)
  const numericNames = rows.length === 0 ? [] : outputNames.filter(name =>
    rows.every(row => {
      const value = row.outputs.find(output => output.name === name)?.value
      return typeof value === 'number' && Number.isFinite(value)
    }))
  const hasIteration = rows.length > 0 && rows.every(row =>
    row.for_iteration != null || row.while_iteration != null)

  // Reconcile definitions across every Page without clearing other Pages on tab switches.
  let displayedPanels = panels
  if (panels === null && hasIteration && numericNames.length > 0) {
    displayedPanels = [{ id: 0, page, outputs: [numericNames[0]], xAxisTitle: 'Iteration', yAxisTitle: '' }]
  } else if (panels) {
    const reconciled = reconcileChartPanels(panels, pages, page, rows.length > 0 ? numericNames : null)
    if (JSON.stringify(reconciled) !== JSON.stringify(panels)) displayedPanels = reconciled
  }

  useEffect(() => {
    if (displayedPanels !== panels && displayedPanels !== null) onPanelsChange(displayedPanels)
  }, [displayedPanels, panels, onPanelsChange])

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

  if (!hasIteration) return null
  if (numericNames.length === 0) return <section aria-label="Charts">
    <h3>Charts</h3>
    <p>No numeric Outputs are available for charts.</p>
  </section>
  if (!displayedPanels) return null

  // Safe local keys keep user Output names out of Recharts path resolution.
  const series = numericNames.map((name, index) => ({
    name, key: `series${index}`, color: SERIES_COLORS[index % SERIES_COLORS.length],
  }))
  const points = rows.map((row, index) => {
    const point: Record<string, number> = {
      iteration: index + 1,
    }
    series.forEach(item => {
      point[item.key] = row.outputs.find(output => output.name === item.name)!.value as number
    })
    return point
  })

  function addChart() {
    if (saving.current) return
    if (!displayedPanels || displayedPanels.length >= MAX_CHARTS) return
    const name = numericNames.find(name => !displayedPanels.some(panel => panel.outputs.includes(name)))
      ?? numericNames[0]
    onPanelsChange([...displayedPanels, {
      id: nextChartPanelId(displayedPanels), page, outputs: [name], xAxisTitle: 'Iteration', yAxisTitle: '',
    }])
  }

  return <section className="result-chart" aria-label="Charts">
    <div className="section-header">
      <h3>Charts</h3>
      <button className="action-button" type="button" onClick={addChart}
        disabled={savingId !== null || displayedPanels.length >= MAX_CHARTS}>+ Add chart</button>
    </div>
    {displayedPanels.length >= MAX_CHARTS && <p>Maximum 8 charts.</p>}
    <p>Select multiple numeric Outputs to compare them on the same chart.</p>
    <div className="result-charts-grid">
      {displayedPanels.filter(panel => panel.page === page).map((panel, index) => {
        const selectedSeries = series.filter(item => panel.outputs.includes(item.name))
        return <section className="result-chart-panel" key={panel.id} aria-label={`Chart ${index + 1}`}>
          <div className="section-header">
            <h4>Chart {index + 1}</h4>
            <div className="result-chart-panel-actions">
              <button className="action-button" type="button" disabled={savingId !== null}
                onClick={() => void saveImage(panel.id, index)}>Save image</button>
              {displayedPanels.length > 1 && <button className="action-button action-button-danger" type="button"
                aria-label={`Remove Chart ${index + 1}`} disabled={savingId !== null}
                onClick={() => {
                  if (saving.current) return
                  if (feedback?.id === panel.id) setFeedback(null)
                  onPanelsChange(displayedPanels.filter(item => item.id !== panel.id))
                }}>Remove</button>}
            </div>
          </div>
          {feedback?.id === panel.id && <p role="status">{feedback.message}</p>}
          <fieldset className="result-chart-outputs" disabled={savingId !== null}>
            <legend>Outputs</legend>
            {numericNames.map(name => <label key={name}>
              <input type="checkbox" checked={panel.outputs.includes(name)} onChange={event => {
                const outputs = event.target.checked
                  ? [...panel.outputs, name] : panel.outputs.filter(output => output !== name)
                onPanelsChange(displayedPanels.map(item => item.id === panel.id ? { ...item, outputs } : item))
              }} />
              {name}
            </label>)}
          </fieldset>
          <fieldset className="result-chart-axis-titles" disabled={savingId !== null}>
            <legend>Axis titles</legend>
            <label>
              X-axis title
              <input type="text" value={panel.xAxisTitle} onChange={event =>
                onPanelsChange(displayedPanels.map(item => item.id === panel.id
                  ? { ...item, xAxisTitle: event.target.value } : item))} />
            </label>
            <label>
              Y-axis title
              <input type="text" value={panel.yAxisTitle} onChange={event =>
                onPanelsChange(displayedPanels.map(item => item.id === panel.id
                  ? { ...item, yAxisTitle: event.target.value } : item))} />
            </label>
          </fieldset>
          {selectedSeries.length === 0 ? <p>Select at least one Output to display this chart.</p> : (
            <div className="result-chart-plot" role="img"
              ref={element => { if (element) plots.current.set(panel.id, element); else plots.current.delete(panel.id) }}
              aria-label={`Line chart: ${selectedSeries.map(item => item.name).join(', ')} versus Iteration, ${points.length} points per series`}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={points} margin={{ top: 16, right: 24, bottom: 32, left: 24 }}>
                  <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
                  <XAxis stroke="var(--chart-axis)" type="number" dataKey="iteration" name="Iteration" allowDecimals={false}
                    label={panel.xAxisTitle ? { value: panel.xAxisTitle, position: 'bottom', offset: 0 } : undefined} />
                  <YAxis stroke="var(--chart-axis)" type="number" width={72}
                    label={panel.yAxisTitle
                      ? { value: panel.yAxisTitle, angle: -90, position: 'insideLeft', offset: 0, style: { textAnchor: 'middle' } }
                      : undefined} />
                  <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)',
                    borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-md)', color: 'var(--ink)' }}
                    labelStyle={{ color: 'var(--muted)' }} cursor={{ stroke: 'var(--chart-axis)' }}
                    labelFormatter={value => `Iteration: ${value}`} />
                  {selectedSeries.length > 1 && <Legend verticalAlign="top" />}
                  {selectedSeries.map(item => <Line key={item.key} type="linear"
                    dataKey={item.key} name={item.name} stroke={item.color}
                    dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />)}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      })}
    </div>
  </section>
}
