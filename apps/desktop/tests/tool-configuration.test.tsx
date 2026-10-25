import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
let backends: Record<string, 'system' | '@py'>
let identities: Record<string, { manufacturer: string | null; model: string | null; model_id: string | null; serial: string | null; identity: string | null }>
let resources: Record<string, string>

beforeEach(() => {
  vi.clearAllMocks()
  tools = ['meters', 'powers', 'scopes', 'wavegen'].map(toolStatus)
  newDraft = structuredClone(original)
  loadedDraft = structuredClone(original)
  loadError = false
  resources = {}
  backends = {}
  identities = {}
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
      case 'get_live_resource_identities': return { ...identities }
      case 'get_live_backends': return { ...backends }
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
      case 'refresh_powers_status': return { protection_tripped: params.executionMode === 'live', over_voltage_tripped: params.executionMode === 'live',
        over_current_tripped: false, channels: [{ channel: 1, output_enabled: false,
          over_voltage_tripped: params.executionMode === 'live', over_current_tripped: false }] }
      case 'clear_powers_protection': return { mode: params.executionMode, status: {
        protection_tripped: false, over_voltage_tripped: false, over_current_tripped: false, channels: [],
      } }
      case 'set_live_resource':
        resources[String(params.instanceId)] = String(params.resource)
        backends[String(params.instanceId)] = params.backend as 'system' | '@py'
        if (params.identity) identities[String(params.instanceId)] = params.identity as typeof identities[string]
        else delete identities[String(params.instanceId)]
        return
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
function focusClick(control: HTMLElement) {
  fireEvent.pointerDown(control)
  act(() => control.focus()) // Native focus() dispatches blur/focusout before click, including relatedTarget.
  fireEvent.pointerUp(control)
  fireEvent.click(control)
}
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
  expect(power.getByRole('button', { name: 'Refresh Status' })).toBeTruthy()
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
  expect(power.getByRole('textbox', { name: 'Live Resource' })).toBeTruthy()
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

test.each(['Acquisition Setup', 'Scopes instance', 'Tools tab'])('Average Count survives focus transfer to %s before hiding and accepts a completed value', async target => {
  await mount()
  click('Expand Acquisition Setup')
  const count = screen.getByRole('spinbutton', { name: 'Average Count' }) as HTMLInputElement
  act(() => count.focus())
  fireEvent.change(count, { target: { value: '1' } })
  const control = target === 'Tools tab' ? screen.getByRole('tab', { name: 'Tools' })
    : screen.getByRole('button', { name: target === 'Scopes instance' ? 'Collapse scopes-1' : 'Collapse Acquisition Setup' })
  const events: string[] = []
  count.addEventListener('blur', () => events.push('blur'), { once: true })
  control.addEventListener('click', () => events.push('click'), { once: true })
  focusClick(control)
  expect(events).toEqual(['blur', 'click'])
  expect(screen.queryByRole('spinbutton', { name: 'Average Count' })).toBeNull()
  if (target === 'Tools tab') tab('Setup')
  else click(target === 'Scopes instance' ? 'Expand scopes-1' : 'Expand Acquisition Setup')
  expect(count.value).toBe('1')
  expect(await savedDraft()).toEqual(original) // An incomplete draft never becomes a formal setting.
  act(() => count.focus())
  fireEvent.change(count, { target: { value: '64' } })
  act(() => count.blur())
  expect(count.value).toBe('64')
  const saved = await savedDraft()
  expect(saved.tool_instances[1].setup.acquisition).toEqual({ acquisition_type: 'average', average_count: 64 })
  expect(saved.tool_instances[1].setup).toEqual({ ...original.tool_instances[1].setup,
    acquisition: { acquisition_type: 'average', average_count: 64 } })
})

test('Average Count ordinary blur still restores the accepted value and Acquisition Type changes clear the draft', async () => {
  await mount()
  click('Expand Acquisition Setup')
  const count = screen.getByRole('spinbutton', { name: 'Average Count' }) as HTMLInputElement
  const type = screen.getByRole('combobox', { name: 'Acquisition Type' })
  for (const next of [type, instance('scopes-1').getByRole('textbox', { name: 'Live Resource' }),
    screen.getByRole('button', { name: 'Expand Channel Configuration' }),
    screen.getByRole('button', { name: 'Collapse powers-1' }), null]) {
    act(() => count.focus())
    fireEvent.change(count, { target: { value: '1' } })
    act(() => { if (next) next.focus(); else count.blur() })
    expect(count.value).toBe('16')
  }
  act(() => count.focus())
  fireEvent.change(count, { target: { value: '1' } })
  act(() => type.focus())
  fireEvent.change(type, { target: { value: 'normal' } })
  expect(count.disabled).toBe(true)
  expect(count.value).toBe('')
  fireEvent.change(type, { target: { value: 'average' } })
  expect(count.disabled).toBe(false)
  expect(count.value).toBe('')
  expect((await savedDraft()).tool_instances[1].setup.acquisition).toEqual({ acquisition_type: 'average' })
})

test.each(['New Template', 'Open Template'])('%s resets a preserved Average Count draft even with the same instance ID', async action => {
  await mount()
  click('Expand Acquisition Setup')
  const count = screen.getByRole('spinbutton', { name: 'Average Count' }) as HTMLInputElement
  act(() => count.focus())
  fireEvent.change(count, { target: { value: '1' } })
  focusClick(screen.getByRole('button', { name: 'Collapse Acquisition Setup' }))
  expect(count.value).toBe('1')
  click(action)
  await waitFor(() => expect(count.isConnected).toBe(false))
  click('Expand Acquisition Setup')
  expect((screen.getByRole('spinbutton', { name: 'Average Count' }) as HTMLInputElement).value).toBe('16')
  expect(await savedDraft()).toEqual(original)
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
    instanceId: 'powers-1', resource: 'USB::power', identity: null, backend: 'system',
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

test('VISA backend drafts clear only their instance, save with Resource, and appear in Live confirmation', async () => {
  newDraft.tool_instances.push({ id: 'powers-2', tool: 'powers', setup: {} })
  newDraft.tool_instances.push({ id: 'meters-1', tool: 'meters', setup: {
    measurement: 'voltage-dc', range_mode: 'manual', manual_range: 30, nplc: 1,
    auto_zero: 'on', dcv_input_impedance: null, current_terminal: null,
  } })
  newDraft.workflow.steps = ['powers-1', 'powers-2'].map((target, index) => ({
    type: 'tool-action', id: `off-${index}`, target, action: 'output-off', arguments: { channel: 1 },
  }))
  newDraft.workflow.steps.push({ type: 'tool-action', id: 'scope-scale', target: 'scopes-1',
    action: 'channel-scale', arguments: { channel: 4, volts_per_division: 2 } })
  resources = { 'powers-1': 'USB::saved-py', 'powers-2': 'USB::saved-system' }
  backends = { 'powers-1': '@py' }
  identities = { 'powers-1': { manufacturer: 'Saved Vendor', model: 'Saved Model', model_id: 'saved-model', serial: 'old-serial', identity: null } }
  identities['scopes-1'] = { ...identities['powers-1'], model: 'Saved Scope', model_id: 'saved-scope' }
  identities['meters-1'] = { ...identities['powers-1'], model: 'Saved Meter', model_id: 'saved-meter' }
  await mount()
  const first = instance('powers-1')
  const second = instance('powers-2')
  expect((first.getByRole('combobox', { name: 'VISA Backend' }) as HTMLSelectElement).value).toBe('@py')
  expect((first.getByRole('textbox', { name: 'Live Resource' }) as HTMLInputElement).value).toBe('USB::saved-py')
  expect(first.getByText('Saved Vendor Saved Model')).toBeTruthy()
  // Device and backend controls remain available with Protection Setup collapsed.
  expect(first.getByRole('button', { name: 'Expand Protection Setup' })).toBeTruthy()
  click('Live')
  fireEvent.click(first.getByRole('button', { name: 'Expand Protection Setup' }))
  await first.findByRole('combobox', { name: 'Channel 3 OCP' })
  fireEvent.click(first.getByRole('button', { name: 'Collapse Protection Setup' }))
  tab('Workflow')
  const workflow = () => within(screen.getByRole('tabpanel', { name: 'Workflow' }))
  fireEvent.click(workflow().getByRole('button', { name: 'Step 1: Power Output OFF, off-0' }))
  expect(workflow().getByRole('option', { name: 'CH3' })).toBeTruthy()
  expect(workflow().getByRole('option', { name: /Saved Model/ })).toBeTruthy()
  tab('Setup')
  fireEvent.click(first.getByRole('button', { name: 'Refresh Status' }))
  await waitFor(() => expect((first.getAllByRole('button', { name: 'Clear Protection...' })[0] as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(first.getByRole('button', { name: 'List Resources' }))
  await first.findByRole('combobox', { name: 'Discovered Resources' })
  fireEvent.change(first.getByRole('combobox', { name: 'VISA Backend' }), { target: { value: 'system' } })
  expect((first.getByRole('textbox', { name: 'Live Resource' }) as HTMLInputElement).value).toBe('')
  expect(first.queryByText('Saved Vendor Saved Model')).toBeNull()
  expect(first.queryByRole('combobox', { name: 'Discovered Resources' })).toBeNull()
  expect((first.getByRole('button', { name: 'Clear Protection...' }) as HTMLButtonElement).disabled).toBe(true)
  expect(resources['powers-1']).toBe('USB::saved-py')
  expect(backends['powers-1']).toBe('@py')
  expect(calls().some(([command]) => command === 'set_live_resource')).toBe(false)
  expect(identities['powers-1'].model_id).toBe('saved-model')
  expect(first.queryByRole('rowheader', { name: '3' })).toBeNull()
  tab('Workflow')
  expect((workflow().getByRole('combobox', { name: 'Channel' }) as HTMLSelectElement).disabled).toBe(true)
  expect(workflow().queryByRole('option', { name: /Saved Model/ })).toBeNull()
  await waitFor(() => expect((screen.getByRole('button', { name: 'Run Live' }) as HTMLButtonElement).disabled).toBe(true))
  expect(screen.getByText(/unsaved Live Resource, backend or identity changes/)).toBeTruthy()
  tab('Setup')
  fireEvent.click(first.getByRole('button', { name: 'List Resources' }))
  const discovered = await first.findByRole('combobox', { name: 'Discovered Resources' })
  fireEvent.change(discovered, { target: { value: 'USB::powers::system' } })
  await waitFor(() => expect(calls()).toContainEqual(['get_powers_capabilities', { modelId: 'canonical-model', executionMode: 'live' }]))
  tab('Workflow')
  await waitFor(() => expect((workflow().getByRole('combobox', { name: 'Channel' }) as HTMLSelectElement).disabled).toBe(false))
  expect(workflow().queryByRole('option', { name: 'CH3' })).toBeNull()
  expect(workflow().getByRole('option', { name: /Model \[123\]/ })).toBeTruthy()
  fireEvent.click(workflow().getByRole('button', { name: 'Step 3: Scope Channel Scale, scope-scale' }))
  await workflow().findByRole('option', { name: 'CH4' })
  tab('Setup')
  const scope = instance('scopes-1')
  fireEvent.click(scope.getByRole('button', { name: 'Expand Channel Configuration' }))
  expect((scope.getByRole('combobox', { name: 'Channel 4 Waveform Invert' }) as HTMLSelectElement).disabled).toBe(false)
  fireEvent.change(scope.getByRole('combobox', { name: 'VISA Backend' }), { target: { value: '@py' } })
  expect((scope.getByRole('combobox', { name: 'Channel 4 Waveform Invert' }) as HTMLSelectElement).disabled).toBe(true)
  tab('Workflow')
  expect((workflow().getByRole('combobox', { name: 'Channel' }) as HTMLSelectElement).disabled).toBe(true)
  expect((workflow().getByRole('combobox', { name: 'Channel' }) as HTMLSelectElement).value).toBe('4')
  tab('Setup')
  const meter = instance('meters-1')
  expect((meter.getByRole('combobox', { name: 'Manual Range (V)' }) as HTMLSelectElement).value).toBe('30')
  fireEvent.change(meter.getByRole('combobox', { name: 'VISA Backend' }), { target: { value: '@py' } })
  await waitFor(() => expect(meter.getByRole('combobox', { name: 'Manual Range (V)' })
    .querySelector('option[value="10"]')).not.toBeNull())
  expect((meter.getByRole('combobox', { name: 'Manual Range (V)' }) as HTMLSelectElement).value).toBe('30')
  expect(await savedDraft()).toEqual(newDraft)
  // Restore the other instances through Discovery/Save before checking Live confirmation.
  for (const controls of [scope, meter]) {
    fireEvent.click(controls.getByRole('button', { name: 'List Resources' }))
    const select = await controls.findByRole('combobox', { name: 'Discovered Resources' })
    fireEvent.change(select, { target: { value: controls === scope ? 'USB::scopes::@py' : 'USB::meters::@py' } })
    fireEvent.click(controls.getByRole('button', { name: 'Save Resource' }))
    await waitFor(() => expect((controls.getByRole('button', { name: 'Save Resource' }) as HTMLButtonElement).disabled).toBe(false))
  }
  fireEvent.change(second.getByRole('combobox', { name: 'VISA Backend' }), { target: { value: '@py' } })
  expect(first.getByRole('combobox', { name: 'Discovered Resources' })).toBeTruthy()
  fireEvent.click(second.getByRole('button', { name: 'List Resources' }))
  await second.findByRole('combobox', { name: 'Discovered Resources' })
  expect(second.queryByRole('option', { name: /USB::powers::system/ })).toBeNull()
  expect(first.queryByRole('option', { name: /USB::powers::@py/ })).toBeNull()
  fireEvent.change(second.getByRole('textbox', { name: 'Live Resource' }), { target: { value: 'manual::second' } })
  fireEvent.click(first.getByRole('button', { name: 'Save Resource' }))
  await waitFor(() => expect(resources['powers-1']).toBe('USB::powers::system'))
  await waitFor(() => expect((first.getByRole('button', { name: 'Save Resource' }) as HTMLButtonElement).disabled).toBe(false))
  expect(backends['powers-1']).toBe('system')
  expect(identities['powers-1'].model_id).toBe('canonical-model')
  expect((second.getByRole('textbox', { name: 'Live Resource' }) as HTMLInputElement).value).toBe('manual::second')
  expect(backends['powers-2']).toBeUndefined()
  fireEvent.click(second.getByRole('button', { name: 'Save Resource' }))
  await waitFor(() => expect(backends['powers-2']).toBe('@py'))
  tab('Workflow')
  await waitFor(() => expect((screen.getByRole('button', { name: 'Run Live' }) as HTMLButtonElement).disabled).toBe(false))
  vi.mocked(confirm).mockResolvedValueOnce(false)
  click('Run Live')
  await waitFor(() => expect(confirm).toHaveBeenCalled())
  const confirmation = String(vi.mocked(confirm).mock.calls.at(-1)![0])
  expect(confirmation).toContain('powers-1 (powers)\nModel ID: canonical-model\nVendor Model\nS/N: 123\nBackend: System VISA\nUSB::powers::system')
  expect(confirmation).toContain('powers-2 (powers)\nBackend: PyVISA-py (@py)\nmanual::second')
  expect(calls().some(([command]) => command === 'run_workflow_live')).toBe(false)
  tab('Tools')
  click('Refresh')
  await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false))
  tab('Setup')
  expect((second.getByRole('combobox', { name: 'VISA Backend' }) as HTMLSelectElement).value).toBe('@py')
  expect((second.getByRole('textbox', { name: 'Live Resource' }) as HTMLInputElement).value).toBe('manual::second')
}, 15000)
