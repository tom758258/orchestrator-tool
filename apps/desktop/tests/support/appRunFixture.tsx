import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import type { Channel } from '@tauri-apps/api/core'
import { confirm, save } from '@tauri-apps/plugin-dialog'
import App from '../../src/App'
import type { RunMetadataDto, WorkflowRunEventDto } from '../../src/workflow'
import type { WorkflowDraft } from '../../src/templateDraft'

export function createAppRunFixture() {
  const draft: WorkflowDraft = { name: 'Run test', tool_instances: [], workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [
    { type: 'for', id: 'outer', variable: 'i', range: { start: '0', stop: '2', step: '1' }, steps: [
      { type: 'for', id: 'inner', variable: 'j', range: { start: '0', stop: '2', step: '1' }, steps: [
        { type: 'output', id: 'out', name: 'Voltage', page: 'Results', value: { source: 'literal', value: 10.600000000000001 } },
      ] },
    ] },
  ] } }

  function backgroundDraft(count: number): WorkflowDraft {
    return { ...structuredClone(draft), tool_instances: Array.from({ length: count }, (_, index) => ({
      id: `meters-${index+1}`, tool: 'meters', setup: { trigger_mode: 'immediate-custom',
        measurement: 'voltage-dc', range_mode: 'auto', manual_range: null, nplc: 1, auto_zero: 'on',
        dcv_input_impedance: null, current_terminal: null },
    })), backgrounds: Array.from({ length: count }, (_, index) => ({
      id: `background-${index+1}`, tool_instance_id: `meters-${index+1}`, live_monitor: true,
      limit_count: 3,
    })), workflow: { interaction: { enabled: false, max_active_command_status: 4096, buffer: { enabled: false, mode: 'fifo', overflow_policy: 'fail-run' } }, steps: [
      { type: 'background', id: 'on', background_id: 'background-1', action: 'worker-on', capture: true },
      ...structuredClone(draft.workflow.steps),
    ] } }
  }

  function metadata(runId: number, status: RunMetadataDto['status'] = 'succeeded'): RunMetadataDto {
    return { run_id: runId, status, error: null, completed_successfully: status === 'succeeded', manual_exportable: true,
      execution_count: 1, execution_revision: 1,
      latest_execution: { step_id: 'out', status: 'succeeded', output: 10.600000000000001, output_omitted: false,
        message: null, for_iteration: { for_step_id: 'inner', iteration_index: 0 }, while_iteration: null },
      pages: [{ name: 'Results', output_names: ['Voltage'], row_count: 1, revision: 1, iteration_rows: true,
        numeric_outputs: ['Voltage'], timestamp_outputs: [],
        summaries: [{ name: 'Voltage', count: 1, min: 10.600000000000001, max: 10.600000000000001, avg: 10.600000000000001, std_dev: null }] }],
      step_summaries: [], messages: [{ target: 'message-1', total: 1, revision: 1 }],
    }
  }

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }

  const state = {
    run: deferred<RunMetadataDto>(),
    preflightErrors: [] as string[],
    simulationRequirements: [] as string[],
    currentDraft: structuredClone(draft),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.removeItem('orchestrator-tool.step-density')
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
    state.run = deferred<RunMetadataDto>()
    state.preflightErrors = []
    state.simulationRequirements = []
    state.currentDraft = structuredClone(draft)
    vi.mocked(confirm).mockResolvedValue(true)
    vi.mocked(save).mockResolvedValue('saved.json')
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const params = args as Record<string, unknown>
      switch (command) {
        case 'create_workflow_draft': return JSON.stringify(state.currentDraft)
        case 'get_tool_status': return []
        case 'get_simulation_sample_requirements': return state.simulationRequirements
        case 'get_background_output': return { workers: [{ id: 'background-1', state: 'off', stream_state: 'ended', live_monitor: true, error: null }],
          datasets: [{ id: 'capture-1', background_id: 'background-1', worker_run_id: 'worker', status: 'completed', quality: 'no_loss_detected', row_count: 300001, min: 1, max: 1, avg: 1, csv_path: null, error: null }],
          rows: [], monitor: [] }
        case 'get_live_resources': case 'get_live_resource_identities': case 'get_live_backends': return {}
        case 'get_powers_capabilities': return { channels: [1, 2] }
        case 'check_live_preflight': return state.preflightErrors
        case 'get_background_chart_series': return { total_count: 300001, visible_count: 300001, returned_count: 1,
          sampled: true, raw_limit: 25000, raw_limit_exceeded: false, domain: { min: 0, max: 30 },
          points: [{ x: 0.003, value: 1, sample_index: 5, timestamp_utc: '2026-10-28T00:00:00.003Z', elapsed_s: 0.003, unit: 'V' }] }
        case 'validate_workflow_draft': {
          const value = JSON.parse(params.templateJson as string) as WorkflowDraft
          const invalid = value.output_views?.charts.findIndex(chart => chart.source && !value.backgrounds?.some(background => background.id === chart.source!.background_id)) ?? -1
          if (invalid >= 0) throw new Error(`chart ${invalid + 1} references unknown Background`)
          return params.templateJson
        }
        case 'load_workflow_template': return JSON.stringify(state.currentDraft)
        case 'save_workflow_template': return params.templateJson
        case 'clear_last_run': case 'open_help': return undefined
        case 'run_workflow_live': case 'run_workflow_simulation': return state.run.promise
        case 'request_workflow_stop': case 'request_global_workflow_stop': return true
        case 'get_last_run_executions': return { run_id: params.runId, offset: 0, total_executions: 1, executions: [metadata(Number(params.runId)).latest_execution] }
        case 'get_last_run_messages': return { run_id: params.runId, target: params.target, revision: 1, total_messages: 1, offset: 0, messages: [`Message from run ${params.runId}`] }
        case 'get_last_run_page_rows': return { run_id: params.runId, page: 'Results', revision: 1, total_rows: 1, offset: 0,
          rows: [{ page: 'Results', for_iteration: null, while_iteration: null, outputs: [{ name: 'Voltage', value: 10.600000000000001 }] }] }
        default: throw new Error(`Unexpected command: ${command}`)
      }
    })
  })

  const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))
  const runButton = (mode: string) => screen.getByRole('button', { name: `Run ${mode}` }) as HTMLButtonElement
  const snapshot = () => JSON.parse(screen.getByTestId('chart-snapshot').textContent!)
  const runCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command.startsWith('run_workflow_'))
  function progressChannel() {
    return (runCalls().at(-1)![1] as { onProgress: Channel<WorkflowRunEventDto> }).onProgress
  }
  async function mount() {
    render(<App />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_workflow_draft'))
    tab('Workflow')
    await waitFor(() => expect(runButton('Simulation').disabled).toBe(false))
  }
  async function selectLive() {
    fireEvent.click(screen.getByRole('button', { name: 'Live' }))
    expect(runButton('Live').disabled).toBe(true)
    await screen.findByText('Live Preflight: Passed')
  }
  async function finish(runId: number) {
    await act(async () => state.run.resolve(metadata(runId)))
  }
  async function previousRun() {
    await mount()
    fireEvent.click(runButton('Simulation'))
    await finish(7)
    await screen.findByText('Message from run 7')
    state.run = deferred<RunMetadataDto>()
  }

  async function savedDraft(): Promise<WorkflowDraft> {
    tab('Workflow')
    fireEvent.click(screen.getByRole('button', { name: 'Save Template' }))
    await screen.findByText('Template saved.')
    return JSON.parse((vi.mocked(invoke).mock.calls.filter(([command]) => command === 'save_workflow_template')
      .at(-1)![1] as { templateJson: string }).templateJson)
  }

  return { state, draft, backgroundDraft, metadata, deferred, tab, runButton, snapshot, runCalls, progressChannel, mount, selectLive, finish, previousRun, savedDraft }
}
