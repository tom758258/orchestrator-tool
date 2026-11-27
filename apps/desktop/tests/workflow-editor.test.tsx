import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { confirm, open, save } from '@tauri-apps/plugin-dialog'
import type { ComponentProps } from 'react'
import App from '../src/App'
import { I18nProvider } from '../src/i18n/I18nProvider'
import type ResultChart from '../src/ResultChart'
import type { ForStep } from '../src/workflow'
import type { WorkflowDraft } from '../src/templateDraft'
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

const { state, draft, backgroundDraft, tab, runButton, runCalls, mount, finish, savedDraft } = createAppRunFixture()

test('Steps palette selects a type before inserting, keeps action fixed, and clears selection afterward', async () => {
  state.currentDraft = { name: 'Target card', tool_instances: [], workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [
    { type: 'if', id: 'if-2', left: { source: 'literal', value: 1 }, operator: 'equal',
      right: { source: 'literal', value: 1 },
      then_steps: [{ type: 'wait', id: 'then-wait', duration_ms: 1 }],
      else_steps: [{ type: 'wait', id: 'else-wait', duration_ms: 1 }] },
    { type: 'for', id: 'for-1', variable: 'i', range: { start: '1', stop: '2', step: '1' }, steps: [] },
    { type: 'while', id: 'while-1', left: { source: 'literal', value: 0 }, operator: 'less-than',
      right: { source: 'literal', value: 1 }, max_iterations: 1, steps: [] },
  ] } }
  await mount()
  const target = screen.getByRole('status', { name: 'Step insertion target' })
  const categories = screen.getByRole('region', { name: 'Step categories' })
  const add = screen.getByRole('button', { name: 'Add Step' }) as HTMLButtonElement
  const paletteButton = (name: string) => within(categories).getByRole('button', { name })
  const card = (id: string) => screen.getByRole('button', { name: new RegExp(`Step .*?, ${id}$`) })
  const expectTarget = (label: string) => expect(target.textContent).toContain(label)
  expect(within(target).getByText('ADDING STEP TO')).toBeTruthy()
  expect(target.textContent).not.toContain('📍')
  expectTarget('Root Workflow')
  expect(add.disabled).toBe(true)
  expect(screen.getByText('Selected Step:')).toHaveProperty('textContent', 'Selected Step: None')
  expect(Boolean(add.compareDocumentPosition(categories) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)

  fireEvent.click(card('if-2'))
  expectTarget('IF 2 → THEN')
  fireEvent.change(screen.getByRole('combobox', { name: 'If branch for new Steps' }), { target: { value: 'else' } })
  expectTarget('IF 2 → ELSE')
  fireEvent.click(card('then-wait'))
  expectTarget('IF 2 → THEN')
  fireEvent.click(card('else-wait'))
  expectTarget('IF 2 → ELSE')
  fireEvent.click(card('for-1'))
  expectTarget('FOR 1')
  fireEvent.click(card('while-1'))
  expectTarget('WHILE 1')

  fireEvent.click(card('if-2'))
  expectTarget('IF 2 → ELSE')
  fireEvent.click(paletteButton('Wait'))
  expect(paletteButton('Wait').getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByText('Selected Step:').textContent).toContain('Wait')
  expect(add.disabled).toBe(false)
  expect(screen.queryByRole('button', { name: /Step .*?, wait-1$/ })).toBeNull()
  fireEvent.click(add)
  expect(within(screen.getByRole('list', { name: 'ELSE of if-2' }))
    .getByRole('button', { name: /Step .*?, wait-1$/ })).toBeTruthy()
  expectTarget('IF 2 → ELSE')
  expect(add.disabled).toBe(true)
  expect(paletteButton('Wait').getAttribute('aria-pressed')).toBe('false')

  fireEvent.click(paletteButton('Wait'))
  fireEvent.click(screen.getByRole('button', { name: 'Set Target to Root' }))
  expectTarget('Root Workflow')
  expect(add.disabled).toBe(false)
  fireEvent.click(add)
  expect(within(screen.getByRole('list', { name: 'Root steps' }))
    .getByRole('button', { name: /Step .*?, wait-2$/ })).toBeTruthy()
  expect(add.disabled).toBe(true)

  fireEvent.click(paletteButton('Wait'))
  fireEvent.click(screen.getByRole('button', { name: 'New Template' }))
  await waitFor(() => expect(screen.getByText('Selected Step:').textContent).toBe('Selected Step: None'))
  fireEvent.click(paletteButton('Wait'))
  vi.mocked(open).mockResolvedValueOnce('template.json')
  fireEvent.click(screen.getByRole('button', { name: 'Open Template' }))
  await screen.findByText('Template loaded.')
  expect(screen.getByText('Selected Step:').textContent).toBe('Selected Step: None')
  expect(add.disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Steps' }))
  expect(screen.queryByRole('status', { name: 'Step insertion target' })).toBeNull()
})

test('Dragging palette steps inserts exactly at the Root and nested drop target without replacing Add Step', async () => {
  state.currentDraft = { ...structuredClone(draft), workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [
    { type: 'if', id: 'if-2', left: { source: 'literal', value: 1 }, operator: 'equal',
      right: { source: 'literal', value: 1 }, then_steps: [], else_steps: [] },
    { type: 'for', id: 'for-1', variable: 'i', range: { start: '1', stop: '2', step: '1' }, steps: [] },
    { type: 'while', id: 'while-1', left: { source: 'literal', value: 0 },
      operator: 'less-than', right: { source: 'literal', value: 1 }, max_iterations: 2, steps: [] },
    { type: 'wait', id: 'anchor', duration_ms: 1 },
  ] } }
  await mount()
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number
    constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1 }
  })
  const categories = screen.getByRole('region', { name: 'Step categories' })
  let destination: Element | null = null
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => destination })
  const drag = (name: string, target: Element | null, y = 50) => {
    const button = within(categories).getByRole('button', { name })
    Object.assign(button, { setPointerCapture: vi.fn(), hasPointerCapture: () => false, releasePointerCapture: vi.fn() })
    destination = target
    fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(button, { pointerId: 1, clientX: 20, clientY: y })
    fireEvent.pointerUp(button, { pointerId: 1, clientX: 20, clientY: y })
    fireEvent.click(button, { detail: 1 })
  }
  const root = screen.getByRole('list', { name: 'Root steps' })
  const card = (id: string) => screen.getByRole('button', { name: new RegExp(`Step .*?, ${id}$`) })
  const ids = (list: HTMLElement) => within(list).queryAllByRole('button', { name: /^Step / })
    .filter(button => button.closest('ol') === list).map(button => button.getAttribute('aria-label')!.split(', ').at(-1))
  vi.spyOn(card('anchor').parentElement!, 'getBoundingClientRect')
    .mockReturnValue({ top: 0, height: 100 } as DOMRect)
  fireEvent.click(card('anchor'))
  drag('Wait', card('anchor'), 25)
  expect(ids(root)).toEqual(['if-2', 'for-1', 'while-1', 'wait-1', 'anchor'])
  expect(card('wait-1').getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByText('Selected Step:').textContent).toContain('None')
  drag('Assert', card('anchor'), 75)
  expect(ids(root)).toEqual(['if-2', 'for-1', 'while-1', 'wait-1', 'anchor', 'assert-1'])
  drag('Wait', screen.getByRole('list', { name: 'THEN of if-2' }))
  expect(ids(screen.getByRole('list', { name: 'THEN of if-2' }))).toEqual(['wait-2'])
  drag('Wait', screen.getByRole('list', { name: 'ELSE of if-2' }))
  expect(ids(screen.getByRole('list', { name: 'ELSE of if-2' }))).toEqual(['wait-3'])
  drag('Wait', screen.getByRole('list', { name: 'Body of for-1' }))
  drag('Wait', screen.getByRole('list', { name: 'Body of while-1' }))
  expect(ids(screen.getByRole('list', { name: 'Body of for-1' }))).toEqual(['wait-4'])
  expect(ids(screen.getByRole('list', { name: 'Body of while-1' }))).toEqual(['wait-5'])
  const beforeCancel = root.textContent
  drag('Wait', document.body)
  expect(root.textContent).toBe(beforeCancel)
  fireEvent.click(within(categories).getByRole('button', { name: 'Wait' }))
  expect(screen.getByText('Selected Step:').textContent).toContain('Wait')
  fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))
  expect(ids(screen.getByRole('list', { name: 'Body of while-1' }))).toEqual(['wait-5', 'wait-6'])
  expect(screen.getByText('Selected Step:').textContent).toContain('None')
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'validate_workflow_draft')).toHaveLength(0)

  // A drop on the list gap must land between cards, not silently append to Root.
  Array.from(root.children).forEach((row, index) => {
    const main = row.querySelector('.sequence-step-main')
    if (main) vi.spyOn(main, 'getBoundingClientRect').mockReturnValue({ top: index * 100, height: 80 } as DOMRect)
  })
  drag('Wait', root, 190)
  expect(ids(root)).toEqual(['if-2', 'for-1', 'wait-7', 'while-1', 'wait-1', 'anchor', 'assert-1'])
  expect(card('wait-7').getAttribute('aria-pressed')).toBe('true')
  expect((within(screen.getByRole('region', { name: 'Properties' }))
    .getByRole('spinbutton', { name: 'Duration (ms)' }) as HTMLInputElement).value).toBe('500')
})


