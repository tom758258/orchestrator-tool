import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import { InteractionEditor, InteractionSettingsEditor, type InteractionCommandDrafts } from '../src/InteractionEditor'
import InputValueEditor from '../src/InputValueEditor'
import type { InputValueWire } from '../src/inputValue'
import type { InteractionStep, WorkflowStep } from '../src/workflow'
import type { ToolInstance } from '../src/ToolSetupEditor'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => '/tmp/payload.bin') }))

test('Interaction settings lock without Background and retain capacity through collapse', () => {
  function Settings({ hasBackground, disabled = false }: { hasBackground: boolean; disabled?: boolean }) {
    const [value, setValue] = useState({ enabled: false, max_active_command_status: 4096 })
    return <InteractionSettingsEditor value={value} hasBackground={hasBackground} disabled={disabled} onChange={setValue} />
  }
  const view = render(<Settings hasBackground={false} />)
  const toggle = () => screen.getByRole('button', { name: /FG\/BG Interaction$/ })
  expect((toggle() as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByLabelText('Enable FG/BG Interaction')).toBeNull()

  view.rerender(<Settings hasBackground />)
  expect((toggle() as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(toggle())
  const capacity = screen.getByLabelText('Max Active Command Status') as HTMLInputElement
  expect(capacity.disabled).toBe(true)
  expect(capacity.value).toBe('4096')
  fireEvent.click(screen.getByLabelText('Enable FG/BG Interaction'))
  fireEvent.change(capacity, { target: { value: '65536' } })
  fireEvent.click(toggle())
  expect(screen.queryByLabelText('Max Active Command Status')).toBeNull()
  fireEvent.click(toggle())
  expect((screen.getByLabelText('Max Active Command Status') as HTMLInputElement).value).toBe('65536')
  view.rerender(<Settings hasBackground disabled />)
  expect((screen.getByLabelText('Enable FG/BG Interaction') as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByLabelText('Max Active Command Status') as HTMLInputElement).disabled).toBe(true)
})

const command = (id: string, background_id = 'bg'): InteractionStep => ({ type: 'bg-interaction', id, background_id, timeout_ms: null,
  operation: { kind: 'command', command: 'software-trigger', wait_for_completion: false } })

test('Binding and Output value editor can select native Get results and their JSON pointers', () => {
  const getters: InteractionStep[] = [
    { ...command('latest'), operation: { kind: 'get-latest' } },
    { ...command('next'), operation: { kind: 'wait-next' } },
    { ...command('result'), operation: { kind: 'get-command-result', source_step: 'send' } },
  ]
  const changed = vi.fn()
  function Editor() {
    const [value, setValue] = useState<InputValueWire>({ source: 'literal', value: 0 })
    return <InputValueEditor value={value} onChange={next => { setValue(next); changed(next) }}
      earlierSteps={[command('send'), ...getters]} instances={[]} earlierVariables={[]}
      stepLabel={step => step.id} disabled={false} />
  }
  render(<Editor />)
  expect((screen.getByRole('option', { name: 'Previous step result' }) as HTMLOptionElement).disabled).toBe(false)
  fireEvent.change(screen.getByLabelText('Value Source'), { target: { value: 'step-output' } })
  const source = screen.getByLabelText('Step') as HTMLSelectElement
  expect(Array.from(source.options).map(option => option.value)).toEqual(['', 'latest', 'next', 'result'])
  for (const step of getters) {
    fireEvent.change(source, { target: { value: step.id } })
    fireEvent.change(screen.getByLabelText('JSON Pointer'), { target: { value: '/value' } })
    expect(changed).toHaveBeenLastCalledWith({ source: 'step-output', step_id: step.id, pointer: '/value' })
  }
})

test('Background Meters Get result uses the existing Value and Unit dropdown', () => {
  const latest: InteractionStep = { ...command('latest'), operation: { kind: 'get-latest' } }
  function Editor() {
    const [value, setValue] = useState<InputValueWire>({
      source: 'step-output', step_id: 'latest', pointer: '/value',
    })
    return <InputValueEditor value={value} onChange={setValue} earlierSteps={[latest]}
      instances={[{ id: 'meter-1', tool: 'meters', setup: {} } as ToolInstance]}
      backgrounds={[{ id: 'bg', tool_instance_id: 'meter-1', live_monitor: false, limit_count: 3 }]}
      earlierVariables={[]} stepLabel={step => step.id} disabled={false} />
  }
  render(<Editor />)
  const result = screen.getByLabelText('Result') as HTMLSelectElement
  expect(Array.from(result.options).map(option => option.textContent)).toEqual(['Value', 'Unit', 'Custom pointer...'])
  expect(result.value).toBe('/value')
  fireEvent.change(result, { target: { value: '/unit' } })
  expect(result.value).toBe('/unit')
  expect(screen.queryByLabelText('JSON Pointer')).toBeNull()
})

test('Result editor offers earlier same-Background commands in legal Loop scopes', () => {
  const get: InteractionStep = { type: 'bg-interaction', id: 'get', background_id: 'bg', timeout_ms: null, operation: { kind: 'get-command-result', source_step: '' } }
  const steps: WorkflowStep[] = [command('outer'), command('other-background', 'other'),
    { type: 'for', id: 'closed-loop', variable: 'i', range: { start: '0', stop: '1', step: '1' }, steps: [command('expired')] }, get, command('later')]
  const onChange = vi.fn()
  render(<InteractionEditor step={get} steps={steps} backgrounds={[{ id: 'bg', tool_instance_id: 'meter', live_monitor: false, limit_count: 1 }]}
    savedCommands={{}} onSaveCommand={vi.fn()}
    disabled={false} onChange={onChange} />)
  const source = screen.getByLabelText('Source BG Command Step') as HTMLSelectElement
  expect(Array.from(source.options).map(option => option.value)).toEqual(['', 'outer'])
  fireEvent.change(source, { target: { value: 'outer' } })
  expect(onChange).toHaveBeenLastCalledWith({ ...get, operation: { kind: 'get-command-result', source_step: 'outer' } })
  fireEvent.change(screen.getByLabelText('Step timeout (ms)'), { target: { value: '250' } })
  expect(onChange).toHaveBeenLastCalledWith({ ...get, timeout_ms: 250 })
})

test('BG Command exposes optional completion wait and locks controls during a Run', () => {
  const step = command('send')
  const onChange = vi.fn()
  const props = { step, steps: [step], backgrounds: [], onChange, savedCommands: {}, onSaveCommand: vi.fn() }
  const view = render(<InteractionEditor {...props} disabled={false} />)
  fireEvent.click(screen.getByLabelText('Wait for Completion'))
  expect(onChange).toHaveBeenCalledWith({ ...step, operation: { ...step.operation, wait_for_completion: true } })
  view.rerender(<InteractionEditor {...props} disabled />)
  expect(screen.getByRole('group').hasAttribute('disabled')).toBe(true)
})

test('Serial BG Command reuses TX and file controls and retains settings across command switches', async () => {
  const instance = { id: 'serial', tool: 'serial', setup: { transport: 'serial', baud: 115200 } } as ToolInstance
  const original: InteractionStep = { ...command('send'), operation: { kind: 'command', command: 'serial-send',
    wait_for_completion: true, arguments: { tx_format: 'text', tx_value: 'START' } } }
  let saved = original
  function Editor() {
    const [step, setStep] = useState(original)
    const [savedCommands, setSavedCommands] = useState<InteractionCommandDrafts>({})
    return <InteractionEditor step={step} steps={[step]} instances={[instance]}
      savedCommands={savedCommands} onSaveCommand={operation => setSavedCommands(current => ({ ...current, [operation.command]: operation }))}
      backgrounds={[{ id: 'bg', tool_instance_id: 'serial', live_monitor: false, limit_count: null }]}
      disabled={false} onChange={value => { saved = value; setStep(value) }} />
  }
  render(<Editor />)
  expect((screen.getByLabelText('TX Format') as HTMLSelectElement).value).toBe('text')
  fireEvent.change(screen.getByLabelText('TX Data'), { target: { value: 'STOP' } })
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'serial-send-file' } })
  fireEvent.click(screen.getByRole('button', { name: 'Browse File' }))
  await vi.waitFor(() => expect((screen.getByLabelText('Absolute File Path (Worker-local)') as HTMLInputElement).value).toBe('/tmp/payload.bin'))
  expect(saved.operation).toEqual({ kind: 'command', command: 'serial-send-file', wait_for_completion: true, arguments: { path: '/tmp/payload.bin' } })
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'serial-send' } })
  expect((screen.getByLabelText('TX Data') as HTMLInputElement).value).toBe('STOP')
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'serial-send-file' } })
  expect((screen.getByLabelText('Absolute File Path (Worker-local)') as HTMLInputElement).value).toBe('/tmp/payload.bin')
})

