import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { protectionChannelNumbers, updatePowersProtectionSetting } from '../src/powersProtectionSetup.ts'

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
  assert.doesNotMatch(app, /deviceStatus\?\.clearPlan !== null/)
  assert.match(app, /const clearPlan = deviceStatus\?\.clearPlan \?\? null/)
  assert.match(app, /\{clearPlan !== null && <div className="simulation-plan-result"/)
  assert.doesNotMatch(app, /JSON\.stringify\(clearPlan/)
  for (const field of ['Target', 'Safety', 'Action', 'Final output', 'Hardware I\/O']) {
    assert.ok(app.includes(`>${field}</dt>`))
  }
  assert.match(app, /All power outputs will be turned OFF first/)
  assert.match(app, /Remains OFF/)
  assert.doesNotMatch(app, /setInterval\([^)]*refreshPowersStatus/)
})

test('Protection Setup renders capability and configured channels with fixed, disabled controls', () => {
  assert.match(setup, /hasConfigurableProtection/)
  assert.match(setup, /Protection configuration is unavailable for the current model/)
  assert.doesNotMatch(setup, /Add Protection Channel|Remove Channel|Remove setting/)
  assert.match(setup, /protectionChannelNumbers\(capabilities\?\.channels \?\? \[\], channels\)/)
  assert.match(setup, /displayChannels\.map/)
  assert.match(setup, /disabled=\{!supported\('ocp'\)\}/)
  assert.match(setup, /disabled=\{triggers\.length === 0 \|\| unsupportedTrigger\}/)
  assert.match(setup, /existing value preserved/)
})

test('display channels preserve configured channels even without capability data', () => {
  const configured = [{ channel: 4, ocp: 'on' }]
  assert.deepEqual(protectionChannelNumbers([1, 2, 3], configured), [1, 2, 3, 4])
  assert.deepEqual(protectionChannelNumbers([], configured), [4])
  assert.deepEqual(configured, [{ channel: 4, ocp: 'on' }])
})

test('Protection Setup upserts only changed settings and prunes empty channels and setup', () => {
  const empty = {}
  assert.deepEqual(updatePowersProtectionSetting(empty, 2, 'ocp', undefined), {})
  const changed = updatePowersProtectionSetting(empty, 2, 'ocp', 'on')
  assert.deepEqual(changed, { protection: { channels: [{ channel: 2, ocp: 'on' }] } })
  assert.deepEqual(empty, {})
  const withDelay = updatePowersProtectionSetting(changed, 2, 'ocp_delay', 0)
  const withoutOcp = updatePowersProtectionSetting(withDelay, 2, 'ocp', undefined)
  assert.deepEqual(withoutOcp, { protection: { channels: [{ channel: 2, ocp_delay: 0 }] } })
  assert.deepEqual(updatePowersProtectionSetting(withoutOcp, 2, 'ocp_delay', undefined), {})
  const withOtherChannel = updatePowersProtectionSetting(changed, 1, 'ocp', 'off')
  assert.deepEqual(updatePowersProtectionSetting(withOtherChannel, 2, 'ocp', undefined),
    { protection: { channels: [{ channel: 1, ocp: 'off' }] } })
})

test('editing supported settings leaves other saved unsupported values intact', () => {
  const original = { protection: { channels: [{ channel: 4, ovp_voltage: 5, ocp: 'on' }] } }
  const edited = updatePowersProtectionSetting(original, 2, 'ocp', 'on')
  assert.deepEqual(edited.protection.channels[0], original.protection.channels[0])
  assert.deepEqual(updatePowersProtectionSetting(edited, 2, 'ocp', undefined), original)
})

test('Device Status renders placeholders and stable action cells before Refresh', () => {
  assert.match(app, /protectionChannelNumbers\(capabilityChannels, instance\.setup\.protection\?\.channels \?\? \[\]\)/)
  assert.match(app, /powersCapabilityChannels\?\.key === powersCapabilityKey/)
  assert.match(app, /get_powers_capabilities[^\n]*modelId, executionMode/)
  assert.match(app, /<th[^>]*>Action<\/th>/)
  assert.match(app, /deviceStatus\?\.status \?[^\n]*: '—'/)
  assert.match(app, /status \?[^\n]*: '—'/)
  assert.doesNotMatch(app, /\(executionMode === 'simulate' \|\| channel\.over_voltage_tripped/)
  assert.match(app, /disabled=\{!resourceReady \|\| workflowBusy \|\| operationBusy \|\| toolConfigBusy !== null \|\| !canClear\}/)
  assert.match(app, /status && \(status\.over_voltage_tripped \|\| status\.over_current_tripped\)/)
  assert.match(app, /executionMode === 'simulate'[\s\S]*capabilityChannels\.includes\(channel\)/)
})
