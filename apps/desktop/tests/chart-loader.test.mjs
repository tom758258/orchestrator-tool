import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { chartLoadGroups, chartNeedsLoad, createPageChartData } from '../src/chartData.ts'

const source = readFileSync(new URL('../src/ResultChart.tsx', import.meta.url), 'utf8')

test('heterogeneous series are planned from their own local lengths with a 25k bound', () => {
  const data = createPageChartData()
  data.append('V', 0, Array.from({ length: 50_000 }, () => 1))
  const groups = chartLoadGroups(data, ['V', 'I'], 75_000, 25_000)
  assert.deepEqual(groups.map(group => [group.startRow, group.names, group.limit]), [
    [50_000, ['V'], 25_000],
    [0, ['I'], 25_000],
  ])
})

test('caught-up detection becomes false again as soon as a new row arrives', () => {
  const data = createPageChartData()
  data.append('V', 0, Array.from({ length: 25_000 }, () => 1))
  assert.equal(chartNeedsLoad(data, ['V'], 25_000), false)
  assert.equal(chartNeedsLoad(data, ['V'], 25_001), true)
})

test('each successful response still renders once after all response series append', () => {
  const loader = source.slice(source.indexOf('async function runLoader'))
  const appendAt = loader.indexOf('local.append(names[index], startRow, tails[index])')
  const bumpAt = loader.indexOf('setDataVersion(version => version + 1)')
  assert.ok(appendAt !== -1 && bumpAt !== -1 && appendAt < bumpAt)
  assert.equal(loader.match(/setDataVersion\(version => version \+ 1\)/g).length, 1)
  assert.doesNotMatch(source, /Promise\.all\(\[?\.\.\.groups/)
})

test('loader identity remains reversible and content-stable', () => {
  assert.match(source, /JSON\.stringify\(\[\.\.\.requestedNames\]\.sort\(\)\)/)
  assert.match(source, /JSON\.parse\(requestedKey\) as string\[\]/)
  assert.doesNotMatch(source, /join\('\\0'\)|split\('\\0'\)/)
})
