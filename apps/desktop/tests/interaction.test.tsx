import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import { InteractionEditor, InteractionSettingsEditor } from '../src/InteractionEditor'
import type { InteractionStep, WorkflowStep } from '../src/workflow'

test('Workflow interaction controls require opt-in and retain the shared capacity', () => {
  function Settings() {
    const [value, setValue] = useState({ enabled: false, max_active_command_status: 4096 })
    return <InteractionSettingsEditor value={value} disabled={false} onChange={setValue} />
  }
  render(<Settings />)
  const capacity = screen.getByLabelText('Max Active Command Status') as HTMLInputElement
  expect(capacity.disabled).toBe(true)
  expect(capacity.value).toBe('4096')
  fireEvent.click(screen.getByLabelText('Enable FG/BG Interaction'))
  fireEvent.change(capacity, { target: { value: '65536' } })
  fireEvent.click(screen.getByLabelText('Enable FG/BG Interaction'))
  fireEvent.click(screen.getByLabelText('Enable FG/BG Interaction'))
  expect(capacity.value).toBe('65536')
  expect(capacity.disabled).toBe(false)
})

const command = (id: string, background_id = 'bg'): InteractionStep => ({ type: 'bg-interaction', id, background_id, timeout_ms: null,
  operation: { kind: 'command', command: 'software-trigger', wait_for_completion: false } })

test('Result editor offers earlier same-Background commands in legal Loop scopes', () => {
  const get: InteractionStep = { type: 'bg-interaction', id: 'get', background_id: 'bg', timeout_ms: null, operation: { kind: 'get-command-result', source_step: '' } }
  const steps: WorkflowStep[] = [command('outer'), command('other-background', 'other'),
    { type: 'for', id: 'closed-loop', variable: 'i', range: { start: '0', stop: '1', step: '1' }, steps: [command('expired')] }, get, command('later')]
  const onChange = vi.fn()
  render(<InteractionEditor step={get} steps={steps} backgrounds={[{ id: 'bg', tool_instance_id: 'meter', live_monitor: false, limit_count: 1 }]}
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
  const props = { step, steps: [step], backgrounds: [], onChange }
  const view = render(<InteractionEditor {...props} disabled={false} />)
  fireEvent.click(screen.getByLabelText('Wait for Completion'))
  expect(onChange).toHaveBeenCalledWith({ ...step, operation: { ...step.operation, wait_for_completion: true } })
  view.rerender(<InteractionEditor {...props} disabled />)
  expect(screen.getByRole('group').hasAttribute('disabled')).toBe(true)
})
