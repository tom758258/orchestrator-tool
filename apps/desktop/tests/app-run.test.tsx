import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { confirm, open, save } from '@tauri-apps/plugin-dialog'
import type { ComponentProps } from 'react'
import App from '../src/App'
import { I18nProvider } from '../src/i18n/I18nProvider'
import type ResultChart from '../src/ResultChart'
import ChartPanelView from '../src/ChartPanelView'
import { addChartPanel, addBackgroundChartPanel, chartPanelToSavedChart } from '../src/chartPanels'
import type { RunMetadataDto } from '../src/workflow'
import type { BackgroundChartSeries, BackgroundOutputData } from '../src/backgroundChartData'
import { createAppRunFixture } from './support/appRunFixture'

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

const { state, draft, backgroundDraft, metadata, deferred, tab, runButton, snapshot, runCalls, progressChannel, mount, selectLive, finish, previousRun, savedDraft } = createAppRunFixture()

test.each(['Simulation', 'Live'] as const)('Error Queue stays disabled for every instance through %s workflow cleanup', async mode => {
  state.currentDraft.tool_instances = [
    { id: 'powers-1', tool: 'powers', setup: {} },
    { id: 'powers-2', tool: 'powers', setup: {} },
    { id: 'scopes-1', tool: 'scopes', setup: {} },
    ...backgroundDraft(1).tool_instances,
    { id: 'wavegen-1', tool: 'wavegen', setup: {} },
  ]
  state.currentDraft.workflow.steps.unshift({ type: 'tool-action', id: 'status', target: 'powers-1', action: 'protection-status', arguments: {} })
  const existing = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    switch (command) {
      case 'get_tool_status': return ['powers', 'meters', 'scopes', 'wavegen'].map(tool_id => ({
        tool_id, executable_status: 'available', compatibility: 'compatible', path: `${tool_id}.exe`,
        source: 'configured', tool_version: '1.0', worker_schema_versions: [3], reason: null,
      }))
      case 'get_live_resources': return Object.fromEntries(state.currentDraft.tool_instances.map(({ id }) => [id, `${id}::SAVED`]))
      case 'get_live_resource_identities': return { 'scopes-1': { model_id: 'keysight-dsox4024a' } }
      case 'get_scopes_capabilities': return { analog_channels: 4, check_error_supported: true }
      case 'check_meters_error_queue_support': return undefined
      default: return existing(command, args)
    }
  })
  const buttons = () => screen.getAllByRole<HTMLButtonElement>('button', { name: 'Read & Drain Errors' })
  await mount()
  if (mode === 'Live') await selectLive()
  tab('Setup')
  await waitFor(() => expect(buttons().map(button => button.disabled)).toEqual([false, false, false, false]))
  tab('Workflow')
  fireEvent.click(runButton(mode))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  tab('Setup')
  expect(buttons().every(button => button.disabled)).toBe(true)
  await act(async () => progressChannel().onmessage({ type: 'progress-batch', run: metadata(50, 'running'), completed_step_ids: [] }))
  tab('Workflow')
  fireEvent.click(screen.getByRole('button', { name: 'Stop Workflow' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('request_global_workflow_stop', { runId: 50 }))
  tab('Setup')
  await act(async () => progressChannel().onmessage({ type: 'progress-batch', run: metadata(50, 'stopped'), completed_step_ids: [] }))
  expect(buttons().every(button => button.disabled)).toBe(true)
  buttons().forEach(button => fireEvent.click(button))
  expect(invoke).not.toHaveBeenCalledWith('read_and_drain_errors', expect.anything())
  await act(async () => state.run.resolve(metadata(50, 'stopped')))
  expect(buttons().every(button => !button.disabled)).toBe(true)
}, 15000)

