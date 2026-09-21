import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPageChartData, exactHoverIndex, minMaxDecimate, numericOutputNames } from '../src/chartData.ts'

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
  assert.equal(y[401], 100)
  assert.equal(y[402], -100)
})

test('hover rounds and clamps the full raw sequence, independent of display points', () => {
  for (const [x, expected] of [[1, 0], [250_000, 249_999], [234_520.7, 234_520], [-5, 0], [600_000, 499_999]]) {
    assert.equal(exactHoverIndex(x, 500_000), expected)
  }
  assert.equal(exactHoverIndex(9, 1), 0)
  const x = sequence(100)
  const a = Float64Array.from(x, value => value * 2)
  const b = Float64Array.from(x, value => -value)
  assert.ok(!minMaxDecimate(x, a, 1).some(([iteration]) => iteration === 50))
  assert.equal(a[exactHoverIndex(50, 100)], 100)
  assert.equal(b[exactHoverIndex(50, 100)], -50)
})

test('Page adapter appends compact tails and shares each raw series once', () => {
  const page = createPageChartData()
  assert.equal(page.append('V', 0, [1, 2]), true)
  assert.equal(page.rowCount, 2)
  assert.ok(page.iteration instanceof Float64Array)
  assert.deepEqual([...page.iteration], [1, 2])
  const voltage = page.getSeries('V')
  assert.ok(voltage instanceof Float64Array)
  assert.equal(page.series.size, 1)
  assert.equal(page.getSeries('V').buffer, voltage.buffer)
  assert.equal(page.append('I', 0, [2, 4]), true)
  assert.deepEqual([...page.getSeries('I')], [2, 4])
  assert.equal(page.append('V', 2, [3]), true)
  assert.deepEqual([...page.getSeries('V')], [1, 2, 3])
  assert.equal(page.append('V', 1, [99]), false)
  assert.equal(page.series.size, 2)
  const other = createPageChartData()
  other.append('V', 0, [99])
  assert.deepEqual([...other.getSeries('V')], [99])
  assert.deepEqual([...voltage], [1, 2])
})

test('eligibility still requires every cell to be a finite number', () => {
  const rows = [{ outputs: [
    { name: 'finite', value: 1 }, { name: 'mixed', value: 1 },
    { name: 'infinite', value: Infinity }, { name: 'nan', value: NaN },
  ] }, { outputs: [
    { name: 'finite', value: 2 }, { name: 'mixed', value: '2' },
    { name: 'infinite', value: 2 }, { name: 'nan', value: 2 },
  ] }]
  assert.deepEqual(numericOutputNames(rows, ['finite', 'mixed', 'infinite', 'nan', 'missing']), ['finite'])
  assert.deepEqual(numericOutputNames([], ['finite']), [])
})

test('eligibility rejects missing and nonnumeric cells independently and preserves candidate order', () => {
  const invalid = [null, '2', true, {}, NaN, Infinity, -Infinity]
  const names = ['Power', 'Voltage', ...invalid.map((_, index) => `invalid-${index}`), 'missing']
  const rows = [1, 2, 3].map(value => ({ outputs: [
    { name: 'Voltage', value }, { name: 'Power', value: value * 2 },
    ...invalid.map((bad, index) => ({ name: `invalid-${index}`, value: value === 2 ? bad : value })),
    ...(value === 2 ? [] : [{ name: 'missing', value }]),
    { name: 'unrequested', value },
  ] }))
  assert.deepEqual(numericOutputNames(rows, names), ['Power', 'Voltage'])
  assert.deepEqual(numericOutputNames(rows, []), [])
})

test('duplicate cells cannot replace a missing row and retain first-cell eligibility', () => {
  const rows = [{ outputs: [
    { name: 'missing', value: 1 }, { name: 'missing', value: 2 },
    { name: 'invalidFirst', value: null }, { name: 'invalidFirst', value: 2 },
    { name: 'validFirst', value: 1 }, { name: 'validFirst', value: Infinity },
  ] }, { outputs: [
    { name: 'invalidFirst', value: 3 }, { name: 'validFirst', value: 3 },
  ] }]
  assert.deepEqual(numericOutputNames(rows, ['missing', 'invalidFirst', 'validFirst']), ['validFirst'])
})
