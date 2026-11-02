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
  expect(serialContinuousView(events, 'text')).toBe('中\\r\\n')
  expect(serialContinuousView(events, 'hex')).toBe('E4 B8 AD 0D 0A')
  // Paging the first window must not pre-feed its own rows as a prefix.
  expect(serialEventViews(events.slice(1), 'text', 'e4')).toEqual(['', '中\\r\\n'])
})
