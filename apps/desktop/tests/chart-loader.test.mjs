import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/ResultChart.tsx', import.meta.url), 'utf8')

test('each successful chunk appends its whole response then notifies exactly once', () => {
  const loader = source.slice(source.indexOf('async function runLoader'))
  assert.match(loader, /for \(let index = 0; index < names\.length; index\+\+\)/)
  const appendAt = loader.indexOf('local.append(names[index], startRow, tails[index])')
  const bumpAt = loader.indexOf('setDataVersion(version => version + 1)')
  assert.ok(appendAt !== -1 && bumpAt !== -1 && appendAt < bumpAt)
  assert.equal(loader.match(/setDataVersion\(version => version \+ 1\)/g).length, 1)
  assert.doesNotMatch(source, /Promise\.all\(\[?\.\.\.groups/)
})

test('loader identity is content-stable and excludes progress metadata', () => {
  assert.ok(source.includes("[...requestedNames].sort().join('\\0')"))
  assert.match(source, /\[runId, page, requestedKey, chartData, loadGeneration\]/)
  assert.ok(!source.includes('requestedNames,'))
  assert.ok(!/\[runId, page, (revision|rowCount),/.test(source))
})

test('heterogeneous series progress regroups by local length until all catch up', () => {
  const loader = source.slice(source.indexOf('async function runLoader'))
  assert.match(loader, /const pending = outputs\.filter\(name => local\.length\(name\) < target\)/)
  assert.match(loader, /if \(pending\.length === 0\) break/)
  assert.match(loader, /for \(const name of pending\)/)
  assert.match(loader, /const start = local\.length\(name\)/)
  assert.doesNotMatch(loader, /let cursor = /)
})

test('group appends are atomic after a full preflight', () => {
  const loader = source.slice(source.indexOf('async function runLoader'))
  assert.match(loader, /response\.run_id !== runId \|\| response\.page !== page \|\| response\.start_row !== startRow/)
  assert.match(loader, /const tails = names\.map\(name => response\.series\[name\]\)/)
  assert.match(loader, /tails\.some\(tail => tail\.length !== tailLength\)/)
  assert.match(loader, /!names\.every\(name => local\.length\(name\) === startRow\)\) return/)
})

test('a single loader pass handles at most one chunk per group before regrouping', () => {
  const loader = source.slice(source.indexOf('async function runLoader'))
  assert.doesNotMatch(loader, /while \(!cancelled && cursor/)
  assert.match(loader, /if \(!progressed\) break/)
})
