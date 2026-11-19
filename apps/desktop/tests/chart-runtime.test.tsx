import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import ChartSettings from '../src/ChartSettings'
import ResultChart from '../src/ResultChart'
import { addChartPanel } from '../src/chartPanels'
import { createPageChartData } from '../src/chartData'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})

test('Chart Settings blocks a running non-Line type change in the UI and Apply', () => {
  const panel = { ...addChartPanel([], 'A', ['V'])[0], type: 'scatter' as const, scatterXOutput: 'V' }
  const onApply = vi.fn()
  render(<ChartSettings panel={panel} numericNames={['V']} outputs={[]} running hasRows={false}
    onApply={onApply} onClose={vi.fn()} />)
  const chartType = screen.getByRole('combobox', { name: 'Chart type' })
  expect((chartType.querySelector('option[value="histogram"]') as HTMLOptionElement).disabled).toBe(true)
  fireEvent.change(chartType, { target: { value: 'histogram' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(onApply).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(panel.type).toBe('scatter')
})

test('Chart Settings treats uncommitted Elapsed X bounds as raw seconds', () => {
  const panel = { ...addChartPanel([], 'A', ['V'])[0], type: 'scatter' as const, scatterXOutput: 'V' }
  const onApply = vi.fn()
  render(<ChartSettings panel={panel} numericNames={['V', 'Elapsed']}
    scatterXNames={['V', 'Elapsed']} outputs={[
      { type: 'output', id: 'elapsed', name: 'Elapsed', page: 'A',
        value: { source: 'elapsed-time' }, time_format: { kind: 'elapsed-time', format: 'days-decimal' } },
    ]} running={false} hasRows onApply={onApply} onClose={vi.fn()} />)
  fireEvent.change(screen.getByRole('combobox', { name: 'X source' }), { target: { value: 'Elapsed' } })
  fireEvent.click(screen.getByRole('tab', { name: 'Axes' }))
  expect(screen.getByText(/X-axis Minimum, Maximum, and Major unit use raw seconds/)).toBeTruthy()
  const axis = within(screen.getByRole('group', { name: 'X Axis' }))
  fireEvent.change(axis.getByRole('textbox', { name: 'Minimum' }), { target: { value: '2.857' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
    xAxis: expect.objectContaining({ min: 2.857 }),
  }))
})

const name = ['V']
const slots = new Map<number, HTMLElement>()
const onPanelsChange = vi.fn()
const onSavingChange = vi.fn()
const panel = addChartPanel([], 'A', name)[0]
function chartView(runId: number, rowCount: number, revision: number,
  cache: Map<string, ReturnType<typeof createPageChartData>>, running = true) {
  return <ResultChart runId={runId} revision={revision} rowCount={rowCount} page="A"
    numericNames={name} timestampNames={[]} outputs={[]} panels={[panel]}
    onPanelsChange={onPanelsChange} onSavingChange={onSavingChange}
    chartData={cache} portalSlots={slots} running={running} />
}

test('live Line loads only newly committed rows through the actual ResultChart', async () => {
  const cache = new Map<string, ReturnType<typeof createPageChartData>>()
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    expect(command).toBe('get_last_run_chart_series')
    const request = args as { runId: number; page: string; outputs: string[]; startRow: number }
    return { run_id: request.runId, page: request.page, start_row: request.startRow,
      series: { V: request.startRow === 0 ? [11, 12] : [13] } }
  })
  const { rerender } = render(chartView(1, 2, 1, cache))
  await waitFor(() => expect(cache.get('A')?.length('V')).toBe(2))
  rerender(chartView(1, 3, 2, cache))
  await waitFor(() => expect(cache.get('A')?.length('V')).toBe(3))
  expect(vi.mocked(invoke).mock.calls.map(([, args]) => (args as { startRow: number }).startRow)).toEqual([0, 2])
  expect([...cache.get('A')!.getSeries('V')]).toEqual([11, 12, 13])
})

test('stale Chart replies cannot populate the next run cache', async () => {
  let finishOld!: (value: unknown) => void
  const oldCache = new Map<string, ReturnType<typeof createPageChartData>>()
  const nextCache = new Map<string, ReturnType<typeof createPageChartData>>()
  vi.mocked(invoke).mockImplementation((command, args) => {
    expect(command).toBe('get_last_run_chart_series')
    const request = args as { runId: number; page: string; startRow: number }
    if (request.runId === 1) return new Promise(resolve => { finishOld = resolve })
    return Promise.resolve({ run_id: 2, page: 'A', start_row: 0, series: { V: [22] } })
  })
  const { rerender } = render(chartView(1, 1, 1, oldCache))
  await waitFor(() => expect(finishOld).toBeTypeOf('function'))
  rerender(chartView(2, 1, 1, nextCache))
  await waitFor(() => expect(nextCache.get('A')?.length('V')).toBe(1))
  await act(async () => finishOld({ run_id: 1, page: 'A', start_row: 0, series: { V: [11] } }))
  expect(oldCache.get('A')?.length('V') ?? 0).toBe(0)
  expect([...nextCache.get('A')!.getSeries('V')]).toEqual([22])
})
