import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addChartPanel } from '../src/chartPanels.ts'
import { createPageChartData, minMaxDecimateRange, prepareChartSeries } from '../src/chartData.ts'

const data = createPageChartData()
data.append('V', 0, [10, 20, 30, 40, 50, 60, 70, 80])
data.append('I', 0, [8, 7, 6, 5, 4, 3, 2, 1])
const base = { ...addChartPanel([], 'A', ['I'])[0], outputs: ['I'] }
const range = { min: 2, max: 6 }

test('Line and Area use visible iteration min/max decimation', () => {
  const expected = minMaxDecimateRange(data.iteration, data.getSeries('I'), 1, range)
  for (const type of ['line', 'area']) {
    assert.deepEqual(prepareChartSeries({ ...base, type }, data, 1, range),
      [{ name: 'I', data: expected }])
  }
})

test('Column keeps every raw row in the visible iteration viewport', () => {
  assert.deepEqual(prepareChartSeries({ ...base, type: 'column' }, data, 1, range),
    [{ name: 'I', data: [[2, 7], [3, 6], [4, 5], [5, 4], [6, 3]] }])
})

test('Scatter pairs each raw X source with Y series on the coherent prefix', () => {
  const iteration = prepareChartSeries({ ...base, type: 'scatter' }, data, 1, range)
  assert.deepEqual(iteration[0].data[0], [1, 8])
  assert.deepEqual(iteration[0].data.at(-1), [8, 1])
  const output = prepareChartSeries({ ...base, type: 'scatter', scatterXOutput: 'V',
    outputs: ['I', 'V'] }, data, 1, range)
  assert.deepEqual(output.map(series => series.name), ['I', 'V'])
  assert.deepEqual(output[0].data[0], [10, 8])
  assert.deepEqual(output[0].data.at(-1), [80, 1])
  assert.deepEqual(output[1].data[0], [10, 10])
})

test('Bar retains raw values on physical X and iteration on physical Y', () => {
  const series = prepareChartSeries({ ...base, type: 'bar', outputs: ['I', 'V'] }, data, 1, range)
  assert.deepEqual(series.map(item => item.name), ['I', 'V'])
  assert.deepEqual(series[0].data[0], [8, 1])
  assert.deepEqual(series[0].data.at(-1), [1, 8])
  assert.deepEqual(series[1].data[0], [10, 1])
  assert.equal(series[0].data.length, 8)
})
