import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { isInaccessible } from '@testing-library/dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { confirm, open, save } from '@tauri-apps/plugin-dialog'
import App from '../src/App'
import ScopesActionEditor from '../src/ScopesActionEditor'
import ProcessEditor from '../src/ProcessEditor'
import { useState } from 'react'
import InputValueEditor, { ExpressionOperandEditor } from '../src/InputValueEditor'
import { I18nProvider } from '../src/i18n/I18nProvider'
import type { WorkflowDraft } from '../src/templateDraft'
import type { ExpressionOperandWire } from '../src/inputValue'
import ToolSetupEditor, { type ToolInstance } from '../src/ToolSetupEditor'
import BackgroundSetup from '../src/BackgroundSetup'
import type { BackgroundConfig, ProcessStep, ToolActionStep, WorkflowStep } from '../src/workflow'
import { addBackgroundChartPanel, chartPanelToSavedChart } from '../src/chartPanels'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.2.0' }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(), open: vi.fn(), save: vi.fn() }))

const original: WorkflowDraft = { name: 'Setup test', tool_instances: [
  { id: 'powers-1', tool: 'powers', setup: { protection: { channels: [{ channel: 1, ocp: 'on' }] } } },
  { id: 'scopes-1', tool: 'scopes', setup: { acquisition: { acquisition_type: 'average', average_count: 16 },
    channels: [{ channel: 4, invert: true }] } },
  { id: 'wavegen-1', tool: 'wavegen', setup: {} },
], workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [] } }
const empty: WorkflowDraft = { ...original, tool_instances: [] }
const backgroundMeter: ToolInstance = { id: 'meters-1', tool: 'meters', setup: { trigger_mode: 'immediate-custom',
  measurement: 'voltage-dc', range_mode: 'auto', manual_range: null, nplc: 1, auto_zero: 'on', dcv_input_impedance: null, current_terminal: null } }


test('Scope Single Wait shows fixed integer inputs without force or capability queries', () => {
  let step: ToolActionStep = { type: 'tool-action', id: 'trigger', target: 'scopes-1',
    action: 'single-wait', arguments: { trigger_timeout_ms: 5000, trigger_poll_interval_ms: 100 } }
  const changes = vi.fn((next: ToolActionStep) => { step = next })
  const view = () => <ScopesActionEditor step={step} instances={[]} earlierSteps={[]}
    earlierVariables={[]} disabled={false} onChange={changes} stepLabel={item => item.id}
    executionMode="simulate" modelId={undefined} scopesExecutableKey="scopes.exe" />
  const { rerender } = render(view())
  const trigger = screen.getByRole('spinbutton', { name: 'Trigger Timeout (ms)' }) as HTMLInputElement
  const poll = screen.getByRole('spinbutton', { name: 'Poll Interval (ms)' }) as HTMLInputElement
  expect(trigger.value).toBe('5000')
  expect(poll.value).toBe('100')
  expect(screen.getByRole('spinbutton', { name: 'Poll Interval (ms)', description: /no greater than Trigger Timeout/ })).toBe(poll)
  expect(screen.getByRole('spinbutton', { name: 'Trigger Timeout (ms)', description: /successful Step result.*No force trigger/ })).toBe(trigger)
  expect(screen.queryByRole('checkbox', { name: /Force Trigger/i })).toBeNull()
  expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('get_scopes_capabilities', expect.anything())
  fireEvent.change(trigger, { target: { value: '12000' } })
  rerender(view())
  expect(step.arguments.trigger_timeout_ms).toBe(12000)
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Poll Interval (ms)' }), { target: { value: '250' } })
  rerender(view())
  expect(step.arguments.trigger_poll_interval_ms).toBe(250)
  const count = changes.mock.calls.length
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Poll Interval (ms)' }), { target: { value: '-1' } })
  expect(changes).toHaveBeenCalledTimes(count)
  expect(step.arguments).toEqual({ trigger_timeout_ms: 12000, trigger_poll_interval_ms: 250 })
  expect(step.bindings).toBeUndefined()
})

test.each([
  ['en', 'Slope', ['Positive', 'Negative', 'Either', 'Alternate']],
  ['zh-TW', '斜率', ['正向', '負向', '任一方向', '交替']],
] as const)('Scope slope choices render in %s and keep their original values', async (locale, field, labels) => {
  const step: ToolActionStep = { type: 'tool-action', id: 'trigger', target: 'scopes-1',
    action: 'trigger-edge', arguments: { source_channel: 1, level: 0, slope: 'positive' } }
  const onChange = vi.fn()
  vi.mocked(invoke).mockResolvedValueOnce({
    analog_channels: 2, trigger_edge_slopes: ['positive', 'negative', 'either', 'alternate'],
  })
  render(<I18nProvider initialLanguage={locale}><ScopesActionEditor step={step}
    instances={[]} earlierSteps={[]} earlierVariables={[]} disabled={false}
    onChange={onChange} stepLabel={item => item.id} executionMode="simulate"
    modelId={undefined} scopesExecutableKey="scopes.exe" /></I18nProvider>)
  const slope = screen.getByRole('combobox', { name: field }) as HTMLSelectElement
  await waitFor(() => expect(slope.disabled).toBe(false))
  expect([...slope.options].filter(option => option.value).map(option => option.textContent)).toEqual([...labels])
  fireEvent.change(slope, { target: { value: 'alternate' } })
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
    arguments: expect.objectContaining({ slope: 'alternate' }),
  }))
})

test('status Result hints show comparison types and values without rewriting IF operands', () => {
  const scope: ToolActionStep = { type: 'tool-action', id: 'single', target: 'scopes-1', action: 'single-wait', arguments: {} }
  const power: ToolActionStep = { type: 'tool-action', id: 'protection', target: 'powers-1', action: 'protection-status', arguments: {} }
  const cases = [
    [scope, '/outcome', /String.*natural.*timeout/],
    [scope, '/timed_out', /Boolean.*true.*false/],
    [scope, '/capture_allowed', /Boolean.*true.*false/],
    [power, '/protection_tripped', /Boolean.*true.*false/],
    [power, '/over_voltage_tripped', /Boolean.*true.*false/],
    [power, '/over_current_tripped', /Boolean.*true.*false/],
  ] as const
  for (const [step, pointer, hint] of cases) {
    const onChange = vi.fn()
    const { unmount } = render(<ExpressionOperandEditor side="Left"
      value={{ source: 'step-output', step_id: step.id, pointer }}
      onChange={onChange} disabled={false} earlierSteps={[step]}
      instances={original.tool_instances} earlierVariables={[]} stepLabel={item => item.id} />)
    expect(screen.getByText(hint)).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
    unmount()
  }

  let value: ExpressionOperandWire = { source: 'step-output', step_id: 'single', pointer: '/outcome' }
  const onChange = vi.fn((next: ExpressionOperandWire) => { value = next })
  const view = () => <ExpressionOperandEditor side="Left" value={value} onChange={onChange}
    disabled={false} earlierSteps={[scope]} instances={original.tool_instances}
    earlierVariables={[]} stepLabel={item => item.id} />
  const { rerender, unmount } = render(view())
  fireEvent.change(screen.getByRole('combobox', { name: 'Result' }), { target: { value: '/timed_out' } })
  rerender(view())
  expect(value).toEqual({ source: 'step-output', step_id: 'single', pointer: '/timed_out' })
  expect(screen.getByText(/Boolean.*true.*false/)).toBeTruthy()
  expect(screen.queryByText(/String.*natural.*timeout/)).toBeNull()
  const calls = onChange.mock.calls.length
  fireEvent.change(screen.getByRole('combobox', { name: 'Result' }), { target: { value: 'custom' } })
  expect(onChange).toHaveBeenCalledTimes(calls)
  expect(screen.queryByText(/Boolean.*true.*false/)).toBeNull()
  unmount()

  const { unmount: closeZh } = render(<I18nProvider initialLanguage="zh-TW">
    <ExpressionOperandEditor side="Left" value={{ source: 'step-output', step_id: 'single', pointer: '/outcome' }}
      onChange={vi.fn()} disabled={false} earlierSteps={[scope]} instances={original.tool_instances}
      earlierVariables={[]} stepLabel={item => item.id} />
  </I18nProvider>)
  expect(screen.getByText(/String.*natural.*timeout/)).toBeTruthy()
  closeZh()
})

