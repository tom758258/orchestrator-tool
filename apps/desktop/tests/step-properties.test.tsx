import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import App from '../src/App'
import ProcessEditor from '../src/ProcessEditor'
import { useState } from 'react'
import InputValueEditor, { ExpressionOperandEditor } from '../src/InputValueEditor'
import { I18nProvider } from '../src/i18n/I18nProvider'
import type { ProcessStep, WorkflowStep } from '../src/workflow'
import { createToolConfigurationFixture } from './support/toolConfigurationFixture'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.2.0' }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme: async () => {} }) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: vi.fn(), open: vi.fn(), save: vi.fn() }))

const { state, original, backgroundMeter, toolStatus, click, tab, savedDraft, serialBackgroundDraft } = createToolConfigurationFixture()

test('Step ID editor rejects invalid names, supports cancel, and updates BG Command references on save', async () => {
  const command: WorkflowStep = { type: 'bg-interaction', id: 'send', background_id: 'background-1', timeout_ms: null,
    operation: { kind: 'command', command: 'software-trigger', wait_for_completion: false } }
  const result: WorkflowStep = { type: 'bg-interaction', id: 'get', background_id: 'background-1', timeout_ms: null,
    operation: { kind: 'get-command-result', source_step: 'send' } }
  state.newDraft = { ...original, tool_instances: [{ ...backgroundMeter, setup: { ...backgroundMeter.setup, trigger_mode: 'software' } }],
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
  state.tools.push(toolStatus('serial'))
  const source: WorkflowStep = { type: 'bg-interaction', id: 'latest', background_id: 'serial-bg',
    timeout_ms: null, operation: { kind: 'get-latest' } }
  const command: WorkflowStep = { type: 'bg-interaction', id: 'send', background_id: 'serial-bg', timeout_ms: null,
    operation: { kind: 'command', command: 'serial-send', wait_for_completion: true,
      arguments: { tx_format: 'text', tx_value: 'unchanged' },
      bindings: { tx_value: { source: 'step-output', step_id: 'latest', pointer: '/value' } } } }
  state.newDraft = { ...structuredClone(serialBackgroundDraft),
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

test('all 42 Workflow presets show their Palette description in Properties', async () => {
  state.tools = [...state.tools, toolStatus('serial')]
  state.newDraft = {
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
