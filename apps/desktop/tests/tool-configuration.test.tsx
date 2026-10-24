import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { isInaccessible } from '@testing-library/dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { confirm, open, save } from '@tauri-apps/plugin-dialog'
import App from '../src/App'
import type { WorkflowDraft } from '../src/templateDraft'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.2.0' }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(), open: vi.fn(), save: vi.fn() }))

const original: WorkflowDraft = { schema_version: 1, name: 'Setup test', tool_instances: [
  { id: 'powers-1', tool: 'powers', setup: { protection: { channels: [{ channel: 1, ocp: 'on' }] } } },
  { id: 'scopes-1', tool: 'scopes', setup: { acquisition: { acquisition_type: 'average', average_count: 16 },
    channels: [{ channel: 4, invert: true }] } },
  { id: 'wavegen-1', tool: 'wavegen', setup: {} },
], workflow: { steps: [] } }
const empty: WorkflowDraft = { ...original, tool_instances: [] }
const toolStatus = (tool_id: string) => ({ tool_id, executable_status: 'available', compatibility: 'compatible',
  source: 'configured', path: `${tool_id}.exe`, tool_version: '1.0', worker_schema_versions: [3], reason: null })
let tools: ReturnType<typeof toolStatus>[]
let newDraft: WorkflowDraft
let loadedDraft: WorkflowDraft
let loadError: boolean
let resources: Record<string, string>

beforeEach(() => {
  vi.clearAllMocks()
  tools = ['meters', 'powers', 'scopes', 'wavegen'].map(toolStatus)
  newDraft = structuredClone(original)
  loadedDraft = structuredClone(original)
  loadError = false
  resources = {}
  vi.mocked(confirm).mockResolvedValue(true)
  vi.mocked(open).mockResolvedValue('template.json')
  vi.mocked(save).mockResolvedValue('saved.json')
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const params = args as Record<string, unknown>
    switch (command) {
      case 'create_workflow_draft': return JSON.stringify(newDraft)
      case 'load_workflow_template':
        if (loadError) throw new Error('Cannot load Template')
        return JSON.stringify(loadedDraft)
      case 'get_tool_status': return [...tools]
      case 'get_live_resources': return { ...resources }
      case 'get_live_resource_identities': return {}
      case 'get_powers_capabilities': return { channels: [1], protection_features: {
        ovp_voltage: true, ocp: true, ocp_delay: false, ocp_delay_triggers: [],
      } }
      case 'get_scopes_capabilities': return { analog_channels: 2,
        acquisition_modes: ['normal', 'average'], average_counts: [4, 16, 64] }
      case 'get_meters_capabilities': return { trigger_modes: ['software'], limits: {
        sample_count: { max: 1000 }, buffer_drain_size: { max: 1000 }, trigger_count: { max: 1000 },
      }, reading_memory_limit: 1000, measurements: [] }
      case 'check_live_preflight': return []
      case 'refresh_powers_status': return { protection_tripped: params.executionMode === 'live', over_voltage_tripped: params.executionMode === 'live',
        over_current_tripped: false, channels: [{ channel: 1, output_enabled: false,
          over_voltage_tripped: params.executionMode === 'live', over_current_tripped: false }] }
      case 'clear_powers_protection': return { mode: params.executionMode, status: {
        protection_tripped: false, over_voltage_tripped: false, over_current_tripped: false, channels: [],
      } }
      case 'set_live_resource': resources[String(params.instanceId)] = String(params.resource); return
      case 'set_tool_executable': tools = tools.map(tool => tool.tool_id === params.toolId
        ? { ...tool, path: String(params.path) } : tool); return
      case 'reset_tool_executable': tools = tools.filter(tool => tool.tool_id !== params.toolId); return
      case 'save_workflow_template': case 'validate_workflow_draft': return params.templateJson
      default: throw new Error(`Unexpected command: ${command}`)
    }
  })
})

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))
const instance = (id: string) => within(screen.getByRole('button', {
  name: new RegExp(`^(?:Expand|Collapse) ${id}$`),
}).closest('fieldset')!)
const calls = () => vi.mocked(invoke).mock.calls
async function mount() {
  render(<App />)
  await screen.findByRole('button', { name: 'Expand powers details' })
  tab('Setup')
  await waitFor(() => expect((screen.getByRole('button', { name: 'Add Tool Instance' }) as HTMLButtonElement).disabled).toBe(false))
  await waitFor(() => expect(calls().some(([command]) => command === 'get_scopes_capabilities')).toBe(true))
}
async function savedDraft() {
  click('Save Template')
  await screen.findByText('Template saved.')
  const args = calls().filter(([command]) => command === 'save_workflow_template').at(-1)![1] as { templateJson: string }
  return JSON.parse(args.templateJson)
}
const summaryCounts = () => Array.from(screen.getByRole('region', { name: 'Tool Instance Summary' })
  .querySelectorAll('dl > div')).map(node => [node.querySelector('dt')!.textContent, node.querySelector('dd')!.textContent])