test.each(['root', 'nested', 'unreferenced'])('Background binding removal respects %s references', kind => {
  const action: WorkflowStep = { type: 'background', id: 'on', background_id: 'background-1', action: 'worker-on', capture: false }
  const steps: WorkflowStep[] = kind === 'root' ? [action] : kind === 'nested' ? [
    { type: 'for', id: 'for', variable: 'i', range: { start: '0', stop: '1', step: '1' }, steps: [
      { type: 'while', id: 'while', left: { source: 'literal', value: true }, operator: 'equal',
        right: { source: 'literal', value: true }, max_iterations: 1, steps: [action] },
    ] },
  ] : []
  const onChange = vi.fn()
  render(<BackgroundSetup instance={backgroundMeter}
    value={[{ id: 'background-1', tool_instance_id: 'meters-1', live_monitor: false, limit_count: 10 }]}
    steps={steps} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Expand Background Streaming' }))
  const binding = screen.getByLabelText('Enable Background Streaming') as HTMLInputElement
  expect(binding.disabled).toBe(kind !== 'unreferenced')
  if (kind === 'unreferenced') {
    fireEvent.click(binding)
    expect(onChange).toHaveBeenCalledWith([])
  }
  else expect(onChange).not.toHaveBeenCalled()
})
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
      case 'check_serial_send_files': return []
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

test('all Tool instances place Background Streaming between tool setup and Live Device', () => {
  const serial: ToolInstance = { id: 'serial-1', tool: 'serial', setup: {
    transport: 'serial', baud: 9600, data_bits: 8, parity: 'none', stop_bits: 1, flow_control: 'none', timeout_ms: 1000,
  } }
  const instances = [backgroundMeter, ...original.tool_instances, serial]
  render(<ToolSetupEditor value={instances} steps={[]} onChange={vi.fn()} disabled={false}
    configuredToolTypes={instances.map(item => item.tool)} resourceIdentities={{}} executionMode="simulate"
    metersExecutableKey="" powersExecutableKey="" scopesExecutableKey="" onBackgroundsChange={vi.fn()}
    renderResource={item => <h4>Live Device {item.id}</h4>} renderPowersDeviceStatus={() => null} />)
  const headings = { meters: 'Measurement Setup', powers: 'Protection Setup', scopes: 'Channel Configuration',
    serial: 'Communication Setup', wavegen: 'No additional setup' }
  const toolTypes = screen.getByRole('combobox', { name: 'Tool type' }) as HTMLSelectElement
  expect([...toolTypes.options].find(option => option.value === 'scopes')?.textContent).toBe('Scopes')
  expect([...toolTypes.options].find(option => option.value === 'meters')?.textContent).toBe('Meters')
  for (const item of instances) {
    const card = instance(item.id)
    const setup = card.getByText(headings[item.tool])
    const background = card.getByRole('heading', { name: /Background Streaming$/ })
    const resource = card.getByRole('heading', { name: `Live Device ${item.id}` })
    expect(setup.compareDocumentPosition(background) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(background.compareDocumentPosition(resource) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect((card.getByLabelText('Enable Background Streaming') as HTMLInputElement).disabled)
      .toBe(item.tool === 'powers' || item.tool === 'wavegen')
  }
})

test('Setup groups preserve settings through collapse and tabs, and reset on New Template', async () => {
  tools.push(toolStatus('serial'))
  const instances: ToolInstance[] = [backgroundMeter, { id: 'serial-1', tool: 'serial', setup: {
    transport: 'tcp', baud: 9600, data_bits: 7, parity: 'even', stop_bits: 2,
    flow_control: 'none', timeout_ms: 1000, connect_timeout_ms: 3000, io_timeout_ms: 2500,
  } }]
  newDraft = { ...original, tool_instances: instances, backgrounds: [
    { id: 'background-1', tool_instance_id: 'meters-1', live_monitor: true, limit_count: 10 },
  ] }
  loadedDraft = structuredClone(newDraft)
  render(<App />)
  await screen.findByRole('button', { name: 'Expand meters details' })
  tab('Setup')
  const groups = [['meters-1', 'Measurement Setup', 'Trigger Mode'], ['serial-1', 'Communication Setup', 'Transport']]
  for (const [id, title, field] of groups) {
    const card = instance(id)
    expect(card.getByRole('button', { name: 'Expand Background Streaming' }).getAttribute('aria-expanded')).toBe('false')
    expect(isInaccessible(card.getByLabelText('Enable Background Streaming'))).toBe(true)
    expect(card.getByRole('button', { name: 'Collapse Live Device' }).getAttribute('aria-expanded')).toBe('true')
    const resource = card.getByRole('textbox', { name: id === 'meters-1' ? 'Live Resource' : 'TCP Host' })
    fireEvent.change(resource, { target: { value: id === 'meters-1' ? 'USB::pending' : '127.0.0.1' } })
    fireEvent.click(card.getByRole('button', { name: 'Expand Background Streaming' }))
    fireEvent.click(card.getByRole('button', { name: 'Collapse Live Device' }))
    expect(isInaccessible(resource)).toBe(true)
    expect(card.getByRole('button', { name: `Collapse ${title}` }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(card.getByRole('button', { name: `Collapse ${title}` }))
    expect(card.queryByRole('combobox', { name: field })).toBeNull()
    expect(isInaccessible(card.getByLabelText('Enable Background Streaming'))).toBe(false)
    expect(card.getByRole('button', { name: 'Expand Live Device' })).toBeTruthy()
    fireEvent.click(card.getByRole('button', { name: `Collapse ${id}` }))
  }
  tab('Tools'); tab('Setup')
  for (const [id, title] of groups) {
    fireEvent.click(instance(id).getByRole('button', { name: `Expand ${id}` }))
    const card = instance(id)
    expect(card.getByRole('button', { name: `Expand ${title}` }).getAttribute('aria-expanded')).toBe('false')
    expect(card.getByRole('button', { name: 'Collapse Background Streaming' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(card.getByRole('button', { name: 'Expand Live Device' }))
    expect((card.getByRole('textbox', { name: id === 'meters-1' ? 'Live Resource' : 'TCP Host' }) as HTMLInputElement).value)
      .toBe(id === 'meters-1' ? 'USB::pending' : '127.0.0.1')
    fireEvent.click(card.getByRole('button', { name: 'Collapse Live Device' }))
  }
  const saved = await savedDraft()
  expect(saved.tool_instances).toEqual(instances)
  expect(saved.backgrounds).toEqual(newDraft.backgrounds)
  const previous = instance('meters-1').getByRole('button', { name: 'Expand Measurement Setup' })
  click('New Template')
  await waitFor(() => expect(previous.isConnected).toBe(false))
  tab('Setup')
  for (const [id, title, field] of groups) {
    const card = instance(id)
    expect(card.getByRole('button', { name: 'Expand Background Streaming' }).getAttribute('aria-expanded')).toBe('false')
    expect(card.getByRole('button', { name: 'Collapse Live Device' }).getAttribute('aria-expanded')).toBe('true')
    expect(card.getByRole('button', { name: `Collapse ${title}` }).getAttribute('aria-expanded')).toBe('true')
    expect(card.getByRole('combobox', { name: field })).toBeTruthy()
    fireEvent.click(card.getByRole('button', { name: 'Expand Background Streaming' }))
    fireEvent.click(card.getByRole('button', { name: 'Collapse Live Device' }))
    fireEvent.click(card.getByRole('button', { name: `Collapse ${title}` }))
  }
})
function focusClick(control: HTMLElement) {
  fireEvent.pointerDown(control)
  act(() => control.focus()) // Native focus() dispatches blur/focusout before click, including relatedTarget.
  fireEvent.pointerUp(control)
  fireEvent.click(control)
}
async function mount() {
  render(<I18nProvider initialLanguage="en"><App /></I18nProvider>)
  await screen.findByRole('button', { name: 'Expand powers details' })
  tab('Setup')
  await waitFor(() => expect((screen.getByRole('button', { name: 'Add Tool Instance' }) as HTMLButtonElement).disabled).toBe(false))
  await waitFor(() => expect(calls().some(([command]) => command === 'get_scopes_capabilities')).toBe(true))
}

test('Error Queue uses the selected mode and saved address, and shows partial errors', async () => {
  newDraft = { ...original, tool_instances: [...original.tool_instances, backgroundMeter] }
  resources['powers-1'] = 'USB::SAVED'
  resources['scopes-1'] = 'USB::SCOPE'
  resources['meters-1'] = 'USB::METER'
  identities['scopes-1'] = { model_id: 'unsupported-scope', model: null, manufacturer: null, serial: null, identity: null }
  identities['meters-1'] = { model_id: 'unsupported-meter', model: null, manufacturer: null, serial: null, identity: null }
  let meterCliSupportsErrorQueue = false
  const existing = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'get_scopes_capabilities') {
      return { analog_channels: 4, check_error_supported: (args as { modelId?: string }).modelId !== 'unsupported-scope' }
    }
    if (command === 'check_meters_error_queue_support') {
      if ((args as { executionMode: string }).executionMode === 'live') throw 'Unsupported instrument model: unsupported-meter'
      if (!meterCliSupportsErrorQueue) throw 'Use a Meters CLI that supports read-errors'
      return undefined
    }
    if (command === 'read_and_drain_errors') {
      return (args as { executionMode: string }).executionMode === 'simulate'
        ? { status: 'queue_empty', entries: [], error: null }
        : { status: 'failed', entries: [{ code: '-113', message: 'Undefined header, channel 1' }], error: 'Connection lost' }
    }
    return existing(command, args)
  })
  render(<I18nProvider initialLanguage="en"><App /></I18nProvider>)
  await screen.findByRole('button', { name: 'Expand powers details' }, { timeout: 5000 })
  tab('Setup')
  const read = () => instance('powers-1').getByRole<HTMLButtonElement>('button', { name: 'Read & Drain Errors' })
  const meterRead = () => instance('meters-1').getByRole<HTMLButtonElement>('button', { name: 'Read & Drain Errors' })
  await instance('meters-1').findByText(/CLI that supports read-errors/)
  expect(meterRead().disabled).toBe(true)
  meterCliSupportsErrorQueue = true // The executable is replaced without changing its path or version.
  tab('Tools')
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh' }).disabled).toBe(false))
  click('Refresh')
  tab('Setup')
  await waitFor(() => expect(meterRead().disabled).toBe(false))
  expect(invoke).not.toHaveBeenCalledWith('read_and_drain_errors', expect.anything())
  fireEvent.click(read())
  await instance('powers-1').findByText(/Queue Empty.*NO HARDWARE I\/O/)
  expect(confirm).not.toHaveBeenCalled()
  expect(invoke).toHaveBeenCalledWith('read_and_drain_errors', { toolId: 'powers', instanceId: 'powers-1', executionMode: 'simulate' })
  click('Live')
  await instance('meters-1').findByText(/Unsupported instrument model: unsupported-meter/)
  expect(meterRead().disabled).toBe(true)
  await instance('scopes-1').findByText(/does not support reading the Error Queue/)
  expect(instance('scopes-1').getByRole<HTMLButtonElement>('button', { name: 'Read & Drain Errors' }).disabled).toBe(true)
  fireEvent.change(instance('powers-1').getByRole('textbox', { name: 'Live Resource' }), { target: { value: 'USB::DRAFT' } })
  fireEvent.change(instance('powers-1').getByRole('combobox', { name: 'VISA Backend' }), { target: { value: '@py' } })
  expect(read().disabled).toBe(false)
  vi.mocked(confirm).mockResolvedValueOnce(false)
  fireEvent.click(read())
  await waitFor(() => expect(read().disabled).toBe(false))
  expect(vi.mocked(confirm).mock.calls.at(-1)![0]).toMatch(/USB::SAVED.*removes the returned entries/)
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'read_and_drain_errors')).toHaveLength(1)
  fireEvent.click(read())
  await instance('powers-1').findByText('Connection lost')
  expect(invoke).toHaveBeenCalledWith('read_and_drain_errors', { toolId: 'powers', instanceId: 'powers-1', executionMode: 'live' })
  expect(instance('powers-1').getByRole('cell', { name: '-113' })).toBeTruthy()
  expect(instance('powers-1').getByRole('cell', { name: 'Undefined header, channel 1' })).toBeTruthy()
  expect(instance('powers-1').getByRole('status').textContent).toBe('Queue Status Failed')
}, 15000)
async function savedDraft() {
  click('Save Template')
  await screen.findByText('Template saved.')
  const args = calls().filter(([command]) => command === 'save_workflow_template').at(-1)![1] as { templateJson: string }
  return JSON.parse(args.templateJson)
}

test('Interaction panel and Step category follow Background binding and opt-in', async () => {
  newDraft = { ...original, tool_instances: [{ ...backgroundMeter, setup: { ...backgroundMeter.setup, trigger_mode: 'software' } }], backgrounds: [],
    workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [] } }
  render(<App />)
  await screen.findByRole('button', { name: 'Expand meters details' })
  tab('Workflow')
  const categories = () => within(screen.getByRole('region', { name: 'Step categories' }))
  const interactionCategory = () => categories().getByRole('button', { name: 'FG/BG Interaction' }) as HTMLButtonElement
  const bgCategory = () => categories().getByRole('button', { name: 'Background Workflow' }) as HTMLButtonElement
  const unavailable = () => categories().getByRole('button', { name: /Unavailable categories \(\d+\)/ })
  expect(unavailable().getAttribute('aria-expanded')).toBe('false')
  expect(categories().queryByRole('button', { name: 'FG/BG Interaction' })).toBeNull()
  fireEvent.click(unavailable())
  expect(interactionCategory().disabled).toBe(true)
  expect(bgCategory().disabled).toBe(true)
  const panelButton = screen.getByRole('button', { name: 'Expand FG/BG Interaction' }) as HTMLButtonElement
  expect(panelButton.disabled).toBe(true)
  expect(bgCategory().compareDocumentPosition(interactionCategory()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Chart Options' }).compareDocumentPosition(panelButton)
    & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  tab('Setup')
  fireEvent.click(instance('meters-1').getByRole('button', { name: 'Expand Background Streaming' }))
  fireEvent.click(instance('meters-1').getByLabelText('Enable Background Streaming'))
  tab('Workflow')
  expect(bgCategory().disabled).toBe(false)
  expect(interactionCategory().disabled).toBe(true)
  click('Expand FG/BG Interaction')
  fireEvent.click(screen.getByLabelText('Enable FG/BG Interaction'))
  expect(interactionCategory().disabled).toBe(false)
  fireEvent.click(categories().getByRole('button', { name: 'BG Command' }))
  expect((screen.getByRole('button', { name: 'Add Step' }) as HTMLButtonElement).disabled).toBe(false)

  fireEvent.click(screen.getByLabelText('Enable FG/BG Interaction'))
  expect(interactionCategory().disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Add Step' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByLabelText('Enable FG/BG Interaction'))
  fireEvent.change(screen.getByLabelText('Max Active Command Status'), { target: { value: '12' } })
  tab('Setup')
  fireEvent.click(instance('meters-1').getByLabelText('Enable Background Streaming'))
  tab('Workflow')
  expect(bgCategory().disabled).toBe(true)
  expect(interactionCategory().disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Expand FG/BG Interaction' }) as HTMLButtonElement).disabled).toBe(true)
  const saved = await savedDraft()
  expect(saved.workflow.interaction).toEqual({ enabled: false, max_active_command_status: 12, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } })
})

test('Workflow saves interaction settings and command/result references through the editor', async () => {
  newDraft = { ...original, tool_instances: [{ ...backgroundMeter, setup: { ...backgroundMeter.setup, trigger_mode: 'software' } }],
    backgrounds: [{ id: 'background-1', tool_instance_id: 'meters-1', live_monitor: false, limit_count: 1, command_trigger: true }],
    workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [] } }
  render(<App />)
  await screen.findByRole('button', { name: 'Expand meters details' })
  tab('Workflow')
  click('Expand FG/BG Interaction')
  fireEvent.click(screen.getByLabelText('Enable FG/BG Interaction'))
  fireEvent.change(screen.getByLabelText('Max Active Command Status'), { target: { value: '12' } })
  click('BG Command')
  click('Add Step')
  fireEvent.click(screen.getByLabelText('Wait for Completion'))
  click('Get Command Result')
  click('Add Step')
  const source = screen.getByLabelText('Source BG Command Step') as HTMLSelectElement
  expect(source.options.length).toBe(2)
  fireEvent.change(source, { target: { value: source.options[1].value } })
  const saved = await savedDraft()
  expect(saved.workflow.interaction).toEqual({ enabled: true, max_active_command_status: 12, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } })
  const [command, get] = saved.workflow.steps
  expect(command.operation).toEqual({ kind: 'command', command: 'software-trigger', wait_for_completion: true })
  expect(get.operation).toEqual({ kind: 'get-command-result', source_step: command.id })
})

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

test('Serial command drafts survive Step selection and stay out of saved/replaced Templates', async () => {
  tools.push(toolStatus('serial'))
  newDraft = structuredClone(serialBackgroundDraft)
  render(<App />)
  await screen.findByRole('button', { name: 'Expand serial details' })
  tab('Workflow')
  click('Step 1: BG Command, send')
  fireEvent.change(screen.getByLabelText('TX Data'), { target: { value: 'STOP' } })
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'serial-send-file' } })
  fireEvent.change(screen.getByLabelText('Absolute File Path (Worker-local)'), { target: { value: '/tmp/payload.bin' } })
  click('Step 2: Wait, other')
  click('Step 1: BG Command, send')
  expect((screen.getByLabelText('Absolute File Path (Worker-local)') as HTMLInputElement).value).toBe('/tmp/payload.bin')
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'serial-send' } })
  expect((screen.getByLabelText('TX Data') as HTMLInputElement).value).toBe('STOP')
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'serial-send-file' } })
  const expected = structuredClone(serialBackgroundDraft)
  expected.workflow.steps[0] = { type: 'bg-interaction', id: 'send', background_id: 'serial-bg', timeout_ms: null, operation: { kind: 'command',
    command: 'serial-send-file', wait_for_completion: true, arguments: { path: '/tmp/payload.bin' } } }
  expect(await savedDraft()).toEqual(expected)

  newDraft = expected
  loadedDraft = expected
  for (const action of ['New Template', 'Open Template']) {
    const previous = screen.getByLabelText('Absolute File Path (Worker-local)')
    click(action)
    await waitFor(() => expect(previous.isConnected).toBe(false))
    click('Step 1: BG Command, send')
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'serial-send' } })
    expect((screen.getByLabelText('TX Data') as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('TX Data'), { target: { value: 'session-only' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'serial-send-file' } })
  }
})

