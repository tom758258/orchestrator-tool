import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('Page Result Summary consumes Rust metadata without scanning ResultRows', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const component = readFileSync(new URL('../src/PageResultSummary.tsx', import.meta.url), 'utf8')
  assert.match(app, /<PageResultSummary summaries=\{runPageMetadata\.summaries\} \/>/)
  assert.match(component, /summaries: readonly NumericSummary\[\]/)
  assert.doesNotMatch(component, /ResultRowDto|summarizePageResults/)
})