test('Nested end zones show their level and drop into the matching FOR body', async () => {
  let nested: ForStep = { type: 'for', id: 'depth-4', variable: 'd',
    range: { start: '1', stop: '2', step: '1' },
    steps: [{ type: 'wait', id: 'tail', duration_ms: 1 }] }
  for (let level = 3; level >= 1; level--) {
    nested = { type: 'for', id: `depth-${level}`, variable: `d${level}`,
      range: { start: '1', stop: '2', step: '1' }, steps: [nested] }
  }
  state.currentDraft = { ...structuredClone(draft), workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [nested] } }
  await mount()
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number
    constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1 }
  })
  let destination: Element | null = null
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => destination })
  const root = screen.getByRole('list', { name: 'Root steps' })
  const body4 = screen.getByRole('list', { name: 'Body of depth-4' })
  const body3 = screen.getByRole('list', { name: 'Body of depth-3' })
  const palette = within(screen.getByRole('region', { name: 'Step categories' }))
    .getByRole('button', { name: 'Wait' })
  Object.assign(palette, { setPointerCapture: vi.fn(), hasPointerCapture: () => false, releasePointerCapture: vi.fn() })
  expect(screen.queryByText('▸ FOR 1.1.1.1 (depth-4) · Body · End')).toBeNull()
  const start = (handle: HTMLElement) => {
    destination = root
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 50 })
  }
  const dropAt = (handle: HTMLElement, zone: Element) => {
    destination = zone
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 50 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 20, clientY: 50 })
  }

  start(palette)
  const end4 = within(body4).getByText('▸ FOR 1.1.1.1 (depth-4) · Body · End').closest('li')!
  destination = end4
  fireEvent.pointerMove(palette, { pointerId: 1, clientX: 20, clientY: 50 })
  expect(body4.classList.contains('sequence-drop-container-active')).toBe(true)
  expect(body3.classList.contains('sequence-drop-container-active')).toBe(false)
  expect(end4.classList.contains('sequence-drop-zone-active')).toBe(true)
  fireEvent.pointerUp(palette, { pointerId: 1, clientX: 20, clientY: 50 })
  fireEvent.click(palette, { detail: 1 })
  expect(within(body4).getByRole('button', { name: /Step .*?, wait-1$/ })).toBeTruthy()
  expect(screen.queryByText('▸ FOR 1.1.1 (depth-3) · Body · End')).toBeNull()

  start(palette)
  dropAt(palette, within(body3).getByText('▸ FOR 1.1.1 (depth-3) · Body · End').closest('li')!)
  fireEvent.click(palette, { detail: 1 })
  expect(within(body3).getByRole('button', { name: /Step .*?, wait-2$/ })).toBeTruthy()
  expect(within(body4).queryByRole('button', { name: /Step .*?, wait-2$/ })).toBeNull()

  const handle = screen.getByRole('button', { name: 'Drag wait-1 to reorder' })
  expect(within(handle).getByText('Drag')).toBeTruthy()
  expect(handle.querySelector('svg')).toBeTruthy()
  Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => false, releasePointerCapture: vi.fn() })
  start(handle)
  destination = within(body3).getByText('▸ FOR 1.1.1 (depth-3) · Body · End').closest('li')
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 50 })
  expect(body3.classList.contains('sequence-drop-container-active')).toBe(true)
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 20, clientY: 50 })
  expect(within(body3).getByRole('button', { name: /Step .*?, wait-1$/ })).toBeTruthy()
  expect(within(body4).queryByRole('button', { name: /Step .*?, wait-1$/ })).toBeNull()
})

