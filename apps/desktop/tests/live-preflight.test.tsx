import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { useLivePreflight } from '../src/useLivePreflight'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

type Arguments = Parameters<typeof useLivePreflight>

function fixture() {
  const draft: NonNullable<Arguments[1]> = {
    tool_instances: [{ id: 'power', tool: 'powers', setup: {} }],
    workflow: { steps: [{ type: 'tool-action', id: 'off', target: 'power',
      action: 'output-off', arguments: { channel: 1 } }] },
  }
  const args: Arguments = ['simulate', draft, { power: 'USB::1' }, { power: 'USB::1' },
    { power: { model_id: 'model-1' } }, { power: { model_id: 'model-1' } },
    'powers.exe', 'scopes.exe', false, { power: 'system' }, { power: 'system' }]
  const hook = renderHook(() => useLivePreflight(...args))
  return { args, ...hook, rerender: () => hook.rerender() }
}

async function settlePreflight() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(invoke).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

test('Live remains blocked until a fresh preflight passes, and Simulation stays available', async () => {
  vi.mocked(invoke).mockResolvedValue([])
  const h = fixture()
  expect(h.result.current.blocked).toBe(false)
  h.args[0] = 'live'
  h.rerender()
  expect(h.result.current.blocked).toBe(true)
  await settlePreflight()
  expect(invoke).toHaveBeenCalledWith('check_live_preflight', { templateJson: JSON.stringify(h.args[1]) })
  expect(h.result.current.status).toBe('passed')
  expect(h.result.current.blocked).toBe(false)

  h.args[1] = { ...h.args[1]!, tool_instances: [{ id: 'power', tool: 'powers', setup: {
    protection: { channels: [{ channel: 1, ocp: 'on' }] },
  } }] }
  h.rerender()
  expect(h.result.current.blocked).toBe(true)
  await settlePreflight()
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(h.result.current.blocked).toBe(false)

  h.args[0] = 'simulate'
  h.rerender()
  expect(h.result.current.blocked).toBe(false)
})

test('an older successful reply cannot unblock Live after inputs change', async () => {
  let completeOld!: (errors: string[]) => void
  vi.mocked(invoke)
    .mockImplementationOnce(() => new Promise(resolve => { completeOld = resolve }))
    .mockResolvedValueOnce(['new resource is unsupported'])
  const h = fixture()
  h.args[0] = 'live'
  h.rerender()
  await settlePreflight()
  expect(h.result.current.blocked).toBe(true)

  h.args[2] = h.args[3] = { power: 'USB::2' }
  h.rerender()
  expect(h.result.current.blocked).toBe(true)
  await settlePreflight()
  expect(h.result.current.status).toBe('failed')
  await act(async () => { completeOld([]) })
  expect(h.result.current.status).toBe('failed')
  expect(h.result.current.blocked).toBe(true)
})

test('unsaved Resource, Model and backend edits prevent Live dispatch without a preflight call', () => {
  const h = fixture()
  h.args[0] = 'live'
  h.args[3] = { power: 'UNSAVED' }
  h.rerender()
  expect(h.result.current.blocked).toBe(true)
  // Unsaved inputs fail before any asynchronous Worker preflight is requested.
  expect(h.result.current.status).toBe('failed')
  expect(h.result.current.errors[0]).toMatch(/unsaved Live Resource/i)
  expect(invoke).not.toHaveBeenCalled()

  h.args[3] = h.args[2]
  h.args[5] = { power: { model_id: 'different' } }
  h.rerender()
  expect(h.result.current.blocked).toBe(true)
  expect(h.result.current.errors[0]).toMatch(/unsaved Live Resource/i)
  expect(invoke).not.toHaveBeenCalled()

  h.args[5] = h.args[4]
  h.args[10] = { power: 'other' }
  h.rerender()
  expect(h.result.current.blocked).toBe(true)
  expect(invoke).not.toHaveBeenCalled()
})

test('preflight errors and backend rejection fail closed', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([])
  const h = fixture()
  h.args[0] = 'live'
  h.rerender()
  await settlePreflight()
  expect(h.result.current.status).toBe('failed')
  expect(h.result.current.blocked).toBe(true)
  expect(h.result.current.errors).toEqual(['Error: unavailable'])

  h.args[6] = 'new-powers.exe'
  h.rerender()
  await settlePreflight()
  expect(h.result.current.status).toBe('passed')
  act(() => h.result.current.reject('Model changed after check'))
  expect(h.result.current.blocked).toBe(true)
  expect(h.result.current.errors).toEqual(['Model changed after check'])
})
