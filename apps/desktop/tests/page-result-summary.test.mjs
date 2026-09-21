import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { summarizePageResults } from '../src/numericSummary.ts'

const row = value => ({ page: 'A', outputs: [{ name: 'Voltage', value }], for_iteration: null, while_iteration: null })

test('numeric summary semantics count only finite JSON numbers', () => {
  assert.deepEqual(summarizePageResults([1, null, '2', 3, true, {}, [], NaN, Infinity].map(row)), [
    { name: 'Voltage', count: 2, min: 1, max: 3, avg: 2 },
  ])
})

test('non-numeric columns and empty rows produce no summary', () => {
  assert.deepEqual(summarizePageResults([null, '2', false, {}, []].map(row)), [])
  assert.deepEqual(summarizePageResults([]), [])
})

test('Page Result Summary consumes Rust metadata without scanning ResultRows', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const component = readFileSync(new URL('../src/PageResultSummary.tsx', import.meta.url), 'utf8')
  assert.match(app, /<PageResultSummary summaries=\{runPageMetadata\.summaries\} \/>/)
  assert.match(component, /summaries: readonly NumericSummary\[\]/)
  assert.doesNotMatch(component, /ResultRowDto|summarizePageResults/)
})