test('Palette control drag rejects a ninth nested level without showing an insertion indicator', async () => {
  let nested: ForStep = { type: 'for', id: 'deep-8', variable: 'i',
    range: { start: '1', stop: '2', step: '1' }, steps: [] }
  for (let level = 7; level >= 1; level--) {
    nested = { type: 'for', id: `deep-${level}`, variable: 'i',
      range: { start: '1', stop: '2', step: '1' }, steps: [nested] }
  }
  state.currentDraft = { ...structuredClone(draft), workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [nested] } }
  await mount()
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number
    constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1 }
  })
  const button = within(screen.getByRole('region', { name: 'Step categories' }))
    .getByRole('button', { name: 'For' })
  Object.assign(button, { setPointerCapture: vi.fn(), hasPointerCapture: () => false, releasePointerCapture: vi.fn() })
  const body = screen.getByRole('list', { name: 'Body of deep-8' })
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => body })
  fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
  fireEvent.pointerMove(button, { pointerId: 1, clientX: 20, clientY: 50 })
  expect(body.classList.contains('sequence-drop-end')).toBe(false)
  expect(within(body).queryByText(/▸ .*deep-8.*End/)).toBeNull()
  fireEvent.pointerUp(button, { pointerId: 1, clientX: 20, clientY: 50 })
  expect(within(body).queryAllByRole('button', { name: /^Step / })).toHaveLength(0)
  expect(screen.queryByRole('button', { name: /Step .*?, for-1$/ })).toBeNull()
})