test('locale changes preserve Template payload, active run, output data and Help settings', async () => {
  localStorage.removeItem('orchestrator-tool.theme')
  const original = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation((command, args) => command === 'export_last_run_pages'
    ? Promise.resolve(undefined) : original(command, args))
  render(<I18nProvider initialLanguage="en"><App /></I18nProvider>)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_workflow_draft'))
  tab('Workflow')
  await waitFor(() => expect(runButton('Simulation').disabled).toBe(false))
  const expectProcessHints = (names: string[]) => {
    for (const name of names) {
      const description = screen.getByRole('button', { name }).getAttribute('title')?.split('\n')[1]
      expect(description).toBeTruthy()
      expect(description).not.toMatch(/^steps\.hint\./)
    }
  }
  expectProcessHints(['String Process', 'Byte Process', 'Array Process'])
  const before = await savedDraft()
  fireEvent.click(screen.getByRole('button', { name: 'Switch theme to Light' }))
  fireEvent.click(screen.getByRole('button', { name: 'Switch language to 繁體中文' }))
  expect(screen.getByText('已儲存範本。')).toBeTruthy()
  expectProcessHints(['字串處理 (String Process)', '位元組處理 (Byte Process)', '陣列處理 (Array Process)'])
  fireEvent.click(screen.getByRole('button', { name: '儲存範本' }))
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'save_workflow_template')).toHaveLength(2))
  const latest = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'save_workflow_template').at(-1)!
  expect(JSON.parse((latest[1] as { templateJson: string }).templateJson)).toEqual(before)
  fireEvent.click(screen.getByRole('button', { name: '使用說明' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_help', { locale: 'zh-TW', theme: 'light' }))
  fireEvent.click(screen.getByRole('button', { name: /執行.*模擬/ }))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: '切換語言為 English' }))
  expect(screen.getByRole('button', { name: 'Stop Workflow' })).toBeTruthy()
  expect(runCalls()).toHaveLength(1)
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'create_workflow_draft')).toHaveLength(1)
  await finish(7)
  tab('Output')
  await screen.findByTitle('10.6')
  fireEvent.click(screen.getByRole('button', { name: 'Export XLSX' }))
  await screen.findByText('Pages exported successfully.')
  fireEvent.click(screen.getByRole('button', { name: 'Switch language to 繁體中文' }))
  expect(screen.getByTitle('10.6')).toBeTruthy()
  expect(screen.getByRole('region', { name: '前景輸出' })).toBeTruthy()
  expect(screen.getByText('已成功匯出頁面。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '匯出 XLSX' }))
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'export_last_run_pages')).toHaveLength(2))
  const exports = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'export_last_run_pages')
  expect(exports[0][1]).toEqual(exports[1][1])
  expect(localStorage.getItem('orchestrator-tool.theme')).toBe('light')
  localStorage.removeItem('orchestrator-tool.theme')
  expect(runCalls()).toHaveLength(1)
  localStorage.removeItem('orchestrator-tool.locale')
})

test('Charts creation settings filter Page by Ground and label each source', async () => {
  state.currentDraft = backgroundDraft(2)
  await mount()
  fireEvent.click(runButton('Simulation'))
  await finish(31)
  tab('Output')
  const charts = within(screen.getByRole('region', { name: 'Charts' }))
  const ground = charts.getByRole('combobox', { name: 'Ground' }) as HTMLSelectElement
  const page = charts.getByRole('combobox', { name: 'Page' }) as HTMLSelectElement
  expect(ground.value).toBe('foreground')
  expect([...page.options].map(option => option.textContent?.trim())).toEqual(['Results'])
  fireEvent.click(charts.getByRole('button', { name: '+ Add Chart' }))
  expect(JSON.parse(screen.getByTestId('chart-panels').textContent!)[0]).toMatchObject({
    page: 'Results', outputs: ['Voltage'],
  })

  fireEvent.change(ground, { target: { value: 'background' } })
  expect([...page.options].map(option => option.textContent?.trim())).toEqual(['background-1', 'background-2'])
  fireEvent.change(page, { target: { value: 'background:background-2' } })
  expect(page.value).toBe('background:background-2')
  fireEvent.click(charts.getByRole('button', { name: '+ Add Chart' }))
  const second = within(screen.getByRole('region', { name: 'Chart 2' }))
  expect(second.getByText('Data source').parentElement?.textContent).toContain('Background')
  expect(second.getByText('Source: background-2')).toBeTruthy()
  expect(JSON.parse(screen.getByTestId('chart-panels').textContent!)[1]).toMatchObject({
    source: { background_id: 'background-2' },
  })

  fireEvent.change(ground, { target: { value: 'foreground' } })
  expect(page.value).toBe('page:Results')
  expect(charts.getByText('Charts: 2 / 8')).toBeTruthy()
})

