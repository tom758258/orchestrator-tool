import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { Channel, invoke } from '@tauri-apps/api/core'
import { confirm, open, save } from '@tauri-apps/plugin-dialog'
import type { ComponentProps } from 'react'
import App from '../src/App'
import type ResultChart from '../src/ResultChart'
import { addBackgroundChartPanel, chartPanelToSavedChart } from '../src/chartPanels'
import type { ForStep, RunMetadataDto, WorkflowRunEventDto } from '../src/workflow'
import type { WorkflowDraft } from '../src/templateDraft'
import type { BackgroundChartSeries, BackgroundOutputData } from '../src/backgroundChartData'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class { constructor(public onmessage: (event: unknown) => void) {} },
}))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.1.0' }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(), open: vi.fn(), save: vi.fn() }))
vi.mock('../src/chartPng', () => ({ chartPng: async () => new Uint8Array([137, 80, 78, 71]) }))
vi.mock('echarts/core', () => ({ use: vi.fn(), init: () => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() }) }))
// Chart rendering has its own tests; observe the run snapshot passed across this boundary.
vi.mock('../src/ResultChart', () => ({ default: (props: ComponentProps<typeof ResultChart>) =>
  <>
    <div data-testid="chart-snapshot">{JSON.stringify({ runId: props.runId, sampling: props.changeSettings, fitData: props.fitData })}</div>
    <div data-testid="chart-panels">{JSON.stringify(props.panels)}</div>
  </>,
}))

vi.mock('../src/ChartPlot', () => ({ default: ({ panel, bounded }: { panel: { type: string }; bounded?: { values: Float64Array } }) =>
  <div role="img" aria-label={`${panel.type} chart`}>{bounded?.values.length ?? 0} displayed samples</div> }))

const draft: WorkflowDraft = { schema_version: 2, name: 'Run test', tool_instances: [], workflow: { steps: [
  { type: 'for', id: 'outer', variable: 'i', range: { start: '0', stop: '2', step: '1' }, steps: [
    { type: 'for', id: 'inner', variable: 'j', range: { start: '0', stop: '2', step: '1' }, steps: [
      { type: 'output', id: 'out', name: 'Voltage', page: 'Results', value: { source: 'literal', value: 10.600000000000001 } },
    ] },
  ] },
] } }

