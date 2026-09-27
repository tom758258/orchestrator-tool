import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { claimRunGate, isCurrentRunGeneration, prepareLastRunReplacement, releaseRunGate } from '../src/runLifecycle.ts'

test('Live and Simulation share one immediate run gate before React state can render', () => {
  const gate = { current: false }
  assert.equal(claimRunGate(gate), true)
  assert.equal(claimRunGate(gate), false)
  releaseRunGate(gate)
  assert.equal(claimRunGate(gate), true)
})

test('stale generations cannot publish progress or completion state', () => {
  assert.equal(isCurrentRunGeneration(4, 4), true)
  assert.equal(isCurrentRunGeneration(3, 4), false)
  assert.equal(isCurrentRunGeneration(null, 4), false)
})

test('both run entry points use the shared gate and preserve Chart configuration', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const live = source.slice(source.indexOf('const runLive'), source.indexOf('const runSimulation'))
  const simulation = source.slice(source.indexOf('const runSimulation'), source.indexOf('const workflowBusy'))
  for (const run of [live, simulation]) {
    assert.match(run, /claimRunGate\(runInFlightRef\)/)
    assert.match(run, /releaseRunGate\(runInFlightRef\)/)
    assert.doesNotMatch(run, /setChartPanels\(/)
  }
})

test('workflow replacement resolves only after the old StoredRun clears', async () => {
  const order = []
  const replacement = await prepareLastRunReplacement(
    async () => { order.push('load'); return { name: 'new' } },
    7,
    async runId => { order.push('clear:' + runId) },
  )
  order.push('commit')
  assert.deepEqual(order, ['load', 'clear:7', 'commit'])
  assert.deepEqual(replacement, { name: 'new' })
})

test('failed StoredRun clearing rejects replacement without reaching the caller commit point', async () => {
  let committed = false
  await assert.rejects(async () => {
    const replacement = await prepareLastRunReplacement(
      async () => ({ name: 'new' }),
      7,
      async () => { throw new Error('clear failed') },
    )
    committed = replacement.name === 'new'
  }, /clear failed/)
  assert.equal(committed, false)
})

test('off-tab Chart cleanup does not preserve an unmounted Page cache', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(source, /activeTab === 'output' \? runPage\?\.name : undefined/)
})

test('workflow replacement and Clear Last Run still clear Chart configuration and run caches stay isolated', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  for (const name of ['createDraft', 'handleLoadTemplate', 'handleClearLastRun']) {
    const start = source.indexOf(`const ${name} =`)
    assert.notEqual(start, -1, name)
    const next = source.indexOf('\n  const ', start)
    assert.match(source.slice(start, next), /setChartPanels\(\[\]\)/)
  }
  assert.match(source, /const chartData = useMemo\(\(\) => new Map<string, PageChartData>\(\), \[runMetadata\?\.run_id\]\)/)
  assert.match(source, /setChartPanels\(panels => reconcileRunChartPanels\(/)
})