test('Charts disable Add Chart when the chosen Ground has no sources', async () => {
  await mount()
  fireEvent.click(runButton('Simulation'))
  await finish(32)
  tab('Output')
  const charts = within(screen.getByRole('region', { name: 'Charts' }))
  fireEvent.change(charts.getByRole('combobox', { name: 'Ground' }), { target: { value: 'background' } })
  const page = charts.getByRole('combobox', { name: 'Page' }) as HTMLSelectElement
  expect(page.disabled).toBe(true)
  expect((charts.getByRole('button', { name: '+ Add Chart' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('region', { name: 'Live Monitors' })).toBeNull()
})

test('Run preserves eight saved Background Charts without adding a Foreground Chart', async () => {
  const count = 8
  state.currentDraft = backgroundDraft(1)
  let panels = addBackgroundChartPanel([], 'background-1')
  for (let i = 1; i < count; i++) panels = addBackgroundChartPanel(panels, 'background-1')
  state.currentDraft.output_views = { charts: panels.map(chartPanelToSavedChart) }
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
  await waitFor(() => expect(JSON.parse(screen.getByTestId('chart-panels').textContent!)).toHaveLength(count))
  fireEvent.click(option)
  const saved = await savedDraft()
  expect(saved.output_views?.charts).toHaveLength(count)
  expect(saved.backgrounds).toEqual(state.currentDraft.backgrounds)
  expect(saved.output_views?.charts.filter(chart => chart.source)).toHaveLength(count)
})

test('Last Run Charts survive binding removal, recover from invalid validation and never recreate Draft bindings', async () => {
  state.currentDraft = backgroundDraft(2)
  await mount()
  fireEvent.click(runButton('Simulation'))
  await finish(22)
  tab('Output')
  fireEvent.change(screen.getByRole('combobox', { name: 'Ground' }), { target: { value: 'background' } })
  fireEvent.click(screen.getByRole('button', { name: '+ Add Chart' }))
  const chart = () => screen.getByRole('region', { name: 'Chart 1' })
  const openSource = () => {
    fireEvent.click(within(chart()).getByRole('button', { name: 'Source settings' }))
    return within(screen.getByRole('dialog', { name: 'Source settings' }))
  }
  let source = openSource()
  expect(source.getByText('Source: background-1')).toBeTruthy()
  expect(source.queryByRole('combobox', { name: 'Background' })).toBeNull()
  expect(source.getByLabelText('Capture Dataset')).toBeTruthy()
  expect(source.getByLabelText('X-axis data')).toBeTruthy()
  // A close event queued during StrictMode's effect cleanup must not dismiss a reopened dialog.
  const sourceDialog = screen.getByRole('dialog', { name: 'Source settings' }) as HTMLDialogElement
  expect(sourceDialog.open).toBe(true)
  fireEvent(sourceDialog, new Event('close'))
  expect(screen.getByRole('dialog', { name: 'Source settings' })).toBe(sourceDialog)
  const axis = () => source.getByLabelText('X-axis data') as HTMLSelectElement
  const closeSource = () => fireEvent.click(source.getByRole('button', { name: 'Close' }))
  await within(chart()).findByRole('img', { name: 'line chart' })
  fireEvent.click(screen.getByLabelText('Save charts with template'))
  fireEvent.change(axis(), { target: { value: 'timestamp' } })
  closeSource()
  let saved = await savedDraft()
  expect(saved.output_views?.charts[0].source?.x_axis).toBe('timestamp')
  expect(saved.backgrounds).toEqual(state.currentDraft.backgrounds)
  fireEvent.click(screen.getByRole('button', { name: /Step .*?, on$/ }))
  fireEvent.keyDown(screen.getByRole('tabpanel', { name: 'Workflow' }), { key: 'Delete' })
  tab('Setup')
  const expandFirst = screen.queryByRole('button', { name: 'Expand meters-1' })
  if (expandFirst) fireEvent.click(expandFirst)
  const binding = (id: string) => within(screen.getByRole('button', { name: `Collapse ${id}` }).closest('fieldset')!)
    .getByLabelText('Enable Background Streaming') as HTMLInputElement
  fireEvent.click(within(screen.getByRole('button', { name: 'Collapse meters-1' }).closest('fieldset')!)
    .getByRole('button', { name: 'Expand Background Streaming' }))
  fireEvent.click(binding('meters-1'))
  tab('Output')
  source = openSource()
  expect(source.getByRole('alert').textContent).toContain('no longer available')
  const reassign = source.getByLabelText('Reassign source') as HTMLSelectElement
  expect([...reassign.options].map(option => option.value)).toContain('background-2')
  fireEvent.change(axis(), { target: { value: 'index' } })
  expect(axis().value).toBe('index')
  closeSource()
  await within(chart()).findByRole('img', { name: 'line chart' })
  const writes = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'save_workflow_template').length
  const before = writes()
  tab('Workflow')
  state.run = deferred<RunMetadataDto>()
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(2))
  const error = 'worker exited unexpectedly'
  act(() => progressChannel().onmessage({ type: 'progress-batch', run: { ...metadata(23, 'failed'), error }, completed_step_ids: [] }))
  await act(async () => state.run.reject(error))
  expect(screen.getAllByText('Run failed')).toHaveLength(1)
  const validations = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'validate_workflow_draft').length
  const beforeValidation = validations()
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await screen.findByText(/Validation failed: Chart 1 references Background background-1/)
  expect(screen.queryByText('Run failed')).toBeNull()
  expect(validations()).toBe(beforeValidation)
  expect((screen.getByRole('button', { name: 'Validate' }) as HTMLButtonElement).disabled).toBe(false)
  expect(runButton('Simulation').disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Save Template' }))
  await screen.findByText(/Template I\/O failed: .*Chart 1 references Background background-1/)
  expect(writes()).toBe(before)
  tab('Output')
  fireEvent.click(screen.getByLabelText('Save charts with template'))
  saved = await savedDraft()
  expect(saved.output_views).toBeUndefined()
  expect(saved.backgrounds).toEqual([state.currentDraft.backgrounds![1]])
  tab('Setup')
  const expandSecond = screen.queryByRole('button', { name: 'Expand meters-2' })
  if (expandSecond) fireEvent.click(expandSecond)
  fireEvent.click(binding('meters-2'))
  fireEvent.click(binding('meters-2'))
  tab('Output')
  source = openSource()
  fireEvent.change(axis(), { target: { value: 'elapsed' } })
  closeSource()
  fireEvent.click(screen.getByLabelText('Save charts with template'))
  tab('Workflow')
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await screen.findByText('Valid')
  expect(screen.queryByText(/Validation failed:/)).toBeNull()
  expect(runButton('Simulation').disabled).toBe(false)
  saved = await savedDraft()
  expect(saved.backgrounds).toEqual([{ id: 'background-1', tool_instance_id: 'meters-2', live_monitor: false, limit_count: 1000 }])
  expect(saved.output_views?.charts[0].source?.x_axis).toBe('elapsed')
  expect(runCalls()).toHaveLength(2)
})

test('invalid Background Chart can be reassigned to a source in both Draft and Last Run', async () => {
  state.currentDraft = backgroundDraft(2)
  await mount()
  fireEvent.click(runButton('Simulation'))
  await finish(22)
  tab('Output')
  fireEvent.change(screen.getByRole('combobox', { name: 'Ground' }), { target: { value: 'background' } })
  fireEvent.click(screen.getByRole('button', { name: '+ Add Chart' }))
  tab('Setup')
  const expandFirst = screen.queryByRole('button', { name: 'Expand meters-1' })
  if (expandFirst) fireEvent.click(expandFirst)
  const first = screen.getByRole('button', { name: 'Collapse meters-1' }).closest('fieldset')!
  fireEvent.click(within(first).getByRole('button', { name: 'Expand Background Streaming' }))
  fireEvent.click(within(first).getByLabelText('Enable Background Streaming'))
  tab('Output')
  const chart = within(screen.getByRole('region', { name: 'Chart 1' }))
  fireEvent.click(chart.getByRole('button', { name: 'Source settings' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Source settings' }))
  const reassign = dialog.getByLabelText('Reassign source') as HTMLSelectElement
  expect([...reassign.options].map(option => option.value)).toContain('background-2')
  fireEvent.change(reassign, { target: { value: 'background-2' } })
  expect(dialog.getByText('Source: background-2')).toBeTruthy()
  expect(JSON.parse(screen.getByTestId('chart-panels').textContent!)[0].source.background_id).toBe('background-2')
  expect(dialog.queryByLabelText('Reassign source')).toBeNull()
  expect(dialog.getByLabelText('Capture Dataset')).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: 'Close' }))
})

test('overlapping chart PNG exports keep application actions busy until every export settles', async () => {
  state.currentDraft = backgroundDraft(1)
  await mount()
  fireEvent.click(runButton('Simulation'))
  await finish(23)
  tab('Output')
  fireEvent.change(screen.getByRole('combobox', { name: 'Ground' }), { target: { value: 'background' } })
  for (let i = 0; i < 2; i++) fireEvent.click(screen.getByRole('button', { name: '+ Add Chart' }))
  const chart = (n: number) => within(screen.getByRole('region', { name: `Chart ${n}` }))
  for (const n of [1, 2]) await chart(n).findByRole('img', { name: 'line chart' })
  const first = deferred<void>()
  const second = deferred<void>()
  const original = vi.mocked(invoke).getMockImplementation()!
  const writes = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'save_chart_png')
  vi.mocked(save).mockResolvedValueOnce('first.png').mockResolvedValueOnce('second.png')
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'save_chart_png'
    ? (args as { destinationPath: string }).destinationPath === 'first.png' ? first.promise : second.promise
    : original(command, args))
  for (const n of [1, 2]) fireEvent.click(chart(n).getByRole('button', { name: 'Export PNG' }))
  await waitFor(() => expect(writes()).toHaveLength(2))
  const expectBusy = (busy: boolean) => {
    expect((screen.getByRole('button', { name: 'New Template' }) as HTMLButtonElement).disabled).toBe(busy)
    expect((screen.getByRole('button', { name: 'Save Template' }) as HTMLButtonElement).disabled).toBe(busy)
    expect((screen.getByRole('tab', { name: 'Workflow' }) as HTMLButtonElement).disabled).toBe(busy)
  }
  expectBusy(true)
  await act(async () => first.resolve())
  await chart(1).findByText('Chart image saved successfully.')
  expectBusy(true)
  expect((chart(2).getByRole('button', { name: 'Export PNG' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => second.reject(new Error('Disk full')))
  await chart(2).findByText(/Could not save chart image: .*Disk full/)
  expectBusy(false)
  const cancelled = deferred<string | null>()
  vi.mocked(save).mockReturnValueOnce(cancelled.promise)
  fireEvent.click(chart(2).getByRole('button', { name: 'Export PNG' }))
  expectBusy(true)
  await act(async () => cancelled.resolve(null))
  expectBusy(false)
  expect(writes()).toHaveLength(2)
})

test('Simulation sample warning supports cancellation, per-instance overrides and fresh defaults', async () => {
  state.currentDraft = backgroundDraft(2)
  state.simulationRequirements = ['meters-1', 'meters-2']
  await mount()
  fireEvent.click(runButton('Simulation'))
  let dialog = await screen.findByRole('dialog', { name: 'Meters Simulation samples' })
  expect((within(dialog).getByLabelText('meters-1 SIM Max Samples') as HTMLInputElement).value).toBe('1000')
  for (const name of ['New Template', 'Open Template', 'Validate', 'Live']) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
  }
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
  expect(runCalls()[0][1]).toMatchObject({ simulationSamples: { 'meters-1': 5000, 'meters-2': 2000 }, templateJson: JSON.stringify(state.currentDraft) })
  const originalError = 'Original run failure'
  await act(async () => state.run.resolve({ ...metadata(19, 'failed'), error: originalError }))
  await waitFor(() => expect(runButton('Simulation').disabled).toBe(false))
  fireEvent.click(runButton('Simulation'))
  dialog = await screen.findByRole('dialog', { name: 'Meters Simulation samples' })
  expect((within(dialog).getByLabelText('meters-1 SIM Max Samples') as HTMLInputElement).value).toBe('1000')
  await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })))
  const original = vi.mocked(invoke).getMockImplementation()!
  const requests = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'get_simulation_sample_requirements').length
  let lastRunId = 19
  for (const action of ['edit', 'validate', 'validate-error', 'live', 'live-error', 'new', 'open']) {
    const requirements = deferred<string[]>()
    const replacement = deferred<string>()
    let rejectValidation = false
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'get_simulation_sample_requirements') return requirements.promise
      if ((action === 'new' && command === 'create_workflow_draft') || (action === 'open' && command === 'load_workflow_template')) return replacement.promise
      if (rejectValidation && command === 'validate_workflow_draft') return Promise.reject({ message: 'Current validation error', step_id: 'out' })
      return original(command, args)
    })
    const before = requests()
    const runsBefore = runCalls().length
    fireEvent.click(runButton('Simulation'))
    await waitFor(() => expect(requests()).toBe(before + 1))
    if (action === 'edit') {
      fireEvent.click(screen.getByRole('button', { name: /Step .*?, out$/ }))
      fireEvent.change(screen.getByLabelText('Value'), { target: { value: '12' } })
    } else if (action.startsWith('validate')) {
      rejectValidation = action === 'validate-error'
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
      await screen.findByText(rejectValidation ? 'Validation failed: Current validation error' : 'Valid')
    } else if (action === 'new' || action === 'open') {
      state.currentDraft = { ...structuredClone(state.currentDraft), name: `${action} replacement` }
      vi.mocked(open).mockResolvedValue('replacement.json')
      fireEvent.click(screen.getByRole('button', { name: action === 'new' ? 'New Template' : 'Open Template' }))
      await waitFor(() => expect(invoke).toHaveBeenCalledWith(
        action === 'new' ? 'create_workflow_draft' : 'load_workflow_template',
        ...(action === 'new' ? [] : [{ path: 'replacement.json' }]),
      ))
    } else {
      await selectLive()
    }
    if (action.endsWith('-error')) {
      await act(async () => requirements.reject('Outdated preparation error'))
    } else {
      await act(async () => requirements.resolve(['meters-1']))
    }
    expect(screen.queryByRole('dialog', { name: 'Meters Simulation samples' })).toBeNull()
    expect(runCalls()).toHaveLength(runsBefore)
    expect(screen.queryByText('Run failed')).toBeNull()
    expect(screen.queryByText('Outdated preparation error')).toBeNull()
    if (rejectValidation) expect(screen.getByText('Validation failed: Current validation error')).toBeTruthy()
    if (action === 'new' || action === 'open') {
      await act(async () => replacement.resolve(JSON.stringify(state.currentDraft)))
      expect(invoke).toHaveBeenCalledWith('clear_last_run', { runId: lastRunId })
      expect(runCalls()).toHaveLength(runsBefore)
    }
    tab('Output')
    if (action === 'new' || action === 'open') {
      expect(screen.queryByTestId('chart-snapshot')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Clear Last Run' })).toBeNull()
    } else {
      expect(snapshot().runId).toBe(lastRunId)
      await screen.findByTitle('10.6')
      await screen.findByText(/capture-1/)
      expect((within(screen.getByRole('region', { name: 'Foreground Output' }))
        .getByRole('button', { name: lastRunId === 19 ? 'Export Partial XLSX' : 'Export XLSX' }) as HTMLButtonElement).disabled).toBe(false)
      if (lastRunId === 19) expect(screen.getByText(originalError)).toBeTruthy()
    }
    tab('Workflow')
    vi.mocked(invoke).mockImplementation(original)
    if (action.startsWith('live')) fireEvent.click(screen.getByRole('button', { name: 'Simulation' }))
    state.run = deferred<RunMetadataDto>()
    fireEvent.click(runButton('Simulation'))
    dialog = await screen.findByRole('dialog', { name: 'Meters Simulation samples' })
    expect((within(dialog).getByLabelText('meters-1 SIM Max Samples') as HTMLInputElement).value).toBe('1000')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run Simulation' }))
    await waitFor(() => expect(runCalls()).toHaveLength(runsBefore + 1))
    if (action === 'new' || action === 'open') {
      expect(JSON.parse((runCalls().at(-1)![1] as { templateJson: string }).templateJson)).toEqual(state.currentDraft)
    }
    await finish(++lastRunId)
    await screen.findByText(`Message from run ${lastRunId}`)
  }
}, 15000)

