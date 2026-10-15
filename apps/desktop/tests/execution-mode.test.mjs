import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const setup = readFileSync(new URL('../src/ToolSetupEditor.tsx', import.meta.url), 'utf8')

test('capability queries select simulator identity only in Simulation', () => {
  assert.match(setup, /model=\{executionMode === 'live' \? resourceIdentities\[instance\.id\]\?\.model : undefined\}/)
  assert.match(setup, /modelId=\{executionMode === 'live' \? resourceIdentities\[instance\.id\]\?\.model_id : undefined\}/)
  assert.match(setup, /get_meters_capabilities[\s\S]*executionMode/)
  assert.match(setup, /get_powers_capabilities[\s\S]*executionMode/)
})

test('Live Resource remains stored for Live mode and saving it does not switch modes', () => {
  assert.match(app, /Stored for Live mode\. Current execution mode is Simulation\./)
  const handler = app.slice(app.indexOf('const handleResource'), app.indexOf('const refreshPowersStatus'))
  assert.doesNotMatch(handler, /setExecutionMode/)
})
