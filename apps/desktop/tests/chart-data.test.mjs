import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  createPageChartData,
  exactHoverIndex,
  nearestScatterHover,
  minMaxDecimate,
  minMaxDecimateRange,
  prepareChartSeries,
  pruneChartData,
} from '../src/chartData.ts'
import { addChartPanel } from '../src/chartPanels.ts'

const sequence = count => Float64Array.from({ length: count }, (_, index) => index + 1)

test('small and empty data remain complete without modifying raw arrays', () => {
  const x = sequence(4)
  const y = Float64Array.of(3, -4, 9, 1)
  assert.deepEqual(minMaxDecimate(x, y, 2), [[1, 3], [2, -4], [3, 9], [4, 1]])
  assert.deepEqual([...x], [1, 2, 3, 4])
  assert.deepEqual([...y], [3, -4, 9, 1])
  assert.deepEqual(minMaxDecimate(new Float64Array(), new Float64Array(), 800), [])
  assert.deepEqual(minMaxDecimate(sequence(1), Float64Array.of(7), 0), [[1, 7]])
})

test('large monotonic data retain endpoints and ordered raw points within a pixel-based bound', () => {
  const x = sequence(500_000)
  for (const width of [1, 320, 800, 1200.5]) {
    const points = minMaxDecimate(x, x, width)
    assert.ok(points.length <= Math.floor(width) * 2 + 2)
    assert.deepEqual(points[0], [1, 1])
    assert.deepEqual(points.at(-1), [500_000, 500_000])
    for (let i = 1; i < points.length; i++) {
      assert.ok(points[i][0] > points[i - 1][0])
      assert.equal(points[i][1], x[points[i][0] - 1])
    }
  }
  assert.ok(minMaxDecimate(x, x, 320).length < minMaxDecimate(x, x, 800).length)
})

test('spikes, dips and first/last values survive even with extrema in reverse order', () => {
  const x = sequence(10_003)
  const y = new Float64Array(x.length)
  y[0] = 2
  y[401] = 100
  y[402] = -100
  y[y.length - 1] = 3
  const points = minMaxDecimate(x, y, 100)
  assert.ok(points.some(([x, y]) => x === 402 && y === 100))
  assert.ok(points.some(([x, y]) => x === 403 && y === -100))
  assert.deepEqual(points[0], [1, 2])
  assert.deepEqual(points.at(-1), [10_003, 3])
  assert.ok(points.length <= 202)
  assert.ok(points.every(([value], index) => index === 0 || value > points[index - 1][0]))
})

test('hover resolves exact raw indices only inside the raw iteration domain', () => {
  for (const [x, expected] of [[1, 0], [250_000, 249_999], [234_520.7, 234_520],
    [0, null], [-5, null], [500_001, null], [600_000, null], [NaN, null], [Infinity, null]]) {
    assert.equal(exactHoverIndex(x, 500_000), expected)
  }
  assert.equal(exactHoverIndex(1, 1), 0)
  assert.equal(exactHoverIndex(9, 1), null)
  assert.equal(exactHoverIndex(1, 0), null)
})

test('Scatter hover selects the nearest real raw point in screen space', () => {
  const x = Float64Array.of(0, 1, 2, 3, 2, 1, 0)
  const y = Float64Array.of(0, 2, 4, 6, 8, 10, 12)
  const y2 = Float64Array.of(20, 21, 22, 23, 24, 25, 26)
  assert.deepEqual(nearestScatterHover(x, [y], 2, 7.8, 1, 1, 1, false),
    { rowIndex: 4, seriesIndex: 0 })
  assert.deepEqual(nearestScatterHover(x, [y], 2, 4.2, 1, 1, 1, false),
    { rowIndex: 2, seriesIndex: 0 })
  assert.deepEqual(nearestScatterHover(x, [y, y2], 3, 23.1, 1, 1, 1, false),
    { rowIndex: 3, seriesIndex: 1 })
  assert.equal(nearestScatterHover(Float64Array.of(0), [Float64Array.of(0)],
    3, 0, 1, 1, 2, false), null)
})

