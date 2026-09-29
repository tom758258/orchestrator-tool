import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { addChartPanel, seriesColor } from '../src/chartPanels.ts'
import { createPageChartData, minMaxDecimateRange, prepareChartSeries } from '../src/chartData.ts'
import { comboRendererSeries, scatterRendererSeries } from '../src/chartOptions.ts'
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

test('Scatter display modes preserve nonmonotonic raw X order and configured rendering', () => {
  const raw = createPageChartData()
  raw.append('X', 0, [0, 1, 2, 3, 2, 1, 0])
  raw.append('Y', 0, [10, 11, 12, 13, 14, 15, 16])
  const scatter = { ...base, type: 'scatter', scatterXOutput: 'X', outputs: ['Y'] }
  const expected = [[0, 10], [1, 11], [2, 12], [3, 13], [2, 14], [1, 15], [0, 16]]
  for (const display of ['markers', 'lines', 'lines-markers']) {
    const configured = { ...scatter, scatter: { display, markerSize: 8, lineWidth: 4 } }
    const prepared = prepareChartSeries(configured, raw, 1, { min: 1, max: 7 })[0]
    assert.deepEqual(prepared.data, expected)
    const rendered = scatterRendererSeries(configured, prepared, 'red')
    assert.equal(rendered.data, prepared.data)
    assert.equal(rendered.type, display === 'markers' ? 'scatter' : 'line')
    assert.equal(rendered.symbolSize, 8)
    if (display === 'markers') {
      assert.equal(rendered.large, true)
      assert.equal(rendered.largeThreshold, 2000)
    } else {
      assert.equal(rendered.showSymbol, display === 'lines-markers')
      assert.equal(rendered.lineStyle.width, 4)
      assert.equal(Object.hasOwn(rendered, 'smooth'), false)
    }
  }
})