test('Palette drag into an empty Workflow, cancellation and busy state leave no partial step', async () => {
  state.currentDraft = { ...structuredClone(draft), workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [] } }
  await mount()
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number
    constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1 }
  })
  const button = within(screen.getByRole('region', { name: 'Step categories' }))
    .getByRole('button', { name: 'Wait' })
  Object.assign(button, { setPointerCapture: vi.fn(), hasPointerCapture: () => false, releasePointerCapture: vi.fn() })
  let destination: Element | null = null
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => destination })
  const pointer = (y: number) =>
    fireEvent.pointerMove(button, { pointerId: 1, clientX: 20, clientY: y })
  destination = document.body
  fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
  pointer(50)
  expect(screen.getByText('▸ Root Workflow · End')).toBeTruthy()
  fireEvent.pointerCancel(button, { pointerId: 1, clientX: 20, clientY: 50 })
  expect(screen.queryByText('▸ Root Workflow · End')).toBeNull()
  expect(screen.queryByRole('button', { name: /Step .*?, wait-1$/ })).toBeNull()
  destination = screen.getByText('Create your first workflow')
  fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
  pointer(50)
  fireEvent.pointerUp(button, { pointerId: 1, clientX: 20, clientY: 50 })
  expect(screen.getByRole('button', { name: /Step .*?, wait-1$/ })).toBeTruthy()
  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  expect((button as HTMLButtonElement).disabled).toBe(true)
  fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
  pointer(50)
  fireEvent.pointerUp(button, { pointerId: 1, clientX: 20, clientY: 50 })
  expect(screen.queryByRole('button', { name: /Step .*?, wait-2$/ })).toBeNull()
  await finish(8)
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
  const number = screen.getByRole('spinbutton', { name: 'Value' })
  // File/URL drops must not navigate the native WebView away from the draft;
  // editable text keeps native drop behavior, but numeric fields must not
  // accept browser-filtered text as a different valid number.
  for (const dispatch of [fireEvent.dragOver, fireEvent.drop]) {
    const files = { types: ['Files'], dropEffect: 'copy' }
    expect(dispatch(page, { dataTransfer: files })).toBe(false)
    expect(dispatch(panel, { dataTransfer: { types: ['Files'] } })).toBe(false)
    expect(dispatch(panel, { dataTransfer: { types: ['text/uri-list'] } })).toBe(false)
    expect(dispatch(page, { dataTransfer: { types: ['text/plain'] } })).toBe(true)
    expect(dispatch(number, { dataTransfer: { types: ['text/plain'] } })).toBe(false)
    expect(dispatch(number, { dataTransfer: { types: ['text/uri-list', 'text/plain'] } })).toBe(false)
  }
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
  const dragDraft: WorkflowDraft = { ...draft, workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [...draft.workflow.steps, a, whileStep, b] } }
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
    ...draft, workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [
      { ...outer, steps: [{ ...inner, steps: [] }] },
      { ...whileStep, steps: [inner.steps[0]] }, a, b,
    ] },
  })
  expect((screen.getByRole('button', { name: 'Drag out to reorder' }) as HTMLButtonElement).disabled).toBe(true)
  await finish(8)
})


test('Sequence controls collapse nested FOR and WHILE without losing selection or changing the template', async () => {
  await mount()
  const sequence = screen.getByRole('region', { name: 'Sequence' })
  const card = (id: string) => screen.getByRole('button', { name: new RegExp(`Step .*?, ${id}$`) })
  expect(card('out')).toBeTruthy()
  fireEvent.click(card('out'))
  fireEvent.click(within(sequence).getByRole('button', { name: 'Collapse FOR outer' }))
  expect(screen.queryByRole('button', { name: /Step .*?, inner$/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /Step .*?, out$/ })).toBeNull()
  expect(within(sequence).getByText('Selected Step inside')).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'Properties' })).getByLabelText('Page name')).toBeTruthy()
  expect(within(sequence).getByText('2 nested Steps')).toBeTruthy()
  expect(within(sequence).getByRole('button', { name: 'Drag outer to reorder' })).toBeTruthy()
  fireEvent.click(within(sequence).getByRole('button', { name: 'Expand FOR outer' }))
  fireEvent.click(within(sequence).getByRole('button', { name: 'Collapse FOR inner' }))
  expect(screen.queryByRole('button', { name: /Step .*?, out$/ })).toBeNull()
  fireEvent.click(within(sequence).getByRole('button', { name: 'Expand All' }))
  expect(card('out')).toBeTruthy()
  fireEvent.click(within(sequence).getByRole('button', { name: 'Collapse All' }))
  expect(screen.queryByRole('button', { name: /Step .*?, inner$/ })).toBeNull()
  fireEvent.click(within(sequence).getByRole('button', { name: 'Expand All' }))
  expect(card('out')).toBeTruthy()
  expect((await savedDraft()).workflow.steps).toEqual(state.currentDraft.workflow.steps)
})

test('Sequence IF supports independent THEN/ELSE collapse and Add Step reveals its target', async () => {
  state.currentDraft = { name: 'IF collapse', tool_instances: [], workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [
    { type: 'if', id: 'if-1', left: { source: 'literal', value: 1 }, operator: 'equal',
      right: { source: 'literal', value: 1 },
      then_steps: [{ type: 'wait', id: 'then-wait', duration_ms: 1 }],
      else_steps: [{ type: 'wait', id: 'else-wait', duration_ms: 1 }] },
    { type: 'wait', id: 'after-if', duration_ms: 1 },
  ] } }
  await mount()
  const sequence = screen.getByRole('region', { name: 'Sequence' })
  const button = (name: string) => within(sequence).getByRole('button', { name })
  expect(within(sequence).getByText('THEN (1 Steps)')).toBeTruthy()
  expect(within(sequence).getByText('ELSE (1 Steps)')).toBeTruthy()
  fireEvent.click(button('Collapse THEN of if-1'))
  expect(screen.queryByRole('button', { name: /Step .*?, then-wait$/ })).toBeNull()
  expect(screen.getByRole('button', { name: /Step .*?, else-wait$/ })).toBeTruthy()
  fireEvent.click(button('Collapse ELSE of if-1'))
  expect(screen.queryByRole('button', { name: /Step .*?, else-wait$/ })).toBeNull()
  fireEvent.click(button('Collapse IF if-1'))
  expect(within(sequence).getByText('THEN 1 · ELSE 1')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Expand THEN of if-1' })).toBeNull()
  expect(screen.getByRole('button', { name: /Step .*?, after-if$/ })).toBeTruthy()
  fireEvent.click(button('Expand IF if-1'))
  expect(button('Expand THEN of if-1')).toBeTruthy()
  expect(button('Expand ELSE of if-1')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: /Step .*?, if-1$/ }))
  fireEvent.click(within(screen.getByRole('region', { name: 'Step categories' }))
    .getByRole('button', { name: 'Wait' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))
  expect(button('Collapse THEN of if-1')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Step .*?, wait-1$/ })).toBeTruthy()
  expect(button('Expand ELSE of if-1')).toBeTruthy()
  expect((await savedDraft()).workflow.steps[0].type).toBe('if')
})

