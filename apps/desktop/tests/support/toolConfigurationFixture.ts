import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { confirm, open, save } from '@tauri-apps/plugin-dialog'
import type { WorkflowDraft } from '../../src/templateDraft'
import type { ToolInstance } from '../../src/toolSetup/types'

export function createToolConfigurationFixture() {
  const original: WorkflowDraft = { name: 'Setup test', tool_instances: [
    { id: 'powers-1', tool: 'powers', setup: { protection: { channels: [{ channel: 1, ocp: 'on' }] } } },
    { id: 'scopes-1', tool: 'scopes', setup: { acquisition: { acquisition_type: 'average', average_count: 16 },
      channels: [{ channel: 4, invert: true }] } },
    { id: 'wavegen-1', tool: 'wavegen', setup: {} },
  ], workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [] } }
  const empty: WorkflowDraft = { ...original, tool_instances: [] }
  const backgroundMeter: ToolInstance = { id: 'meters-1', tool: 'meters', setup: { trigger_mode: 'immediate-custom',
    measurement: 'voltage-dc', range_mode: 'auto', manual_range: null, nplc: 1, auto_zero: 'on', dcv_input_impedance: null, current_terminal: null } }

  const toolStatus = (tool_id: string) => ({ tool_id, executable_status: 'available', compatibility: 'compatible',
    source: 'configured', path: `${tool_id}.exe`, tool_version: '1.0', worker_schema_versions: [3], reason: null })

  const state = {
    tools: [] as ReturnType<typeof toolStatus>[],
    newDraft: structuredClone(original),
    loadedDraft: structuredClone(original),
    loadError: false,
    backends: {} as Record<string, 'system' | '@py'>,
    identities: {} as Record<string, { manufacturer: string | null; model: string | null; model_id: string | null; serial: string | null; identity: string | null }>,
    resources: {} as Record<string, string>,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    state.tools = ['meters', 'powers', 'scopes', 'wavegen'].map(toolStatus)
    state.newDraft = structuredClone(original)
    state.loadedDraft = structuredClone(original)
    state.loadError = false
    state.resources = {}
    state.backends = {}
    state.identities = {}
    vi.mocked(confirm).mockResolvedValue(true)
    vi.mocked(open).mockResolvedValue('template.json')
    vi.mocked(save).mockResolvedValue('saved.json')
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const params = args as Record<string, unknown>
      switch (command) {
        case 'create_workflow_draft': return JSON.stringify(state.newDraft)
        case 'load_workflow_template':
          if (state.loadError) throw new Error('Cannot load Template')
          return JSON.stringify(state.loadedDraft)
        case 'get_tool_status': return [...state.tools]
        case 'get_live_resources': return { ...state.resources }
        case 'get_live_resource_identities': return { ...state.identities }
        case 'get_live_backends': return { ...state.backends }
        case 'list_live_resources': return [{ resource: `USB::${params.toolId}::${params.backend}`, manufacturer: 'Vendor', model: 'Model', model_id: 'canonical-model', serial: '123', identity: 'Vendor,Model,123,1' }]
        case 'get_powers_capabilities': return { channels: params.modelId === 'saved-model' ? [1, 3] : [1], protection_features: {
          ovp_voltage: true, ocp: true, ocp_delay: false, ocp_delay_triggers: [],
        } }
        case 'get_scopes_capabilities': return { analog_channels: params.modelId === 'saved-scope' ? 4 : 2,
          acquisition_modes: ['normal', 'average'], average_counts: [4, 16, 64] }
        case 'get_meters_capabilities': return { trigger_modes: ['software'], limits: {
          sample_count: { max: 1000 }, buffer_drain_size: { max: 1000 }, trigger_count: { max: 1000 },
        }, reading_memory_limit: 1000, measurements: [
          { measurement_name: 'voltage-dc', range_values: params.model === 'Saved Meter' ? [30] : [10] },
        ] }
        case 'check_live_preflight': return []
        case 'check_serial_send_files': return []
        case 'refresh_powers_status': return { protection_tripped: params.executionMode === 'live', over_voltage_tripped: params.executionMode === 'live',
          over_current_tripped: false, channels: [{ channel: 1, output_enabled: false,
            over_voltage_tripped: params.executionMode === 'live', over_current_tripped: false }] }
        case 'clear_powers_protection': return { mode: params.executionMode, status: {
          protection_tripped: false, over_voltage_tripped: false, over_current_tripped: false, channels: [],
        } }
        case 'set_live_resource':
          state.resources[String(params.instanceId)] = String(params.resource)
          state.backends[String(params.instanceId)] = params.backend as 'system' | '@py'
          if (params.identity) state.identities[String(params.instanceId)] = params.identity as typeof state.identities[string]
          else delete state.identities[String(params.instanceId)]
          return
        case 'set_tool_executable': state.tools = state.tools.map(tool => tool.tool_id === params.toolId
          ? { ...tool, path: String(params.path) } : tool); return
        case 'reset_tool_executable': state.tools = state.tools.filter(tool => tool.tool_id !== params.toolId); return
        case 'save_workflow_template': case 'validate_workflow_draft': return params.templateJson
        default: throw new Error(`Unexpected command: ${command}`)
      }
    })
  })

  const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
  const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))

  const calls = () => vi.mocked(invoke).mock.calls

  async function savedDraft() {
    click('Save Template')
    await screen.findByText('Template saved.')
    const args = calls().filter(([command]) => command === 'save_workflow_template').at(-1)![1] as { templateJson: string }
    return JSON.parse(args.templateJson)
  }

  const serialBackgroundDraft: WorkflowDraft = { name: 'Serial interaction', tool_instances: [
    { id: 'serial-1', tool: 'serial', setup: { transport: 'serial', baud: 115200,
      data_bits: 8, parity: 'none', stop_bits: 1, flow_control: 'none', timeout_ms: 1000 } },
  ], backgrounds: [{ id: 'serial-bg', tool_instance_id: 'serial-1', live_monitor: false, limit_count: null }],
  workflow: { interaction: { enabled: true, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [
    { type: 'bg-interaction', id: 'send', background_id: 'serial-bg', timeout_ms: null,
      operation: { kind: 'command', command: 'serial-send', wait_for_completion: true,
        arguments: { tx_format: 'text', tx_value: 'START' } } },
    { type: 'wait', id: 'other', duration_ms: 1 },
  ] } }

  return { state, original, empty, backgroundMeter, toolStatus, click, tab, calls, savedDraft, serialBackgroundDraft }
}
