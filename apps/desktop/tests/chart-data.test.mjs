import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  createPageChartData,
  exactHoverIndex,
  minMaxDecimate,
  minMaxDecimateRange,
  pruneChartData,
} from '../src/chartData.ts'

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
  pruneChartData(cache, [{ page: 'B', outputs: ['V'] }])
  assert.equal(cache.has('A'), false)
  assert.equal(cache.get('B'), b)
})

test('partial Chart cleanup drops unused series and shrinks the shared iteration buffer', () => {
  const page = createPageChartData()
  page.append('V', 0, [1, 2])
  page.append('I', 0, Array.from({ length: 1000 }, (_, index) => index))
  const oldBytes = page.iteration.buffer.byteLength
  const cache = new Map([['A', page]])
  pruneChartData(cache, [{ page: 'A', outputs: ['V'] }])
  assert.deepEqual([...page.getSeries('V')], [1, 2])
  assert.equal(page.getSeries('I').length, 0)
  assert.deepEqual([...page.iteration], [1, 2])
  assert.ok(page.iteration.buffer.byteLength < oldBytes)
})

test('ChartPlot refreshes raw typed-array views after live appends or cleanup', () => {
  const source = readFileSync(new URL('../src/ChartPlot.tsx', import.meta.url), 'utf8')
  assert.match(source, /\[data, data\.version, panel\.outputs\]/)
})

test('ChartPlot uses the common selected-series prefix for axis, decimation, and hover', () => {
  const source = readFileSync(new URL('../src/ChartPlot.tsx', import.meta.url), 'utf8')
  assert.match(source, /data\.commonLength\(panel\.outputs\)/)
  assert.match(source, /data\.iteration\.subarray\(0, rawRowCount\)/)
  assert.match(source, /exactHoverIndex\(x, rawRowCount\)/)
})