test('Sequence result summaries and tooltips use the same localized labels as result selection without changing references', async () => {
  state.currentDraft = backgroundDraft(1)
  state.currentDraft.tool_instances.push({ id: 'powers-1', tool: 'powers', setup: {} })
  state.currentDraft.workflow.steps = [
    { type: 'tool-action', id: 'protect', target: 'powers-1', action: 'protection-status', arguments: { channel: 1 } },
    { type: 'bg-interaction', id: 'batch', background_id: 'background-1', timeout_ms: null,
      operation: { kind: 'get-buffer-data', read_mode: 'peek', selection: { kind: 'all' } } },
    { type: 'array-process', id: 'batch-length', operation: 'length',
      arguments: { input: { source: 'step-output', step_id: 'batch', pointer: '/data' } } },
    { type: 'for', id: 'loop', variable: 'i', range: { start: '0', stop: '2', step: '1' }, steps: [
      { type: 'output', id: 'out', name: 'Length', page: 'Results',
        value: { source: 'step-output', step_id: 'batch-length', pointer: '/value' } },
      { type: 'assert', id: 'check', operator: 'equal', message: '',
        left: { source: 'step-output', step_id: 'protect', pointer: '/protection_tripped' },
        right: { source: 'literal', value: false } },
      { type: 'string-process', id: 'inside', operation: 'length',
        arguments: { input: { source: 'literal', value: 'x' } } },
    ] },
    { type: 'set-variable', id: 'events', variable: 'events', value: { source: 'step-output', step_id: 'batch', pointer: '/data' } },
    { type: 'set-variable', id: 'raw', variable: 'raw', value: { source: 'step-output', step_id: 'batch', pointer: '/data/0' } },
    { type: 'set-variable', id: 'whole', variable: 'whole', value: { source: 'step-output', step_id: 'batch', pointer: '' } },
    { type: 'set-variable', id: 'missing-ref', variable: 'missing', value: { source: 'step-output', step_id: 'missing', pointer: '/value' } },
    { type: 'set-variable', id: 'out-of-scope', variable: 'outside', value: { source: 'step-output', step_id: 'inside', pointer: '/value' } },
    { type: 'set-variable', id: 'calc', variable: 'calc', value: { source: 'expression', operator: 'add',
      left: { source: 'step-output', step_id: 'batch-length', pointer: '/value' }, right: { source: 'literal', value: 1 } } },
  ]
  render(<I18nProvider initialLanguage="en"><App /></I18nProvider>)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_workflow_draft'))
  tab('Workflow')
  await screen.findByTitle('Length = batch-length → Value')
  const expectSummary = (summary: string) => {
    expect(screen.getByTitle(summary).textContent).toBe(summary)
  }
  expectSummary('Length = batch-length → Value')
  expectSummary('protect → Protection Tripped == false')
  expectSummary('events = batch → Data (Array)')
  expectSummary('raw = batch → /data/0')
  expectSummary('whole = batch → Complete result')
  expectSummary('missing = missing → /value')
  expectSummary('outside = inside → /value')
  expectSummary('calc = batch-length → Value + 1')

  fireEvent.click(screen.getByRole('button', { name: 'Switch language to 繁體中文' }))
  expectSummary('Length = batch-length → 處理結果')
  expectSummary('protect → 保護已觸發 == false')
  expectSummary('events = batch → Data（Array）')
  expectSummary('whole = batch → 完整結果')
  expectSummary('raw = batch → /data/0')
  expectSummary('missing = missing → /value')
  expectSummary('outside = inside → /value')
  expectSummary('calc = batch-length → 處理結果 + 1')
  fireEvent.click(screen.getByRole('button', { name: '切換語言為 English' }))
  expectSummary('Length = batch-length → Value')
  expect((await savedDraft()).workflow.steps).toEqual(state.currentDraft.workflow.steps)
  localStorage.removeItem('orchestrator-tool.locale')
})

test('Sequence locates nested validation errors even when their ancestors were collapsed', async () => {
  await mount()
  const sequence = screen.getByRole('region', { name: 'Sequence' })
  fireEvent.click(within(sequence).getByRole('button', { name: 'Collapse All' }))
  const original = vi.mocked(invoke).getMockImplementation()!
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'validate_workflow_draft') throw { message: 'Nested output is invalid', step_id: 'out' }
    return original(command, args)
  })
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await screen.findByText('Validation failed: Nested output is invalid')
  const card = await screen.findByRole('button', { name: /Step .*?, out$/ })
  expect(card.getAttribute('aria-invalid')).toBe('true')
  fireEvent.click(within(sequence).getByRole('button', { name: 'Collapse FOR outer' }))
  expect(within(sequence).getByText('Validation warning inside')).toBeTruthy()
})