function backgroundDraft(count: number): WorkflowDraft {
  return { ...structuredClone(draft), tool_instances: Array.from({ length: count }, (_, index) => ({
    id: `meters-${index+1}`, tool: 'meters', setup: { trigger_mode: 'immediate-custom',
      measurement: 'voltage-dc', range_mode: 'auto', manual_range: null, nplc: 1, auto_zero: 'on',
      dcv_input_impedance: null, current_terminal: null },
  })), backgrounds: Array.from({ length: count }, (_, index) => ({
    id: `background-${index+1}`, tool_instance_id: `meters-${index+1}`, live_monitor: true,
    trigger_count: 3,
  })), workflow: { steps: [
    { type: 'background', id: 'on', background_id: 'background-1', action: 'worker-on', capture: true },
    ...structuredClone(draft.workflow.steps),
  ] } }
}

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
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  run = deferred<RunMetadataDto>()
  preflightErrors = []
  simulationRequirements = []
  currentDraft = structuredClone(draft)
  vi.mocked(confirm).mockResolvedValue(true)
  vi.mocked(save).mockResolvedValue('saved.json')
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const params = args as Record<string, unknown>
    switch (command) {
      case 'create_workflow_draft': return JSON.stringify(currentDraft)
      case 'get_tool_status': return []
      case 'get_simulation_sample_requirements': return simulationRequirements
      case 'get_background_output': return { workers: [{ id: 'background-1', state: 'off', stream_state: 'ended', live_monitor: true, error: null }],
        datasets: [{ id: 'capture-1', background_id: 'background-1', worker_run_id: 'worker', status: 'completed', quality: 'no_loss_detected', row_count: 300001, min: 1, max: 1, avg: 1, csv_path: null, error: null }],
        rows: [], monitor: [] }
      case 'get_live_resources': case 'get_live_resource_identities': case 'get_live_backends': return {}
      case 'get_powers_capabilities': return { channels: [1, 2] }
      case 'check_live_preflight': return preflightErrors
      case 'get_background_chart_series': return { total_count: 300001, visible_count: 300001, returned_count: 1,
        sampled: true, raw_limit: 25000, raw_limit_exceeded: false, domain: { min: 0, max: 30 },
        points: [{ x: 0.003, value: 1, sample_index: 5, timestamp_utc: '2026-10-28T00:00:00.003Z', elapsed_s: 0.003, unit: 'V' }] }
      case 'validate_workflow_draft': {
        const value = JSON.parse(params.templateJson as string) as WorkflowDraft
        const invalid = value.output_views?.charts.findIndex(chart => chart.source && !value.backgrounds?.some(background => background.id === chart.source!.background_id)) ?? -1
        if (invalid >= 0) throw new Error(`chart ${invalid + 1} references unknown Background`)
        return params.templateJson
      }
      case 'load_workflow_template': return JSON.stringify(currentDraft)
      case 'save_workflow_template': return params.templateJson
      case 'clear_last_run': return undefined
      case 'run_workflow_live': case 'run_workflow_simulation': return run.promise
      case 'request_workflow_stop': case 'request_global_workflow_stop': return true
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

async function savedDraft(): Promise<WorkflowDraft> {
  tab('Workflow')
  fireEvent.click(screen.getByRole('button', { name: 'Save Template' }))
  await screen.findByText('Template saved.')
  return JSON.parse((vi.mocked(invoke).mock.calls.filter(([command]) => command === 'save_workflow_template')
    .at(-1)![1] as { templateJson: string }).templateJson)
}

test.each([8, 7])('automatic Foreground Charts respect %i saved Background Charts through save toggles', async count => {
  currentDraft = backgroundDraft(1)
  let panels = addBackgroundChartPanel([], 'background-1')
  for (let i = 1; i < count; i++) panels = addBackgroundChartPanel(panels, 'background-1')
  currentDraft.output_views = { charts: panels.map(chartPanelToSavedChart) }
  await mount()
  vi.mocked(open).mockResolvedValue('template.json')
  fireEvent.click(screen.getByRole('button', { name: 'Open Template' }))
  await screen.findByText('Template loaded.')
  fireEvent.click(runButton('Simulation'))
  await finish(21)
  tab('Output')
  const option = screen.getByLabelText('Save charts with template') as HTMLInputElement
  expect(option.checked).toBe(true)
  fireEvent.click(option)
  await waitFor(() => expect(JSON.parse(screen.getByTestId('chart-panels').textContent!)).toHaveLength(8))
  fireEvent.click(option)
  const saved = await savedDraft()
  expect(saved.output_views?.charts).toHaveLength(8)
  expect(saved.backgrounds).toEqual(currentDraft.backgrounds)
  expect(saved.output_views?.charts.filter(chart => chart.source)).toHaveLength(count)
})

test('Last Run Charts survive binding removal, recover from invalid validation and never recreate Draft bindings', async () => {
  currentDraft = backgroundDraft(2)
  await mount()
  fireEvent.click(runButton('Simulation'))
  await finish(22)
  tab('Output')
  fireEvent.change(screen.getByLabelText('Chart source'), { target: { value: 'background:background-1' } })
  fireEvent.click(screen.getByRole('button', { name: '+ Add Chart' }))
  const chart = () => screen.getByRole('region', { name: 'Chart 2' })
  const axis = () => within(chart()).getByLabelText('X axis') as HTMLSelectElement
  await within(chart()).findByRole('img', { name: 'line chart' })
  fireEvent.click(screen.getByLabelText('Save charts with template'))
  fireEvent.change(axis(), { target: { value: 'timestamp' } })
  let saved = await savedDraft()
  expect(saved.output_views?.charts[1].source?.x_axis).toBe('timestamp')
  expect(saved.backgrounds).toEqual(currentDraft.backgrounds)
  fireEvent.click(screen.getByRole('button', { name: /Step .*?, on$/ }))
  fireEvent.keyDown(screen.getByRole('tabpanel', { name: 'Workflow' }), { key: 'Delete' })
  tab('Setup')
  const expandFirst = screen.queryByRole('button', { name: 'Expand meters-1' })
  if (expandFirst) fireEvent.click(expandFirst)
  const binding = (id: string) => within(screen.getByRole('button', { name: `Collapse ${id}` }).closest('fieldset')!)
    .getByLabelText('Use this instance as a Background') as HTMLInputElement
  fireEvent.click(binding('meters-1'))
  tab('Output')
  fireEvent.change(axis(), { target: { value: 'index' } })
  expect(axis().value).toBe('index')
  await within(chart()).findByRole('img', { name: 'line chart' })
  const writes = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'save_workflow_template').length
  const before = writes()
  tab('Workflow')
  run = deferred<RunMetadataDto>()
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(2))
  const error = 'worker exited unexpectedly'
  act(() => progressChannel().onmessage({ type: 'progress-batch', run: { ...metadata(23, 'failed'), error }, completed_step_ids: [] }))
  await act(async () => run.reject(error))
  expect(screen.getAllByText('Run failed')).toHaveLength(1)
  const validations = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'validate_workflow_draft').length
  const beforeValidation = validations()
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await screen.findByText(/Validation failed: Chart 2 references Background background-1/)
  expect(screen.queryByText('Run failed')).toBeNull()
  expect(validations()).toBe(beforeValidation)
  expect((screen.getByRole('button', { name: 'Validate' }) as HTMLButtonElement).disabled).toBe(false)
  expect(runButton('Simulation').disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Save Template' }))
  await screen.findByText(/Template I\/O failed: .*Chart 2 references Background background-1/)
  expect(writes()).toBe(before)
  tab('Output')
  fireEvent.click(screen.getByLabelText('Save charts with template'))
  saved = await savedDraft()
  expect(saved.output_views).toBeUndefined()
  expect(saved.backgrounds).toEqual([currentDraft.backgrounds![1]])
  tab('Setup')
  const expandSecond = screen.queryByRole('button', { name: 'Expand meters-2' })
  if (expandSecond) fireEvent.click(expandSecond)
  fireEvent.click(binding('meters-2'))
  fireEvent.click(binding('meters-2'))
  tab('Output')
  fireEvent.change(axis(), { target: { value: 'elapsed' } })
  fireEvent.click(screen.getByLabelText('Save charts with template'))
  tab('Workflow')
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await screen.findByText('Valid')
  expect(screen.queryByText(/Validation failed:/)).toBeNull()
  expect(runButton('Simulation').disabled).toBe(false)
  saved = await savedDraft()
  expect(saved.backgrounds).toEqual([{ id: 'background-1', tool_instance_id: 'meters-2', live_monitor: false, trigger_count: 1000 }])
  expect(saved.output_views?.charts[1].source?.x_axis).toBe('elapsed')
  expect(runCalls()).toHaveLength(2)
})

