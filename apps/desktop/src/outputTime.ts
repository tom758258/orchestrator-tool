import type { InputValueWire } from './inputValue.ts'
import type { OutputStep } from './workflow.ts'

export type ElapsedTimeFormat = 'seconds' | 'minutes-seconds' | 'hours-minutes-seconds' | 'days-decimal'
export type TimestampFormat = { kind: 'timestamp'; include_date: boolean; include_utc_offset: boolean }
export type OutputTimeFormat = { kind: 'elapsed-time'; format: ElapsedTimeFormat } | TimestampFormat

export const ELAPSED_TIME_FORMATS: Record<ElapsedTimeFormat, string> = {
  seconds: 'Seconds', 'minutes-seconds': 'Minutes:Seconds',
  'hours-minutes-seconds': 'Hours:Minutes:Seconds', 'days-decimal': 'Days (Decimal)',
}

export function changeOutputValue(step: OutputStep, value: InputValueWire): OutputStep {
  const { time_format, ...rest } = step
  if (value.source === step.value.source) return { ...step, value }
  if (value.source === 'elapsed-time') return { ...rest, value, time_format: { kind: 'elapsed-time', format: 'seconds' } }
  if (value.source === 'timestamp') return { ...rest, value, time_format: { kind: 'timestamp', include_date: true, include_utc_offset: true } }
  return { ...rest, value }
}

export function formatElapsedTime(seconds: number, format: ElapsedTimeFormat): string {
  if (format === 'seconds') return seconds.toFixed(3)
  if (format === 'days-decimal') return `${(seconds / 86400).toFixed(9)} d`
  const roundedMs = Math.round(seconds * 1000)
  const sign = roundedMs < 0 ? '-' : ''
  const ms = Math.abs(roundedMs)
  const wholeSeconds = Math.floor(ms / 1000)
  const tail = `${String(wholeSeconds % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
  if (format === 'minutes-seconds') return `${sign}${String(Math.floor(wholeSeconds / 60)).padStart(2, '0')}:${tail}`
  return `${sign}${String(Math.floor(wholeSeconds / 3600)).padStart(2, '0')}:${String(Math.floor(wholeSeconds / 60) % 60).padStart(2, '0')}:${tail}`
}

export function formatTimestamp(value: string, format: TimestampFormat): string {
  const start = format.include_date ? 0 : 11
  const end = format.include_utc_offset ? value.length : 23
  return value.slice(start, end)
}

export function formatTimestampMillis(value: number, format: TimestampFormat): string {
  const iso = new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, -1) + '+08:00'
  return formatTimestamp(iso, format)
}

export function formatOutputValue(step: OutputStep, value: unknown): string {
  const format = step.time_format
  if (step.value.source === 'elapsed-time' && format?.kind === 'elapsed-time' && typeof value === 'number') {
    return formatElapsedTime(value, format.format)
  }
  if (step.value.source === 'timestamp' && format?.kind === 'timestamp' && typeof value === 'string') {
    return formatTimestamp(value, format)
  }
  return typeof value === 'string' ? value : JSON.stringify(value) ?? '—'
}
