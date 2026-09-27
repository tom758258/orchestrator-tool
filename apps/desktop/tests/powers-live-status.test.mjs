import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import React from 'react'
import { transformWithOxc } from 'vite'
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

test('Powers Device presentation shows Device Status before Live Device in both modes', () => {
  const presentation = app.slice(app.indexOf('renderResource={instance => ('),
    app.indexOf('onChange={updateToolInstances}'))
  const statusStart = presentation.indexOf("{instance.tool === 'powers' && (() => {")
  const liveStart = presentation.indexOf("{(instance.tool === 'powers' || instance.tool === 'meters') && (")
  assert.ok(statusStart >= 0 && liveStart > statusStart)
  assert.ok(presentation.indexOf('<h5>Device Status') < presentation.indexOf('<strong>Live Device</strong>'))
  assert.match(presentation, /Save the Live Resource below before using Device Status in Live mode\./)
})

test('Protection Setup renders capability and configured channels with fixed, disabled controls', () => {
  assert.match(setup, /hasConfigurableProtection/)
  assert.match(setup, /Protection configuration is unavailable for the current model/)
  assert.doesNotMatch(setup, /Add Protection Channel|Remove Channel|Remove setting/)
  assert.match(setup, /protectionChannelNumbers\(capabilities\?\.channels \?\? \[\], channels\)/)
  assert.match(setup, /displayChannels\.map/)
  assert.match(setup, /disabled=\{!protectionEnabled \|\| !supported\('ocp'\)\}/)
  assert.match(setup, /disabled=\{!protectionEnabled \|\| triggers\.length === 0 \|\| unsupportedTrigger\}/)
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
  assert.match(app, /protectionChannelNumbers\(\s*capabilityChannels, instance\.setup\.protection\?\.channels \?\? \[\], deviceStatus\?\.status\?\.channels \?\? \[\],\s*\)/)
  assert.match(app, /powersCapabilityChannels\?\.key === powersCapabilityKey/)
  assert.match(app, /get_powers_capabilities[^\n]*modelId, executionMode/)
  assert.match(app, /<th[^>]*>Action<\/th>/)
  assert.match(app, /powers-protection-summary/)
  assert.match(app, /Protection Summary/)
  assert.match(app, /tripped === undefined \? '—' : tripped \? 'TRIPPED' : clearLabel/)
  assert.match(app, /status \?[^\n]*: '—'/)
  assert.doesNotMatch(app, /\(executionMode === 'simulate' \|\| channel\.over_voltage_tripped/)
  assert.match(app, /disabled=\{!resourceReady \|\| workflowBusy \|\| operationBusy \|\| toolConfigBusy !== null \|\| !canClear\}/)
  assert.match(app, /status && \(status\.over_voltage_tripped \|\| status\.over_current_tripped\)/)
  assert.match(app, /executionMode === 'simulate'[\s\S]*capabilityChannels\.includes\(channel\)/)
})

// Exercise the component handlers with local hooks and offline capabilities, without a Worker or DOM.
const powersFields = setup.slice(setup.indexOf('function PowersSetupFields('), setup.indexOf('function setupSummary('))
const { code } = await transformWithOxc(powersFields, 'PowersSetupFields.tsx', { jsx: { runtime: 'classic' } })
const createFields = new Function('React', 'useState', 'useEffect', 'invoke',
  'protectionChannelNumbers', 'updatePowersProtectionSetting', `${code}; return PowersSetupFields`)

function protectionEditor(initial = {}) {
  let value = initial
  let changes = 0
  let cursor = 0
  const hooks = [null, {
    key: JSON.stringify(['simulate', undefined, 'test']),
    value: { channels: [1, 2, 3], protection_features: {
      ovp_voltage: true, ocp: true, ocp_delay: false, ocp_delay_triggers: [],
    } },
  }]
  const Fields = createFields(React, initial => {
    const index = cursor++
    if (!(index in hooks)) hooks[index] = initial
    return [hooks[index], next => { hooks[index] = next }]
  }, () => {}, () => { throw new Error('Unexpected Worker invocation') },
  protectionChannelNumbers, updatePowersProtectionSetting)
  return {
    get value() { return value },
    get changes() { return changes },
    replace(next) { value = next },
    render() {
      cursor = 0
      const elements = []
      function visit(node) {
        if (Array.isArray(node)) node.forEach(visit)
        else if (React.isValidElement(node)) {
          elements.push(node)
          visit(node.props.children)
        }
      }
      visit(Fields({ value, onChange: next => { value = next; changes++ },
        executionMode: 'simulate', powersExecutableKey: 'test' }))
      return {
        checkboxes: elements.filter(node => node.props.type === 'checkbox'),
        field: label => elements.find(node => node.props['aria-label'] === label),
        rows: elements.filter(node => node.type === 'tr').length - 1,
      }
    },
  }
}

test('one instance toggle enables only supported fields without writing empty protection data', () => {
  const editor = protectionEditor()
  let view = editor.render()
  assert.equal(view.checkboxes.length, 1)
  assert.equal(view.checkboxes[0].props.checked, false)
  assert.equal(view.rows, 3)
  for (const label of ['OVP Voltage (V)', 'OCP', 'OCP Delay (s)', 'OCP Delay Trigger']) {
    assert.equal(view.field(`Channel 2 ${label}`).props.disabled, true)
  }
  assert.deepEqual(editor.value, {})
  assert.equal(editor.changes, 0)
  view.checkboxes[0].props.onChange({ target: { checked: true } })
  view = editor.render()
  assert.equal(view.checkboxes[0].props.checked, true)
  assert.equal(view.field('Channel 2 OVP Voltage (V)').props.disabled, false)
  assert.equal(view.field('Channel 2 OCP').props.disabled, false)
  assert.equal(view.field('Channel 2 OCP Delay (s)').props.disabled, true)
  assert.equal(view.field('Channel 2 OCP Delay Trigger').props.disabled, true)
  assert.deepEqual(editor.value, {})
  assert.equal(editor.changes, 0)
  view.field('Channel 2 OCP').props.onChange({ target: { value: 'on' } })
  assert.deepEqual(editor.value, { protection: { channels: [{ channel: 2, ocp: 'on' }] } })
  assert.equal(editor.render().checkboxes[0].props.checked, true)
})

test('existing setup enables the toggle; disabling or pruning resets fields and setup', () => {
  const existing = { protection: { channels: [{ channel: 2, ocp: 'on' }] } }
  const editor = protectionEditor(existing)
  let view = editor.render()
  assert.equal(view.checkboxes[0].props.checked, true)
  view.checkboxes[0].props.onChange({ target: { checked: false } })
  assert.deepEqual(editor.value, {})
  view = editor.render()
  assert.equal(view.checkboxes[0].props.checked, false)
  assert.equal(view.field('Channel 2 OCP').props.value, '')
  assert.equal(view.field('Channel 2 OCP').props.disabled, true)
  view.checkboxes[0].props.onChange({ target: { checked: true } })
  editor.render().field('Channel 2 OCP').props.onChange({ target: { value: 'on' } })
  editor.render().field('Channel 2 OCP').props.onChange({ target: { value: '' } })
  assert.deepEqual(editor.value, {})
  assert.equal(editor.render().checkboxes[0].props.checked, false)
  assert.equal(editor.render().field('Channel 2 OCP').props.disabled, true)
  editor.render().checkboxes[0].props.onChange({ target: { checked: true } })
  editor.replace({})
  assert.equal(editor.render().checkboxes[0].props.checked, false)
})

test('existing unsupported values stay visible and disabled while supported fields are edited', () => {
  const editor = protectionEditor({ protection: { channels: [{ channel: 2, ocp_delay: 5 }] } })
  const view = editor.render()
  assert.equal(view.checkboxes[0].props.checked, true)
  assert.equal(view.field('Channel 2 OCP Delay (s)').props.value, 5)
  assert.equal(view.field('Channel 2 OCP Delay (s)').props.disabled, true)
  view.field('Channel 2 OCP').props.onChange({ target: { value: 'on' } })
  assert.deepEqual(editor.value, { protection: { channels: [{ channel: 2, ocp_delay: 5, ocp: 'on' }] } })
})

test('Device Status includes observed channels without guessing before a successful refresh', () => {
  const observed = [{ channel: 3 }, { channel: 1 }, { channel: 2 }]
  assert.deepEqual(protectionChannelNumbers([], []), [])
  assert.deepEqual(protectionChannelNumbers([], [], observed), [1, 2, 3])
  assert.deepEqual(protectionChannelNumbers([1, 2, 3], [], observed), [1, 2, 3])
  assert.deepEqual(protectionChannelNumbers([1], [{ channel: 4, ocp: 'on' }], observed), [1, 2, 3, 4])
})