test('Scatter line hover uses line proximity but reports a real endpoint row', () => {
  const x = Float64Array.of(0, 10)
  const y = Float64Array.of(0, 0)
  assert.equal(nearestScatterHover(x, [y], 5, 0, 1, 1, 1, false), null)
  assert.deepEqual(nearestScatterHover(x, [y], 4, 0, 1, 1, 1, true),
    { rowIndex: 0, seriesIndex: 0 })
  assert.deepEqual(nearestScatterHover(x, [y], 6, 0, 1, 1, 1, true),
    { rowIndex: 1, seriesIndex: 0 })
  assert.equal(nearestScatterHover(x, [y], 5, 0, 0, 1, 1, true), null)
})

test('Scatter hover handles 100,000 raw rows without sampling or indexing assumptions', () => {
  const count = 100_000
  const x = Float64Array.from({ length: count }, (_, index) => index)
  const y = Float64Array.from({ length: count }, (_, index) => index * 2)
  assert.deepEqual(nearestScatterHover(x, [y], 54_321, 108_642, 1, 2, 2, true),
    { rowIndex: 54_321, seriesIndex: 0 })
})

test('viewport decimation reads only its raw slice and retains line-clipping neighbors', () => {
  const x = sequence(1000)
  const points = minMaxDecimateRange(x, x, 100, { min: 400, max: 410 })
  assert.deepEqual(points.map(([iteration]) => iteration),
    Array.from({ length: 13 }, (_, index) => index + 399))
  assert.deepEqual(minMaxDecimateRange(x, x, 100, { min: 1001, max: 2000 }), [])
  assert.deepEqual(minMaxDecimateRange(x, x, 100, { min: -100, max: 0 }), [])
})

test('large viewport remains pixel-bounded while retaining its spike and dip', () => {
  const x = sequence(500_000)
  const y = new Float64Array(x.length)
  y[202_344] = 100
  y[202_345] = -100
  const points = minMaxDecimateRange(x, y, 320, { min: 200_000, max: 205_000 })
  assert.ok(points.length <= 642)
  assert.deepEqual(points[0], [199_999, 0])
  assert.deepEqual(points.at(-1), [205_001, 0])
  assert.ok(points.some(([iteration, value]) => iteration === 202_345 && value === 100))
  assert.ok(points.some(([iteration, value]) => iteration === 202_346 && value === -100))
  assert.ok(points.every(([iteration]) => iteration >= 199_999 && iteration <= 205_001))
})

test('deep zoom exposes more raw detail than full-range decimation', () => {
  const x = sequence(100_000)
  const y = Float64Array.from(x, (_, index) => index % 2)
  const full = minMaxDecimateRange(x, y, 100, { min: 1, max: 100_000 })
  const local = minMaxDecimateRange(x, y, 100, { min: 20_000, max: 20_100 })
  assert.ok(full.length <= 202)
  assert.ok(local.length >= 101)
  assert.ok(local.filter(([iteration]) => iteration >= 20_000 && iteration <= 20_100).length >
    full.filter(([iteration]) => iteration >= 20_000 && iteration <= 20_100).length)
})

test('Page adapter appends compact tails and shares each raw series once', () => {
  const page = createPageChartData()
  assert.equal(page.append('V', 0, [1, 2]), true)
  const voltage = page.getSeries('V')
  assert.equal(page.getSeries('V').buffer, voltage.buffer)
  assert.equal(page.append('I', 0, [2, 4]), true)
  assert.equal(page.append('V', 2, [3]), true)
  assert.equal(page.append('V', 1, [99]), false)
  assert.deepEqual([...page.getSeries('V')], [1, 2, 3])
  assert.equal(page.commonLength(['V', 'I']), 2)
})

test('global Chart cleanup removes off-Page caches with no consumer', () => {
  const a = createPageChartData()
  const b = createPageChartData()
  a.append('V', 0, [1, 2, 3])
  b.append('V', 0, [4, 5])
  const cache = new Map([['A', a], ['B', b]])
  pruneChartData(cache, [addChartPanel([], 'B', ['V'])[0]])
  assert.equal(cache.has('A'), false)
  assert.equal(cache.get('B'), b)
})

