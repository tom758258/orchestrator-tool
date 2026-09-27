import type { PowersProtectionChannel, PowersSetup } from './ToolSetupEditor'

export function protectionChannelNumbers(
  capabilityChannels: readonly number[],
  configuredChannels: readonly PowersProtectionChannel[],
  observedChannels: readonly { channel: number }[] = [],
): number[] {
  return [...new Set([...capabilityChannels, ...configuredChannels.map(record => record.channel),
    ...observedChannels.map(record => record.channel)])]
    .sort((a, b) => a - b)
}

export function updatePowersProtectionSetting<K extends keyof Omit<PowersProtectionChannel, 'channel'>>(
  setup: PowersSetup,
  channel: number,
  field: K,
  value: PowersProtectionChannel[K],
): PowersSetup {
  const channels = setup.protection?.channels ?? []
  const existing = channels.find(record => record.channel === channel)
  if (!existing && value === undefined) return setup
  const updated = { ...(existing ?? { channel }) }
  if (value === undefined) delete updated[field]
  else updated[field] = value
  const next = existing
    ? channels.flatMap(record => record.channel !== channel ? [record]
      : Object.keys(updated).length > 1 ? [updated] : [])
    : [...channels, updated]
  return next.length ? { protection: { channels: next } } : {}
}