test('overlapping chart PNG exports keep application actions busy until every export settles', async () => {
  currentDraft = backgroundDraft(1)
  await mount()
  fireEvent.click(runButton('Simulation'))
  await finish(23)
  tab('Output')
  fireEvent.change(screen.getByLabelText('Chart source'), { target: { value: 'background:background-1' } })
  for (let i = 0; i < 2; i++) fireEvent.click(screen.getByRole('button', { name: '+ Add Chart' }))
  const chart = (n: number) => within(screen.getByRole('region', { name: `Chart ${n}` }))
  for (const n of [2, 3]) await chart(n).findByRole('img', { name: 'line chart' })
  const first = deferred<void>()
  const second = deferred<void>()
  const original = vi.mocked(invoke).getMockImplementation()!
  const writes = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'save_chart_png')
  vi.mocked(save).mockResolvedValueOnce('first.png').mockResolvedValueOnce('second.png')
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'save_chart_png'
    ? (args as { destinationPath: string }).destinationPath === 'first.png' ? first.promise : second.promise
    : original(command, args))
  for (const n of [2, 3]) fireEvent.click(chart(n).getByRole('button', { name: 'Export PNG' }))
  await waitFor(() => expect(writes()).toHaveLength(2))
  const expectBusy = (busy: boolean) => {
    expect((screen.getByRole('button', { name: 'New Template' }) as HTMLButtonElement).disabled).toBe(busy)
    expect((screen.getByRole('button', { name: 'Save Template' }) as HTMLButtonElement).disabled).toBe(busy)
    expect((screen.getByRole('tab', { name: 'Workflow' }) as HTMLButtonElement).disabled).toBe(busy)
  }
  expectBusy(true)
  await act(async () => first.resolve())
  await chart(2).findByText('Chart image saved successfully.')
  expectBusy(true)
  expect((chart(3).getByRole('button', { name: 'Export PNG' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => second.reject(new Error('Disk full')))
  await chart(3).findByText(/Could not save chart image: .*Disk full/)
  expectBusy(false)
  const cancelled = deferred<string | null>()
  vi.mocked(save).mockReturnValueOnce(cancelled.promise)
  fireEvent.click(chart(3).getByRole('button', { name: 'Export PNG' }))
  expectBusy(true)
  await act(async () => cancelled.resolve(null))
  expectBusy(false)
  expect(writes()).toHaveLength(2)
})

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
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })))
  fireEvent.click(screen.getByRole('button', { name: /Step .*?, out$/ }))
  const original = vi.mocked(invoke).getMockImplementation()!
  const requests = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'get_simulation_sample_requirements').length
  for (const action of ['edit', 'validate']) {
    const requirements = deferred<string[]>()
    vi.mocked(invoke).mockImplementation((command, args) => command === 'get_simulation_sample_requirements'
      ? requirements.promise : original(command, args))
    const before = requests()
    fireEvent.click(runButton('Simulation'))
    await waitFor(() => expect(requests()).toBe(before + 1))
    if (action === 'edit') {
      fireEvent.change(screen.getByLabelText('Value'), { target: { value: '12' } })
      await act(async () => requirements.resolve([]))
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
      await screen.findByText('Valid')
      await act(async () => requirements.reject('Outdated preparation error'))
    }
    expect(runCalls()).toHaveLength(1)
    expect(screen.queryByText('Run failed')).toBeNull()
    tab('Output')
    expect(snapshot().runId).toBe(19)
    tab('Workflow')
  }
})

