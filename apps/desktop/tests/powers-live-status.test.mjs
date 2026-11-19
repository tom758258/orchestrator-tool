import test from 'node:test'
import assert from 'node:assert/strict'
import { protectionChannelNumbers, updatePowersProtectionSetting } from '../src/powersProtectionSetup.ts'

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
