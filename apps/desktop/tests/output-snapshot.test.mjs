import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/VirtualizedOutputTable.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('window responses carry the exact page revision and total used by the request', () => {
  assert.match(source, /revision: number/)
  assert.match(source, /response\.revision !== requestedRevision/)
  assert.match(source, /response\.total_rows !== requestedRowCount/)
})

test('unresolved windows use request generations instead of deduping an old in-flight request', () => {
  assert.match(source, /if \(currentWindow\) return/)
  assert.match(source, /const generation = \+\+requestGenerationRef\.current/)
  assert.match(source, /requestGenerationRef\.current !== generation/)
  assert.doesNotMatch(source, /activeQueryRef|settled/)
  assert.match(source, /\[runId, page, revision, rowCount, range\.start, range\.end, currentWindow\]/)
})

test('an older viewport is rebased in place when live rows append', () => {
  assert.match(source, /rebaseNewestFirstWindow\(current\.offset, current\.total_rows, rowCount\)/)
  assert.match(source, /revision, total_rows: rebased\.totalRows, offset: rebased\.offset/)
})

test('only a current coherent window supplies rows and Iteration numbers', () => {
  assert.match(source, /window\.revision === revision/)
  assert.match(source, /window\.total_rows === rowCount/)
  assert.match(source, /window\.offset === range\.start/)
  assert.match(source, /virtualOutputWindow\(currentWindow\.rows, currentWindow\.offset, currentWindow\.total_rows\)/)
})

test('a pending replacement keeps the previous snapshot geometry coherent', () => {
  assert.match(source, /const displayRowCount = samePageWindow\?\.total_rows \?\? rowCount/)
  assert.match(source, /rowCount: samePageWindow\.total_rows/)
  assert.match(source, /aria-rowcount=\{displayRowCount \+ 1\}/)
  assert.match(source, /displayRange\.topSpacerHeight/)
  assert.match(source, /displayRange\.bottomSpacerHeight/)
  assert.match(source, /virtualOutputWindow\(displayWindow\.rows, displayWindow\.offset, displayWindow\.total_rows\)/)
})

test('a new run remounts the Output table at the latest position', () => {
  assert.ok(app.includes("key={`${displayedRun.run_id}:${runPage.name}`}"))
})