test('partial Chart cleanup drops unused series and shrinks the shared iteration buffer', () => {
  const page = createPageChartData()
  page.append('V', 0, [1, 2])
  page.append('I', 0, Array.from({ length: 1000 }, (_, index) => index))
  const oldBytes = page.iteration.buffer.byteLength
  const cache = new Map([['A', page]])
  pruneChartData(cache, [addChartPanel([], 'A', ['V'])[0]])
  assert.deepEqual([...page.getSeries('V')], [1, 2])
  assert.equal(page.getSeries('I').length, 0)
  assert.deepEqual([...page.iteration], [1, 2])
  assert.ok(page.iteration.buffer.byteLength < oldBytes)
})

test('ChartPlot refreshes raw typed-array views after live appends or cleanup', () => {
  const source = readFileSync(new URL('../src/ChartPlot.tsx', import.meta.url), 'utf8')
  assert.match(source, /\[data, data\.version, panel\.outputs, rawRowCount, isStatistical\]/)
  assert.match(source, /\[panel, data, data\.version, width, visibleRange\.min, visibleRange\.max, isStatistical, changeSettings\]/)
})

test('ChartPlot uses the common selected-series prefix for axis, decimation, and hover', () => {
  const source = readFileSync(new URL('../src/ChartPlot.tsx', import.meta.url), 'utf8')
  assert.match(source, /data\.commonLength\(chartRequiredOutputs\(panel\)\)/)
  assert.match(source, /data\.iteration\.subarray\(0, rawRowCount\)/)
  assert.match(source, /exactHoverIndex\(x, rawRowCount\)/)
  assert.match(source, /nearestScatterHover\(scatterXValues, yValues/)
})

test('Scatter X remains cached when it is not selected as a Y Output', () => {
  const data = createPageChartData()
  data.append('V', 0, [1, 2, 3])
  data.append('I', 0, [4, 5, 6])
  data.append('unused', 0, [7, 8, 9])
  const panel = { ...addChartPanel([], 'A', ['I'])[0], type: 'scatter', scatterXOutput: 'V' }
  pruneChartData(new Map([['A', data]]), [panel])
  assert.deepEqual([...data.getSeries('V')], [1, 2, 3])
  assert.deepEqual([...data.getSeries('I')], [4, 5, 6])
  assert.equal(data.getSeries('unused').length, 0)
})

test('threshold buckets select qualifying Max, Min, or both in original order', () => {
  const x = sequence(4)
  assert.deepEqual(minMaxDecimate(x, Float64Array.of(100, 140, 160, 150), 1, 30),
    [[1, 100], [3, 160], [4, 150]])
  assert.deepEqual(minMaxDecimate(x, Float64Array.of(100, 65, 40, 60), 1, 30),
    [[1, 100], [3, 40], [4, 60]])
  assert.deepEqual(minMaxDecimate(x, Float64Array.of(100, 140, 50, 160), 1, 30),
    [[1, 100], [3, 50], [4, 160]])
  assert.deepEqual(minMaxDecimate(x, Float64Array.of(100, 160, 50, 140), 1, 30),
    [[1, 100], [2, 160], [3, 50], [4, 140]])
  // Quiet buckets still carry the line to their final raw sample.
  assert.deepEqual(minMaxDecimate(x, Float64Array.of(100, 110, 120, 115), 1, 30),
    [[1, 100], [4, 115]])
})

test('quiet buckets retain the comparison reference for cumulative drift', () => {
  const values = Float64Array.of(100, 101, 102, 103, 104, 104, 105, 106, 106, 106, 106, 106)
  assert.deepEqual(minMaxDecimate(sequence(values.length), values, 4, 5),
    [[1, 100], [3, 102], [6, 104], [8, 106], [12, 106]])
})

test('zero, invalid raw values and disabled mode do not break threshold sampling', () => {
  const x = sequence(4)
  assert.deepEqual(minMaxDecimate(x, Float64Array.of(0, -5, 3, 0), 1, 50),
    [[1, 0], [2, -5], [3, 3], [4, 0]])
  assert.deepEqual(minMaxDecimate(x, Float64Array.of(0, -5, 3, 0), 1, 101),
    [[1, 0], [4, 0]])
  assert.deepEqual(minMaxDecimate(x, Float64Array.of(100, NaN, 160, 120), 1, 30),
    [[1, 100], [3, 160], [4, 120]])
  const values = Float64Array.of(100, 140, 50, 160)
  const baseline = minMaxDecimate(x, values, 1)
  for (const disabled of [null, 0, -1, NaN, Infinity]) {
    assert.deepEqual(minMaxDecimate(x, values, 1, disabled), baseline)
  }
  assert.deepEqual([...values], [100, 140, 50, 160])
})

test('threshold sampler stays bounded, ordered and viewport-local at 500k rows', () => {
  const x = sequence(500_000)
  const y = Float64Array.from(x, (_, index) => [100, 160, 50, 140][index % 4])
  const points = minMaxDecimate(x, y, 320, 30)
  assert.ok(points.length <= 642)
  assert.ok(points.every(([iteration], index) => index === 0 || iteration > points[index - 1][0]))
  assert.deepEqual(points[0], [1, 100])
  assert.deepEqual(points.at(-1), [500_000, 140])
  const zoomed = minMaxDecimateRange(x, y, 320, { min: 200_000, max: 205_000 }, 30)
  assert.ok(zoomed.length <= 642)
  assert.ok(zoomed[0][0] >= 199_999 && zoomed.at(-1)[0] <= 205_001)
})

test('selected Line Outputs sample independently and non-Line charts ignore the threshold', () => {
  const chart = createPageChartData()
  chart.append('V', 0, [100, 140, 50, 160])
  chart.append('I', 0, [10, 12, 14, 13])
  const panel = { ...addChartPanel([], 'A', ['V'])[0], outputs: ['V', 'I'] }
  const range = { min: 1, max: 4 }
  const enabled = prepareChartSeries(panel, chart, 1, range, { enabled: true, thresholdPercent: 30 })
  assert.deepEqual(enabled[0].data, [[1, 100], [3, 50], [4, 160]])
  assert.deepEqual(enabled[1].data, [[1, 10], [3, 14], [4, 13]])
  const area = { ...panel, type: 'area' }
  assert.deepEqual(prepareChartSeries(area, chart, 1, range, { enabled: true, thresholdPercent: 30 }),
    prepareChartSeries(area, chart, 1, range))
})

test('Show All Raw Data bypasses Line sampling for the visible viewport and is reversible', () => {
  const chart = createPageChartData()
  const raw = Array.from({ length: 40 }, (_, index) => index * 3)
  chart.append('V', 0, raw)
  const panel = addChartPanel([], 'A', ['V'])[0]
  const all = { ...panel, showAllRawData: true }
  const setting = { enabled: true, thresholdPercent: 30 }
  const fullRange = { min: 1, max: 40 }
  const reduced = prepareChartSeries(panel, chart, 1, fullRange, setting)[0].data
  assert.ok(reduced.length <= 4)
  assert.deepEqual(prepareChartSeries(all, chart, 1, fullRange, setting)[0].data,
    raw.map((value, index) => [index + 1, value]))
  // Zoom includes one clipping neighbor each side, as in the existing Min/Max path.
  assert.deepEqual(prepareChartSeries(all, chart, 1, { min: 10, max: 14 }, setting)[0].data,
    [[9, 24], [10, 27], [11, 30], [12, 33], [13, 36], [14, 39], [15, 42]])
  assert.deepEqual(prepareChartSeries({ ...all, showAllRawData: false }, chart, 1, fullRange, setting)[0].data,
    reduced)
  assert.deepEqual([...chart.getSeries('V')], raw)
  const area = { ...all, type: 'area' }
  assert.deepEqual(prepareChartSeries(area, chart, 1, fullRange, setting),
    prepareChartSeries({ ...area, showAllRawData: false }, chart, 1, fullRange, setting))
})

test('25k-row incremental chart loading preserves threshold sampling across the boundary', () => {
  const count = 50_002
  const x = sequence(count)
  const y = Float64Array.from(x, (_, index) => [100, 160, 50, 140][index % 4])
  const chart = createPageChartData()
  assert.equal(chart.append('V', 0, [...y.subarray(0, 25_000)]), true)
  assert.equal(chart.append('V', 25_000, [...y.subarray(25_000)]), true)
  const panel = addChartPanel([], 'A', ['V'])[0]
  assert.deepEqual(prepareChartSeries(panel, chart, 1, { min: 1, max: count },
    { enabled: true, thresholdPercent: 30 })[0].data, minMaxDecimate(x, y, 1, 30))
})
