/** Presentation-only decoding; authoritative Serial RX is hexadecimal bytes in Core. */
export type SerialDataFormat = 'hex' | 'text'
export type SerialEvent = { rx_hex?: string; rx_bytes?: number; timestamp_utc: string }

export function serialBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return new Uint8Array()
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16))
}

export function serialHex(hex: string): string {
  return (hex.toUpperCase().match(/.{1,2}/g) ?? []).join(' ')
}

export function escapeSerialText(value: string): string {
  return [...value].map(ch => {
    if (ch === '\r') return '\\r'
    if (ch === '\n') return '\\n'
    if (ch === '\t') return '\\t'
    const code = ch.codePointAt(0) ?? 0
    return (code < 32 || code === 127) ? '\\u{' + code.toString(16).toUpperCase().padStart(4, '0') + '}' : ch
  }).join('')
}

export function serialEventViews(events: SerialEvent[], mode: SerialDataFormat, prefixHex = ''): string[] {
  if (mode === 'hex') return events.map(event => serialHex(event.rx_hex ?? ''))
  const decoder = new TextDecoder('utf-8', { fatal: false })
  if (prefixHex) decoder.decode(serialBytes(prefixHex), { stream: true })
  return events.map(event => escapeSerialText(decoder.decode(serialBytes(event.rx_hex ?? ''), { stream: true })))
}

export function serialContinuousView(events: SerialEvent[], mode: SerialDataFormat): string {
  if (mode === 'hex') return serialHex(events.map(event => event.rx_hex ?? '').join(''))
  const decoder = new TextDecoder('utf-8', { fatal: false })
  return escapeSerialText(decoder.decode(serialBytes(events.map(event => event.rx_hex ?? '').join(''))))
}