test('Background-only Output separates Charts, Monitor and export with a shared eight-chart limit', async () => {
  currentDraft = backgroundDraft(1)
  currentDraft.name = 'Background-only'
  currentDraft.workflow.steps = currentDraft.workflow.steps.slice(0, 1)
  let captures = ['capture-1', 'capture-2']
  let monitorSamples = 0
  const original = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const result = await original(command, args)
    if (command === 'get_background_output') {
      const output = result as BackgroundOutputData
      // Capture has stopped, while the Worker continues sending Monitor samples.
      return { ...output, datasets: captures.map(id => ({ ...output.datasets[0], id })),
        workers: [{ ...output.workers[0], state: 'on', stream_state: 'running' }],
        monitor: Array.from({ length: ++monitorSamples }, (_, i) => ({ timestamp_utc: '2026-10-28T00:00:00Z',
          elapsed_s: i, captured: i + 1, value: i, unit: 'V' })) }
    }
    if (command === 'get_background_chart_series' && (args as { query: { raw: boolean } }).query.raw) {
      return { ...result as BackgroundChartSeries, returned_count: 0, sampled: false, raw_limit_exceeded: true, points: [] }
    }
    return result
  })
  await mount()
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  act(() => progressChannel().onmessage({ type: 'progress-batch', run: { ...metadata(20, 'running'), pages: [] }, completed_step_ids: [] }))
  tab('Output')
  const output = await screen.findByRole('region', { name: 'Background Output' })
  const charts = screen.getByRole('region', { name: 'Charts' })
  expect(within(charts).getByRole('region', { name: 'Live Monitor: background-1' })).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Foreground Output' })).toBeTruthy()
  await within(output).findByText(/More than 300,000 samples/)
  expect((within(output).getByLabelText('Samples per XLSX file') as HTMLInputElement).value).toBe('300000')
  expect((within(output).getByRole('button', { name: 'Export Background' }) as HTMLButtonElement).disabled).toBe(true)
  for (let i = 0; i < 2; i++) fireEvent.click(within(charts).getByRole('button', { name: '+ Add Chart' }))
  const chart = (n: number) => within(screen.getByRole('region', { name: `Chart ${n}` }))
  const dataset = (n: number) => chart(n).getByLabelText('Capture Dataset') as HTMLSelectElement
  await waitFor(() => expect(dataset(1).value).toBe('capture-2'))
  fireEvent.change(dataset(1), { target: { value: 'capture-1' } })
  expect(dataset(2).value).toBe('capture-2')
  captures.push('capture-3')
  await chart(1).findByRole('option', { name: /capture-3/ })
  expect(dataset(1).value).toBe('capture-1')
  expect(dataset(2).value).toBe('capture-2')
  tab('Workflow'); tab('Output')
  await waitFor(() => expect(dataset(1).value).toBe('capture-1'))
  expect(dataset(2).value).toBe('capture-2')
  const currentCharts = () => within(screen.getByRole('region', { name: 'Charts' }))
  for (let i = 2; i < 8; i++) fireEvent.click(currentCharts().getByRole('button', { name: '+ Add Chart' }))
  expect(currentCharts().getByText('Charts: 8 / 8')).toBeTruthy()
  expect((currentCharts().getByRole('button', { name: '+ Add Chart' }) as HTMLButtonElement).disabled).toBe(true)
  await waitFor(() => expect(dataset(8).value).toBe('capture-3'))
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'get_background_output').every(([,args]) => (args as {limit:number}).limit <= 100)).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Live Monitor: background-1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Chart 1' }))
  const queries = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'get_background_output').length
  const beforePoll = queries()
  await waitFor(() => expect(queries()).toBeGreaterThan(beforePoll))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Chart 1' }))
  expect(dataset(1).value).toBe('capture-1')
  fireEvent.click(screen.getByRole('button', { name: 'Expand Live Monitor: background-1' }))
  expect(Number(within(screen.getByRole('region', { name: 'Live Monitor: background-1' })).getByRole('img').textContent!.split(' ')[0])).toBeGreaterThan(1)
  await act(async () => run.resolve({ ...metadata(20), pages: [] }))
  const backgroundOutput = within(screen.getByRole('region', { name: 'Background Output' }))
  await waitFor(() => expect((backgroundOutput.getByRole('button', { name: 'Export Background' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(chart(1).getByRole('button', { name: 'Settings' }))
  fireEvent.click(screen.getByLabelText('Show All Raw Data'))
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  await chart(1).findByText(/Show All Raw Data supports at most 25,000/)
  expect(chart(1).getByRole('img').textContent).toBe('0 displayed samples')
  expect((chart(1).getByRole('button', { name: 'Export PNG' }) as HTMLButtonElement).disabled).toBe(true)
  expect((chart(2).getByRole('button', { name: 'Export PNG' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(chart(2).getByRole('button', { name: 'Settings' }))
  fireEvent.change(screen.getByLabelText('Chart type'), { target: { value: 'column' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  await chart(2).findByRole('img', { name: 'column chart' })
  // A new run selects its own latest Dataset, even with the same Chart IDs.
  captures = ['next-run-capture']
  run = deferred<RunMetadataDto>()
  tab('Workflow')
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(2))
  act(() => progressChannel().onmessage({ type: 'progress-batch', run: { ...metadata(21, 'running'), pages: [] }, completed_step_ids: [] }))
  tab('Output')
  await chart(2).findByText(/Waiting for run to finish/)
  expect(chart(2).queryByRole('img')).toBeNull()
  expect(vi.mocked(invoke).mock.calls.some(([command, args]) => command === 'get_background_chart_series'
    && (args as { runId: number; query: { chart_type: string } }).runId === 21
    && (args as { query: { chart_type: string } }).query.chart_type === 'column')).toBe(false)
  await act(async () => run.resolve({ ...metadata(21), pages: [] }))
  await chart(2).findByRole('img', { name: 'column chart' })
  await waitFor(() => expect(dataset(1).value).toBe('next-run-capture'))
  expect(chart(1).queryByRole('option', { name: /capture-1/ })).toBeNull()
  for (let i = 8; i >= 1; i--) fireEvent.click(screen.getByRole('button', { name: `Remove Chart ${i}` }))
  expect(currentCharts().getByText('Charts: 0 / 8')).toBeTruthy()
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

test.each(['Simulation', 'Live'])('%s dismisses stale Summary failures while preserving Last Run and showing new failures', async mode => {
  currentDraft = backgroundDraft(1)
  const original = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'get_live_resources'
    ? { 'meters-1': 'USB::METER' } : original(command, args))
  await previousRun()
  if (mode === 'Live') await selectLive()
  const error = 'worker exited unexpectedly'
  let runId = 7
  const fail = async (reject = false) => {
    run = deferred<RunMetadataDto>()
    await waitFor(() => expect(runButton(mode).disabled).toBe(false))
    runId++
    fireEvent.click(runButton(mode))
    await waitFor(() => expect(runCalls()).toHaveLength(runId - 6))
    const failed = { ...metadata(runId, 'failed'), error }
    const onProgress = progressChannel().onmessage
    act(() => onProgress({ type: 'progress-batch', run: failed, completed_step_ids: [] }))
    await act(async () => reject ? run.reject(error) : run.resolve(failed))
    expect(screen.getAllByText('Run failed')).toHaveLength(1)
    expect(screen.getByText(error)).toBeTruthy()
    expect(screen.getByText('Technical details')).toBeTruthy()
    return onProgress
  }
  const preserved = async () => {
    tab('Output')
    expect(snapshot().runId).toBe(runId)
    expect(screen.getByText(error)).toBeTruthy()
    expect(screen.getByText('Run failed')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Export Partial XLSX' }) as HTMLButtonElement).disabled).toBe(false)
    await screen.findByTitle('10.6')
    await screen.findByText(/capture-1/)
    tab('Workflow')
    expect(screen.getByText(`Message from run ${runId}`)).toBeTruthy()
  }
  let lateProgress = await fail()
  await preserved()
  fireEvent.click(screen.getByRole('button', { name: /Step .*?, out$/ }))
  tab('Setup')
  const expand = screen.queryByRole('button', { name: 'Expand meters-1' })
  if (expand) fireEvent.click(expand)
  fireEvent.change(screen.getByLabelText(/Display Name \(optional\)/), { target: { value: 'Meter' } })
  tab('Workflow')
  fireEvent.click(screen.getByRole('button', { name: 'Chart Options' }))
  fireEvent.click(screen.getByLabelText('Fit Data'))
  expect(screen.getAllByText('Run failed')).toHaveLength(1)
  // Step edits, Tool Setup and Background Setup each invalidate the Summary feedback.
  for (const field of ['Value', 'NPLC', 'Trigger count']) {
    if (field !== 'Value') {
      tab('Setup')
      const expand = screen.queryByRole('button', { name: 'Expand meters-1' })
      if (expand) fireEvent.click(expand)
    }
    fireEvent.change(screen.getByLabelText(field), { target: { value: field === 'Value' ? '12' : '10' } })
    tab('Workflow')
    expect(screen.queryByText('Run failed')).toBeNull()
    await preserved()
    expect(screen.queryByText('Run failed')).toBeNull()
    lateProgress = await fail()
  }
  // Validate hides both metadata-only and invoke-rejection failures before Core replies.
  for (const outcome of ['pass', 'fail']) {
    const validation = deferred<string>()
    const invokeRun = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation((command, args) => command === 'validate_workflow_draft'
      ? validation.promise : invokeRun(command, args))
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    expect(screen.getByRole('button', { name: 'Validating…' })).toBeTruthy()
    expect(screen.queryByText('Run failed')).toBeNull()
    act(() => lateProgress({ type: 'progress-batch', run: { ...metadata(runId, 'failed'), error }, completed_step_ids: [] }))
    expect(screen.queryByText('Run failed')).toBeNull()
    if (outcome === 'pass') {
      const json = (vi.mocked(invoke).mock.calls.filter(([command]) => command === 'validate_workflow_draft').at(-1)![1] as { templateJson: string }).templateJson
      await act(async () => validation.resolve(json))
      expect(screen.getByText('Valid')).toBeTruthy()
    } else {
      await act(async () => validation.reject({ message: 'Invalid template', step_id: 'out' }))
      expect(screen.getByText('Validation failed: Invalid template')).toBeTruthy()
    }
    vi.mocked(invoke).mockImplementation(invokeRun)
    expect(screen.queryByText('Run failed')).toBeNull()
    await preserved()
    expect(screen.queryByText('Run failed')).toBeNull()
    if (outcome === 'pass') {
      lateProgress = await fail(true)
      expect(screen.getByText('Valid')).toBeTruthy()
    }
  }
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: '13' } })
  run = deferred<RunMetadataDto>()
  await waitFor(() => expect(runButton(mode).disabled).toBe(false))
  fireEvent.click(runButton(mode))
  await finish(++runId)
  expect(screen.queryByText('Run failed')).toBeNull()
  tab('Output')
  expect(snapshot().runId).toBe(runId)
  expect(screen.queryByText(error)).toBeNull()
})

test.each(['Simulation', 'Live'])('%s can stop before any loop or step progress and waits for cleanup', async mode => {
  currentDraft.workflow.steps = [{ type: 'wait', id: 'wait', duration_ms: 30000 }]
  await mount()
  if (mode === 'Live') await selectLive()
  fireEvent.click(runButton(mode))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  const channel = progressChannel()
  const initial = { ...metadata(8, 'running'), execution_count: 0, latest_execution: null, pages: [], messages: [] }
  const progress = { type: 'progress-batch' as const, run: initial, completed_step_ids: [] as string[] }
  if (mode === 'Live') act(() => channel.onmessage(progress))
  fireEvent.click(await screen.findByRole('button', { name: 'Stop Workflow' }))
  const stopCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_global_workflow_stop')
  if (mode === 'Simulation') expect(stopCalls()).toHaveLength(0)
  act(() => channel.onmessage(progress))
  await waitFor(() => expect(stopCalls()).toEqual([['request_global_workflow_stop', { runId: 8 }]]))
  act(() => channel.onmessage(progress))
  expect(stopCalls()).toHaveLength(1)
  expect((screen.getByRole('button', { name: 'Stopping Workflow…' }) as HTMLButtonElement).disabled).toBe(true)
  expect(runButton(mode).disabled).toBe(true)
  await act(async () => run.resolve({ ...initial, status: 'stopped', manual_exportable: true }))
  await screen.findByText('Run stopped')
  expect(screen.queryByText('Run failed')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Stopping Workflow…' })).toBeNull()
  expect(runButton(mode).disabled).toBe(false)
})

test.each(['reject', 'not-accepted'])('global stop can retry a %s request and retains stopped output', async failure => {
  await mount()
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  act(() => progressChannel().onmessage({ type: 'progress-batch', run: metadata(8, 'running'), completed_step_ids: [] }))
  const original = vi.mocked(invoke).getMockImplementation()!
  let attempts = 0
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'request_global_workflow_stop' && ++attempts === 1) {
      if (failure === 'reject') throw new Error('Transport unavailable')
      return false
    }
    return original(command, args)
  })
  fireEvent.click(screen.getByRole('button', { name: 'Stop Workflow' }))
  await screen.findByText(/Workflow stop request failed:/)
  fireEvent.click(screen.getByRole('button', { name: 'Stop Workflow' }))
  await waitFor(() => expect(attempts).toBe(2))
  await act(async () => run.resolve(metadata(8, 'stopped')))
  await screen.findByText('Run stopped')
  expect(screen.getByText('Message from run 8')).toBeTruthy()
  tab('Output')
  expect(snapshot().runId).toBe(8)
  expect((screen.getByRole('button', { name: 'Export Partial XLSX' }) as HTMLButtonElement).disabled).toBe(false)
})

test('late global stop replies and progress cannot affect the next run', async () => {
  await mount()
  const reply = deferred<boolean>()
  const original = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'request_global_workflow_stop' ? reply.promise : original(command, args))
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  const previous = progressChannel()
  act(() => previous.onmessage({ type: 'progress-batch', run: metadata(8, 'running'), completed_step_ids: [] }))
  fireEvent.click(screen.getByRole('button', { name: 'Stop Workflow' }))
  await finish(8)
  run = deferred<RunMetadataDto>()
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(2))
  await act(async () => reply.resolve(false))
  act(() => previous.onmessage({ type: 'progress-batch', run: metadata(8, 'running'), completed_step_ids: [] }))
  act(() => progressChannel().onmessage({ type: 'progress-batch', run: metadata(9, 'running'), completed_step_ids: [] }))
  expect(screen.queryByText(/Workflow stop request failed:/)).toBeNull()
  expect((screen.getByRole('button', { name: 'Stop Workflow' }) as HTMLButtonElement).disabled).toBe(false)
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'request_global_workflow_stop')).toHaveLength(1)
  await finish(9)
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
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  expect(screen.queryByText('Worker could not start')).toBeNull()
  await screen.findByText('Valid')
  run = deferred<RunMetadataDto>()
  fireEvent.click(runButton(mode))
  await waitFor(() => expect(runCalls()).toHaveLength(2))
  await act(async () => run.reject('Another startup failure'))
  expect(screen.getByText('Another startup failure')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Step .*?, out$/ }))
  fireEvent.change(screen.getByLabelText('Page name'), { target: { value: 'Moved' } })
  expect(screen.queryByText('Another startup failure')).toBeNull()
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
