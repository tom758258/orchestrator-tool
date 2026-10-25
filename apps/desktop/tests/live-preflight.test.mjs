import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { transformWithOxc } from 'vite'
import { allWorkflowSteps } from '../src/workflow.ts'

const source = readFileSync(new URL('../src/useLivePreflight.ts', import.meta.url), 'utf8')
const { code } = await transformWithOxc(source, 'useLivePreflight.ts')
const body = code.replace(/import .+? from ".+?";/g, '').replace('export function', 'function')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve() }

function harness() {
  const state = [], effects = [], timers = [], queries = []
  let cursor = 0
  const useState = initial => {
    const i = cursor++
    if (!(i in state)) state[i] = initial
    return [state[i], value => { state[i] = value }]
  }
  const useEffect = (callback, deps) => {
    const i = cursor++
    if (!state[i] || deps.some((value, j) => value !== state[i].deps[j])) {
      state[i]?.cleanup?.()
      effects.push(() => { state[i] = { deps, cleanup: callback() } })
    }
  }
  const invoke = (command, args) => {
    const query = deferred()
    queries.push({ command, args, ...query })
    return query.promise
  }
  const hook = new Function('useEffect', 'useState', 'invoke', 'allWorkflowSteps', 'setTimeout', 'clearTimeout',
    `${body}; return useLivePreflight`)(useEffect, useState, invoke, allWorkflowSteps,
    callback => { const timer = { callback }; timers.push(timer); return timer }, timer => { timer.cancelled = true })
  const draft = { tool_instances: [{ id: 'power', tool: 'powers', setup: {} }], workflow: { steps: [
    { type: 'tool-action', id: 'off', target: 'power', action: 'output-off', arguments: { channel: 1 } },
  ] } }
  const args = ['simulate', draft, { power: 'USB::1' }, { power: 'USB::1' },
    { power: { model_id: 'model-1' } }, { power: { model_id: 'model-1' } }, 'powers.exe', 'scopes.exe', false, {}, {}]
  return {
    args, queries,
    render() { cursor = 0; const value = hook(...args); effects.splice(0).forEach(effect => effect()); return value },
    timers() { timers.splice(0).forEach(timer => { if (!timer.cancelled) timer.callback() }) },
  }
}

test('live_preflight automatically checks Live, aggregates failure, and requires a fresh pass after editing', async () => {
  const h = harness()
  assert.equal(h.render().blocked, false)
  h.timers()
  assert.equal(h.queries.length, 0)
  h.args[0] = 'live'
  assert.equal(h.render().blocked, true)
  assert.equal(h.render().status, 'checking')
  h.timers()
  assert.equal(h.queries[0].command, 'check_live_preflight')
  assert.deepEqual(JSON.parse(h.queries[0].args.templateJson), h.args[1])
  h.queries[0].resolve(['unsupported channel', 'unsupported setup'])
  await settle()
  assert.equal(h.render().status, 'failed')
  assert.equal(h.render().errors.length, 2)
  h.args[1] = { ...h.args[1], tool_instances: [{ ...h.args[1].tool_instances[0], setup: { protection: {} } }] }
  assert.equal(h.render().status, 'checking')
  h.timers()
  h.queries[1].resolve([])
  await settle()
  assert.equal(h.render().blocked, false)
})

test('live_preflight discards stale responses and debounces edits, then releases Simulation', async () => {
  const h = harness()
  h.args[0] = 'live'
  h.render(); h.timers()
  for (let channel = 2; channel <= 4; channel++) {
    h.args[1] = { ...h.args[1], workflow: { steps: [{ ...h.args[1].workflow.steps[0], arguments: { channel } }] } }
    assert.equal(h.render().blocked, true)
  }
  h.queries[0].resolve([])
  await settle()
  assert.equal(h.render().status, 'checking')
  h.timers()
  assert.equal(h.queries.length, 2)
  h.queries[1].resolve(['channel 4 unsupported'])
  await settle()
  assert.equal(h.render().status, 'failed')
  h.args[0] = 'simulate'
  assert.equal(h.render().blocked, false)
  h.timers()
  assert.equal(h.queries.length, 2)
})

test('live_preflight invalidates saved Resource, Model, executables and Template; unsaved edits never pass', async () => {
  const h = harness()
  h.args[0] = 'live'
  h.render(); h.timers(); h.queries[0].resolve([]); await settle()
  assert.equal(h.render().status, 'passed')
  // Loading the same Template still invalidates its earlier pass.
  h.args[8] = true
  assert.equal(h.render().blocked, true)
  h.timers()
  h.args[8] = false
  assert.equal(h.render().blocked, true)
  h.timers(); h.queries.at(-1).resolve([]); await settle()
  assert.equal(h.render().status, 'passed')
  for (const mutate of [
    () => { h.args[6] = 'new-powers.exe' },
    () => { h.args[7] = 'new-scopes.exe' },
    () => { h.args[2] = h.args[3] = { power: 'USB::2' } },
    () => { h.args[9] = h.args[10] = { power: '@py' } },
    () => { h.args[4] = h.args[5] = { power: { model_id: 'model-2' } } },
    () => { h.args[1] = { ...h.args[1], name: 'New template' } },
  ]) {
    mutate()
    assert.equal(h.render().blocked, true)
    h.timers(); h.queries.at(-1).resolve([]); await settle()
    assert.equal(h.render().status, 'passed')
  }
  const before = h.queries.length
  h.args[10] = { power: 'system' }
  assert.equal(h.render().blocked, true)
  assert.equal(h.render().status, 'failed')
  h.timers()
  assert.equal(h.queries.length, before)
  h.args[10] = h.args[9]
  h.args[3] = { power: 'UNSAVED' }
  assert.equal(h.render().blocked, true)
  assert.match(h.render().errors[0], /unsaved Live Resource/)
  h.timers()
  assert.equal(h.queries.length, before)
  h.args[3] = h.args[2]
  h.args[5] = { power: { model_id: 'unsaved-model' } }
  h.render()
  assert.equal(h.render().status, 'failed')
  h.args[5] = h.args[4]
  h.render(); h.timers(); h.queries.at(-1).resolve([]); await settle()
  assert.equal(h.render().status, 'passed')
})

test('live_preflight query failures and backend rejection fail closed until inputs change', async () => {
  const h = harness()
  h.args[0] = 'live'
  h.render(); h.timers(); h.queries[0].reject('executable unavailable'); await settle()
  assert.equal(h.render().status, 'failed')
  assert.equal(h.render().blocked, true)
  h.args[6] = 'restored.exe'
  h.render(); h.timers(); h.queries[1].resolve([]); await settle()
  h.args[0] = 'simulate'
  assert.equal(h.render().blocked, false)
  h.args[0] = 'live'
  assert.equal(h.render().blocked, true)
  h.timers(); h.queries[2].resolve([]); await settle()
  h.render().reject('Live Preflight failed: changed model')
  assert.equal(h.render().status, 'failed')
  assert.equal(h.render().blocked, true)
})
