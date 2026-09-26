import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const setup = fs.readFileSync(new URL('../src/ToolSetupEditor.tsx', import.meta.url), 'utf8')

test('Powers Device Status is explicit, mode-aware, and runtime-only', () => {
  assert.match(app, /Refresh Status/)
  assert.match(app, /savedResource\?\.trim\(\).*draftResource === savedResource/s)
  assert.match(app, /refresh_powers_status/)
  assert.match(app, /clear_powers_protection/)
  assert.match(app, /manualOperationRequiresSavedResource\(executionMode\)/)
  assert.match(app, /Uses the simulator model\. No saved Live Resource is required/)
  assert.match(app, /PLAN GENERATED · SIMULATION/)
  assert.match(app, /No real protection latch was changed/)
  assert.match(app, /Not saved in Template/)
  assert.doesNotMatch(app, /setInterval\([^)]*refreshPowersStatus/)
})

test('Protection channel creation requires at least one configurable feature', () => {
  assert.match(setup, /hasConfigurableProtection/)
  assert.match(setup, /Protection configuration is unavailable for the current model/)
  assert.match(setup, /const available = hasConfigurableProtection/)
})