test('Setup preserves independent groups, local drafts and protection data through edits and tab/instance toggles', async () => {
  await mount()
  const power = instance('powers-1')
  const scope = instance('scopes-1')
  expect(power.getByRole('button', { name: 'Expand Protection Setup' }).textContent).toBe('+')
  expect(power.queryByRole('button', { name: 'Refresh Status' })).toBeNull()
  expect(scope.queryByRole('spinbutton', { name: 'Average Count' })).toBeNull()
  expect(scope.queryByRole('combobox', { name: 'Channel 4 Waveform Invert' })).toBeNull()
  expect(scope.getByRole('textbox', { name: 'Live Resource' })).toBeTruthy()
  const beforeToggle = calls().length
  fireEvent.click(power.getByRole('button', { name: 'Expand Protection Setup' }))
  expect((power.getByRole('checkbox', { name: 'Use Protection Setup' }) as HTMLInputElement).checked).toBe(true)
  expect(power.getByRole('region', { name: 'Protection Summary' })).toBeTruthy()
  expect(power.getByRole('textbox', { name: 'Live Resource' })).toBeTruthy()
  expect(power.getByRole('button', { name: 'Generate Clear Plan...' })).toBeTruthy()
  fireEvent.click(power.getByRole('button', { name: 'Collapse Protection Setup' }))
  expect(power.queryByRole('textbox', { name: 'Live Resource' })).toBeNull()
  fireEvent.click(power.getByRole('button', { name: 'Expand Protection Setup' }))
  fireEvent.click(scope.getByRole('button', { name: 'Expand Acquisition Setup' }))
  expect(scope.getByRole('button', { name: 'Expand Channel Configuration' }).getAttribute('aria-expanded')).toBe('false')
  const count = scope.getByRole('spinbutton', { name: 'Average Count' }) as HTMLInputElement
  fireEvent.change(count, { target: { value: '1' } }) // An incomplete count remains a local draft.
  fireEvent.click(scope.getByRole('button', { name: 'Collapse Acquisition Setup' }))
  fireEvent.click(scope.getByRole('button', { name: 'Expand Channel Configuration' }))
  expect((scope.getByRole('combobox', { name: 'Channel 4 Waveform Invert' }) as HTMLSelectElement).disabled).toBe(true)
  fireEvent.click(scope.getByRole('button', { name: 'Collapse scopes-1' }))
  fireEvent.click(power.getByRole('button', { name: 'Collapse powers-1' }))
  tab('Tools')
  tab('Setup')
  fireEvent.click(instance('powers-1').getByRole('button', { name: 'Expand powers-1' }))
  fireEvent.click(instance('scopes-1').getByRole('button', { name: 'Expand scopes-1' }))
  expect(instance('powers-1').getByRole('button', { name: 'Collapse Protection Setup' })).toBeTruthy()
  expect(instance('scopes-1').getByRole('button', { name: 'Collapse Channel Configuration' })).toBeTruthy()
  fireEvent.click(instance('scopes-1').getByRole('button', { name: 'Expand Acquisition Setup' }))
  expect(instance('scopes-1').getByRole('spinbutton', { name: 'Average Count' })).toBe(count)
  expect(count.value).toBe('1')
  expect(calls().slice(beforeToggle)).toEqual([])
  fireEvent.change(instance('powers-1').getByRole('textbox', { name: /Display Name \(optional\)/ }), { target: { value: 'Bench power' } })
  expect(instance('powers-1').getByRole('button', { name: 'Collapse Protection Setup' })).toBeTruthy()
  expect(await savedDraft()).toEqual({ ...original, tool_instances: original.tool_instances.map(item =>
    item.id === 'powers-1' ? { ...item, display_name: 'Bench power' } : item) })
})

