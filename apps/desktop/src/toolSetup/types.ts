import type { ScopesSetup } from '../scopesSetup'

export type MetersSetup = {
  measurement: 'voltage-dc' | 'current-dc'
  range_mode: 'auto' | 'manual'
  manual_range: number | null
  nplc: number
  auto_zero: 'on' | 'off' | 'once'
  dcv_input_impedance: 'default' | 'ten-megohm' | 'auto' | null
  current_terminal: number | null
  vm_comp_slope?: 'pos' | 'neg' | null
  trigger_mode?: 'software' | 'immediate' | 'external' | 'software-custom' | 'immediate-custom' | 'external-custom'
  hw_trigger_slope?: 'pos' | 'neg' | null
  hw_trigger_delay_s?: number | null
  sample_count?: number
  buffer_drain_size?: number | null
  allow_buffer_overflow_risk?: boolean
}

export type SerialSetup = {
  transport: 'serial' | 'tcp'
  baud: number; data_bits: number; parity: 'none' | 'odd' | 'even'; stop_bits: number
  flow_control: 'none' | 'software' | 'hardware'; timeout_ms: number
  connect_timeout_ms?: number; io_timeout_ms?: number
}
export type ToolInstance = { display_name?: string } & (
  | { id: string; tool: 'meters'; setup: MetersSetup }
  | { id: string; tool: 'powers'; setup: PowersSetup }
  | { id: string; tool: 'scopes'; setup: ScopesSetup }
  | { id: string; tool: 'wavegen'; setup: Record<string, never> }
 | { id: string; tool: 'serial'; setup: SerialSetup }
)

export type PowersProtectionChannel = {
  channel: number
  ovp_voltage?: number
  ocp?: 'on' | 'off'
  ocp_delay?: number
  ocp_delay_trigger?: 'setting-change' | 'cc-transition'
}
export type PowersSetup = { protection?: { channels: PowersProtectionChannel[] } }

