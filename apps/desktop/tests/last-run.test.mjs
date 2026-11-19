import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failurePresentation } from '../src/failurePresentation.ts'

const invalidSettingsSummary = 'This operation was not valid or supported with the current settings.'

test('failure presentation matches real invalid and unsupported adapter errors', () => {
  for (const message of [
    'invalid Powers arguments: channel must be a positive integer',
    'invalid Meters arguments: unexpected argument field',
    'unsupported Powers action example',
    'unsupported Meters action example',
    'workflow execution failed: invalid Powers arguments: channel must be a positive integer',
  ]) {
    assert.equal(failurePresentation(message).summary, invalidSettingsSummary)
  }
  assert.equal(
    failurePresentation('instrument rejected command because device is busy').summary,
    'This operation failed while executing.',
  )
})

test('Assert failure presentation distinguishes a failed check from evaluation errors', () => {
  assert.equal(
    failurePresentation('Assertion failed.', { type: 'assert', message: '' }).summary,
    'This check did not pass.',
  )
  assert.equal(
    failurePresentation('Voltage must stay below limit.', {
      type: 'assert', message: 'Voltage must stay below limit.',
    }).summary,
    'This check did not pass.',
  )
  assert.equal(
    failurePresentation('unresolved variable foo', { type: 'assert', message: '' }).summary,
    'This check could not be evaluated.',
  )
  const longMessage = '😀'.repeat(513)
  const boundedMessage = Array.from(longMessage).slice(0, 512).join('')
  assert.equal(
    failurePresentation(boundedMessage, { type: 'assert', message: longMessage }).summary,
    'This check did not pass.',
  )
})
