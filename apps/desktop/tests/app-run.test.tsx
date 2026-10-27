import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { Channel, invoke } from '@tauri-apps/api/core'
import { confirm, open } from '@tauri-apps/plugin-dialog'
import type { ComponentProps } from 'react'
import App from '../src/App'
import type ResultChart from '../src/ResultChart'
import type { ForStep, RunMetadataDto, WorkflowRunEventDto } from '../src/workflow'
import type { WorkflowDraft } from '../src/templateDraft'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class { constructor(public onmessage: (event: unknown) => void) {} },
}))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.1.0' }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(), open: vi.fn(), save: vi.fn() }))
vi.mock('echarts/core', () => ({ use: vi.fn(), init: () => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() }) }))
// Chart rendering has its own tests; observe the run snapshot passed across this boundary.
vi.mock('../src/ResultChart', () => ({ default: (props: ComponentProps<typeof ResultChart>) =>
  <div data-testid="chart-snapshot">{JSON.stringify({ runId: props.runId, sampling: props.changeSettings, fitData: props.fitData })}</div>,
}))

const draft: WorkflowDraft = { schema_version: 2, name: 'Run test', tool_instances: [], workflow: { steps: [
  { type: 'for', id: 'outer', variable: 'i', range: { start: '0', stop: '2', step: '1' }, steps: [
    { type: 'for', id: 'inner', variable: 'j', range: { start: '0', stop: '2', step: '1' }, steps: [
      { type: 'output', id: 'out', name: 'Voltage', page: 'Results', value: { source: 'literal', value: 10.600000000000001 } },
    ] },
  ] },
] } }

function metadata(runId: number, status: RunMetadataDto['status'] = 'succeeded'): RunMetadataDto {
  return { run_id: runId, status, error: null, completed_successfully: status === 'succeeded', manual_exportable: true,
    execution_count: 1, execution_revision: 1,
    latest_execution: { step_id: 'out', status: 'succeeded', output: 10.600000000000001, output_omitted: false,
      message: null, for_iteration: { for_step_id: 'inner', iteration_index: 0 }, while_iteration: null },
    pages: [{ name: 'Results', output_names: ['Voltage'], row_count: 1, revision: 1, iteration_rows: true,
      numeric_outputs: ['Voltage'], timestamp_outputs: [],
      summaries: [{ name: 'Voltage', count: 1, min: 10.600000000000001, max: 10.600000000000001, avg: 10.600000000000001, std_dev: null }] }],
    step_summaries: [], messages: [{ target: 'message-1', total: 1, revision: 1 }],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

let run: ReturnType<typeof deferred<RunMetadataDto>>
let preflightErrors: string[]
let simulationRequirements: string[]
let currentDraft: WorkflowDraft

beforeEach(() => {
  vi.clearAllMocks()
  run = deferred<RunMetadataDto>()
  preflightErrors = []
  simulationRequirements = []
  currentDraft = structuredClone(draft)
  vi.mocked(confirm).mockResolvedValue(true)
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const params = args as Record<string, unknown>
    switch (command) {
      case 'create_workflow_draft': return JSON.stringify(currentDraft)
      case 'get_tool_status': return []
      case 'get_simulation_sample_requirements': return simulationRequirements
      case 'get_background_output': return { workers: [{ id: 'background-1', state: 'off', stream_state: 'ended', live_monitor: true, error: null }],
        datasets: [{ id: 'capture-1', background_id: 'background-1', worker_run_id: 'worker', status: 'completed', quality: 'no_loss_detected', row_count: 300001, min: 1, max: 1, avg: 1, csv_path: null, error: null }],
        chart: [], rows: [], monitor: [] }
      case 'get_live_resources': case 'get_live_resource_identities': case 'get_live_backends': return {}
      case 'get_powers_capabilities': return { channels: [1, 2] }
      case 'check_live_preflight': return preflightErrors
      case 'validate_workflow_draft': return params.templateJson
      case 'load_workflow_template': return JSON.stringify(draft)
      case 'clear_last_run': return undefined
      case 'run_workflow_live': case 'run_workflow_simulation': return run.promise
      case 'request_workflow_stop': return true
      case 'get_last_run_executions': return { run_id: params.runId, offset: 0, total_executions: 1, executions: [metadata(Number(params.runId)).latest_execution] }
      case 'get_last_run_messages': return { run_id: params.runId, target: params.target, revision: 1, total_messages: 1, offset: 0, messages: [`Message from run ${params.runId}`] }
      case 'get_last_run_page_rows': return { run_id: params.runId, page: 'Results', revision: 1, total_rows: 1, offset: 0,
        rows: [{ page: 'Results', for_iteration: null, while_iteration: null, outputs: [{ name: 'Voltage', value: 10.600000000000001 }] }] }
      default: throw new Error(`Unexpected command: ${command}`)
    }
  })
})