test('Serial timeout controls and Assert String literals persist through Workflow save/open', async () => {
  tools.push(toolStatus('serial'))
  const serial: ToolInstance = { id: 'serial-1', tool: 'serial', setup: {
    transport: 'serial', baud: 115200, data_bits: 8, parity: 'none', stop_bits: 1,
    flow_control: 'none', timeout_ms: 1000,
  } }
  newDraft = { name: 'Serial timeout editor', tool_instances: [serial],
    workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [
      { type: 'tool-action', id: 'query-1', target: 'serial-1', action: 'query',
        arguments: { tx_format: 'text', tx_value: 'REA', delimiter_format: 'hex',
          delimiter_value: '0D0A', max_bytes: 32 } },
      { type: 'tool-action', id: 'receive-1', target: 'serial-1', action: 'receive',
        arguments: { max_bytes: 32 } },
      { type: 'assert', id: 'assert-1',
        left: { source: 'literal', value: 0 }, operator: 'equal',
        right: { source: 'literal', value: 0 }, message: 'RX mismatch' },
    ] } }
  render(<App />)
  await screen.findByRole('button', { name: 'Expand serial details' })
  tab('Workflow')
  click('Step 1: Serial Query, query-1')
  expect((screen.getByRole('combobox', { name: 'Receive Mode' }) as HTMLSelectElement).value).toBe('delimiter')
  expect(screen.getByText('Reads until the delimiter appears; the returned data includes the delimiter.')).toBeTruthy()
  const queryFlag = screen.getByRole('checkbox', { name: 'Fail on Read Timeout' }) as HTMLInputElement
  expect(queryFlag.checked).toBe(false)
  const properties = within(screen.getByRole('region', { name: 'Properties' }))
  const results = () => within(properties.getByRole('group', { name: 'Common result fields' }))
  expect(results().queryByText('/rx_hex')).toBeNull()
  expect(results().getByText('RX Data (Hex String)')).toBeTruthy()
  expect(results().getByText('RX Length (Bytes)')).toBeTruthy()
  expect(results().getByText('RX Read Timed Out')).toBeTruthy()
  expect(results().getByText('Serial Read Status')).toBeTruthy()
  expect(results().getByText('Partial RX Hex')).toBeTruthy()
  expect(results().getByText('Partial RX Bytes')).toBeTruthy()
  expect(results().queryByText('RX Text (UTF-8)')).toBeNull()
  expect(results().queryByText('Partial RX Text (UTF-8)')).toBeNull()
  fireEvent.click(queryFlag)
  expect(queryFlag.checked).toBe(true)
  expect(results().getByText('RX Data (Hex String)')).toBeTruthy()
  expect(results().queryByText('Partial RX Hex')).toBeNull()
  expect(results().queryByText('Partial RX Bytes')).toBeNull()
  click('Step 2: Serial Receive, receive-1')
  const receiveMode = screen.getByRole('combobox', { name: 'Receive Mode' }) as HTMLSelectElement
  expect(receiveMode.value).toBe('single')
  expect(screen.getByText('Performs one underlying read; a successful return completes the Step without filling Max RX Bytes.')).toBeTruthy()
  expect((screen.getByRole('checkbox', { name: 'Fail on Read Timeout' }) as HTMLInputElement).checked).toBe(false)
  fireEvent.change(receiveMode, { target: { value: 'fixed' } })
  const expectedBytes = screen.getByRole('spinbutton', { name: 'Expected RX Bytes' }) as HTMLInputElement
  expect(expectedBytes.value).toBe('')
  fireEvent.change(expectedBytes, { target: { value: '8' } })
  expect(results().queryByText('RX Text (UTF-8)')).toBeNull()
  expect(results().queryByText('Partial RX Text (UTF-8)')).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enable RX Text (UTF-8)' }))
  expect(results().getByText('RX Text (UTF-8)')).toBeTruthy()
  expect(results().getByText('Partial RX Text (UTF-8)')).toBeTruthy()
  fireEvent.change(receiveMode, { target: { value: 'idle' } })
  const gap = screen.getByRole('spinbutton', { name: 'Idle Gap (ms)' }) as HTMLInputElement
  expect(gap.value).toBe('')
  fireEvent.change(gap, { target: { value: '20' } })
  fireEvent.change(receiveMode, { target: { value: 'fixed' } })
  expect((screen.getByRole('spinbutton', { name: 'Expected RX Bytes' }) as HTMLInputElement).value).toBe('8')

  click('Step 3: Assert, assert-1')
  const left = within(screen.getByRole('group', { name: /Left/ }))
  const right = within(screen.getByRole('group', { name: /Right/ }))
  fireEvent.change(right.getByRole('combobox', { name: 'Value Type' }), { target: { value: 'string' } })
  fireEvent.change(right.getByRole('textbox', { name: 'Value' }), { target: { value: '524541' } })
  fireEvent.change(left.getByRole('combobox', { name: 'Value Type' }), { target: { value: 'string' } })
  fireEvent.change(left.getByRole('textbox', { name: 'Value' }), { target: { value: 'temporary' } })
  fireEvent.change(left.getByRole('combobox', { name: 'Left Source' }), { target: { value: 'step-output' } })
  fireEvent.change(left.getByRole('combobox', { name: 'Result' }), { target: { value: '/partial_rx_hex' } })
  expect((right.getByRole('textbox', { name: 'Value' }) as HTMLInputElement).value).toBe('524541')

  const saved = await savedDraft()
  const [query, receive, assertion] = saved.workflow.steps
  expect(query.arguments.fail_on_read_timeout).toBe(true)
  expect(receive.arguments.fail_on_read_timeout).toBeUndefined()
  expect(receive.arguments.receive_mode).toBe('fixed')
  expect(receive.arguments.expected_bytes).toBe(8)
  expect(receive.arguments.idle_gap_ms).toBe(20)
  expect(receive.arguments.enable_rx_text).toBe(true)
  expect(assertion.left).toEqual({ source: 'step-output', step_id: 'query-1', pointer: '/partial_rx_hex' })
  expect(assertion.right).toEqual({ source: 'literal', value: '524541' })

  loadedDraft = saved
  click('Open Template')
  await screen.findByText('Template loaded.')
  click('Step 1: Serial Query, query-1')
  expect((screen.getByRole('checkbox', { name: 'Fail on Read Timeout' }) as HTMLInputElement).checked).toBe(true)
  click('Step 2: Serial Receive, receive-1')
  expect((screen.getByRole('combobox', { name: 'Receive Mode' }) as HTMLSelectElement).value).toBe('fixed')
  expect((screen.getByRole('spinbutton', { name: 'Expected RX Bytes' }) as HTMLInputElement).value).toBe('8')
  expect((screen.getByRole('checkbox', { name: 'Enable RX Text (UTF-8)' }) as HTMLInputElement).checked).toBe(true)
  const reloadedProperties = within(screen.getByRole('region', { name: 'Properties' }))
  expect(within(reloadedProperties.getByRole('group', { name: 'Common result fields' })).getByText('RX Text (UTF-8)')).toBeTruthy()
  expect(within(reloadedProperties.getByRole('group', { name: 'Common result fields' })).getByText('Partial RX Text (UTF-8)')).toBeTruthy()
  click('Step 3: Assert, assert-1')
  const reloadedLeft = within(screen.getByRole('group', { name: /Left/ }))
  const reloadedRight = within(screen.getByRole('group', { name: /Right/ }))
  expect((reloadedLeft.getByRole('combobox', { name: 'Result' }) as HTMLSelectElement).value).toBe('/partial_rx_hex')
  expect((reloadedRight.getByRole('textbox', { name: 'Value' }) as HTMLInputElement).value).toBe('524541')
})

