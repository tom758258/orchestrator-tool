import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'

test('Page Result Summary consumes Rust metadata without scanning ResultRows', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const component = readFileSync(new URL('../src/PageResultSummary.tsx', import.meta.url), 'utf8')
  assert.match(app, /<PageResultSummary summaries=\{runPageMetadata\.summaries\} \/>/)
  assert.match(component, /summaries: readonly NumericSummary\[\]/)
  assert.doesNotMatch(component, /ResultRowDto|summarizePageResults/)
})

test('Summary defaults and optional derived columns use metadata and preserve missing sigma', () => {
  const source = readFileSync(new URL('../src/PageResultSummary.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('const columns =')
  const end = source.indexOf('export default', start)
  assert.ok(start >= 0 && end > start)
  const columns = runInNewContext(stripTypeScriptTypes(source.slice(start, end) + '\ncolumns'))
  assert.deepEqual(Array.from(columns.filter(column => column.default), column => column.key),
    ['count', 'min', 'max', 'avg'])
  const summary = { name: 'V', count: 4, min: 1, max: 4, avg: 2.5, std_dev: 1.2909944487358056 }
  const values = Object.fromEntries(columns.map(column => [column.key, column.value(summary)]))
  assert.equal(values.range, 3)
  assert.equal(values.stdDev, summary.std_dev)
  assert.equal(values.twoSigma, summary.std_dev * 2)
  assert.equal(values.threeSigma, summary.std_dev * 3)
  for (const std_dev of [null, 0]) {
    const constant = { ...summary, count: std_dev === null ? 1 : 3, min: 7, max: 7, std_dev }
    const derived = Object.fromEntries(columns.map(column => [column.key, column.value(constant)]))
    assert.equal(derived.range, 0)
    assert.equal(derived.stdDev, std_dev)
    assert.equal(derived.twoSigma, std_dev)
    assert.equal(derived.threeSigma, std_dev)
  }
})
