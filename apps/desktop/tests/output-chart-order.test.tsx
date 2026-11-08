import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import OutputCharts, { LiveMonitors } from '../src/OutputCharts'
import { addBackgroundChartPanel, addChartPanel, chartPanelToSavedChart, savedChartsToPanels } from '../src/chartPanels'
import type { ChartPanel } from '../src/chartPanels'
import type { BackgroundConfig, OutputStep, RunPageMetadata } from '../src/workflow'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async (command: string) => {
  if (command === 'get_background_output') return { datasets: [], workers: [], rows: [], monitor: [] }
  throw new Error('Unexpected IPC: ' + command)
}) }))
vi.mock('../src/ChartPlot', () => ({ default: () => <div role="img" aria-label="Chart plot" /> }))

const backgrounds: BackgroundConfig[] = [
  { id: 'background-1', tool_instance_id: 'meter-1', live_monitor: false, limit_count: 100 },
]
const pages = ['Main', 'Aux'].map(name => ({
  name, outputs: [{ type: 'output', id: name, name: 'Voltage', page: name,
    value: { source: 'literal', value: 1 } } as OutputStep],
}))
const metadata: RunPageMetadata[] = pages.map(page => ({
  name: page.name, output_names: ['Voltage'], numeric_outputs: ['Voltage'], timestamp_outputs: [],
  row_count: 0, revision: 0, iteration_rows: false, summaries: [],
}))
const interleaved = () => {
  let panels: ChartPanel[] = []
  panels = addBackgroundChartPanel(panels, 'background-1')
  panels = addChartPanel(panels, 'Main', ['Voltage'])
  panels = addBackgroundChartPanel(panels, 'background-1')
  panels = addChartPanel(panels, 'Aux', ['Voltage'])
  return panels
}

test('Chart cards and their controls follow displayed numbers across Foreground and Background sources', () => {
  function View() {
    const [panels, setPanels] = useState(interleaved)
    return <OutputCharts runId={7} pages={pages} metadata={metadata}
      backgrounds={backgrounds} currentDraftBackgrounds={backgrounds} toolKinds={{ 'meter-1': 'meters' }}
      panels={panels} onPanelsChange={setPanels} chartData={new Map()} running={false}
      onSavingChange={() => {}} saveChartsWithTemplate={false} onSaveChartsWithTemplateChange={() => {}}
      selections={new Map()} />
  }
  render(<View />)
  const charts = within(screen.getByRole('region', { name: 'Charts' }))
  const cards = () => charts.getAllByRole('region', { name: /^Chart [0-9]+$/ })
  const sources = () => cards().map(card => within(card).getByText(/^(Foreground|Background)$/).textContent)
  expect(cards().map(card => card.getAttribute('aria-label'))).toEqual(['Chart 1', 'Chart 2', 'Chart 3', 'Chart 4'])
  expect(sources()).toEqual(['Background', 'Foreground', 'Background', 'Foreground'])
  expect(charts.getAllByRole('button', { name: 'Settings' }).length).toBe(4)

  fireEvent.click(charts.getByRole('button', { name: 'Remove Chart 2' }))
  expect(cards().map(card => card.getAttribute('aria-label'))).toEqual(['Chart 1', 'Chart 2', 'Chart 3'])
  expect(sources()).toEqual(['Background', 'Background', 'Foreground'])
  fireEvent.change(charts.getByRole('combobox', { name: 'Ground' }), { target: { value: 'foreground' } })
  fireEvent.click(charts.getByRole('button', { name: '+ Add Chart' }))
  expect(cards().map(card => card.getAttribute('aria-label'))).toEqual(['Chart 1', 'Chart 2', 'Chart 3', 'Chart 4'])
  expect(sources()).toEqual(['Background', 'Background', 'Foreground', 'Foreground'])
})

test('saved mixed-source Charts retain their order when restored', () => {
  const restored = savedChartsToPanels(interleaved().map(chartPanelToSavedChart))
  render(<OutputCharts runId={7} pages={pages} metadata={metadata}
    backgrounds={backgrounds} currentDraftBackgrounds={backgrounds} toolKinds={{ 'meter-1': 'meters' }}
    panels={restored} onPanelsChange={() => {}} chartData={new Map()} running={false}
    onSavingChange={() => {}} saveChartsWithTemplate={true} onSaveChartsWithTemplateChange={() => {}}
    selections={new Map()} />)
  const charts = within(screen.getByRole('region', { name: 'Charts' }))
  const cards = charts.getAllByRole('region', { name: /^Chart [0-9]+$/ })
  expect(cards.map(card => within(card).getByText(/^(Foreground|Background)$/).textContent))
    .toEqual(['Background', 'Foreground', 'Background', 'Foreground'])
  expect(cards.map(card => card.getAttribute('aria-label')))
    .toEqual(['Chart 1', 'Chart 2', 'Chart 3', 'Chart 4'])
})

test('Serial Live Monitor follows new RX until manually scrolled up, then resumes at the bottom', async () => {
  let rxHex = '41'
  vi.mocked(invoke).mockImplementation(async command => {
    if (command !== 'get_background_output') throw new Error('Unexpected IPC: ' + command)
    return { datasets: [], workers: [], rows: [],
      monitor: [{ timestamp_utc: '2026-11-08T00:00:00Z', rx_hex: rxHex, rx_bytes: rxHex.length / 2 }] }
  })
  const serialBackground: BackgroundConfig = {
    id: 'bg-serial', tool_instance_id: 'serial-1', live_monitor: true, limit_count: null,
  }
  const view = (running: boolean) => <LiveMonitors runId={42} backgrounds={[serialBackground]}
    toolKinds={{ 'serial-1': 'serial' }} running={running} />
  const { rerender } = render(view(false))
  const rx = await screen.findByLabelText('Serial RX bg-serial') as HTMLPreElement
  await waitFor(() => expect(rx.textContent).toBe('41'))
  Object.defineProperty(rx, 'scrollHeight', { configurable: true, value: 1200 })
  Object.defineProperty(rx, 'clientHeight', { configurable: true, value: 350 })

  rxHex = '4242'
  rerender(view(true))
  await waitFor(() => expect(rx.textContent).toBe('42 42'))
  expect(rx.scrollTop).toBe(1200)

  rx.scrollTop = 200
  fireEvent.scroll(rx)
  rxHex = '4343'
  rerender(view(false))
  rerender(view(true))
  await waitFor(() => expect(rx.textContent).toBe('43 43'))
  expect(rx.scrollTop).toBe(200)

  rx.scrollTop = 850
  fireEvent.scroll(rx)
  rxHex = '4444'
  rerender(view(false))
  rerender(view(true))
  await waitFor(() => expect(rx.textContent).toBe('44 44'))
  expect(rx.scrollTop).toBe(1200)

  rx.scrollTop = 200
  fireEvent.scroll(rx)
  fireEvent.change(screen.getByRole('combobox', { name: 'Serial Live Monitor Display bg-serial' }),
    { target: { value: 'text' } })
  expect(rx.textContent).toBe('DD')
  expect(rx.scrollTop).toBe(1200)
})
