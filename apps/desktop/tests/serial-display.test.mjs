import assert from 'node:assert/strict'
import { test } from 'node:test'
import { serialContinuousView, serialEventViews } from '../src/serialDisplay.ts'

test('Serial RX display keeps event rows and decodes UTF-8 across event boundaries', () => {
  const events = [
    { timestamp_utc: '2026-11-02T00:00:00Z', rx_hex: 'e4', rx_bytes: 1 },
    { timestamp_utc: '2026-11-02T00:00:00Z', rx_hex: 'b8', rx_bytes: 1 },
    { timestamp_utc: '2026-11-02T00:00:00Z', rx_hex: 'ad0d0a', rx_bytes: 3 },
  ]
  assert.deepEqual(serialEventViews(events, 'hex'), ['E4', 'B8', 'AD 0D 0A'])
  assert.deepEqual(serialEventViews(events, 'text'), ['', '', '中\\r\\n'])
  assert.equal(serialContinuousView(events, 'text'), '中\n')
  assert.equal(serialContinuousView(events, 'hex'), 'E4 B8 AD 0D 0A')
  // Paging the first window must not pre-feed its own rows as a prefix.
  assert.deepEqual(serialEventViews(events.slice(1), 'text', 'e4'), ['', '中\\r\\n'])
})

test('Serial Text distinguishes event escapes from continuous RX and replaces invalid UTF-8', () => {
  const now = '2026-11-02T00:00:00Z'
  const control = [{ timestamp_utc: now, rx_hex: '00097fc2800d0a', rx_bytes: 7 }]
  assert.deepEqual(serialEventViews(control, 'text'), ['\\u{0}\\t\\u{7F}\\u{80}\\r\\n'])
  assert.equal(serialContinuousView(control, 'text'), '\\u{0}\\t\\u{7F}\\u{80}\n')
  assert.deepEqual(serialEventViews([{ timestamp_utc: now, rx_hex: 'ff', rx_bytes: 1 }], 'text'), ['�'])
})