test('Changing Background preserves Serial inputs and shows an incompatible command', () => {
  const original: InteractionStep = { ...command('send'), operation: { kind: 'command', command: 'serial-send',
    wait_for_completion: false, arguments: { tx_format: 'hex-byte', tx_value: 257 } } }
  const changed = vi.fn()
  function Editor() {
    const [step, setStep] = useState(original)
    return <InteractionEditor step={step} steps={[step]} instances={[
      { id: 'serial', tool: 'serial', setup: {} }, { id: 'meter', tool: 'meters', setup: {} },
    ] as ToolInstance[]} backgrounds={[
      { id: 'bg', tool_instance_id: 'serial', live_monitor: false, limit_count: null },
      { id: 'other', tool_instance_id: 'meter', live_monitor: false, limit_count: 1 },
    ]} savedCommands={{}} onSaveCommand={vi.fn()} disabled={false} onChange={value => { changed(value); setStep(value) }} />
  }
  render(<Editor />)
  fireEvent.change(screen.getByLabelText('Background'), { target: { value: 'other' } })
  expect(changed).toHaveBeenLastCalledWith({ ...original, background_id: 'other' })
  const incompatibleCommand = screen.getByLabelText('Command') as HTMLSelectElement
  expect(incompatibleCommand.value).toBe('serial-send')
  expect(incompatibleCommand.selectedOptions[0]?.textContent).toMatch(/^Serial-send\s+\(unsupported Background\)$/)
  expect(screen.getByRole('alert').textContent).toContain('does not match')
  expect((screen.getByLabelText('TX Format') as HTMLSelectElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Background'), { target: { value: 'bg' } })
  expect(screen.queryByRole('alert')).toBeNull()
  expect((screen.getByLabelText('TX Format') as HTMLSelectElement).value).toBe('hex-byte')
})

test('Serial Get Command Result explanation only appears for that operation', () => {
  const instance = { id: 'serial', tool: 'serial', setup: {} } as ToolInstance
  const background = [{ id: 'bg', tool_instance_id: 'serial', live_monitor: false, limit_count: null }]
  const original: InteractionStep = { ...command('send'), operation: { kind: 'command', command: 'serial-send',
    wait_for_completion: false, arguments: { tx_format: 'text', tx_value: 'PING' } } }
  const props = { steps: [original], instances: [instance], backgrounds: background,
    savedCommands: {}, onSaveCommand: vi.fn(), disabled: false, onChange: vi.fn() }
  const hint = /Get Command Result returns the complete native job_finished event/
  const view = render(<InteractionEditor {...props} step={original} />)
  expect(screen.queryByText(hint)).toBeNull()
  view.rerender(<InteractionEditor {...props} step={{ ...original, operation: { kind: 'get-latest' } }} />)
  expect(screen.queryByText(hint)).toBeNull()
  view.rerender(<InteractionEditor {...props} step={{ ...original, operation: { kind: 'wait-next' } }} />)
  expect(screen.queryByText(hint)).toBeNull()
  view.rerender(<InteractionEditor {...props} step={{ ...original, operation: { kind: 'get-command-result', source_step: 'send' } }} />)
  expect(screen.getByText(hint)).toBeTruthy()
})
