import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { ComponentProps } from 'react'
import WorkflowRunSummary from '../src/WorkflowRunSummary'

const defaults: ComponentProps<typeof WorkflowRunSummary> = {
  workflowDraft: { schema_version: 1, name: 'Example', tool_instances: [], workflow: { steps: [] } },
  workflowBusy: false, toolConfigBusy: null, loading: false, chartThresholdInvalid: false,
  executionMode: 'simulate', validationStatus: 'idle', validationError: null,
  runStatus: 'idle', runningText: 'Running…', runError: null, displayedRun: null,
  livePreflight: { status: 'passed', blocked: false, errors: [] }, liveStartError: null,
  validateDraft: () => {}, runSelectedMode: () => {}, stopControls: null, stopFeedback: null,
}

test('summary gates actions while loading, configuring tools or validating', () => {
  const validateDraft = vi.fn(), runSelectedMode = vi.fn()
  const props = { ...defaults, validateDraft, runSelectedMode }
  const view = render(<WorkflowRunSummary {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  fireEvent.click(screen.getByRole('button', { name: 'Run Simulation' }))
  expect(validateDraft).toHaveBeenCalledTimes(1)
  expect(runSelectedMode).toHaveBeenCalledTimes(1)
  for (const gate of [{ loading: true }, { toolConfigBusy: 'meters' }, { workflowBusy: true }]) {
    view.rerender(<WorkflowRunSummary {...props} {...gate} />)
    const run = screen.getByRole('button', { name: 'Run Simulation' }) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Validate' }) as HTMLButtonElement).disabled).toBe('workflowBusy' in gate)
    fireEvent.click(run)
  }
  expect(runSelectedMode).toHaveBeenCalledTimes(1)
  view.rerender(<WorkflowRunSummary {...props} workflowBusy validationStatus="validating" />)
  expect((screen.getByRole('button', { name: 'Validating…' }) as HTMLButtonElement).disabled).toBe(true)
})

test('summary preserves raw diagnostics and displays a shared run failure only once', () => {
  const error = 'invalid Powers arguments: channel must be a positive integer'
  const view = render(<WorkflowRunSummary {...defaults} runError={error} displayedRun={{ status: 'failed', error }} />)
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(screen.getByText(error)).toBeTruthy()
  expect(screen.getByText('Technical details')).toBeTruthy()
  expect(screen.getByText('This operation was not valid or supported with the current settings.')).toBeTruthy()
  view.rerender(<WorkflowRunSummary {...defaults} executionMode="live" liveStartError="Resource changed" />)
  expect(screen.getByText('Live run did not start')).toBeTruthy()
  expect(screen.getByText('Resource changed')).toBeTruthy()
  expect(screen.queryByText('Run failed')).toBeNull()
})
