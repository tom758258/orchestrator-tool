import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import BackgroundOutput from '../src/BackgroundOutput'
import { DEFAULT_NUMERIC_DISPLAY_FORMAT, type NumericDisplayFormat } from '../src/outputTime'
import type { BackgroundOutputData } from '../src/backgroundChartData'
import type { BackgroundConfig } from '../src/workflow'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

const backgrounds = [
  { id: 'bg-meter', tool_instance_id: 'meter-1', live_monitor: false, limit_count: 101 },
  { id: 'bg-scope', tool_instance_id: 'scope-1', live_monitor: false, limit_count: 1 },
  { id: 'bg-serial', tool_instance_id: 'serial-1', live_monitor: false, limit_count: 1 },
] as BackgroundConfig[]

const datasets: BackgroundOutputData['datasets'] = [
  { id: 'meter-1', background_id: 'bg-meter', worker_run_id: 'w1', status: 'completed', quality: 'unknown',
    row_count: 101, min: 1.234, max: 3.234, avg: 2.234, csv_path: null, error: null, tool_kind: 'meters' },
  { id: 'scope-1', background_id: 'bg-scope', worker_run_id: 'w2', status: 'completed', quality: 'incomplete',
    row_count: 1, min: null, max: null, avg: null, csv_path: null, error: null, tool_kind: 'scopes',
    fields: ['v1'], field_stats: { v1: { valid: 0, invalid: 1, min: null, max: null, avg: null } } },
  { id: 'serial-1', background_id: 'bg-serial', worker_run_id: 'w3', status: 'completed', quality: 'unknown',
    row_count: 1, min: null, max: null, avg: null, csv_path: null, error: null, tool_kind: 'serial', rx_bytes: 2 },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(open).mockResolvedValue('exports')
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'export_background_datasets') return ['export.xlsx']
    if (command !== 'get_background_output') throw new Error('Unexpected IPC: ' + command)
    const request = args as { backgroundId: string; datasetId: string | null; offset: number; limit: number }
    const id = request.datasetId
    const rows = id === 'meter-1'
      ? [{ timestamp_utc: '2026-11-08T00:00:00Z', elapsed_s: 1, captured: request.offset + 1, value: 2.234, unit: 'V' }]
      : id === 'scope-1'
        ? [{ timestamp_utc: '2026-11-08T00:00:01Z', elapsed_s: 2, captured: 1,
          values: { v1: { value: null, unit: 'V', valid: false, reason: 'Invalid measurement' } } }]
        : id === 'serial-1'
          ? [{ timestamp_utc: '2026-11-08T00:00:02Z', elapsed_s: 3, captured: 1, rx_hex: '4142', rx_bytes: 2 }]
          : []
    return { datasets, workers: backgrounds.map(background => ({ id: background.id, state: 'off',
      stream_state: 'ended', live_monitor: false, error: null })), rows, monitor: [] }
  })
})

function mount() {
  function Test() {
    const [format, setFormat] = useState<NumericDisplayFormat>(DEFAULT_NUMERIC_DISPLAY_FORMAT)
    return <BackgroundOutput runId={5} backgrounds={backgrounds} running={false}
      numericFormat={format} onNumericFormatChange={setFormat} />
  }
  render(<Test />)
}

test('Background Meters use the shared numeric summary and table style without changing 100-row paging', async () => {
  mount()
  const summary = await screen.findByRole('table', { name: 'Background Result Summary' })
  expect(summary.classList.contains('output-table')).toBe(true)
  expect(within(summary).getByRole('rowheader', { name: 'Value' })).toBeTruthy()
  const output = await screen.findByRole('table', { name: 'Background Output Data' })
  expect(output.classList.contains('output-table')).toBe(true)
  expect(await within(output).findByText('2.234')).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: 'Background Number display' }), { target: { value: 'fixed' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Background Decimal places' }), { target: { value: '1' } })
  expect(within(output).getByText('2.2')).toBeTruthy()
  const columns = screen.getByText('Columns ▾')
  fireEvent.click(columns)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Max' }))
  expect(within(summary).queryByRole('columnheader', { name: 'Max' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_background_output', {
    runId: 5, backgroundId: 'bg-meter', datasetId: 'meter-1', offset: 100, limit: 100,
  }))
  expect(screen.getByText('Page 2 of 2')).toBeTruthy()
})

test('Background Source switches preserve Scopes invalid readings and Serial RX statistics', async () => {
  mount()
  await screen.findByRole('table', { name: 'Background Result Summary' })
  const source = screen.getByRole('combobox', { name: 'Background' })
  fireEvent.change(source, { target: { value: 'bg-scope' } })
  await screen.findByRole('rowheader', { name: 'v1' })
  const scopeSummary = screen.getByRole('table', { name: 'Background Result Summary' })
  expect(within(scopeSummary).getByRole('columnheader', { name: 'Invalid' })).toBeTruthy()
  expect(screen.getByText(/Quality: incomplete/)).toBeTruthy()
  expect(await screen.findByTitle('Invalid measurement')).toBeTruthy()
  fireEvent.change(source, { target: { value: 'bg-serial' } })
  await waitFor(() => expect(screen.getByRole('rowheader', { name: 'Captured bytes' })).toBeTruthy())
  const serialSummary = screen.getByRole('table', { name: 'Background Result Summary' })
  expect(within(serialSummary).getByRole('rowheader', { name: 'RX events' })).toBeTruthy()
  expect(within(serialSummary).getByRole('cell', { name: '2' })).toBeTruthy()
  expect(screen.queryByRole('combobox', { name: 'Background Number display' })).toBeNull()
})
