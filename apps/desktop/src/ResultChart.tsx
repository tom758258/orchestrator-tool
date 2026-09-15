import { useState } from 'react'
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { ResultRowDto } from './workflow'

type Axes = { x: string | null; y: string }
type ChartPoint = { x: number; y: number }

export default function ResultChart({ rows, outputNames }: {
  rows: ResultRowDto[]
  outputNames: string[]
}) {
  const [chartType, setChartType] = useState<'line' | 'scatter'>('line')
  const [selection, setSelection] = useState<Axes | null>(null)
  const numericNames = rows.length === 0 ? [] : outputNames.filter(name =>
    rows.every(row => {
      const value = row.outputs.find(output => output.name === name)?.value
      return typeof value === 'number' && Number.isFinite(value)
    }))
  const hasIteration = rows.length > 0 && rows.every(row =>
    row.for_iteration != null || row.while_iteration != null)
  const defaultAxes: Axes | null = numericNames.length >= 2
    ? { x: numericNames[0], y: numericNames[1] }
    : hasIteration && numericNames.length === 1 ? { x: null, y: numericNames[0] } : null
  const axes = selection && numericNames.includes(selection.y)
    && (selection.x === null ? hasIteration : numericNames.includes(selection.x) && selection.x !== selection.y)
    ? selection : defaultAxes

  // Replace invalid choices before rendering newly committed rows.
  if (axes !== selection) setSelection(axes)

  if (rows.length === 0) return null
  if (!axes) return <section aria-label="Chart">
    <h3>Chart</h3>
    <p>Chart requires two numeric Outputs, or one numeric Output with loop iteration data.</p>
  </section>

  const xName = axes.x ?? 'Iteration'
  const points: ChartPoint[] = rows.map(row => ({
    x: axes.x === null
      ? (row.for_iteration ?? row.while_iteration)!.iteration_index + 1
      : row.outputs.find(output => output.name === axes.x)!.value as number,
    y: row.outputs.find(output => output.name === axes.y)!.value as number,
  }))
  const xChoices = [
    ...(hasIteration ? [{ value: 'iteration', name: 'Iteration', x: null }] : []),
    ...numericNames.map(name => ({ value: `output:${name}`, name, x: name })),
  ]
  const chartAxes = <>
    <CartesianGrid strokeDasharray="3 3" />
    <XAxis type="number" dataKey="x" name={xName}
      label={{ value: xName, position: 'bottom', offset: 0 }} />
    <YAxis type="number" dataKey="y" name={axes.y}
      label={{ value: axes.y, angle: -90, position: 'insideLeft' }} />
  </>

  return <section className="result-chart" aria-label="Chart">
    <h3>Chart</h3>
    <div className="result-chart-controls">
      <label className="step-property-field">
        <span className="step-property-label">Chart type</span>
        <select value={chartType} onChange={event => setChartType(event.target.value as 'line' | 'scatter')}>
          <option value="line">Line</option>
          <option value="scatter">Scatter</option>
        </select>
      </label>
      <label className="step-property-field">
        <span className="step-property-label">X axis</span>
        <select value={axes.x === null ? 'iteration' : `output:${axes.x}`} onChange={event => {
          const x = xChoices.find(choice => choice.value === event.target.value)!.x
          setSelection({ x, y: x === axes.y ? numericNames.find(name => name !== x)! : axes.y })
        }}>
          {xChoices.map(choice => <option key={choice.value} value={choice.value}
            disabled={choice.x !== null && numericNames.length < 2}>{choice.name}</option>)}
        </select>
      </label>
      <label className="step-property-field">
        <span className="step-property-label">Y axis</span>
        <select value={axes.y} onChange={event => setSelection({ ...axes, y: event.target.value })}>
          {numericNames.filter(name => name !== axes.x).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
    </div>
    <div className="result-chart-plot" role="img" aria-label={`${chartType === 'line' ? 'Line' : 'Scatter'} chart: ${axes.y} versus ${xName}, ${points.length} points`}>
      <ResponsiveContainer width="100%" height="100%">
        {chartType === 'line' ? (
          <LineChart data={points} margin={{ top: 16, right: 24, bottom: 24, left: 20 }}>
            {chartAxes}
            <Tooltip labelFormatter={value => `${xName}: ${value}`} />
            <Line type="linear" dataKey="y" name={axes.y} stroke="#2563eb"
              dot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        ) : (
          <ScatterChart margin={{ top: 16, right: 24, bottom: 24, left: 20 }}>
            {chartAxes}
            <Tooltip />
            <Scatter data={points} name={axes.y} fill="#2563eb" isAnimationActive={false} />
          </ScatterChart>
        )}
      </ResponsiveContainer>
    </div>
  </section>
}
