import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/VirtualizedOutputTable.tsx', import.meta.url), 'utf8')

test('window responses carry the page revision alongside rows and totals', () => {
  assert.match(source, /revision: number; total_rows: number/)
})

test('displayed rows and Iteration numbers use the snapshot total, not live metadata', () => {
  assert.match(source, /virtualOutputWindow\(window\.rows, window\.offset, window\.total_rows\)/)
  assert.doesNotMatch(source, /virtualOutputWindow\(window\.rows, window\.offset, rowCount\)/)
})

test('table geometry follows the displayed snapshot total', () => {
  assert.match(source, /const displayRowCount = window/)
  assert.match(source, /window\.total_rows : rowCount/)
  assert.match(source, /aria-rowcount=\{displayRowCount \+ 1\}/)
  assert.match(source, /displayRange\.topSpacerHeight/)
  assert.match(source, /displayRange\.bottomSpacerHeight/)
})

test('stale windows never match on revision equality with live metadata', () => {
  assert.doesNotMatch(source, /window\.revision === revision/)
  assert.doesNotMatch(source, /window\.revision === current/)
})

test('late older snapshots cannot overwrite newer windows', () => {
  assert.match(source, /response\.revision < current\.revision/)
})

test('stale run, page, and range responses are rejected', () => {
  assert.match(source, /response\.run_id !== desired\.runId \|\| response\.page !== desired\.page/)
  assert.match(source, /response\.offset !== desired\.start/)
})

test('revision updates refresh without starving the active range query', () => {
  assert.match(source, /activeQueryRef/)
  assert.match(source, /!activeQueryRef\.current\.settled/)
})