const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))
const runButton = (mode: string) => screen.getByRole('button', { name: `Run ${mode}` }) as HTMLButtonElement
const snapshot = () => JSON.parse(screen.getByTestId('chart-snapshot').textContent!)
const runCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command.startsWith('run_workflow_'))
function progressChannel() {
  return (runCalls().at(-1)![1] as { onProgress: Channel<WorkflowRunEventDto> }).onProgress
}
async function mount() {
  render(<App />)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_workflow_draft'))
  tab('Workflow')
  await waitFor(() => expect(runButton('Simulation').disabled).toBe(false))
}
async function selectLive() {
  fireEvent.click(screen.getByRole('button', { name: 'Live' }))
  expect(runButton('Live').disabled).toBe(true)
  await screen.findByText('Live Preflight: Passed')
}
async function finish(runId: number) {
  await act(async () => run.resolve(metadata(runId)))
}
async function previousRun() {
  await mount()
  fireEvent.click(runButton('Simulation'))
  await finish(7)
  await screen.findByText('Message from run 7')
  run = deferred<RunMetadataDto>()
}

test('Simulation sample warning supports cancellation, per-instance overrides and fresh defaults', async () => {
  simulationRequirements = ['meters-1', 'meters-2']
  await mount()
  fireEvent.click(runButton('Simulation'))
  let dialog = await screen.findByRole('dialog', { name: 'Meters Simulation samples' })
  expect((within(dialog).getByLabelText('meters-1 SIM Max Samples') as HTMLInputElement).value).toBe('1000')
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })))
  expect(runCalls()).toHaveLength(0)
  fireEvent.click(runButton('Simulation'))
  dialog = await screen.findByRole('dialog', { name: 'Meters Simulation samples' })
  fireEvent.change(within(dialog).getByLabelText('meters-1 SIM Max Samples'), { target: { value: '5000' } })
  fireEvent.change(within(dialog).getByLabelText('meters-2 SIM Max Samples'), { target: { value: '0' } })
  expect((within(dialog).getByRole('button', { name: 'Run Simulation' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(within(dialog).getByLabelText('meters-2 SIM Max Samples'), { target: { value: '2000' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Run Simulation' }))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  expect(runCalls()[0][1]).toMatchObject({ simulationSamples: { 'meters-1': 5000, 'meters-2': 2000 }, templateJson: JSON.stringify(draft) })
  await finish(19)
  await waitFor(() => expect(runButton('Simulation').disabled).toBe(false))
  fireEvent.click(runButton('Simulation'))
  dialog = await screen.findByRole('dialog', { name: 'Meters Simulation samples' })
  expect((within(dialog).getByLabelText('meters-1 SIM Max Samples') as HTMLInputElement).value).toBe('1000')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
})

test('Background-only Output queries bounded windows and separates Monitor, Dataset and export', async () => {
  currentDraft = { schema_version: 2, name: 'Background-only', tool_instances: [],
    backgrounds: Array.from({ length: 9 }, (_, index) => ({ id: `background-${index+1}`, tool_instance_id: `meters-${index+1}`,
      live_monitor: true, trigger_count: 3, ...(index < 7 ? { chart: { x_axis: 'elapsed' as const } } : {}) })),
    workflow: { steps: [{ type: 'background', id: 'on', background_id: 'background-1', action: 'worker-on', capture: true }] } }
  await mount()
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  await finish(20)
  tab('Output')
  const output = await screen.findByRole('region', { name: 'Background Results' })
  await within(output).findByRole('img', { name: 'Background Dataset Line' })
  expect(within(output).getByRole('img', { name: 'Background Live Monitor Line' })).toBeTruthy()
  expect(within(output).getByText(/More than 300,000 samples/)).toBeTruthy()
  expect((within(output).getByLabelText('Samples per XLSX file') as HTMLInputElement).value).toBe('300000')
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'get_background_output').every(([,args]) => (args as {limit:number}).limit===100)).toBe(true)
  expect((within(output).getByRole('button', { name: 'Export Background' }) as HTMLButtonElement).disabled).toBe(false)
  const background = within(output).getByLabelText('Background')
  fireEvent.change(background, { target: { value: 'background-8' } })
  await waitFor(() => expect(within(output).queryByText('Maximum 8 charts.')).toBeNull())
  fireEvent.change(within(output).getByLabelText('X axis'), { target: { value: 'timestamp' } })
  expect((within(output).getByLabelText('X axis') as HTMLSelectElement).value).toBe('timestamp')
  fireEvent.change(background, { target: { value: 'background-9' } })
  await waitFor(() => expect(within(output).queryByText('Maximum 8 charts.')).toBeNull())
  fireEvent.change(within(output).getByLabelText('X axis'), { target: { value: 'index' } })
  expect(within(output).getByRole('alert').textContent).toBe('Maximum 8 charts.')
  expect((within(output).getByLabelText('X axis') as HTMLSelectElement).value).toBe('elapsed')
  fireEvent.change(background, { target: { value: 'background-1' } })
  fireEvent.change(within(output).getByLabelText('X axis'), { target: { value: 'index' } })
  expect((within(output).getByLabelText('X axis') as HTMLSelectElement).value).toBe('index')
})

test.each(['Simulation', 'Live'])('%s uses one run entry, locks editing and snapshots options for Last Run', async mode => {
  await mount()
  if (mode === 'Live') await selectLive()
  fireEvent.click(screen.getByRole('button', { name: 'Chart Options' }))
  fireEvent.click(screen.getByLabelText('Preserve Significant Changes'))
  const threshold = screen.getByLabelText('Change Threshold (%)')
  fireEvent.change(threshold, { target: { value: '0' } })
  expect(runButton(mode).disabled).toBe(true)
  fireEvent.change(threshold, { target: { value: '12' } })
  fireEvent.click(screen.getByLabelText('Fit Data'))
  fireEvent.click(screen.getByRole('button', { name: 'CSV Export' }))
  fireEvent.click(screen.getByLabelText('Stream CSV during run'))
  fireEvent.click(runButton(mode))
  fireEvent.click(runButton(mode))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  expect(runCalls()[0][0]).toBe(mode === 'Live' ? 'run_workflow_live' : 'run_workflow_simulation')
  expect(runCalls()[0][1]).toMatchObject({ templateJson: JSON.stringify(draft),
    streamCsv: { output_folder: null, page: 'Results', all_pages: false }, scopesOutputFolder: null })
  for (const button of within(screen.getByLabelText('Desktop Execution Mode')).getAllByRole('button')) {
    expect((button as HTMLButtonElement).disabled).toBe(true)
  }
  expect((screen.getByRole('button', { name: 'Validate' }) as HTMLButtonElement).disabled).toBe(true)
  const channel = progressChannel()
  if (mode === 'Simulation') {
    tab('Output')
    expect(snapshot()).toEqual({ runId: null, sampling: { enabled: true, thresholdPercent: 12, showMarkers: false }, fitData: true })
    tab('Workflow')
  }
  act(() => channel.onmessage({ type: 'progress-batch', run: metadata(8, 'running'), completed_step_ids: ['out'] }))
  await screen.findByText('Message from run 8')
  tab('Output')
  expect(snapshot().runId).toBe(8)
  await finish(8)
  tab('Workflow')
  fireEvent.change(screen.getByLabelText('Change Threshold (%)'), { target: { value: '25' } })
  fireEvent.click(screen.getByLabelText('Fit Data'))
  tab('Output')
  expect(snapshot()).toEqual({ runId: 8, sampling: { enabled: true, thresholdPercent: 12, showMarkers: false }, fitData: true })
  // An old channel cannot overwrite the next run's metadata or messages.
  tab('Workflow')
  run = deferred<RunMetadataDto>()
  fireEvent.click(runButton(mode))
  await waitFor(() => expect(runCalls()).toHaveLength(2))
  act(() => progressChannel().onmessage({ type: 'progress-batch', run: metadata(9, 'running'), completed_step_ids: [] }))
  act(() => channel.onmessage({ type: 'progress-batch', run: metadata(8, 'running'), completed_step_ids: [] }))
  await screen.findByText('Message from run 9')
  expect(screen.queryByText('Message from run 8')).toBeNull()
  tab('Output')
  expect(snapshot().runId).toBe(9)
  await finish(9)
})

test('Live cancellation and backend preflight rejection preserve the previous Last Run', async () => {
  await previousRun()
  await selectLive()
  vi.mocked(confirm).mockResolvedValueOnce(false)
  fireEvent.click(runButton('Live'))
  await waitFor(() => expect(runButton('Live').disabled).toBe(false))
  expect(runCalls()).toHaveLength(1)
  expect(screen.getByText('Message from run 7')).toBeTruthy()
  fireEvent.click(runButton('Live'))
  await waitFor(() => expect(runCalls()).toHaveLength(2))
  tab('Output')
  expect(snapshot().runId).toBe(7)
  await act(async () => run.reject('Live Preflight failed: CH3 unsupported'))
  expect(snapshot().runId).toBe(7)
  tab('Workflow')
  expect(screen.getByText('Live Preflight failed: CH3 unsupported')).toBeTruthy()
  expect(screen.queryByText('Run failed')).toBeNull()
  expect(screen.getByText('Message from run 7')).toBeTruthy()
  expect(runButton('Live').disabled).toBe(true)
})

test('an accepted Live failure replaces Last Run and retains partial results with raw diagnostics', async () => {
  await previousRun()
  await selectLive()
  fireEvent.click(runButton('Live'))
  await waitFor(() => expect(runCalls()).toHaveLength(2))
  act(() => progressChannel().onmessage({ type: 'progress-batch', run: metadata(8, 'running'), completed_step_ids: [] }))
  await screen.findByText('Message from run 8')
  const error = 'worker exited unexpectedly'
  await act(async () => run.resolve({ ...metadata(8, 'failed'), error }))
  expect(screen.getAllByText('Run failed')).toHaveLength(1)
  expect(screen.getByText(error)).toBeTruthy()
  expect(screen.getByText('Technical details')).toBeTruthy()
  tab('Output')
  expect(snapshot().runId).toBe(8)
  expect(screen.getByText(error)).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Export Partial XLSX' }) as HTMLButtonElement).disabled).toBe(false)
})

test('loop Stop follows the selected loop and completed progress releases its pending state', async () => {
  await mount()
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  const channel = progressChannel()
  const progress = { type: 'progress-batch' as const, run: metadata(8, 'running'), completed_step_ids: [] as string[] }
  act(() => channel.onmessage(progress))
  fireEvent.click(screen.getByRole('button', { name: 'Stop outer' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('request_workflow_stop', { loopStepId: 'outer' }))
  expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(true)
  act(() => channel.onmessage({ ...progress, completed_step_ids: ['outer'] }))
  vi.mocked(invoke).mockRejectedValueOnce('Transport failed')
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await screen.findByText('Stop request failed: Transport failed')
  expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(false)
  vi.mocked(invoke).mockResolvedValueOnce(false)
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('request_workflow_stop', { loopStepId: 'inner' }))
  expect((screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement).disabled).toBe(true)
  await finish(8)
  expect(screen.queryByRole('button', { name: 'Stopping…' })).toBeNull()
})

test('validation preserves Last Run and numeric display controls update both summary and output rows', async () => {
  await previousRun()
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await screen.findByText('Valid')
  expect(invoke).toHaveBeenCalledWith('validate_workflow_draft', { templateJson: JSON.stringify(draft) })
  vi.mocked(invoke).mockRejectedValueOnce('Invalid template')
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await screen.findByText('Validation failed: Invalid template')
  expect(screen.queryByText('Valid')).toBeNull()
  tab('Output')
  expect(snapshot().runId).toBe(7)
  await screen.findByTitle('10.6')
  fireEvent.change(screen.getByLabelText('Number display'), { target: { value: 'fixed' } })
  const places = screen.getByLabelText('Decimal places')
  expect(within(places).getAllByRole('option').map(option => (option as HTMLOptionElement).value))
    .toEqual(Array.from({ length: 13 }, (_, index) => String(index)))
  fireEvent.change(places, { target: { value: '0' } })
  expect(within(screen.getByRole('table', { name: 'Page Result Summary' })).getAllByRole('cell').map(cell => cell.textContent))
    .toEqual(['1', '11', '11', '11'])
  expect(screen.getByTitle('11')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Number display'), { target: { value: 'raw' } })
  expect(screen.getByTitle('10.600000000000001')).toBeTruthy()
  expect(screen.queryByLabelText('Decimal places')).toBeNull()
})

test('failed Live preflight blocks dispatch and switching back to Simulation remains usable', async () => {
  await mount()
  preflightErrors = ['CH3 unsupported']
  fireEvent.click(screen.getByRole('button', { name: 'Live' }))
  fireEvent.click(runButton('Live'))
  await screen.findByText('CH3 unsupported')
  fireEvent.click(runButton('Live'))
  expect(runCalls()).toHaveLength(0)
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Simulation' }))
  expect(runButton('Simulation').disabled).toBe(false)
  fireEvent.click(runButton('Simulation'))
  await finish(1)
})

test('loading a template resets the execution mode without persisting desktop mode in template data', async () => {
  await mount()
  await selectLive()
  vi.mocked(open).mockResolvedValue('template.json')
  fireEvent.click(screen.getByRole('button', { name: 'Open Template' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Simulation' }).getAttribute('aria-pressed')).toBe('true'))
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  expect(JSON.parse((runCalls()[0][1] as { templateJson: string }).templateJson)).toEqual(draft)
  await finish(1)
})


test.each(['Validate', 'Simulation', 'Live'])('%s presents structured validation locations and prevents invalid run dispatch', async action => {
  await previousRun()
  if (action === 'Live') await selectLive()
  const original = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'validate_workflow_draft') throw { message: 'Variable i is unavailable', step_id: 'out' }
    return original(command, args)
  })
  fireEvent.click(action === 'Validate' ? screen.getByRole('button', { name: 'Validate' }) : runButton(action))
  await screen.findByText('Validation failed: Variable i is unavailable')
  expect(runCalls()).toHaveLength(1)
  expect(screen.queryByText('Run failed')).toBeNull()
  expect(screen.queryByText('Live run did not start')).toBeNull()
  expect(runButton(action === 'Live' ? 'Live' : 'Simulation').disabled).toBe(false)
  expect((screen.getByRole('button', { name: 'Validate' }) as HTMLButtonElement).disabled).toBe(false)
  const card = screen.getByRole('button', { name: /Step 1.1.1:/ })
  expect(card.getAttribute('aria-invalid')).toBe('true')
  expect(card.classList.contains('sequence-step-invalid')).toBe(true)
  expect(screen.getByRole('img', { name: 'Validation warning' })).toBeTruthy()
  fireEvent.click(card)
  expect(within(screen.getByRole('region', { name: 'Properties' })).getByRole('alert').textContent).toBe('Variable i is unavailable')
  expect(screen.getByText('Message from run 7')).toBeTruthy()
  tab('Output')
  expect(snapshot().runId).toBe(7)
  tab('Workflow')
  fireEvent.change(screen.getByLabelText('Page name'), { target: { value: 'Moved' } })
  expect(screen.getByRole('button', { name: /Step 1.1.1:/ }).hasAttribute('aria-invalid')).toBe(false)
  expect(screen.queryByRole('img', { name: 'Validation warning' })).toBeNull()
  vi.mocked(invoke).mockImplementation(original)
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await screen.findByText('Valid')
  await waitFor(() => expect(runButton(action === 'Live' ? 'Live' : 'Simulation').disabled).toBe(false))
  fireEvent.click(runButton(action === 'Live' ? 'Live' : 'Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(2))
  expect(JSON.parse((runCalls()[1][1] as { templateJson: string }).templateJson).workflow.steps[0].steps[0].steps[0].page).toBe('Moved')
  await finish(8)
})

test.each(['Simulation', 'Live'])('%s still presents execution errors after successful validation', async mode => {
  await mount()
  if (mode === 'Live') await selectLive()
  fireEvent.click(runButton(mode))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  await act(async () => run.reject('Worker could not start'))
  expect(screen.getByText(mode === 'Live' ? 'Live run did not start' : 'Run failed')).toBeTruthy()
  expect(screen.getByText('Worker could not start')).toBeTruthy()
  expect(screen.queryByText(/Validation failed:/)).toBeNull()
  expect(runButton(mode).disabled).toBe(false)
})

test('unlocated validation errors do not guess a card from their message', async () => {
  await mount()
  vi.mocked(invoke).mockRejectedValueOnce({ message: 'out has a conflicting Page', step_id: null })
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await screen.findByText('Validation failed: out has a conflicting Page')
  expect(screen.queryByRole('img', { name: 'Validation warning' })).toBeNull()
})

test('Workflow shortcuts cut, paste, copy, select siblings and delete while respecting editing and busy state', async () => {
  await mount()
  const panel = screen.getByRole('tabpanel', { name: 'Workflow' })
  const key = (key: string, target = panel) => fireEvent.keyDown(target, { key, ctrlKey: key !== 'Delete' })
  const card = (id: string) => screen.getByRole('button', { name: new RegExp(`Step .*?, ${id}$`) })
  key('a')
  expect(card('outer').getAttribute('aria-pressed')).toBe('true')
  expect(card('inner').getAttribute('aria-pressed')).toBe('false')
  key('x')
  expect(screen.queryByRole('button', { name: /Step .*?, outer$/ })).toBeNull()
  key('v')
  expect(card('outer').getAttribute('aria-pressed')).toBe('true')
  expect(card('out')).toBeTruthy()
  key('c')
  key('v')
  expect(card('outer-copy')).toBeTruthy()
  key('Delete')
  expect(screen.queryByRole('button', { name: /Step .*?, outer-copy$/ })).toBeNull()
  fireEvent.click(card('out'))
  key('a')
  expect(card('out').getAttribute('aria-pressed')).toBe('true')
  expect(card('outer').getAttribute('aria-pressed')).toBe('false')
  const page = screen.getByLabelText('Page name')
  for (const shortcut of ['x', 'a', 'Delete', 'c', 'v']) key(shortcut, page)
  expect(card('out').getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  for (const shortcut of ['x', 'Delete', 'v']) key(shortcut)
  expect(card('out')).toBeTruthy()
  key('c')
  await finish(8)
  key('v')
  expect(card('out-copy-2')).toBeTruthy()
})

test('Pointer dragging moves between Root and empty bodies, preserves selection and never triggers validation', async () => {
  const whileStep = { type: 'while' as const, id: 'while', left: { source: 'literal' as const, value: 1 },
    operator: 'less-than' as const, right: { source: 'literal' as const, value: 0 }, max_iterations: 2, steps: [] }
  const a = { type: 'wait' as const, id: 'a', duration_ms: 1 }
  const b = { type: 'wait' as const, id: 'b', duration_ms: 2 }
  const dragDraft = { ...draft, workflow: { steps: [...draft.workflow.steps, a, whileStep, b] } }
  const original = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'create_workflow_draft'
    ? JSON.stringify(dragDraft) : original(command, args))
  await mount()
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number
    constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1 }
  })
  const editor = screen.getByRole('region', { name: 'Sequence' })
  vi.spyOn(editor, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 100, left: 0, right: 100 } as DOMRect)
  let destination: Element | null = null
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => destination })
  const drag = (id: string, target: Element, y = 95) => {
    destination = target
    const handle = screen.getByRole('button', { name: `Drag ${id} to reorder` })
    Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => false, releasePointerCapture: vi.fn() })
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    vi.useFakeTimers()
    const scrollBefore = editor.scrollTop
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: y })
    act(() => vi.advanceTimersByTime(100))
    if (y === 95) expect(editor.scrollTop).toBeGreaterThan(scrollBefore)
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 20, clientY: y })
    vi.useRealTimers()
  }
  const root = screen.getByRole('list', { name: 'Root steps' })
  drag('outer', screen.getByRole('list', { name: 'Body of inner' }))
  expect(within(root).getByRole('button', { name: /Step 1:.*outer$/ })).toBeTruthy()
  drag('out', root)
  const moved = screen.getByRole('button', { name: /Step 5:.*out$/ })
  expect(moved.getAttribute('aria-pressed')).toBe('true')
  expect(within(screen.getByRole('list', { name: 'Body of inner' })).queryByRole('button', { name: /Step / })).toBeNull()
  drag('out', screen.getByRole('list', { name: 'Body of inner' }))
  expect(screen.getByRole('button', { name: /Step 1.1.1:.*out$/ }).getAttribute('aria-pressed')).toBe('true')
  const card = (id: string) => screen.getByRole('button', { name: new RegExp(`Step .*?, ${id}$`) })
  const ids = (list: HTMLElement) => within(list).getAllByRole('button', { name: /^Step / })
    .filter(button => button.closest('ol') === list).map(button => button.getAttribute('aria-label')!.split(', ').at(-1))
  const actions = screen.getByRole('group', { name: 'Actions for outer' })
  vi.spyOn(actions, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 } as DOMRect)
  for (const name of ['Up', 'Down', 'Delete']) {
    drag('b', within(actions).getByRole('button', { name }), 25)
    expect(ids(root)).toEqual(['b', 'outer', 'a', 'while'])
    drag('b', root)
    expect(ids(root)).toEqual(['outer', 'a', 'while', 'b'])
  }
  vi.spyOn(card('outer').parentElement!, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 } as DOMRect)
  drag('b', card('outer'), 25)
  expect(ids(root)).toEqual(['b', 'outer', 'a', 'while'])
  drag('b', card('outer'), 75)
  expect(ids(root)).toEqual(['outer', 'b', 'a', 'while'])
  drag('b', root)
  fireEvent.click(card('a'))
  fireEvent.click(card('b'), { ctrlKey: true })
  drag('b', screen.getByRole('list', { name: 'Body of inner' }))
  expect(ids(screen.getByRole('list', { name: 'Body of inner' }))).toEqual(['out', 'a', 'b'])
  drag('a', screen.getByRole('list', { name: 'Body of while' }))
  expect(ids(screen.getByRole('list', { name: 'Body of while' }))).toEqual(['a', 'b'])
  drag('out', screen.getByRole('list', { name: 'Body of while' }))
  expect(ids(screen.getByRole('list', { name: 'Body of while' }))).toEqual(['a', 'b', 'out'])
  fireEvent.click(card('a'))
  fireEvent.click(card('b'), { ctrlKey: true })
  drag('a', root)
  expect(ids(root)).toEqual(['outer', 'while', 'a', 'b'])
  expect(card('a').getAttribute('aria-pressed')).toBe('true')
  expect(card('b').getAttribute('aria-pressed')).toBe('true')
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'validate_workflow_draft')).toHaveLength(0)
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  const outer = draft.workflow.steps[0] as ForStep
  const inner = outer.steps[0] as ForStep
  expect(JSON.parse((runCalls()[0][1] as { templateJson: string }).templateJson)).toEqual({
    ...draft, workflow: { steps: [
      { ...outer, steps: [{ ...inner, steps: [] }] },
      { ...whileStep, steps: [inner.steps[0]] }, a, b,
    ] },
  })
  expect((screen.getByRole('button', { name: 'Drag out to reorder' }) as HTMLButtonElement).disabled).toBe(true)
  await finish(8)
})