test('summary follows Template instances and add/remove; replacement resets even matching IDs without clearing Template data', async () => {
  tools = tools.filter(tool => tool.tool_id !== 'wavegen')
  await mount()
  expect(summaryCounts()).toEqual([['Powers', '1'], ['Scopes', '1'], ['Wavegen', '1']])
  fireEvent.change(screen.getByRole('combobox', { name: 'Tool type' }), { target: { value: 'powers' } })
  click('Add Tool Instance')
  expect(summaryCounts()).toEqual([['Powers', '2'], ['Scopes', '1'], ['Wavegen', '1']])
  fireEvent.click(instance('powers-2').getByRole('button', { name: 'Expand Protection Setup' }))
  fireEvent.click(instance('powers-2').getByRole('button', { name: 'Remove Tool Instance' }))
  click('Add Tool Instance')
  expect(instance('powers-2').getByRole('button', { name: 'Expand Protection Setup' })).toBeTruthy()
  fireEvent.click(instance('powers-2').getByRole('button', { name: 'Remove Tool Instance' }))
  fireEvent.click(instance('powers-1').getByRole('button', { name: 'Expand Protection Setup' }))
  fireEvent.click(instance('scopes-1').getByRole('button', { name: 'Expand Acquisition Setup' }))
  fireEvent.click(instance('scopes-1').getByRole('button', { name: 'Expand Channel Configuration' }))
  fireEvent.click(instance('wavegen-1').getByRole('button', { name: 'Collapse wavegen-1' }))
  // Canceled and failed loads leave the UI session intact.
  vi.mocked(open).mockResolvedValueOnce(null)
  click('Open Template')
  await waitFor(() => expect((screen.getByRole('button', { name: 'Open Template' }) as HTMLButtonElement).disabled).toBe(false))
  loadError = true
  click('Open Template')
  await screen.findByText(/Cannot load Template/)
  expect(instance('powers-1').getByRole('button', { name: 'Collapse Protection Setup' })).toBeTruthy()
  loadError = false
  click('Open Template')
  await screen.findByText('Template loaded.')
  expect(instance('powers-1').getByRole('button', { name: 'Expand Protection Setup' })).toBeTruthy()
  expect(instance('scopes-1').getByRole('button', { name: 'Expand Acquisition Setup' })).toBeTruthy()
  expect(instance('scopes-1').getByRole('button', { name: 'Expand Channel Configuration' })).toBeTruthy()
  expect(instance('wavegen-1').getByRole('button', { name: 'Collapse wavegen-1' })).toBeTruthy()
  expect(await savedDraft()).toEqual(original)
  loadedDraft = structuredClone(empty)
  click('Open Template')
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Tool Instance Summary' })).toBeNull())
  click('New Template')
  await screen.findByRole('button', { name: 'Expand Protection Setup' })
  expect(summaryCounts()).toEqual([['Powers', '1'], ['Scopes', '1'], ['Wavegen', '1']])
})

test('External Tools keep status visible and independent state across refresh/tabs/path changes, and reset on New/Open', async () => {
  await mount()
  tab('Tools')
  expect(screen.getAllByText('Available').filter(node => !isInaccessible(node))).toHaveLength(4)
  expect(screen.queryByRole('button', { name: 'Change Path...' })).toBeNull()
  click('Expand powers details')
  expect(screen.getAllByRole('button', { name: 'Change Path...' })).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Expand scopes details' })).toBeTruthy()
  click('Refresh')
  await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false))
  tab('Setup')
  tab('Tools')
  expect(screen.getByRole('button', { name: 'Collapse powers details' })).toBeTruthy()
  vi.mocked(open).mockResolvedValueOnce('new-powers.exe')
  click('Change Path...')
  await screen.findByText('new-powers.exe')
  expect(screen.getByRole('button', { name: 'Collapse powers details' })).toBeTruthy()
  click('Remove Tool')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Collapse powers details' })).toBeNull())
  tools.push(toolStatus('powers'))
  click('Refresh')
  await screen.findByRole('button', { name: 'Expand powers details' })
  for (const action of ['Open Template', 'New Template']) {
    click('Expand powers details')
    click(action)
    await screen.findByRole('button', { name: 'Expand powers details' })
  }
})

test('the grouped Device retains explicit status, clear and resource operations in Simulation and Live', async () => {
  await mount()
  const power = instance('powers-1')
  fireEvent.click(power.getByRole('button', { name: 'Expand Protection Setup' }))
  fireEvent.click(power.getByRole('button', { name: 'Refresh Status' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('refresh_powers_status', { instanceId: 'powers-1', executionMode: 'simulate' }))
  await waitFor(() => expect((power.getByRole('button', { name: 'Generate Clear Plan...' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(power.getByRole('button', { name: 'Generate Clear Plan...' }))
  await power.findByText('PLAN GENERATED · SIMULATION')
  fireEvent.change(power.getByRole('textbox', { name: 'Live Resource' }), { target: { value: 'USB::power' } })
  fireEvent.click(power.getByRole('button', { name: 'Save Resource' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_live_resource', {
    instanceId: 'powers-1', resource: 'USB::power', identity: null,
  }))
  await waitFor(() => expect((power.getByRole('button', { name: 'Save Resource' }) as HTMLButtonElement).disabled).toBe(false))
  click('Live')
  fireEvent.click(power.getByRole('button', { name: 'Refresh Status' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('refresh_powers_status', { instanceId: 'powers-1', executionMode: 'live' }))
  await waitFor(() => expect((power.getByRole('button', { name: 'Clear Protection...' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(power.getByRole('button', { name: 'Clear Protection...' }))
  await power.findByText('Protection clear completed in LIVE mode. Real hardware was addressed and outputs remain OFF.')
  expect(invoke).toHaveBeenCalledWith('clear_powers_protection', { instanceId: 'powers-1', channel: 1, executionMode: 'live' })
  // Saved unsupported settings survive the mode change and collapsing; no Template UI data is serialized.
  fireEvent.click(power.getByRole('button', { name: 'Collapse Protection Setup' }))
  fireEvent.click(power.getByRole('button', { name: 'Expand Protection Setup' }))
  expect((power.getByRole('checkbox', { name: 'Use Protection Setup' }) as HTMLInputElement).checked).toBe(true)
  expect(await savedDraft()).toEqual(original)
})
