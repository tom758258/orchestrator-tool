import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addChartPanel } from '../src/chartPanels.ts'
import { createPageChartData, minMaxDecimateRange, prepareChartSeries } from '../src/chartData.ts'
import { comboRendererSeries } from '../src/chartOptions.ts'
import { formatBinBoundary, statisticalChartSeries } from '../src/chartStatistics.ts'

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

test('Combo decimates Line and retains Column viewport rows with independent Y assignment', () => {
  const panel = { ...base, type: 'combo', outputs: ['I', 'V'] }
  const display = prepareChartSeries(panel, data, 1, range)
  assert.deepEqual(display[0].data, [[2, 7], [3, 6], [4, 5], [5, 4], [6, 3]])
  assert.deepEqual(display[1].data, minMaxDecimateRange(data.iteration, data.getSeries('V'), 1, range))
  const series = comboRendererSeries(panel, display, ['red', 'blue'])
  assert.deepEqual(series.map(item => [item.type, item.yAxisIndex]), [['bar', 0], ['line', 1]])
  assert.equal(series.some(item => Object.hasOwn(item, 'stack')), false)
})

test('statistical responses map bins and box statistics directly to ECharts series', () => {
  const histogram = statisticalChartSeries({ ...base, type: 'histogram' }, {
    run_id: 1, page: 'A', output: 'I', sample_count: 4,
    bins: [{ start: 0, end: 2, count: 2 }, { start: 2, end: 4, count: 2 }],
  }, 'red')
  assert.deepEqual(histogram.categories, ['0–2', '2–4'])
  assert.equal(histogram.series[0].type, 'bar')
  assert.deepEqual(histogram.series[0].data, [2, 2])
  const response = { run_id: 1, page: 'A', items: [{ output: 'I', count: 6,
    lower_whisker: 1, q1: 2.25, median: 3.5, q3: 4.75, upper_whisker: 5, outliers: [100] }] }
  const box = statisticalChartSeries({ ...base, type: 'boxplot' }, response, 'blue')
  assert.deepEqual(box.categories, ['I'])
  assert.deepEqual(box.series[0].data, [[1, 2.25, 3.5, 4.75, 5]])
  assert.deepEqual(box.series[1].data, [[0, 100]])
  assert.equal(statisticalChartSeries({ ...base, type: 'boxplot',
    boxPlot: { showOutliers: false } }, response, 'blue').series.length, 1)
})

test('Histogram formats category boundaries without changing statistical values', () => {
  assert.deepEqual([formatBinBoundary(1), formatBinBoundary(231.69230769230768),
    formatBinBoundary(1.2e-7)], ['1', '231.692', '1.2e-7'])
  const response = { run_id: 1, page: 'A', output: 'I', sample_count: 1,
    bins: [{ start: 1, end: 231.69230769230768, count: 1 }] }
  assert.deepEqual(statisticalChartSeries({ ...base, type: 'histogram' }, response, 'red').categories,
    ['1–231.692'])
  assert.equal(response.bins[0].end, 231.69230769230768)
})