test('Background-only Output separates Charts, Monitor and export with a shared eight-chart limit', async () => {
  state.currentDraft = backgroundDraft(1)
  state.currentDraft.name = 'Background-only'
  state.currentDraft.workflow.steps = state.currentDraft.workflow.steps.slice(0, 1)
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
  const currentMonitors = () => within(screen.getByRole('region', { name: 'Live Monitors' }))
  const monitor = currentMonitors().getByRole('region', { name: 'Live Monitor: background-1' })
  expect(within(monitor).getByRole('region', { name: 'Monitor info' })).toBeTruthy()
  expect(within(charts).queryByRole('region', { name: 'Live Monitor: background-1' })).toBeNull()
  expect(screen.getByRole('region', { name: 'Foreground Output' })).toBeTruthy()
  await within(output).findByText(/More than 300,000 samples/)
  expect((within(output).getByLabelText('Samples per XLSX file') as HTMLInputElement).value).toBe('300000')
  expect((within(output).getByRole('button', { name: 'Export XLSX' }) as HTMLButtonElement).disabled).toBe(true)
  for (let i = 0; i < 2; i++) fireEvent.click(within(charts).getByRole('button', { name: '+ Add Chart' }))
  const chart = (n: number) => within(screen.getByRole('region', { name: `Chart ${n}` }))
  const openSource = (n: number) => {
    fireEvent.click(chart(n).getByRole('button', { name: 'Source settings' }))
    return within(screen.getByRole('dialog', { name: 'Source settings' }))
  }
  const dataset = (dialog: ReturnType<typeof within>) => dialog.getByLabelText('Capture Dataset') as HTMLSelectElement
  const closeSource = (dialog: ReturnType<typeof within>) => fireEvent.click(dialog.getByRole('button', { name: 'Close' }))
  let source = openSource(1)
  expect(source.getByText('Source: background-1')).toBeTruthy()
  expect(source.queryByRole('combobox', { name: 'Background' })).toBeNull()
  await waitFor(() => expect(dataset(source).value).toBe('capture-2'))
  fireEvent.change(dataset(source), { target: { value: 'capture-1' } })
  closeSource(source)
  source = openSource(2)
  expect(dataset(source).value).toBe('capture-2')
  closeSource(source)
  const summary = await chart(1).findByRole('region', { name: 'Data summary' })
  expect(within(summary).getByText('Total samples')).toBeTruthy()
  expect(within(summary).getByText('In range')).toBeTruthy()
  expect(within(summary).getByText('Plotted')).toBeTruthy()
  captures.push('capture-3')
  source = openSource(1)
  await source.findByRole('option', { name: /capture-3/ })
  expect(dataset(source).value).toBe('capture-1')
  closeSource(source)
  source = openSource(2)
  expect(dataset(source).value).toBe('capture-2')
  closeSource(source)
  tab('Workflow'); tab('Output')
  source = openSource(1)
  await waitFor(() => expect(dataset(source).value).toBe('capture-1'))
  closeSource(source)
  source = openSource(2)
  expect(dataset(source).value).toBe('capture-2')
  closeSource(source)
  const currentCharts = () => within(screen.getByRole('region', { name: 'Charts' }))
  for (let i = 2; i < 8; i++) fireEvent.click(currentCharts().getByRole('button', { name: '+ Add Chart' }))
  expect(currentCharts().getByText('Charts: 8 / 8')).toBeTruthy()
  expect((currentCharts().getByRole('button', { name: '+ Add Chart' }) as HTMLButtonElement).disabled).toBe(true)
  source = openSource(8)
  await waitFor(() => expect(dataset(source).value).toBe('capture-3'))
  closeSource(source)
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'get_background_output').every(([,args]) => (args as {limit:number}).limit <= 100)).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Charts' }))
  expect(screen.queryByRole('button', { name: '+ Add Chart' })).toBeNull()
  expect(currentMonitors().getByRole('region', { name: 'Live Monitor: background-1' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Expand Charts' }))
  expect(currentCharts().getByText('Charts: 8 / 8')).toBeTruthy()
  await act(async () => state.run.resolve({ ...metadata(20), pages: [] }))
  const backgroundOutput = within(screen.getByRole('region', { name: 'Background Output' }))
  await waitFor(() => expect((backgroundOutput.getByRole('button', { name: 'Export XLSX' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(chart(1).getByRole('button', { name: 'Settings' }))
  fireEvent.click(screen.getByLabelText('Show All Raw Data'))
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  await chart(1).findByText(/Show All Raw Data supports at most 25,000/)
  expect(within(chart(1).getByRole('region', { name: 'Data summary' })).getByText('Plotted')).toBeTruthy()
  expect(chart(1).getByRole('img').textContent).toBe('0 displayed samples')
  expect((chart(1).getByRole('button', { name: 'Export PNG' }) as HTMLButtonElement).disabled).toBe(true)
  expect((chart(2).getByRole('button', { name: 'Export PNG' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(chart(2).getByRole('button', { name: 'Settings' }))
  fireEvent.change(screen.getByLabelText('Chart type'), { target: { value: 'column' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  await chart(2).findByRole('img', { name: 'column chart' })
  // A new run selects its own latest Dataset, even with the same Chart IDs.
  captures = ['next-run-capture']
  state.run = deferred<RunMetadataDto>()
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
  await act(async () => state.run.resolve({ ...metadata(21), pages: [] }))
  await chart(2).findByRole('img', { name: 'column chart' })
  source = openSource(1)
  await waitFor(() => expect(dataset(source).value).toBe('next-run-capture'))
  expect(source.queryByRole('option', { name: /capture-1/ })).toBeNull()
  closeSource(source)
})

test.each(['Simulation', 'Live'])('%s uses one run entry, locks editing and snapshots options for Last Run', async mode => {
  await mount()
  if (mode === 'Live') await selectLive()
  fireEvent.click(screen.getByRole('button', { name: 'Chart Options' }))
  fireEvent.click(screen.getByLabelText('Preserve Significant Changes'))
  const threshold = screen.getByLabelText('Change Threshold (%)')
  fireEvent.change(threshold, { target: { value: '0' } })
  expect(runButton(mode).disabled).toBe(true)
  expect(screen.getByRole('spinbutton', { name: 'Change Threshold (%)',
    description: /greater than zero.*Change Threshold must be a finite number greater than zero/ })).toBe(threshold)
  expect(threshold.getAttribute('aria-invalid')).toBe('true')
  fireEvent.change(threshold, { target: { value: '12' } })
  expect(screen.getByRole('spinbutton', { name: 'Change Threshold (%)',
    description: /greater than zero/ })).toBe(threshold)
  expect(threshold.getAttribute('aria-invalid')).toBeNull()
  expect(screen.queryByText('Change Threshold must be a finite number greater than zero.')).toBeNull()
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
  state.run = deferred<RunMetadataDto>()
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
  await act(async () => state.run.reject('Live Preflight failed: CH3 unsupported'))
  expect(snapshot().runId).toBe(7)
  tab('Workflow')
  expect(screen.getByText('Live Preflight failed: CH3 unsupported')).toBeTruthy()
  expect(screen.queryByText('Run failed')).toBeNull()
  expect(screen.getByText('Message from run 7')).toBeTruthy()
  expect(runButton('Live').disabled).toBe(true)
})

test('Simulation dismisses stale Summary failures while preserving Last Run and showing new failures', async () => {
  const mode = 'Simulation' as const
  state.currentDraft = backgroundDraft(1)
  const original = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'get_live_resources'
    ? { 'meters-1': 'USB::METER' } : original(command, args))
  await previousRun()
  const error = 'worker exited unexpectedly'
  let runId = 7
  const fail = async (reject = false) => {
    state.run = deferred<RunMetadataDto>()
    await waitFor(() => expect(runButton(mode).disabled).toBe(false))
    runId++
    fireEvent.click(runButton(mode))
    await waitFor(() => expect(runCalls()).toHaveLength(runId - 6))
    const failed = { ...metadata(runId, 'failed'), error }
    const onProgress = progressChannel().onmessage
    act(() => onProgress({ type: 'progress-batch', run: failed, completed_step_ids: [] }))
    await act(async () => reject ? state.run.reject(error) : state.run.resolve(failed))
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
  for (const field of ['Value', 'NPLC', 'Trigger Count']) {
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
  state.run = deferred<RunMetadataDto>()
  await waitFor(() => expect(runButton(mode).disabled).toBe(false))
  fireEvent.click(runButton(mode))
  await finish(++runId)
  expect(screen.queryByText('Run failed')).toBeNull()
  tab('Output')
  expect(snapshot().runId).toBe(runId)
  expect(screen.queryByText(error)).toBeNull()
}, 10000)

test.each(['Simulation', 'Live'])('%s can stop before any loop or step progress and waits for cleanup', async mode => {
  state.currentDraft.workflow.steps = [{ type: 'wait', id: 'wait', duration_ms: 30000 }]
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
  await act(async () => state.run.resolve({ ...initial, status: 'stopped', manual_exportable: true }))
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
  await act(async () => state.run.resolve(metadata(8, 'stopped')))
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
  state.run = deferred<RunMetadataDto>()
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
  state.preflightErrors = ['CH3 unsupported']
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


test('Validate locates structured errors, preserves Last Run and clears markers after editing', async () => {
  await previousRun()
  const original = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'validate_workflow_draft') throw { message: 'Variable i is unavailable', step_id: 'out' }
    return original(command, args)
  })
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await screen.findByText('Validation failed: Variable i is unavailable')
  expect(runCalls()).toHaveLength(1)
  expect(screen.queryByText('Run failed')).toBeNull()
  const card = screen.getByRole('button', { name: /Step 1.1.1:/ })
  expect(card.getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByRole('img', { name: 'Validation warning' })).toBeTruthy()
  fireEvent.click(card)
  expect(within(screen.getByRole('region', { name: 'Properties' })).getByRole('alert').textContent).toBe('Variable i is unavailable')
  tab('Output')
  expect(snapshot().runId).toBe(7)
  tab('Workflow')
  fireEvent.change(screen.getByLabelText('Page name'), { target: { value: 'Moved' } })
  expect(screen.getByRole('button', { name: /Step 1.1.1:/ }).hasAttribute('aria-invalid')).toBe(false)
  expect(screen.queryByRole('img', { name: 'Validation warning' })).toBeNull()
  vi.mocked(invoke).mockImplementation(original)
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await screen.findByText('Valid')
  await waitFor(() => expect(runButton('Simulation').disabled).toBe(false))
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(2))
  expect(JSON.parse((runCalls()[1][1] as { templateJson: string }).templateJson).workflow.steps[0].steps[0].steps[0].page).toBe('Moved')
  await finish(8)
})

test.each(['Simulation', 'Live'])('%s blocks invalid Workflow before starting a run', async mode => {
  await mount()
  if (mode === 'Live') await selectLive()
  const original = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'validate_workflow_draft') throw { message: 'Variable i is unavailable', step_id: 'out' }
    return original(command, args)
  })
  await waitFor(() => expect(runButton(mode).disabled).toBe(false))
  fireEvent.click(runButton(mode))
  await screen.findByText('Validation failed: Variable i is unavailable')
  expect(runCalls()).toHaveLength(0)
  expect(screen.queryByText('Run failed')).toBeNull()
  expect(screen.queryByText('Live run did not start')).toBeNull()
})

test.each(['Simulation', 'Live'])('%s still presents execution errors after successful validation', async mode => {
  await mount()
  if (mode === 'Live') await selectLive()
  fireEvent.click(runButton(mode))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  await act(async () => state.run.reject('Worker could not start'))
  expect(screen.getByText(mode === 'Live' ? 'Live run did not start' : 'Run failed')).toBeTruthy()
  expect(screen.getByText('Worker could not start')).toBeTruthy()
  expect(screen.queryByText(/Validation failed:/)).toBeNull()
  expect(runButton(mode).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  expect(screen.queryByText('Worker could not start')).toBeNull()
  await screen.findByText('Valid')
  state.run = deferred<RunMetadataDto>()
  fireEvent.click(runButton(mode))
  await waitFor(() => expect(runCalls()).toHaveLength(2))
  await act(async () => state.run.reject('Another startup failure'))
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

test('the final Foreground Chart can be removed without any result rows', () => {
  const panels = addChartPanel([], 'Results', ['Voltage'])
  const onPanelsChange = vi.fn()
  render(<ChartPanelView panel={panels[0]} panels={panels} onPanelsChange={onPanelsChange}
    charts={new Map()} numericNames={['Voltage']} running={false} hasRows={false}
    canExport={false} onSavingChange={() => {}}>{null}</ChartPanelView>)
  expect(screen.getByText('Foreground')).toBeTruthy()
  expect(screen.getByText('Page: Results')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Source settings' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Remove Chart 1' }))
  expect(onPanelsChange).toHaveBeenCalledWith([])
})


test('Foreground Output Page picker identifies the selected page and keeps export scoped to it', async () => {
  state.currentDraft = structuredClone(draft)
  state.currentDraft.workflow.steps.push({
    type: 'output', id: 'other-output', name: 'Current', page: 'Meter Series',
    value: { source: 'literal', value: 5 },
  })
  await mount()
  fireEvent.click(runButton('Simulation'))
  const first = metadata(46)
  await act(async () => state.run.resolve({ ...first, pages: [
    ...first.pages,
    { ...first.pages[0], name: 'Meter Series', output_names: ['Current'], numeric_outputs: ['Current'],
      summaries: [{ name: 'Current', count: 1, min: 5, max: 5, avg: 5, std_dev: null }] },
  ] }))
  tab('Output')
  const foreground = within(screen.getByRole('region', { name: 'Foreground Output' }))
  const page = foreground.getByRole('combobox', { name: 'Output Page' }) as HTMLSelectElement
  expect([...page.options].map(option => option.value)).toEqual(['Results', 'Meter Series'])
  expect(foreground.getByText('Page 1 of 2')).toBeTruthy()
  fireEvent.change(page, { target: { value: 'Meter Series' } })
  expect(foreground.getByText('Page 2 of 2')).toBeTruthy()
  expect(foreground.getByText('Export the selected Output Page. Choose a file name and location.')).toBeTruthy()
  expect(within(foreground.getByRole('table', { name: 'Page Result Summary' }))
    .getByRole('rowheader', { name: 'Current' })).toBeTruthy()
  fireEvent.click(foreground.getByRole('button', { name: 'Export XLSX' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('export_last_run_pages', {
    runId: 46, destinationPath: 'saved.json', page: 'Meter Series', format: 'xlsx',
  }))
  fireEvent.change(foreground.getByRole('combobox', { name: 'Export Pages' }), { target: { value: 'all' } })
  expect(foreground.getByText('Export all Output Pages in one XLSX file. Choose a file name and location.')).toBeTruthy()
  fireEvent.click(foreground.getByRole('button', { name: 'Export XLSX' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('export_last_run_pages', {
    runId: 46, destinationPath: 'saved.json', page: null, format: 'xlsx',
  }))
  fireEvent.change(foreground.getByRole('combobox', { name: 'Export format' }), { target: { value: 'csv' } })
  expect(foreground.getByText('Export all Output Pages as separate CSV files. Choose a destination folder.')).toBeTruthy()
})
