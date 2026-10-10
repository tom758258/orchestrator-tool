export const SCOPES_ACTIONS = [
  ['channel-display', 'Scope Channel Display'], ['channel-scale', 'Scope Channel Scale'],
  ['channel-offset', 'Scope Channel Offset'], ['timebase-scale', 'Scope Timebase Scale'],
  ['timebase-position', 'Scope Timebase Position'], ['trigger-edge', 'Scope Edge Trigger'],
  ['measure', 'Scope Measure'], ['capture', 'Scope Capture'], ['screenshot', 'Scope Screenshot'],
] as const
export type ScopesAction = typeof SCOPES_ACTIONS[number][0]

export function scopesActionArguments(action: ScopesAction): Record<string, unknown> {
  switch (action) {
    case 'channel-display': return { channel: 1, on: true }
    case 'channel-scale': return { channel: 1, volts_per_division: 1 }
    case 'channel-offset': return { channel: 1, volts: 0 }
    case 'timebase-scale': return { seconds_per_division: 0.001 }
    case 'timebase-position': return { seconds: 0 }
    case 'trigger-edge': return { source_channel: 1, level: 0, slope: 'positive' }
    case 'measure': return { channel: 1, item: 'vpp' }
    case 'capture': return { channel: [1], points: 1000 }
    case 'screenshot': return { format: 'png' }
  }
}

