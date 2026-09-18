import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { summarizePageResults } from '../src/numericSummary.ts'

const row = (value, page = 'A') => ({
  page, outputs: [{ name: 'Voltage', value }], for_iteration: null, while_iteration: null,
})

test('numeric samples produce Count, Min, Max and arithmetic Avg', () => {
  assert.deepEqual(summarizePageResults([1, 2, 3].map(value => row(value))), [
    { name: 'Voltage', count: 3, min: 1, max: 3, avg: 2 },
  ])
})

test('mixed cells count only finite JSON numbers', () => {
  const values = [1, null, '2', 3, true, {}, [], NaN, Infinity]
  assert.deepEqual(summarizePageResults(values.map(value => row(value))), [
    { name: 'Voltage', count: 2, min: 1, max: 3, avg: 2 },
  ])
})

test('non-numeric columns and empty rows produce no summary', () => {
  assert.deepEqual(summarizePageResults([null, '2', false, {}, []].map(value => row(value))), [])
  assert.deepEqual(summarizePageResults([]), [])
})

test('Outputs are summarized independently', () => {
  const rows = [1, 2, 3].map(value => ({
    ...row(value), outputs: [...row(value).outputs, { name: 'Current', value: value * 10 }],
  }))
  assert.deepEqual(summarizePageResults(rows), [
    { name: 'Voltage', count: 3, min: 1, max: 3, avg: 2 },
    { name: 'Current', count: 3, min: 10, max: 30, avg: 20 },
  ])
})

test('Summary uses the selected Run Page rows without mixing Pages', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const declaration = source.match(/const pageRows = (.+)/)[1]
  assert.ok(source.includes('<PageResultSummary rows={pageRows} />'))
  const displayedRun = { result_rows: [row(100, 'A'), row(2, 'B'), row(4, 'B')] }
  for (const [name, count, min, max, avg] of [['A', 1, 100, 100, 100], ['B', 2, 2, 4, 3]]) {
    const rows = runInNewContext(declaration, { displayedRun, runPage: { name } })
    assert.deepEqual(summarizePageResults(rows), [{ name: 'Voltage', count, min, max, avg }])
  }
})
