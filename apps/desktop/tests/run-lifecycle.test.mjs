import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claimRunGate, isCurrentRunGeneration, lastRunWorkspaceState, prepareLastRunReplacement, releaseRunGate } from '../src/runLifecycle.ts'

test('a started run keeps the Chart workspace render path before its first metadata', () => {
  assert.deepEqual(lastRunWorkspaceState(false, false, false), { starting: false, visible: false })
  assert.deepEqual(lastRunWorkspaceState(true, false, false), { starting: false, visible: false })
  assert.deepEqual(lastRunWorkspaceState(true, false, true), { starting: false, visible: true })
  assert.deepEqual(lastRunWorkspaceState(true, true, false), { starting: true, visible: true })
  assert.deepEqual(lastRunWorkspaceState(true, true, true), { starting: false, visible: true })
})

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
