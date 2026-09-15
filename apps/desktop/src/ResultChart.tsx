import { useRef, useState } from 'react'
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { ResultRowDto } from './workflow'

const MAX_CHARTS = 8
const SERIES_COLORS = ['#2563eb', '#dc2626', '#15803d', '#9333ea', '#b45309', '#0891b2']
type ChartPanel = { id: number; outputs: string[] }

export default function ResultChart({ rows, outputNames }: {
  rows: ResultRowDto[]
  outputNames: string[]
}) {
  const [panels, setPanels] = useState<ChartPanel[] | null>(null)
  const nextPanelId = useRef(1)
  const numericNames = rows.length === 0 ? [] : outputNames.filter(name =>
    rows.every(row => {
      const value = row.outputs.find(output => output.name === name)?.value
      return typeof value === 'number' && Number.isFinite(value)
    }))
  const hasIteration = rows.length > 0 && rows.every(row =>
    row.for_iteration != null || row.while_iteration != null)

  // Null means not initialized; an empty selection must stay empty.
  let displayedPanels = panels
  if (hasIteration) {
    if (panels === null && numericNames.length > 0) {
      displayedPanels = [{ id: 0, outputs: [numericNames[0]] }]
      setPanels(displayedPanels)
    } else if (panels?.some(panel => panel.outputs.some(name => !numericNames.includes(name)))) {
      displayedPanels = panels.map(panel => ({
        ...panel,
        outputs: panel.outputs.filter(name => numericNames.includes(name)),
      }))
      setPanels(displayedPanels)
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
  const points = rows.map(row => {
    const point: Record<string, number> = {
      iteration: (row.for_iteration ?? row.while_iteration)!.iteration_index + 1,
    }
    series.forEach(item => {
      point[item.key] = row.outputs.find(output => output.name === item.name)!.value as number
    })
    return point
  })

  function addChart() {
    if (!displayedPanels || displayedPanels.length >= MAX_CHARTS) return
    const name = numericNames.find(name => !displayedPanels.some(panel => panel.outputs.includes(name)))
      ?? numericNames[0]
    setPanels([...displayedPanels, { id: nextPanelId.current++, outputs: [name] }])
  }

  return <section className="result-chart" aria-label="Charts">
    <div className="section-header">
      <h3>Charts</h3>
      <button className="action-button" type="button" onClick={addChart}
        disabled={displayedPanels.length >= MAX_CHARTS}>+ Add chart</button>
    </div>
    {displayedPanels.length >= MAX_CHARTS && <p>Maximum 8 charts.</p>}
    <p>Select multiple numeric Outputs to compare them on the same chart.</p>
    <div className="result-charts-grid">
      {displayedPanels.map((panel, index) => {
        const selectedSeries = series.filter(item => panel.outputs.includes(item.name))
        return <section className="result-chart-panel" key={panel.id} aria-label={`Chart ${index + 1}`}>
          <div className="section-header">
            <h4>Chart {index + 1}</h4>
            {displayedPanels.length > 1 && <button className="action-button" type="button"
              aria-label={`Remove Chart ${index + 1}`}
              onClick={() => setPanels(displayedPanels.filter(item => item.id !== panel.id))}>Remove</button>}
          </div>
          <fieldset className="result-chart-outputs">
            <legend>Outputs</legend>
            {numericNames.map(name => <label key={name}>
              <input type="checkbox" checked={panel.outputs.includes(name)} onChange={event => {
                const outputs = event.target.checked
                  ? [...panel.outputs, name] : panel.outputs.filter(output => output !== name)
                setPanels(displayedPanels.map(item => item.id === panel.id ? { ...item, outputs } : item))
              }} />
              {name}
            </label>)}
          </fieldset>
          {selectedSeries.length === 0 ? <p>Select at least one Output to display this chart.</p> : (
            <div className="result-chart-plot" role="img"
              aria-label={`Line chart: ${selectedSeries.map(item => item.name).join(', ')} versus Iteration, ${points.length} points per series`}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={points} margin={{ top: 16, right: 24, bottom: 24, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" dataKey="iteration" name="Iteration" allowDecimals={false}
                    label={{ value: 'Iteration', position: 'bottom', offset: 0 }} />
                  <YAxis type="number" />
                  <Tooltip labelFormatter={value => `Iteration: ${value}`} />
                  {selectedSeries.length > 1 && <Legend verticalAlign="top" />}
                  {selectedSeries.map(item => <Line key={item.key} type="linear"
                    dataKey={item.key} name={item.name} stroke={item.color}
                    dot={{ r: 4 }} isAnimationActive={false} />)}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      })}
    </div>
  </section>
}
