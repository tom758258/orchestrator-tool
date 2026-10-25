import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { Channel, invoke } from '@tauri-apps/api/core'
import { confirm, open } from '@tauri-apps/plugin-dialog'
import type { ComponentProps } from 'react'
import App from '../src/App'
import type ResultChart from '../src/ResultChart'
import type { RunMetadataDto, WorkflowRunEventDto } from '../src/workflow'
import type { WorkflowDraft } from '../src/templateDraft'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class { constructor(public onmessage: (event: unknown) => void) {} },
}))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.1.0' }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(), open: vi.fn(), save: vi.fn() }))
// Chart rendering has its own tests; observe the run snapshot passed across this boundary.
vi.mock('../src/ResultChart', () => ({ default: (props: ComponentProps<typeof ResultChart>) =>
  <div data-testid="chart-snapshot">{JSON.stringify({ runId: props.runId, sampling: props.changeSettings, fitData: props.fitData })}</div>,
}))

const draft: WorkflowDraft = { schema_version: 1, name: 'Run test', tool_instances: [], workflow: { steps: [
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

beforeEach(() => {
  vi.clearAllMocks()
  run = deferred<RunMetadataDto>()
  preflightErrors = []
  vi.mocked(confirm).mockResolvedValue(true)
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const params = args as Record<string, unknown>
    switch (command) {
      case 'create_workflow_draft': return JSON.stringify(draft)
      case 'get_tool_status': return []
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
  expect(JSON.parse((runCalls()[0][1] as { templateJson: string }).templateJson)).toEqual(draft)
  await finish(1)
})
