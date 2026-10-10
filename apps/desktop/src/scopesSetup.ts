export type ScopesAcquisition = {
  acquisition_type?: 'normal' | 'average' | 'high_resolution' | 'peak'
  average_count?: number
}
export type ScopesChannel = {
  channel: number
  coupling?: 'ac' | 'dc'
  probe_ratio?: number
  bandwidth_limit?: boolean
  invert?: boolean
  units?: 'volt' | 'amp'
}
export type ScopesSetup = { acquisition?: ScopesAcquisition; channels?: ScopesChannel[] }
export type ScopesCapabilities = {
  model_id: string
  model_name: string
  analog_channels: number
  acquisition_modes: string[] | null
  average_counts: number[] | null
  screenshot_formats: string[]
  measurement_items: string[] | null
}

export function updateScopesAcquisition(value: ScopesSetup, acquisition: ScopesAcquisition): ScopesSetup {
  const next = { ...value }
  const settings = Object.fromEntries(Object.entries(acquisition).filter(([, value]) => value !== undefined))
  if (Object.keys(settings).length) next.acquisition = settings
  else delete next.acquisition
  return next
}

export function updateScopesChannel<K extends Exclude<keyof ScopesChannel, 'channel'>>(
  value: ScopesSetup, channel: number, key: K, setting: ScopesChannel[K],
): ScopesSetup {
  const record = { ...(value.channels?.find(item => item.channel === channel) ?? { channel }) }
  if (setting === undefined) delete record[key]
  else record[key] = setting
  const channels = (value.channels ?? []).filter(item => item.channel !== channel)
  if (Object.keys(record).length > 1) channels.push(record)
  channels.sort((a, b) => a.channel - b.channel)
  const next = { ...value }
  if (channels.length) next.channels = channels
  else delete next.channels
  return next
}

export function scopesChannelNumbers(capabilities: ScopesCapabilities | null, setup: ScopesSetup): number[] {
  return [...new Set([...Array.from({ length: capabilities?.analog_channels ?? 0 }, (_, i) => i + 1),
    ...(setup.channels ?? []).map(item => item.channel)])].sort((a, b) => a - b)
}
