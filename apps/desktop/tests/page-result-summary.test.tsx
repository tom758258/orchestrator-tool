import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import PageResultSummary from '../src/PageResultSummary'
import VirtualizedOutputTable from '../src/VirtualizedOutputTable'
import { DEFAULT_NUMERIC_DISPLAY_FORMAT, formatOutputValue, type NumericDisplayFormat } from '../src/outputTime'
import type { NumericSummary, OutputStep, ResultRowDto } from '../src/workflow'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const numericFormats: NumericDisplayFormat[] = [DEFAULT_NUMERIC_DISPLAY_FORMAT,
  { mode: 'fixed', decimalPlaces: 0 }, { mode: 'fixed', decimalPlaces: 2 },
  { mode: 'fixed', decimalPlaces: 12 }, { mode: 'raw', decimalPlaces: 2 }]

test('summary column selection displays supplied statistics, including missing and zero variance', () => {
  const summaries: NumericSummary[] = [
    { name: 'V', count: 4, min: 1, max: 4, avg: 2.5, std_dev: 1.25 },
    { name: 'Single', count: 1, min: 7, max: 7, avg: 7, std_dev: null },
    { name: 'Constant', count: 3, min: 7, max: 7, avg: 7, std_dev: 0 },
  ]
  const view = render(<PageResultSummary summaries={summaries} outputs={[]} numericFormat={DEFAULT_NUMERIC_DISPLAY_FORMAT} />)
  const table = screen.getByRole('table', { name: 'Page Result Summary' })
  expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent))
    .toEqual(['Output', 'Count', 'Min', 'Max', 'Avg'])
  fireEvent.click(screen.getByText('Columns ▾'))
  for (const name of ['Range (Max − Min)', 'Std Dev (σ)', '2σ', '3σ']) fireEvent.click(screen.getByRole('checkbox', { name }))
  expect(within(table).getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell').map(cell => cell.textContent)))
    .toEqual([['4', '1', '4', '2.5', '3', '1.25', '2.5', '3.75'],
      ['1', '7', '7', '7', '0', '—', '—', '—'], ['3', '7', '7', '7', '0', '0', '0', '0']])
  fireEvent.click(screen.getByRole('checkbox', { name: 'Count' }))
  expect(within(table).queryByRole('columnheader', { name: 'Count' })).toBeNull()
  view.rerender(<PageResultSummary summaries={[]} outputs={[]} numericFormat={DEFAULT_NUMERIC_DISPLAY_FORMAT} />)
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.getByText('No numeric outputs to summarize.')).toBeTruthy()
})

test('summary formatting follows output snapshots and numeric settings without mutating statistics', () => {
  const formats = ['seconds', 'minutes-seconds', 'hours-minutes-seconds', 'days-decimal'] as const
  const outputs: OutputStep[] = formats.map(format => ({ type: 'output', id: format, name: format, page: 'Results',
    value: { source: 'elapsed-time' }, time_format: { kind: 'elapsed-time', format } }))
  outputs.push({ type: 'output', id: 'V', name: 'V', page: 'Results', value: { source: 'literal', value: 1 } })
  const summary = { count: 7, min: 10.600000000000001, max: 90061.123, avg: 45031.990123456, std_dev: 60.123456789 }
  const summaries = outputs.map(output => Object.freeze({ name: output.name, ...summary }))
  const before = structuredClone({ summaries, outputs })
  const view = render(<PageResultSummary summaries={summaries} outputs={outputs} numericFormat={numericFormats[0]} />)
  fireEvent.click(screen.getByText('Columns ▾'))
  for (const name of ['Range (Max − Min)', 'Std Dev (σ)', '2σ', '3σ']) fireEvent.click(screen.getByRole('checkbox', { name }))
  const values = [summary.min, summary.max, summary.avg, summary.max - summary.min,
    summary.std_dev, summary.std_dev * 2, summary.std_dev * 3]
  for (const numericFormat of numericFormats) {
    view.rerender(<PageResultSummary summaries={summaries} outputs={outputs} numericFormat={numericFormat} />)
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    rows.forEach((row, index) => expect(within(row).getAllByRole('cell').map(cell => cell.textContent))
      .toEqual(['7', ...values.map(value => formatOutputValue(outputs[index], value, numericFormat))]))
  }
  expect({ summaries, outputs }).toEqual(before)
})

test('virtualized output loads a bounded window and reformats it without fetching or changing raw rows', async () => {
  const outputs: OutputStep[] = [
    { type: 'output', id: 'value', name: 'value', page: 'Results', value: { source: 'literal', value: 1 } },
    { type: 'output', id: 'elapsed', name: 'elapsed', page: 'Results', value: { source: 'elapsed-time' }, time_format: { kind: 'elapsed-time', format: 'seconds' } },
    { type: 'output', id: 'timestamp', name: 'timestamp', page: 'Results', value: { source: 'timestamp' }, time_format: { kind: 'timestamp', include_date: false, include_utc_offset: true } },
    ...['string', 'bool', 'null', 'object', 'array'].map(name => ({ type: 'output' as const, id: name, name, page: 'Results', value: { source: 'literal' as const, value: 1 } })),
  ]
  const values = [10.600000000000001, 2.857, '2026-10-12T23:24:10.123+08:00', '10.600000000000001', true, null,
    { value: 10.600000000000001 }, [10.600000000000001]]
  const rows: ResultRowDto[] = [{ page: 'Results', for_iteration: null, while_iteration: null,
    outputs: outputs.map((output, index) => ({ name: output.name, value: values[index] })) }]
  const before = structuredClone(rows)
  vi.mocked(invoke).mockResolvedValue({ run_id: 1, page: 'Results', revision: 1, total_rows: 1, offset: 0, rows })
  const props = { runId: 1, page: 'Results', revision: 1, rowCount: 1, iterationRows: true, outputs }
  const view = render(<VirtualizedOutputTable {...props} numericFormat={numericFormats[0]} />)
  await screen.findByTitle('10.6')
  expect(invoke).toHaveBeenCalledWith('get_last_run_page_rows', { runId: 1, page: 'Results', offset: 0, limit: 1 })
  for (const numericFormat of numericFormats) {
    view.rerender(<VirtualizedOutputTable {...props} numericFormat={numericFormat} />)
    const cells = within(screen.getByRole('region', { name: 'Last Run outputs' })).getAllByRole('cell')
    expect(cells.map(cell => cell.textContent)).toEqual(['1', ...values.map((value, index) => formatOutputValue(outputs[index], value, numericFormat))])
  }
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
  expect(rows).toEqual(before)
})
