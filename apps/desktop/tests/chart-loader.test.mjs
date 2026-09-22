import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/ResultChart.tsx', import.meta.url), 'utf8')

test('each successful chunk appends its whole response then notifies once', () => {
  const loader = source.slice(source.indexOf('async function runLoader'))
  assert.match(loader, /for \(let index = 0; index < names\.length; index\+\+\)/)
  const appendAt = loader.indexOf('local.append(names[index], startRow, tails[index])')
  const bumpAt = loader.indexOf('setDataVersion(version => version + 1)')
  assert.ok(appendAt !== -1 && bumpAt !== -1 && appendAt < bumpAt)
  assert.equal(loader.match(/setDataVersion\(version => version \+ 1\)/g).length, 1)
  assert.doesNotMatch(source, /Promise\.all\(\[?\.\.\.groups/)
})

test('loader identity is reversible and content-stable without a delimiter assumption', () => {
  assert.match(source, /JSON\.stringify\(\[\.\.\.requestedNames\]\.sort\(\)\)/)
  assert.match(source, /JSON\.parse\(requestedKey\) as string\[\]/)
  assert.doesNotMatch(source, /join\('\\0'\)|split\('\\0'\)/)
  assert.match(source, /\[runId, page, requestedKey, chartData, loadGeneration\]/)
})

test('heterogeneous series regroup by local length and each request remains bounded', () => {
  const loader = source.slice(source.indexOf('async function runLoader'))
  assert.match(loader, /const pending = outputs\.filter\(name => local\.length\(name\) < target\)/)
  assert.match(loader, /const start = local\.length\(name\)/)
  assert.match(loader, /Math\.min\(CHART_SERIES_CHUNK_ROWS, latest - startRow\)/)
  assert.match(source, /CHART_SERIES_CHUNK_ROWS = 25_000/)
})

test('group appends preflight every requested series before mutation', () => {
  const loader = source.slice(source.indexOf('async function runLoader'))
  assert.match(loader, /const tails = names\.map\(name => response\.series\[name\]\)/)
  assert.match(loader, /tails\.some\(tail => tail\.length !== tailLength\)/)
  assert.match(loader, /!names\.every\(name => local\.length\(name\) === startRow\)\) return/)
})

test('loader closeout rechecks a row that arrived at the caught-up boundary', () => {
  const closeout = source.slice(source.indexOf('finally {'), source.indexOf('void runLoader'))
  assert.match(closeout, /loaderActiveRef\.current = null/)
  assert.match(closeout, /if \(!cancelled && caughtUp\)/)
  assert.match(closeout, /outputs\.some\(name => local\.length\(name\) < latest\)/)
  assert.match(closeout, /setLoadGeneration\(generation => generation \+ 1\)/)
})

test('dropping the last requested series releases the page raw chart cache', () => {
  assert.match(source, /if \(outputs\.length === 0\) \{\s*chartData\.delete\(page\)/)
})