test('Sequence density is a local preference, survives Template changes and remains editable during a run', async () => {
  await mount()
  const sequence = screen.getByRole('region', { name: 'Sequence' })
  const density = within(sequence).getByRole('combobox', { name: 'Step Display Density' }) as HTMLSelectElement
  expect(density.value).toBe('standard')
  fireEvent.change(density, { target: { value: 'compact' } })
  expect(sequence.getAttribute('data-step-density')).toBe('compact')
  expect(localStorage.getItem('orchestrator-tool.step-density')).toBe('compact')
  fireEvent.click(within(sequence).getByRole('button', { name: 'Collapse FOR outer' }))
  fireEvent.click(screen.getByRole('button', { name: 'New Template' }))
  await waitFor(() => expect(within(sequence).getByRole('button', { name: 'Collapse FOR outer' })).toBeTruthy())
  expect(density.value).toBe('compact')
  fireEvent.click(within(sequence).getByRole('button', { name: 'Collapse FOR outer' }))
  vi.mocked(open).mockResolvedValueOnce('template.json')
  fireEvent.click(screen.getByRole('button', { name: 'Open Template' }))
  await screen.findByText('Template loaded.')
  expect(within(sequence).getByRole('button', { name: 'Collapse FOR outer' })).toBeTruthy()
  expect(density.value).toBe('compact')

  fireEvent.click(runButton('Simulation'))
  await waitFor(() => expect(runCalls()).toHaveLength(1))
  expect((within(sequence).getByRole('button', { name: 'Drag outer to reorder' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(density, { target: { value: 'comfortable' } })
  expect(sequence.getAttribute('data-step-density')).toBe('comfortable')
  fireEvent.click(within(sequence).getByRole('button', { name: 'Collapse FOR outer' }))
  expect(within(sequence).getByRole('button', { name: 'Expand FOR outer' })).toBeTruthy()
  expect(JSON.parse((runCalls()[0][1] as { templateJson: string }).templateJson).workflow.steps)
    .toEqual(state.currentDraft.workflow.steps)
  await finish(8)
  expect((await savedDraft()).workflow.steps).toEqual(state.currentDraft.workflow.steps)
})

test('Clear Workflow cancel preserves steps; confirmation removes steps without replacing the Template', async () => {
  await mount()
  const original = await savedDraft()
  const clear = () => screen.getByRole('button', { name: 'Clear Workflow' }) as HTMLButtonElement
  expect(clear().disabled).toBe(false)

  vi.mocked(confirm).mockResolvedValueOnce(false)
  fireEvent.click(clear())
  await waitFor(() => expect(confirm).toHaveBeenCalledWith(
    'Clear all workflow steps?\n\nThis action cannot be undone.',
    expect.objectContaining({ kind: 'warning', okLabel: 'Clear' }),
  ))
  expect(clear().disabled).toBe(false)
  expect(await savedDraft()).toEqual(original)

  vi.mocked(confirm).mockResolvedValueOnce(true)
  fireEvent.click(clear())
  await waitFor(() => expect(clear().disabled).toBe(true))
  const cleared = await savedDraft()
  expect(cleared.workflow.steps).toEqual([])
  expect(cleared.tool_instances).toEqual(draft.tool_instances)
  expect(cleared.name).toBe(draft.name)
})

test('Workflow data processing editors save typed literals and dynamic operands', async () => {
  state.currentDraft.workflow.steps = [
    { type: 'set-variable', id: 'set-suffix', variable: 'suffix', value: { source: 'literal', value: '!' } },
    { type: 'set-variable', id: 'set-flag', variable: 'flag', value: { source: 'literal', value: 0 } },
    { type: 'if', id: 'condition', left: { source: 'literal', value: 0 }, operator: 'equal',
      right: { source: 'literal', value: 0 }, then_steps: [], else_steps: [] },
    { type: 'byte-process', id: 'loaded-text', operation: { kind: 'text-to-hex' },
      arguments: { input: { source: 'literal', value: 'A\r\nB\r\nC\nD\rE\\r' } } },
  ]
  await mount()
  const properties = within(screen.getByRole('region', { name: 'Properties' }))
  const card = (id: string) => screen.getByRole('button', { name: new RegExp(`Step .*?, ${id}$`) })
  const add = (name: string) => {
    fireEvent.click(within(screen.getByRole('region', { name: 'Step categories' })).getByRole('button', { name }))
    fireEvent.click(screen.getByRole('button', { name: 'Add Step' }))
  }
  fireEvent.click(card('set-flag'))
  fireEvent.change(properties.getByRole('combobox', { name: 'Value Type' }), { target: { value: 'boolean' } })
  fireEvent.change(properties.getByRole('combobox', { name: 'Value' }), { target: { value: 'true' } })
  fireEvent.click(card('condition'))
  const left = within(properties.getByRole('group', { name: 'Left operand' }))
  fireEvent.change(left.getByRole('combobox', { name: 'Value Type' }), { target: { value: 'null' } })
  expect(left.queryByRole('spinbutton')).toBeNull()

  // A visible CR escape distinguishes raw CRLF, CR, LF and literal backslashes.
  fireEvent.click(card('loaded-text'))
  const loadedText = properties.getByRole('textbox', { name: 'Input String' }) as HTMLTextAreaElement
  expect(loadedText.value).toBe('A\\r\nB\\r\nC\nD\\rE\\\\r')
  fireEvent.input(loadedText, { target: { value: 'A\\r\nB\\r\nC\nD\\rE\\\\r!' } })
  loadedText.setSelectionRange(0, 0)
  // jsdom has no native edit history. Mock only the browser's insert command;
  // native Undo/Redo and clipboard behavior are verified in Chromium.
  const originalCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')
  const insertText = vi.fn((command: string, _showUI?: boolean, text?: string) => {
    if (command !== 'insertText' || text === undefined) return false
    loadedText.setRangeText(text, loadedText.selectionStart, loadedText.selectionEnd, 'end')
    fireEvent.input(loadedText)
    return true
  })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: insertText })
  try {
    fireEvent.paste(loadedText, { clipboardData: { getData: () => 'X\r\n' } })
    expect(insertText).toHaveBeenCalledWith('insertText', false, 'X\\r\n')
    // Remove CRLF+B and replace it with LF; then replace X's CRLF with LF.
    fireEvent.input(loadedText, { target: { value: 'X\\r\nA\n\\r\nC\nD\\rE\\\\r!' } })
    fireEvent.input(loadedText, { target: { value: 'X\nA\n\\r\nC\nD\\rE\\\\r!' } })
    loadedText.setSelectionRange(0, loadedText.value.length)
    const copyData = vi.fn()
    fireEvent.copy(loadedText, { clipboardData: { setData: copyData } })
    expect(copyData).toHaveBeenCalledWith('text/plain', 'X\nA\n\r\nC\nD\rE\\r!')

    // Unknown typed escapes are literal. A raw transfer must not combine
    // an untouched backslash with the inserted text or the cut suffix.
    fireEvent.input(loadedText, { target: { value: loadedText.value + '|P:\\q|D:\\q|R:\\q|C:\\qr' } })
    const afterSlash = (label: string) => loadedText.value.indexOf('|' + label + ':') + 4
    const pasteAt = (label: string, text: string) => {
      const index = afterSlash(label)
      loadedText.setSelectionRange(index, index)
      fireEvent.paste(loadedText, { clipboardData: { getData: () => text } })
    }
    pasteAt('P', 'n')
    pasteAt('R', '\r')
    const dropIndex = afterSlash('D')
    loadedText.setSelectionRange(dropIndex, dropIndex)
    fireEvent.drop(loadedText, { dataTransfer: { types: ['text/plain'], getData: () => 'n' } })
    fireEvent(loadedText, new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromDrop', data: 'n' }))
    const cutIndex = afterSlash('C')
    loadedText.setSelectionRange(cutIndex, cutIndex + 1)
    const cutData = vi.fn()
    fireEvent.cut(loadedText, { clipboardData: { setData: cutData } })
    expect(cutData).toHaveBeenCalledWith('text/plain', 'q')
  } finally {
    if (originalCommand) Object.defineProperty(document, 'execCommand', originalCommand)
    else Reflect.deleteProperty(document, 'execCommand')
  }

  fireEvent.click(card('set-flag'))
  add('String Process')
  fireEvent.change(properties.getByRole('combobox', { name: 'Operation' }), { target: { value: 'length' } })
  fireEvent.input(properties.getByRole('textbox', { name: 'Input String' }), { target: { value: 'A\nA' } })
  add('Byte Process')
  fireEvent.change(properties.getByRole('combobox', { name: 'Operation' }), { target: { value: 'hex-to-number' } })
  fireEvent.input(properties.getByRole('textbox', { name: 'Input Hex String' }), { target: { value: '12\n34\n56' } })
  fireEvent.change(properties.getByRole('combobox', { name: 'Byte Count Source' }), { target: { value: 'step-output' } })
  expect((within(properties.getByRole('group', { name: 'Byte Count' }))
    .getByRole('combobox', { name: 'Result' }) as HTMLSelectElement).value).toBe('/value')
  fireEvent.change(properties.getByRole('combobox', { name: 'Byte Order' }), { target: { value: 'lsb-first' } })
  fireEvent.change(properties.getByRole('combobox', { name: 'Number Format' }), { target: { value: 'signed' } })

  const saved = await savedDraft()
  expect(saved.workflow.steps.find(step => step.id === 'set-flag')).toMatchObject({
    value: { source: 'literal', value: true },
  })
  expect(saved.workflow.steps.find(step => step.id === 'condition')).toMatchObject({
    left: { source: 'literal', value: null },
  })
  expect(saved.workflow.steps.find(step => step.type === 'string-process')).toMatchObject({
    operation: 'length', arguments: { input: { source: 'literal', value: 'A\nA' } },
  })
  expect(saved.workflow.steps.find(step => step.id === 'loaded-text')).toMatchObject({
    operation: { kind: 'text-to-hex' },
    arguments: { input: { source: 'literal', value: 'X\nA\n\r\nC\nD\rE\\r!|P:\\nq|D:\\nq|R:\\\rq|C:\\r' } },
  })
  expect(saved.workflow.steps.find(step => step.type === 'byte-process' && step.id !== 'loaded-text')).toMatchObject({
    operation: { kind: 'hex-to-number', byte_order: 'lsb-first', number_format: 'signed' },
    arguments: { input: { source: 'literal', value: '12\n34\n56' },
      byte_count: { source: 'step-output', step_id: 'string-process-1', pointer: '/value' } },
  })


  // A cross-field move and its history events may update two operands before
  // React renders. Assert both raw literals at the existing Save Template IPC.
  add('String Process')
  fireEvent.change(properties.getByRole('combobox', { name: 'Operation' }), { target: { value: 'concat' } })
  const source = properties.getByRole('textbox', { name: 'Input String' }) as HTMLTextAreaElement
  const target = properties.getByRole('textbox', { name: 'Append' }) as HTMLTextAreaElement
  const inputEvent = (field: HTMLTextAreaElement, value: string, inputType = 'insertText') =>
    fireEvent.input(field, { target: { value }, inputType })
  const expectConcat = async (input: string, append: string) => {
    expect((await savedDraft()).workflow.steps.find(step => step.type === 'string-process' && step.operation === 'concat')).toMatchObject({
      arguments: { input: { source: 'literal', value: input }, append: { source: 'literal', value: append } },
    })
  }
  for (const { before, moved, beforeRaw, movedRaw, repaired } of [
    { before: ['nB', 'Aq'], moved: ['B', 'Anq'], beforeRaw: ['nB', 'Aq'], movedRaw: ['B', 'Anq'], repaired: 'none' },
    { before: ['nB', 'A\\q'], moved: ['B', 'A\\\\nq'], beforeRaw: ['nB', 'A\\q'], movedRaw: ['B', 'A\\nq'], repaired: 'target' },
    { before: ['A\\qr', 'P'], moved: ['A\\\\r', 'Pq'], beforeRaw: ['A\\qr', 'P'], movedRaw: ['A\\r', 'Pq'], repaired: 'source' },
    { before: ['A\\nqr', 'B\\q'], moved: ['A\\\\r', 'B\\\\nqq'], beforeRaw: ['A\nqr', 'B\\q'], movedRaw: ['A\\r', 'B\\nqq'], repaired: 'both' },
  ]) {
    inputEvent(source, before[0])
    inputEvent(target, before[1])
    const sourceRepaired = repaired === 'source' || repaired === 'both'
    const targetRepaired = repaired === 'target' || repaired === 'both'
    source.setSelectionRange(sourceRepaired ? 2 : 0, repaired === 'both' ? 4 : sourceRepaired ? 3 : 1)
    // jsdom has no native drag edit. For a repaired source, deliver the
    // actual beforeinput and let the dragend handler execute its edit.
    const nativeInsert = vi.fn((command: string, _showUI?: boolean, text?: string) => {
      if (command !== 'insertText' || text === undefined) return false
      source.setRangeText(text, source.selectionStart, source.selectionEnd, 'end')
      fireEvent.input(source, { inputType: 'insertText' })
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: nativeInsert })
    try {
      await act(async () => {
        fireEvent.dragStart(source, { dataTransfer: { setData: vi.fn() } })
        if (sourceRepaired) {
          fireEvent(source, new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteByDrag' }))
        } else {
          inputEvent(source, moved[0], 'deleteByDrag')
        }
        inputEvent(target, moved[1], targetRepaired ? 'insertText' : 'insertFromDrop')
        fireEvent.dragEnd(source)
      })
      await expectConcat(movedRaw[0], movedRaw[1])
    } finally {
      if (originalCommand) Object.defineProperty(document, 'execCommand', originalCommand)
      else Reflect.deleteProperty(document, 'execCommand')
    }

    // jsdom cannot execute native history: simulate Chromium's single native
    // move or the two native commands required by a repaired boundary.
    const historyCommand = vi.fn((command: string) => {
      if (command === 'undo') inputEvent(sourceRepaired ? target : source, before[sourceRepaired ? 1 : 0], 'historyUndo')
      else if (command === 'redo') inputEvent(sourceRepaired ? source : target, moved[sourceRepaired ? 0 : 1], 'historyRedo')
      else return false
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: historyCommand })
    try {
      await act(async () => {
        if (repaired === 'none' || sourceRepaired) inputEvent(source, before[0], 'historyUndo')
        if (!sourceRepaired) inputEvent(target, before[1], 'historyUndo')
      })
      await expectConcat(beforeRaw[0], beforeRaw[1])
      await act(async () => {
        if (!sourceRepaired) inputEvent(source, moved[0], 'historyRedo')
        if (repaired === 'none' || sourceRepaired) inputEvent(target, moved[1], 'historyRedo')
      })
      await expectConcat(movedRaw[0], movedRaw[1])
      expect(historyCommand.mock.calls.map(([command]) => command)).toEqual(repaired === 'none' ? [] : ['undo', 'redo'])
    } finally {
      if (originalCommand) Object.defineProperty(document, 'execCommand', originalCommand)
      else Reflect.deleteProperty(document, 'execCommand')
    }
  }

  // Switching the other operand to a variable must not discard this field's
  // native edit. Send historyUndo to the original field and verify Save IPC.
  inputEvent(source, 'abc')
  inputEvent(source, 'abcX')
  fireEvent.change(properties.getByRole('combobox', { name: 'Append Source' }), { target: { value: 'variable' } })
  const appendGroup = within(properties.getByRole('group', { name: 'Append' }))
  fireEvent.change(appendGroup.getByRole('combobox', { name: 'Referenced Variable' }), { target: { value: 'suffix' } })
  inputEvent(source, 'abc', 'historyUndo')
  expect((await savedDraft()).workflow.steps.find(step => step.type === 'string-process' && step.operation === 'concat')).toMatchObject({
    arguments: { input: { source: 'literal', value: 'abc' }, append: { source: 'variable', variable: 'suffix' } },
  })
})
