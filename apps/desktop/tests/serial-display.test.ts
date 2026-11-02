import { expect, test } from 'vitest'
import { serialContinuousView, serialEventViews } from '../src/serialDisplay'

test('Serial RX display keeps event rows and decodes UTF-8 across event boundaries', () => {
  const events = [
    { timestamp_utc: '2026-11-02T00:00:00Z', rx_hex: 'e4', rx_bytes: 1 },
    { timestamp_utc: '2026-11-02T00:00:00Z', rx_hex: 'b8', rx_bytes: 1 },
    { timestamp_utc: '2026-11-02T00:00:00Z', rx_hex: 'ad0d0a', rx_bytes: 3 },
  ]
  expect(serialEventViews(events, 'hex')).toEqual(['E4', 'B8', 'AD 0D 0A'])
  expect(serialEventViews(events, 'text')).toEqual(['', '', '中\\r\\n'])
  expect(serialContinuousView(events, 'text')).toBe('中\n')
  expect(serialContinuousView(events, 'hex')).toBe('E4 B8 AD 0D 0A')
  // Paging the first window must not pre-feed its own rows as a prefix.
  expect(serialEventViews(events.slice(1), 'text', 'e4')).toEqual(['', '中\\r\\n'])
})

test('Serial Text distinguishes event escapes from continuous RX and preserves partial UTF-8', () => {
  const now = '2026-11-02T00:00:00Z'
  const control = [{ timestamp_utc: now, rx_hex: '00097fc2800d0a', rx_bytes: 7 }]
  expect(serialEventViews(control, 'text')).toEqual(['\\u{0}\\t\\u{7F}\\u{80}\\r\\n'])
  expect(serialContinuousView(control, 'text')).toBe('\\u{0}\\t\\u{7F}\\u{80}\n')
  const partial = [{ timestamp_utc: now, rx_hex: 'e4', rx_bytes: 1 }]
  expect(serialEventViews(partial, 'text')).toEqual([''])
  expect(serialContinuousView(partial, 'text')).toBe('')
  expect(serialEventViews([...partial, { timestamp_utc: now, rx_hex: 'b8ad', rx_bytes: 2 }], 'text'))
    .toEqual(['', '中'])
  expect(serialEventViews([{ timestamp_utc: now, rx_hex: 'ff', rx_bytes: 1 }], 'text')).toEqual(['�'])
})