test('opening a nested BG Send File Template displays the shared nonblocking file warning', async () => {
  const file = { type: 'bg-interaction', id: 'file', background_id: 'serial-bg', timeout_ms: null,
    operation: { kind: 'command', command: 'serial-send-file', wait_for_completion: true,
      arguments: { path: '/tmp/missing-bg-payload.bin' } } } as const
  loadedDraft = { ...structuredClone(serialBackgroundDraft), workflow: {
    ...serialBackgroundDraft.workflow, steps: [
      { type: 'for', id: 'loop', variable: 'i', range: { start: '0', stop: '1', step: '1' }, steps: [file] },
    ],
  } }
  const fileError = 'Step file: /tmp/missing-bg-payload.bin: No such file or directory'
  const nativeInvoke = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'check_serial_send_files'
    ? [fileError] : nativeInvoke(command, args))
  render(<App />)
  await screen.findByRole('button', { name: 'Expand meters details' })
  tab('Workflow')
  click('Open Template')
  await screen.findByText(text => text.includes(fileError))
  expect(invoke).toHaveBeenCalledWith('check_serial_send_files', { templateJson: JSON.stringify(loadedDraft) })
  expect(await savedDraft()).toEqual(loadedDraft)
})

test.each(['simulate', 'live'] as const)('Meters overflow warning follows Allow Risk and known capacity in %s', async executionMode => {
  const capabilities = { model: 'Test Meter', trigger_modes: ['software', 'immediate-custom'], limits: {
    sample_count: { max: 1_000_000 }, buffer_drain_size: { max: 10_000 }, trigger_count: { max: 1_000_000 },
  }, reading_memory_limit: 10_000, measurements: [] }
  let resolveCapabilities!: (value: typeof capabilities) => void
  vi.mocked(invoke).mockReturnValueOnce(new Promise(resolve => { resolveCapabilities = resolve }))
  let value: ToolInstance[] = [{ ...backgroundMeter,
    setup: { ...backgroundMeter.setup, sample_count: 5_000, buffer_drain_size: 100, allow_buffer_overflow_risk: false } }]
  const steps: WorkflowStep[] = []
  let limit: number | null = 1
  const onChange = vi.fn((next: ToolInstance[]) => { value = next })
  const view = () => <ToolSetupEditor value={value} steps={steps} onChange={onChange} disabled={false}
    backgrounds={[{ id: 'background-1', tool_instance_id: 'meters-1', live_monitor: false, limit_count: limit }]}
    configuredToolTypes={['meters']} resourceIdentities={{}} executionMode={executionMode}
    metersExecutableKey="meters.exe" powersExecutableKey="" scopesExecutableKey=""
    renderResource={() => null} renderPowersDeviceStatus={() => null} />
  const { rerender } = render(view())
  const warning = () => {
    const status = screen.getByRole('status')
    expect(within(status).getByText('High Buffer Overflow Risk Accepted')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    return within(status)
  }
  const toggleRisk = (enabled: boolean) => {
    const before = structuredClone(value)
    const edits = onChange.mock.calls.length
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow Buffer Overflow Risk' }))
    expect(onChange).toHaveBeenCalledTimes(edits + 1)
    expect(value).toEqual([{ ...before[0], setup: { ...before[0].setup, allow_buffer_overflow_risk: enabled } }])
    rerender(view())
  }

  expect(screen.queryByRole('status')).toBeNull()
  expect(onChange).not.toHaveBeenCalled()
  toggleRisk(true)
  expect(warning().queryByText(/planned \/ .* capacity/)).toBeNull() // Capabilities are still pending.
  await act(async () => { resolveCapabilities(capabilities) })
  await screen.findByText(/Test Meter · Memory 10,000/)
  expect(warning().queryByText(/planned \/ .* capacity/)).toBeNull() // 5,000 is below capacity.
  toggleRisk(false)
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  toggleRisk(true)
  warning()

  limit = 4
  rerender(view())
  expect(warning().getByText(/20,000 planned \/ 10,000 capacity/)).toBeTruthy()
  toggleRisk(false)
  expect(screen.queryByRole('status')).toBeNull()
  const blocking = within(screen.getByRole('alert'))
  expect(blocking.getByText('Reading memory exceeded')).toBeTruthy()
  expect(blocking.getByText('20,000 planned / 10,000 capacity.')).toBeTruthy()
  expect(blocking.getByText(/Enable “Allow Buffer Overflow Risk” to proceed/)).toBeTruthy()
  toggleRisk(true)
  expect(warning().getByText(/20,000 planned \/ 10,000 capacity/)).toBeTruthy()

  limit = null
  rerender(view())
  expect(warning().queryByText(/planned \/ .* capacity/)).toBeNull()
  expect(onChange).toHaveBeenCalledTimes(5) // Only explicit checkbox changes edit Setup.
  for (const allowRisk of [false, true]) {
    value = [{ ...backgroundMeter, setup: { ...backgroundMeter.setup, trigger_mode: 'software', allow_buffer_overflow_risk: allowRisk } }]
    rerender(view())
    expect(screen.queryByRole('status')).toBeNull() // Single hides even a stored Custom acknowledgement.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Allow Buffer Overflow Risk' })).toBeNull()
  }
  expect(onChange).toHaveBeenCalledTimes(5)
  expect(calls()).toEqual([['get_meters_capabilities', { executionMode }]])
})

test('Meters role controls six Background modes without deleting existing steps', async () => {
  vi.mocked(invoke).mockResolvedValue({ model: '34461A', trigger_modes: ['software', 'immediate', 'external', 'software-custom', 'immediate-custom', 'external-custom'],
    limits: { sample_count: { max: 1000000 }, buffer_drain_size: { max: 10000 }, trigger_count: { max: 1000000 } },
    reading_memory_limit: 10000, measurements: [] })
  let instances: ToolInstance[] = [{ ...backgroundMeter, setup: { ...backgroundMeter.setup, trigger_mode: 'software' } }]
  let backgrounds: BackgroundConfig[] = []
  const steps: WorkflowStep[] = [{ type: 'tool-action', id: 'measure', target: 'meters-1', action: 'measure', arguments: {} }]
  const originalSteps = structuredClone(steps)
  const view = () => <ToolSetupEditor value={instances} steps={steps} backgrounds={backgrounds}
    onChange={value => { instances = value }} onBackgroundsChange={value => { backgrounds = value }} disabled={false}
    configuredToolTypes={['meters']} resourceIdentities={{}} executionMode="simulate" metersExecutableKey="meters"
    powersExecutableKey="" scopesExecutableKey="" renderResource={() => null} renderPowersDeviceStatus={() => null} />
  const { rerender } = render(view())
  const modes = () => screen.getByLabelText('Trigger Mode') as HTMLSelectElement
  await waitFor(() => expect(modes().options[0].disabled).toBe(false))
  expect([...modes().options].map(option => option.textContent)).toEqual(['Single'])
  fireEvent.click(screen.getByRole('button', { name: 'Expand Background Streaming' }))
  fireEvent.click(screen.getByLabelText('Enable Background Streaming'))
  rerender(view())
  expect(modes().options.length).toBe(6)
  expect(backgrounds[0]).toMatchObject({ limit_count: 1000, timer_interval_ms: 1000 })
  expect(screen.getByLabelText('Max Samples')).toBeTruthy()
  expect(screen.getByText(/still has Foreground actions/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Timer Interval (ms)'), { target: { value: '250' } })
  rerender(view())
  fireEvent.change(modes(), { target: { value: 'software-custom' } })
  rerender(view())
  expect(backgrounds[0].timer_interval_ms).toBe(250)
  expect(screen.getByLabelText('Trigger Count')).toBeTruthy()
  expect(screen.getByLabelText('Sample Count')).toBeTruthy()
  fireEvent.change(modes(), { target: { value: 'external' } })
  rerender(view())
  expect(backgrounds[0].timer_interval_ms).toBeUndefined()
  expect(screen.queryByLabelText('Timer Interval (ms)')).toBeNull()
  fireEvent.change(screen.getByLabelText('Hardware Trigger Slope'), { target: { value: 'neg' } })
  rerender(view())
  fireEvent.change(screen.getByLabelText('Hardware Trigger Delay (s)'), { target: { value: '0.25' } })
  rerender(view())
  expect(instances[0].setup).toMatchObject({ hw_trigger_slope: 'neg', hw_trigger_delay_s: 0.25 })
  fireEvent.click(screen.getByLabelText('Enable Background Streaming'))
  rerender(view())
  expect(screen.getByText(/Foreground Meters requires Single/)).toBeTruthy()
  fireEvent.change(modes(), { target: { value: 'software' } })
  rerender(view())
  expect(modes().value).toBe('software')
  expect(backgrounds).toEqual([])
  expect(steps).toEqual(originalSteps)
})

test('loading a Template with Background Charts and accepted overflow risk preserves setup and X axis on save', async () => {
  const panel = addBackgroundChartPanel([], 'background-1')[0]
  panel.source!.x_axis = 'timestamp'
  loadedDraft = { ...empty, tool_instances: [{ ...backgroundMeter,
    setup: { ...backgroundMeter.setup, allow_buffer_overflow_risk: true } }], backgrounds: [{ id: 'background-1', tool_instance_id: 'meters-1',
    live_monitor: true, limit_count: 10 }], output_views: { charts: [chartPanelToSavedChart(panel)] } }
  await mount()
  click('Open Template')
  await screen.findByText('Template loaded.')
  expect(instance('meters-1').getByText('High Buffer Overflow Risk Accepted')).toBeTruthy()
  const saved = await savedDraft()
  expect(saved).toEqual(loadedDraft)
})
const summaryCounts = () => Array.from(screen.getByRole('region', { name: 'Tool Instance Summary' })
  .querySelectorAll('dl > div')).map(node => [node.querySelector('dt')!.textContent, node.querySelector('dd')!.textContent])

test('Setup preserves independent groups, local drafts and protection data through edits and tab/instance toggles', async () => {
  await mount()
  const power = instance('powers-1')
  const scope = instance('scopes-1')
  expect(power.getByRole('button', { name: 'Expand Protection Setup' }).textContent).toBe('+')
  expect(power.queryByRole('heading', { name: 'Device' })).toBeNull()
  expect(power.queryByRole('heading', { name: 'Device Status' })).toBeNull()
  expect(power.queryByRole('button', { name: 'Refresh Status' })).toBeNull()
  expect(power.queryByRole('region', { name: 'Protection Summary' })).toBeNull()
  expect(power.queryByRole('button', { name: 'Generate Clear Plan...' })).toBeNull()
  expect(power.queryByRole('table')).toBeNull()
  expect((power.getByRole('button', { name: 'Remove Tool Instance' }) as HTMLButtonElement).disabled).toBe(false)
  expect(scope.queryByRole('spinbutton', { name: 'Average Count' })).toBeNull()
  expect(scope.queryByRole('combobox', { name: 'Channel 4 Waveform Invert' })).toBeNull()
  expect(scope.getByRole('textbox', { name: 'Live Resource' })).toBeTruthy()
  const beforeToggle = calls().length
  fireEvent.click(power.getByRole('button', { name: 'Expand Protection Setup' }))
  expect((power.getByRole('checkbox', { name: 'Use Protection Setup' }) as HTMLInputElement).checked).toBe(true)
  expect(power.getByRole('region', { name: 'Protection Summary' })).toBeTruthy()
  expect(power.getByRole('textbox', { name: 'Live Resource' })).toBeTruthy()
  expect(power.getByRole('button', { name: 'Generate Clear Plan...' })).toBeTruthy()
  const ocp = power.getByRole('combobox', { name: 'Channel 1 OCP' }) as HTMLSelectElement
  expect(ocp.value).toBe('on')
  fireEvent.click(power.getByRole('button', { name: 'Collapse Protection Setup' }))
  expect(power.queryByRole('button', { name: 'Refresh Status' })).toBeNull()
  expect(power.queryByRole('combobox', { name: 'Channel 1 OCP' })).toBeNull()
  expect(power.getByRole('textbox', { name: 'Live Resource' })).toBeTruthy()
  fireEvent.click(power.getByRole('button', { name: 'Expand Protection Setup' }))
  expect(power.getByRole('combobox', { name: 'Channel 1 OCP' })).toBe(ocp)
  expect(ocp.value).toBe('on')
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

test.each(['Acquisition Setup', 'Tools tab'])('Average Count preserves an incomplete draft across %s and accepts a completed value', async target => {
  await mount()
  click('Expand Acquisition Setup')
  const count = screen.getByRole('spinbutton', { name: 'Average Count' }) as HTMLInputElement
  act(() => count.focus())
  fireEvent.change(count, { target: { value: '1' } })
  const control = target === 'Tools tab'
    ? screen.getByRole('tab', { name: 'Tools' })
    : screen.getByRole('button', { name: 'Collapse Acquisition Setup' })
  const events: string[] = []
  count.addEventListener('blur', () => events.push('blur'), { once: true })
  control.addEventListener('click', () => events.push('click'), { once: true })
  focusClick(control)
  expect(events).toEqual(['blur', 'click'])
  expect(screen.queryByRole('spinbutton', { name: 'Average Count' })).toBeNull()
  if (target === 'Tools tab') tab('Setup')
  else click('Expand Acquisition Setup')
  expect(count.value).toBe('1')
  expect(await savedDraft()).toEqual(original)
  act(() => count.focus())
  fireEvent.change(count, { target: { value: '64' } })
  act(() => count.blur())
  expect(count.value).toBe('64')
  const saved = await savedDraft()
  expect(saved.tool_instances[1].setup.acquisition).toEqual({ acquisition_type: 'average', average_count: 64 })
})

test('Average Count ordinary blur still restores the accepted value and Acquisition Type changes clear the draft', async () => {
  await mount()
  click('Expand Acquisition Setup')
  const count = screen.getByRole('spinbutton', { name: 'Average Count' }) as HTMLInputElement
  const type = screen.getByRole('combobox', { name: 'Acquisition Type' })
  for (const next of [type, null]) {
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

test('Protection Setup hides Device status and results while preserving resource controls and mode badges in Simulation and Live', async () => {
  newDraft.workflow.steps = [{ type: 'tool-action', id: 'power-off', target: 'powers-1',
    action: 'output-off', arguments: { channel: 1 } }]
  await mount()
  const power = instance('powers-1')
  const checkResourceControls = () => {
    expect(isInaccessible(power.getByText('Live Device'))).toBe(false)
    expect(power.getByRole('combobox', { name: 'VISA Backend' })).toBeTruthy()
    expect(power.getByRole('textbox', { name: 'Live Resource' })).toBeTruthy()
    for (const name of ['List Resources', 'Save Resource', 'Clear Resource']) {
      expect(power.getByRole('button', { name })).toBeTruthy()
    }
    expect((power.getByRole('button', { name: 'Remove Tool Instance' }) as HTMLButtonElement).disabled).toBe(true)
    expect(isInaccessible(power.getByText(/Referenced by workflow steps/))).toBe(false)
    expect(isInaccessible(power.getByText('Last-known identity; not a connection check.'))).toBe(false)
  }
  const checkCollapse = (resultText: string, modeBadge: string, clearAction: string) => {
    const heading = power.getByRole('heading', { name: 'Device Status' })
    const summary = power.getByRole('region', { name: 'Protection Summary' })
    const status = summary.textContent
    const result = power.getByText(resultText)
    const beforeToggle = calls().length
    checkResourceControls()
    expect(power.getAllByText(modeBadge)).toHaveLength(1)
    fireEvent.click(power.getByRole('button', { name: 'Collapse Protection Setup' }))
    expect(power.queryByRole('heading', { name: 'Device' })).toBeNull()
    expect(power.queryByRole('heading', { name: 'Device Status' })).toBeNull()
    expect(power.queryByRole('region', { name: 'Protection Summary' })).toBeNull()
    expect(power.queryByRole('button', { name: 'Refresh Status' })).toBeNull()
    expect(power.queryByRole('button', { name: clearAction })).toBeNull()
    expect(power.queryByRole('table')).toBeNull()
    expect(isInaccessible(result)).toBe(true)
    expect(heading.isConnected).toBe(true)
    checkResourceControls()
    expect(power.getAllByText(modeBadge)).toHaveLength(1)
    fireEvent.click(power.getByRole('button', { name: 'Expand Protection Setup' }))
    expect(power.getByRole('heading', { name: 'Device Status' })).toBe(heading)
    expect(power.getByRole('region', { name: 'Protection Summary' })).toBe(summary)
    expect(summary.textContent).toBe(status)
    expect(isInaccessible(result)).toBe(false)
    expect(power.getByRole('button', { name: clearAction })).toBeTruthy()
    checkResourceControls()
    expect(calls().slice(beforeToggle)).toEqual([])
  }
  checkResourceControls()
  fireEvent.click(power.getByRole('button', { name: 'List Resources' }))
  const discovered = await power.findByRole('combobox', { name: 'Discovered Resources' })
  fireEvent.click(power.getByRole('button', { name: 'Expand Protection Setup' }))
  fireEvent.click(power.getByRole('button', { name: 'Refresh Status' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('refresh_powers_status', { instanceId: 'powers-1', executionMode: 'simulate' }))
  await waitFor(() => expect((power.getByRole('button', { name: 'Generate Clear Plan...' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(power.getByRole('button', { name: 'Generate Clear Plan...' }))
  await power.findByText('PLAN GENERATED · SIMULATION')
  checkCollapse('PLAN GENERATED · SIMULATION', 'SIMULATION · NO HARDWARE I/O', 'Generate Clear Plan...')
  expect(power.getByRole('combobox', { name: 'Discovered Resources' })).toBe(discovered)
  fireEvent.click(power.getByRole('button', { name: 'Collapse Protection Setup' }))
  expect(power.getByRole('combobox', { name: 'Discovered Resources' })).toBe(discovered)
  fireEvent.change(power.getByRole('textbox', { name: 'Live Resource' }), { target: { value: 'USB::power' } })
  fireEvent.click(power.getByRole('button', { name: 'Save Resource' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_live_resource', {
    instanceId: 'powers-1', resource: 'USB::power', identity: null, backend: 'system',
  }))
  await waitFor(() => expect((power.getByRole('button', { name: 'Save Resource' }) as HTMLButtonElement).disabled).toBe(false))
  click('Live')
  checkResourceControls()
  expect(power.queryByRole('button', { name: 'Refresh Status' })).toBeNull()
  fireEvent.click(power.getByRole('button', { name: 'Expand Protection Setup' }))
  fireEvent.click(power.getByRole('button', { name: 'Refresh Status' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('refresh_powers_status', { instanceId: 'powers-1', executionMode: 'live' }))
  await waitFor(() => expect((power.getByRole('button', { name: 'Clear Protection...' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(power.getByRole('button', { name: 'Clear Protection...' }))
  await power.findByText('Protection clear completed in LIVE mode. Real hardware was addressed and outputs remain OFF.')
  expect(invoke).toHaveBeenCalledWith('clear_powers_protection', { instanceId: 'powers-1', channel: 1, executionMode: 'live' })
  checkCollapse('Protection clear completed in LIVE mode. Real hardware was addressed and outputs remain OFF.',
    'LIVE · REAL HARDWARE', 'Clear Protection...')
  // Saved unsupported settings survive the mode change and collapsing; no Template UI data is serialized.
  fireEvent.click(power.getByRole('button', { name: 'Collapse Protection Setup' }))
  fireEvent.click(power.getByRole('button', { name: 'Expand Protection Setup' }))
  expect((power.getByRole('checkbox', { name: 'Use Protection Setup' }) as HTMLInputElement).checked).toBe(true)
  expect(await savedDraft()).toEqual(newDraft)
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
  // Live Device and backend controls remain available with Protection Setup collapsed.
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
  fireEvent.click(first.getByRole('button', { name: 'Expand Protection Setup' }))
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

test('Serial Transport preserves UART and TCP setup values across switching', () => {
  const serial: ToolInstance = { id: 'serial-1', tool: 'serial', setup: {
    transport: 'serial', baud: 9600, data_bits: 7, parity: 'even', stop_bits: 2,
    flow_control: 'none', timeout_ms: 1000,
  } }
  let instances: ToolInstance[] = [serial]
  const onChange = vi.fn((updated: ToolInstance[]) => { instances = updated })
  const view = () => <ToolSetupEditor value={instances} steps={[]} onChange={onChange} disabled={false}
    configuredToolTypes={['serial']} resourceIdentities={{}} executionMode="simulate"
    metersExecutableKey="" powersExecutableKey="" scopesExecutableKey=""
    renderResource={() => null} renderPowersDeviceStatus={() => null} />
  const { rerender } = render(view())
  fireEvent.change(screen.getByRole('combobox', { name: 'Transport' }), { target: { value: 'tcp' } })
  rerender(view())
  fireEvent.change(screen.getByRole('spinbutton', { name: 'TCP I/O Timeout (ms)' }), { target: { value: '2500' } })
  rerender(view())
  const changes = onChange.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Communication Setup' }))
  expect(screen.queryByRole('combobox', { name: 'Transport' })).toBeNull()
  expect(screen.queryByRole('spinbutton', { name: 'TCP I/O Timeout (ms)' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Expand Communication Setup' }))
  expect(onChange).toHaveBeenCalledTimes(changes)
  expect((screen.getByRole('spinbutton', { name: 'TCP I/O Timeout (ms)' }) as HTMLInputElement).value).toBe('2500')
  fireEvent.change(screen.getByRole('combobox', { name: 'Transport' }), { target: { value: 'serial' } })
  rerender(view())
  expect((screen.getByRole('spinbutton', { name: 'Baud Rate' }) as HTMLInputElement).value).toBe('9600')
  expect((screen.getByRole('combobox', { name: 'Parity' }) as HTMLSelectElement).value).toBe('even')
  const saved = JSON.parse(JSON.stringify(instances))
  expect(saved[0].setup.io_timeout_ms).toBe(2500)
  expect(saved[0].setup.transport).toBe('serial')
  fireEvent.change(screen.getByRole('combobox', { name: 'Transport' }), { target: { value: 'tcp' } })
  rerender(view())
  expect((screen.getByRole('spinbutton', { name: 'TCP I/O Timeout (ms)' }) as HTMLInputElement).value).toBe('2500')
})

test('Serial TCP Live Device saves Host and Port without COM discovery', async () => {
  tools.push(toolStatus('serial'))
  newDraft = { ...original, tool_instances: [...original.tool_instances, {
    id: 'serial-1', tool: 'serial', setup: {
      transport: 'tcp', baud: 115200, data_bits: 8, parity: 'none', stop_bits: 1,
      flow_control: 'none', timeout_ms: 1000,
    },
  }] }
  await mount()
  const serial = instance('serial-1')
  expect(serial.queryByRole('button', { name: 'List Ports' })).toBeNull()
  fireEvent.change(serial.getByRole('textbox', { name: 'TCP Host' }), { target: { value: 'device.local' } })
  fireEvent.change(serial.getByRole('spinbutton', { name: 'TCP Port' }), { target: { value: '5025' } })
  fireEvent.click(serial.getByRole('button', { name: 'Save Resource' }))
  await waitFor(() => expect(resources['serial-1']).toBe('device.local:5025'))
  expect(calls().some(([command, args]) => command === 'set_live_resource'
    && (args as { instanceId: string }).instanceId === 'serial-1')).toBe(true)
})

test('Step ID editor rejects invalid names, supports cancel, and updates BG Command references on save', async () => {
  const command: WorkflowStep = { type: 'bg-interaction', id: 'send', background_id: 'background-1', timeout_ms: null,
    operation: { kind: 'command', command: 'software-trigger', wait_for_completion: false } }
  const result: WorkflowStep = { type: 'bg-interaction', id: 'get', background_id: 'background-1', timeout_ms: null,
    operation: { kind: 'get-command-result', source_step: 'send' } }
  newDraft = { ...original, tool_instances: [{ ...backgroundMeter, setup: { ...backgroundMeter.setup, trigger_mode: 'software' } }],
    backgrounds: [{ id: 'background-1', tool_instance_id: 'meters-1', live_monitor: false, limit_count: 1, command_trigger: true }],
    workflow: { interaction: { enabled: true, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [command, result] } }
  render(<App />)
  await screen.findByRole('button', { name: 'Expand meters details' })
  tab('Workflow')
  fireEvent.click(screen.getByRole('button', { name: /Step 1.*send/ }))
  click('Edit Step ID')
  const idField = screen.getByRole('textbox', { name: 'Step ID' }) as HTMLInputElement
  fireEvent.change(idField, { target: { value: 'Invalid ID' } })
  click('Save Step ID')
  expect(screen.getByText('Use lowercase letters, digits, and single hyphens between segments.')).toBeTruthy()
  fireEvent.change(idField, { target: { value: 'get' } })
  click('Save Step ID')
  expect(screen.getByText('Step ID must be unique across the entire Workflow.')).toBeTruthy()
  fireEvent.change(idField, { target: { value: 'temporary-id' } })
  fireEvent.keyDown(idField, { key: 'Escape' })
  expect(screen.queryByRole('textbox', { name: 'Step ID' })).toBeNull()
  expect(screen.getByRole('button', { name: /Step 1.*send/ }).getAttribute('aria-pressed')).toBe('true')
  click('Edit Step ID')
  const changed = screen.getByRole('textbox', { name: 'Step ID' })
  fireEvent.change(changed, { target: { value: 'send-renamed' } })
  fireEvent.keyDown(changed, { key: 'Enter' })
  expect(screen.getByRole('button', { name: /Step 1.*send-renamed/ }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: /Step 2.*get/ }))
  expect((screen.getByLabelText('Source BG Command Step') as HTMLSelectElement).value).toBe('send-renamed')
  const saved = await savedDraft()
  expect(saved.workflow.steps[0].id).toBe('send-renamed')
  expect(saved.workflow.steps[1].operation.source_step).toBe('send-renamed')
})

test('Step ID rename updates a saved Serial BG Send binding when switching commands back', async () => {
  tools.push(toolStatus('serial'))
  const source: WorkflowStep = { type: 'bg-interaction', id: 'latest', background_id: 'serial-bg',
    timeout_ms: null, operation: { kind: 'get-latest' } }
  const command: WorkflowStep = { type: 'bg-interaction', id: 'send', background_id: 'serial-bg', timeout_ms: null,
    operation: { kind: 'command', command: 'serial-send', wait_for_completion: true,
      arguments: { tx_format: 'text', tx_value: 'unchanged' },
      bindings: { tx_value: { source: 'step-output', step_id: 'latest', pointer: '/value' } } } }
  newDraft = { ...structuredClone(serialBackgroundDraft),
    workflow: { ...serialBackgroundDraft.workflow, steps: [source, command] } }
  render(<App />)
  await screen.findByRole('button', { name: 'Expand serial details' })
  tab('Workflow')
  fireEvent.click(screen.getByRole('button', { name: /Step 2.*send/ }))
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'serial-send-file' } })
  fireEvent.click(screen.getByRole('button', { name: /Step 1.*latest/ }))
  click('Edit Step ID')
  fireEvent.change(screen.getByRole('textbox', { name: 'Step ID' }), { target: { value: 'latest-new' } })
  click('Save Step ID')
  fireEvent.click(screen.getByRole('button', { name: /Step 2.*send/ }))
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'serial-send' } })
  const saved = await savedDraft()
  expect(saved.workflow.steps[0].id).toBe('latest-new')
  const operation = saved.workflow.steps[1].operation
  expect(operation.bindings.tx_value).toEqual({ source: 'step-output', step_id: 'latest-new', pointer: '/value' })
  expect(operation.arguments.tx_value).toBe('unchanged')
})

test('numeric setpoint UI restricts sources and forwards a selected variable', () => {
  const onChange = vi.fn()
  render(<InputValueEditor value={{ source: 'literal', value: 2 }} onChange={onChange}
    numericSetpoint earlierSteps={[]} earlierVariables={['threshold']}
    instances={original.tool_instances} disabled={false} stepLabel={step => step.id} />)
  const source = screen.getByRole('combobox', { name: 'Value Source' })
  const values = Array.from(source.querySelectorAll('option')).map(option => option.value)
  expect(values).not.toContain('elapsed-time')
  expect(values).not.toContain('timestamp')
  fireEvent.change(source, { target: { value: 'variable' } })
  expect(onChange).toHaveBeenCalledWith({ source: 'variable', variable: 'threshold' })
})

test('operand UI accepts String literals only when explicitly allowed', () => {
  const onChange = vi.fn()
  render(<ExpressionOperandEditor side="Left" value={{ source: 'literal', value: 0 }}
    allowStringLiteral onChange={onChange} earlierSteps={[]} earlierVariables={[]}
    instances={original.tool_instances} disabled={false} stepLabel={step => step.id} />)
  fireEvent.change(screen.getByRole('combobox', { name: 'Value Type' }), { target: { value: 'string' } })
  expect(onChange).toHaveBeenCalledWith({ source: 'literal', value: '' })
})


test('Scopes Screenshot preserves unsupported saved formats until explicit replacement', async () => {
  const step: ToolActionStep = { type: 'tool-action', id: 'image', target: 'scopes-1',
    action: 'screenshot', arguments: { format: 'legacy-format', extra: 'preserved' } }
  const onChange = vi.fn()
  vi.mocked(invoke).mockResolvedValue({ analog_channels: 2, screenshot_formats: ['bmp'] })
  render(<ScopesActionEditor step={step} instances={original.tool_instances} earlierSteps={[]}
    earlierVariables={[]} disabled={false} onChange={onChange} stepLabel={item => item.id}
    executionMode="live" modelId="saved-scope" scopesExecutableKey="scopes.exe" />)
  const format = screen.getByRole('combobox', { name: 'Image Format' }) as HTMLSelectElement
  await waitFor(() => expect(format.disabled).toBe(false))
  expect(format.value).toBe('legacy-format')
  expect((format.querySelector('option[value="legacy-format"]') as HTMLOptionElement).disabled).toBe(true)
  expect((format.querySelector('option[value="png"]') as HTMLOptionElement).disabled).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.change(format, { target: { value: 'bmp' } })
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
    arguments: { format: 'bmp', extra: 'preserved' },
  }))
  expect(step.arguments).toEqual({ format: 'legacy-format', extra: 'preserved' })
})

test('Scopes capabilities discard late replies when the selected Live model changes', async () => {
  let completeOld!: (value: unknown) => void
  vi.mocked(invoke).mockImplementation((command, args) => {
    expect(command).toBe('get_scopes_capabilities')
    const modelId = (args as { modelId: string }).modelId
    if (modelId === 'old-model') return new Promise(resolve => { completeOld = resolve })
    return Promise.resolve({ analog_channels: 2, screenshot_formats: ['bmp'] })
  })
  const step: ToolActionStep = { type: 'tool-action', id: 'image', target: 'scopes-1',
    action: 'screenshot', arguments: { format: 'bmp' } }
  const onChange = vi.fn()
  const view = (modelId: string) => <ScopesActionEditor step={step}
    instances={original.tool_instances} earlierSteps={[]} earlierVariables={[]} disabled={false}
    onChange={onChange} stepLabel={item => item.id} executionMode="live"
    modelId={modelId} scopesExecutableKey="scopes.exe" />
  const { rerender } = render(view('old-model'))
  await waitFor(() => expect(completeOld).toBeTypeOf('function'))
  rerender(view('new-model'))
  const format = screen.getByRole('combobox', { name: 'Image Format' }) as HTMLSelectElement
  await waitFor(() => expect(format.disabled).toBe(false))
  expect((format.querySelector('option[value="png"]') as HTMLOptionElement).disabled).toBe(true)
  await act(async () => completeOld({ analog_channels: 2, screenshot_formats: ['png'] }))
  expect((format.querySelector('option[value="png"]') as HTMLOptionElement).disabled).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
})

test('Scopes Capture maintains nonempty supported channel arrays and unrelated settings', async () => {
  vi.mocked(invoke).mockResolvedValue({ analog_channels: 2, capture_point_options: [1000] })
  let step: ToolActionStep = { type: 'tool-action', id: 'capture', target: 'scopes-1',
    action: 'capture', arguments: { channel: [1], points: 1000, extra: 'keep' } }
  const onChange = vi.fn((next: ToolActionStep) => { step = next })
  const view = () => <ScopesActionEditor step={step} instances={original.tool_instances}
    earlierSteps={[]} earlierVariables={[]} disabled={false} onChange={onChange}
    stepLabel={item => item.id} executionMode="simulate" modelId={undefined}
    scopesExecutableKey="scopes.exe" />
  const { rerender } = render(view())
  const channel2 = await screen.findByRole('checkbox', { name: 'Capture CH2' })
  await waitFor(() => expect(channel2.hasAttribute('disabled')).toBe(false))
  expect((screen.getByRole('checkbox', { name: 'Capture CH1' }) as HTMLInputElement).disabled).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(channel2)
  rerender(view())
  expect(step.arguments).toEqual({ channel: [1, 2], points: 1000, extra: 'keep' })
  expect((screen.getByRole('checkbox', { name: 'Capture CH1' }) as HTMLInputElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Capture CH1' }))
  expect(step.arguments.channel).toEqual([2])
})

test('Scopes Channel rejects unconfirmed saved choices without overwriting numeric bindings', async () => {
  vi.mocked(invoke).mockResolvedValue({ analog_channels: 2 })
  const step: ToolActionStep = { type: 'tool-action', id: 'scale', target: 'scopes-1',
    action: 'channel-scale', arguments: { channel: 99, volts_per_division: 2, extra: 'keep' },
    bindings: { volts_per_division: { source: 'variable', variable: 'level' } } }
  const onChange = vi.fn()
  render(<ScopesActionEditor step={step} instances={original.tool_instances}
    earlierSteps={[]} earlierVariables={[]} disabled={false} onChange={onChange}
    stepLabel={item => item.id} executionMode="simulate" modelId={undefined}
    scopesExecutableKey="scopes.exe" />)
  const channel = screen.getByRole('combobox', { name: 'Channel' }) as HTMLSelectElement
  await waitFor(() => expect(channel.disabled).toBe(false))
  expect(channel.value).toBe('99')
  expect((channel.querySelector('option[value="99"]') as HTMLOptionElement).disabled).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.change(channel, { target: { value: '2' } })
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
    arguments: { channel: 2, volts_per_division: 2, extra: 'keep' },
    bindings: { volts_per_division: { source: 'variable', variable: 'level' } },
  }))
})

test('Powers Step editor selects confirmed channels without rewriting saved bindings', async () => {
  newDraft.workflow.steps = [{ type: 'tool-action', id: 'set-power', target: 'powers-1',
    action: 'set-output', arguments: { channel: 99, voltage: 0, current: 0.25 },
    bindings: { current: { source: 'variable', variable: 'limit' } } },
    { type: 'tool-action', id: 'bound-only', target: 'powers-1', action: 'set-output',
      arguments: { channel: 1 }, bindings: { current: { source: 'variable', variable: 'limit' } } }]
  await mount()
  tab('Workflow')
  const workflow = within(screen.getByRole('tabpanel', { name: 'Workflow' }))
  fireEvent.click(workflow.getByRole('button', { name: /Step 1: Power Set Output, set-power/ }))
  const channel = workflow.getByRole('combobox', { name: 'Channel' }) as HTMLSelectElement
  await waitFor(() => expect(channel.disabled).toBe(false))
  expect(channel.value).toBe('99')
  expect((channel.querySelector('option[value="99"]') as HTMLOptionElement).disabled).toBe(true)
  expect((await savedDraft()).workflow.steps).toEqual(newDraft.workflow.steps)
  fireEvent.change(channel, { target: { value: '1' } })
  const saved = await savedDraft()
  expect(saved.workflow.steps[0].arguments).toEqual({ channel: 1, voltage: 0, current: 0.25 })
  expect(saved.workflow.steps[0].bindings).toEqual({ current: { source: 'variable', variable: 'limit' } })
  const properties = within(screen.getByRole('region', { name: 'Properties' }))
  const results = () => within(properties.getByRole('group', { name: 'Common result fields' }))
  expect(results().queryByText('/request/arguments/voltage')).toBeNull()
  expect(results().getByText('Channel')).toBeTruthy()
  expect(results().getByText('Voltage')).toBeTruthy()
  expect(results().getByText('Current Limit')).toBeTruthy()
  fireEvent.click(properties.getByRole('checkbox', { name: 'Set Voltage' }))
  expect(results().queryByText('Voltage')).toBeNull()
  expect(results().getByText('Current Limit')).toBeTruthy()
  fireEvent.click(properties.getByRole('checkbox', { name: 'Set Voltage' }))
  fireEvent.click(properties.getByRole('checkbox', { name: 'Set Current Limit' }))
  expect(results().getByText('Voltage')).toBeTruthy()
  expect(results().queryByText('Current Limit')).toBeNull()
  const voltageOnly = (await savedDraft()).workflow.steps[0]
  expect(voltageOnly.arguments).toEqual({ channel: 1, voltage: 5 })
  expect(voltageOnly.bindings).toBeUndefined()
  fireEvent.click(workflow.getByRole('button', { name: /Step 2: Power Set Output, bound-only/ }))
  expect(results().queryByText('Voltage')).toBeNull()
  expect(results().getByText('Current Limit')).toBeTruthy()
  expect((await savedDraft()).workflow.steps[1]).toEqual(newDraft.workflow.steps[1])
})

test('Buffer settings and Steps save the current contract with Array input references', async () => {
  newDraft = { ...original, tool_instances: [{ ...backgroundMeter, setup: { ...backgroundMeter.setup, trigger_mode: 'software' } }],
    backgrounds: [{ id: 'background-1', tool_instance_id: 'meters-1', live_monitor: false, limit_count: 1 }],
    workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [] } }
  render(<App />)
  await screen.findByRole('button', { name: 'Expand meters details' })
  tab('Workflow')
  click('Expand FG/BG Interaction')
  fireEvent.click(screen.getByLabelText('Enable FG/BG Interaction'))
  expect((screen.getByRole('button', { name: 'Get Buffer Data' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByLabelText('Enable Buffer'))
  fireEvent.change(screen.getByLabelText('Buffer Mode'), { target: { value: 'ring' } })
  fireEvent.change(screen.getByLabelText('Overflow Policy'), { target: { value: 'continue' } })
  click('Get Buffer Status')
  click('Add Step')
  click('Get Buffer Data')
  click('Add Step')
  fireEvent.change(screen.getByLabelText('Get Mode'), { target: { value: 'count' } })
  fireEvent.change(screen.getByLabelText('Count Source'), { target: { value: 'step-output' } })
  fireEvent.change(screen.getByLabelText('Result'), { target: { value: '/count' } })
  click('Array Process')
  click('Add Step')
  expect(screen.queryByRole('option', { name: 'Fixed value' })).toBeNull()
  const pendingResult = screen.getByLabelText('Result') as HTMLSelectElement
  expect(pendingResult.disabled).toBe(true)
  expect(pendingResult.selectedOptions[0].textContent).toBe('Select a step first')
  expect(screen.queryByLabelText('JSON Pointer')).toBeNull()
  expect(screen.queryByText(/Reference preserved:/)).toBeNull()
  const inputStep = screen.getByLabelText('Step') as HTMLSelectElement
  fireEvent.change(inputStep, { target: { value: inputStep.options[inputStep.options.length - 1].value } })
  const result = screen.getByLabelText('Result') as HTMLSelectElement
  expect(result.disabled).toBe(false)
  expect(result.value).toBe('/data')
  expect(result.selectedOptions[0].textContent).toBe('Data (Array)')
  expect(screen.queryByLabelText('JSON Pointer')).toBeNull()
  fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'get-item' } })
  const saved = await savedDraft()
  expect(saved.workflow.interaction.buffer).toEqual({ enabled: true, mode: 'ring', overflow_policy: 'continue' })
  const [status, batch, item] = saved.workflow.steps
  expect(status.operation).toEqual({ kind: 'get-buffer-status' })
  expect(batch.operation).toEqual({ kind: 'get-buffer-data', read_mode: 'pop', selection: { kind: 'count',
    count: { source: 'step-output', step_id: status.id, pointer: '/count' } } })
  expect(item).toMatchObject({ type: 'array-process', operation: 'get-item',
    arguments: { input: { source: 'step-output', step_id: batch.id, pointer: '/data' },
      index: { source: 'literal', value: 0 } } })
}, 15000)

// This is an operator-facing requirement: every available Step must explain
// its purpose in Properties, using the same description as the Palette.
test('all 42 Workflow presets show their Palette description in Properties', async () => {
  tools = [...tools, toolStatus('serial')]
  newDraft = {
    ...original,
    tool_instances: [...original.tool_instances,
      { ...backgroundMeter, id: 'meters-bg', setup: { ...backgroundMeter.setup, trigger_mode: 'software' } },
      { ...backgroundMeter, id: 'meters-fg', setup: { ...backgroundMeter.setup, trigger_mode: 'immediate' } },
      { id: 'serial-1', tool: 'serial', setup: { transport: 'serial', baud: 115200, data_bits: 8, parity: 'none', stop_bits: 1, flow_control: 'none', timeout_ms: 1000 } }],
    backgrounds: [{ id: 'background-1', tool_instance_id: 'meters-bg', live_monitor: false, limit_count: 1 }],
    workflow: { interaction: { enabled: true, max_active_command_status: 4096,
      buffer: { enabled: true, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [] },
  }
  render(<I18nProvider initialLanguage="en"><App /></I18nProvider>)
  await screen.findByRole('button', { name: 'Expand meters details' })
  tab('Workflow')
  const categories = within(screen.getByRole('region', { name: 'Step categories' }))
  const presets = categories.getAllByRole('button').filter(button => button.hasAttribute('aria-pressed'))
  expect(presets).toHaveLength(42)
  const properties = within(screen.getByRole('region', { name: 'Properties' }))
  for (const preset of presets) {
    const description = preset.getAttribute('title')?.split('\n')[1] ?? ''
    expect(description).toBeTruthy()
    expect(description).not.toMatch(/^steps\.hint\./)
    const root = screen.queryByRole('button', { name: 'Set Target to Root' })
    if (root) fireEvent.click(root)
    fireEvent.click(preset)
    click('Add Step')
    expect(properties.getAllByText(description)).toHaveLength(1)
    if (preset.getAttribute('title')?.split('\n')[0] === 'Scope Single Wait') {
      expect(description).toMatch(/start a single acquisition.*wait for its trigger/i)
    }
    if (preset.getAttribute('title')?.split('\n')[0] === 'Show Message') {
      expect(description).toMatch(/does not create an Output Page, a Popup, or an Assert/i)
    }
    if (preset.getAttribute('title')?.split('\n')[0] === 'Power Protection Status') {
      const results = within(properties.getByRole('group', { name: 'Common result fields' }))
      expect(results.getByText('Protection Tripped')).toBeTruthy()
      expect(results.queryByText('/protection_tripped')).toBeNull()
      expect(results.getByText(/Boolean.*true.*false.*no trip reported/)).toBeTruthy()
    }
  }
  fireEvent.click(screen.getByRole('button', { name: /Step .*?, serial-query-1$/ }))
  expect(properties.getByRole('heading', { name: 'Serial Query' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Switch language to 繁體中文' }))
  const localized = within(screen.getByRole('region', { name: '屬性' }))
  const description = screen.getByRole('button', { name: 'Serial 查詢' }).getAttribute('title')?.split('\n')[1] ?? ''
  expect(localized.getByRole('heading', { name: 'Serial 查詢 (Serial Query)' })).toBeTruthy()
  expect(localized.getAllByText(description)).toHaveLength(1)
  localStorage.removeItem('orchestrator-tool.locale')
}, 30000)

test('all 21 Process operations show contextual help and a result type', () => {
  const literal = { source: 'literal' as const, value: '' }
  const initial: ProcessStep[] = [
    { type: 'string-process', id: 'string', operation: 'length', arguments: { input: literal } },
    { type: 'byte-process', id: 'byte', operation: { kind: 'byte-length' }, arguments: { input: literal } },
    { type: 'array-process', id: 'array', operation: 'length', arguments: {
      input: { source: 'step-output', step_id: '', pointer: '' } } },
  ]
  function Editor({ initialStep }: { initialStep: ProcessStep }) {
    const [step, setStep] = useState(initialStep)
    return <ProcessEditor step={step} onChange={setStep} earlierSteps={[]} earlierVariables={[]}
      instances={[]} backgrounds={[]} stepLabel={step => step.id} disabled={false} />
  }
  const resultTypes: Record<ProcessStep['type'], Record<string, string>> = {
    'string-process': { length: 'Number', substring: 'String', concat: 'String', contains: 'Boolean',
      'index-of': 'Number', replace: 'String', trim: 'String', 'to-upper-case': 'String',
      'to-lower-case': 'String', 'to-number': 'Number' },
    'byte-process': { 'byte-length': 'Number', 'get-byte': 'Number', 'get-bytes': 'Hex String',
      concat: 'Hex String', contains: 'Boolean', 'hex-to-number': 'Number',
      'number-to-hex': 'Hex String', 'hex-to-text': 'String / Null', 'text-to-hex': 'Hex String' },
    'array-process': { length: 'Number', 'get-item': 'JSON' },
  }
  let count = 0
  for (const initialStep of initial) {
    const view = render(<Editor initialStep={initialStep} />)
    const operation = screen.getByRole('combobox', { name: 'Operation' }) as HTMLSelectElement
    if (initialStep.type === 'array-process') {
      expect((screen.getByLabelText('Result') as HTMLSelectElement).disabled).toBe(true)
      expect(screen.getByText('No earlier result-producing steps are available.')).toBeTruthy()
      expect(screen.queryByLabelText('JSON Pointer')).toBeNull()
      expect(screen.queryByText(/Reference preserved:/)).toBeNull()
    }
    const values = Array.from(operation.options, option => option.value)
    const descriptions = new Set<string>()
    for (const value of values) {
      fireEvent.change(operation, { target: { value } })
      const id = operation.getAttribute('aria-describedby')!
      const description = document.getElementById(id)?.textContent ?? ''
      expect(description).toBeTruthy()
      expect(description).not.toMatch(/^process\.help\./)
      descriptions.add(description)
      expect(resultTypes[initialStep.type][value]).toBeTruthy()
      expect(screen.getByText(`Value · ${resultTypes[initialStep.type][value]}`)).toBeTruthy()
      if (initialStep.type === 'byte-process' && value === 'hex-to-number') {
        const order = screen.getByRole('combobox', { name: 'Byte Order' })
        const format = screen.getByRole('combobox', { name: 'Number Format' })
        expect(screen.getByRole('combobox', { name: 'Byte Order', description: /Most significant byte first/ })).toBeTruthy()
        expect(screen.getByRole('combobox', { name: 'Number Format', description: /Unsigned integer/ })).toBeTruthy()
        fireEvent.change(order, { target: { value: 'lsb-first' } })
        fireEvent.change(format, { target: { value: 'signed' } })
        expect(screen.getByRole('combobox', { name: 'Byte Order', description: /Least significant byte first/ })).toBeTruthy()
        expect(screen.getByRole('combobox', { name: 'Number Format', description: /Signed integer/ })).toBeTruthy()
      }
      count += 1
    }
    expect(descriptions.size).toBe(values.length)
    view.unmount()
  }
  expect(count).toBe(21)
})
