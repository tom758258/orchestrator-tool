import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const setup = fs.readFileSync(new URL('../src/ToolSetupEditor.tsx', import.meta.url), 'utf8')

test('Powers Live Device Status is explicit, saved-resource guarded, and runtime-only', () => {
  assert.match(app, /Refresh Status/)
  assert.match(app, /savedResource\?\.trim\(\).*draftResource === savedResource/s)
  assert.match(app, /refresh_powers_live_status/)
  assert.match(app, /clear_powers_protection/)
  assert.match(app, /Not saved in Template/)
  assert.doesNotMatch(app, /setInterval\([^)]*refreshPowersLiveStatus/)
})

test('Protection channel creation requires at least one configurable feature', () => {
  assert.match(setup, /hasConfigurableProtection/)
  assert.match(setup, /Protection configuration is unavailable for the current model/)
  assert.match(setup, /const available = hasConfigurableProtection/)
})