test('Scatter retains all raw pairs at 3,000 and 100,000 rows in every display mode', () => {
  for (const count of [3_000, 100_000]) {
    const raw = createPageChartData()
    raw.append('X', 0, Array.from({ length: count }, (_, index) => index % 50))
    raw.append('Y', 0, Array.from({ length: count }, (_, index) => index))
    for (const display of ['markers', 'lines', 'lines-markers']) {
      const configured = { ...base, type: 'scatter', scatterXOutput: 'X', outputs: ['Y'],
        scatter: { display, markerSize: 4, lineWidth: 2 } }
      const prepared = prepareChartSeries(configured, raw, 1, { min: 1, max: count })[0]
      assert.equal(prepared.data.length, count)
      assert.deepEqual(prepared.data[0], [0, 0])
      assert.deepEqual(prepared.data.at(-1), [(count - 1) % 50, count - 1])
      assert.equal(scatterRendererSeries(configured, prepared, 'red').data.length, count)
    }
  }
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

test('Histogram normal line uses bin centers, sample count and each actual width', () => {
  const response = { run_id: 1, page: 'A', output: 'I', sample_count: 4,
    mean: 2.5, std_dev: 1.2909944487358056,
    bins: [{ start: 1, end: 3, count: 2 }, { start: 3, end: 4, count: 2 }] }
  const panel = { ...base, type: 'histogram', seriesColors: { I: '#123456' } }
  const off = statisticalChartSeries(panel, response, 'red')
  assert.equal(off.series.length, 1)
  assert.equal(off.series[0].itemStyle.color, '#123456')
  const enabled = { ...panel, histogram: { ...panel.histogram, showNormalCurve: true } }
  const on = statisticalChartSeries(enabled, response, 'red')
  assert.deepEqual(on.series[0], off.series[0])
  const line = on.series[1]
  assert.equal(line.type, 'line')
  assert.equal(line.showSymbol, false)
  assert.equal(line.silent, true)
  assert.ok(line.data.every(Number.isFinite))
  response.bins.forEach((bin, index) => {
    const center = (bin.start + bin.end) / 2
    const expected = 4 * Math.exp(-0.5 * ((center - 2.5) / response.std_dev) ** 2) /
      (response.std_dev * Math.sqrt(2 * Math.PI)) * (bin.end - bin.start)
    assert.ok(Math.abs(line.data[index] - expected) < 1e-12)
  })
  for (const std_dev of [0, null]) {
    const omitted = statisticalChartSeries(enabled, { ...response, std_dev }, 'red')
    assert.deepEqual(omitted.series, off.series)
  }
  assert.equal(statisticalChartSeries(enabled, { ...response, sample_count: 1 }, 'red').series.length, 1)
  const custom = { ...enabled, histogram: { ...enabled.histogram, mean: 2, stdDev: 1 } }
  const override = statisticalChartSeries(custom, { ...response, std_dev: null }, 'red').series[1]
  assert.ok(Math.abs(override.data[0] - 8 / Math.sqrt(2 * Math.PI)) < 1e-12)
  assert.notDeepEqual(override.data, line.data)
})

test('Chart Settings explains Combo and Histogram Output requirements', () => {
  const source = readFileSync(new URL('../src/ChartSettings.tsx', import.meta.url), 'utf8')
  assert.match(source, /draft\.type === 'combo'[\s\S]*?Combo requires at least two selected Outputs\./)
  assert.match(source, /draft\.type === 'histogram'[\s\S]*?Histogram uses exactly one Output\.[\s\S]*?Apply keeps the first selected Output\./)
})

test('shared Output color preserves Auto and colors Scatter line/markers and Combo', () => {
  const source = readFileSync(new URL('../src/ChartSettings.tsx', import.meta.url), 'utf8')
  const callback = source.match(/setDraft\((current => \{\s+const seriesColors =[\s\S]*?\n\s+\})\)/)
  assert.ok(callback)
  for (const name of ['__proto__', 'I']) {
    const current = { ...base, seriesColors: { V: '#abcdef' } }
    const update = custom => runInNewContext(`(${callback[1]})`, {
      custom, name, palette: '#123456',
    })
    const customized = update(true)(current)
    assert.notEqual(customized.seriesColors, current.seriesColors)
    assert.equal(Object.prototype.hasOwnProperty.call(customized.seriesColors, name), true)
    assert.equal(seriesColor(customized, name, 'red'), '#123456')
    assert.equal(Object.prototype.hasOwnProperty.call(current.seriesColors, name), false)
    const automatic = update(false)(customized)
    assert.notEqual(automatic.seriesColors, customized.seriesColors)
    assert.equal(Object.prototype.hasOwnProperty.call(automatic.seriesColors, name), false)
    assert.equal(seriesColor(automatic, name, 'red'), 'red')
    assert.equal(seriesColor(automatic, 'V', 'blue'), '#abcdef')
    assert.equal(seriesColor(customized, name, 'red'), '#123456')
  }
  const panel = { ...base, seriesColors: { I: '#123456', V: '#abcdef' } }
  assert.equal(seriesColor(base, 'I', 'red'), 'red')
  assert.equal(seriesColor(base, 'toString', 'red'), 'red')
  assert.equal(seriesColor({ ...base, seriesColors: Object.fromEntries([['toString', '#fedcba']]) }, 'toString', 'red'), '#fedcba')
  assert.equal(seriesColor(panel, 'I', 'red'), '#123456')
  const scatter = scatterRendererSeries({ ...panel, type: 'scatter',
    scatter: { ...panel.scatter, display: 'lines-markers' } }, { name: 'I', data: [[1, 2]] }, 'red')
  assert.equal(scatter.itemStyle.color, '#123456')
  assert.equal(scatter.lineStyle.color, '#123456')
  const combo = comboRendererSeries({ ...panel, type: 'combo', outputs: ['I', 'V'] },
    [{ name: 'I', data: [[1, 2]] }, { name: 'V', data: [[1, 3]] }], ['red', 'blue'])
  assert.deepEqual(combo.map(series => series.itemStyle.color), ['#123456', '#abcdef'])
  const automatic = comboRendererSeries({ ...base, type: 'combo', outputs: ['I', 'V'] },
    [{ name: 'I', data: [] }, { name: 'V', data: [] }], ['red', 'blue'])
  assert.deepEqual(automatic.map(series => series.itemStyle.color), ['red', 'blue'])
})

test('ChartPlot Line renderer resolves custom color and returns to its supplied palette', () => {
  const source = readFileSync(new URL('../src/ChartPlot.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('    return display.map(series => {')
  const end = source.indexOf('  }, [display, numericNames', start)
  assert.ok(start >= 0 && end > start)
  const render = panel => runInNewContext(stripTypeScriptTypes('(() => {' + source.slice(start, end) + '})'), {
    panel, display: [{ name: 'I', data: [[1, 2]] }], numericNames: ['I'], seriesColor,
    style: { getPropertyValue: () => 'red' },
  })()
  assert.equal(render({ ...base, seriesColors: { I: '#123456' } })[0].itemStyle.color, '#123456')
  assert.equal(render(base)[0].itemStyle.color, 'red')
})
