import type { WorkflowStep } from './App'

type SequenceEditorProps = {
  steps: readonly WorkflowStep[]
  selectedStepId: string | null
  onSelectStep: (stepId: string) => void
  stepLabel: (step: WorkflowStep) => string
  workflowBusy: boolean
  onMoveStep: (stepId: string, offset: -1 | 1) => void
  onDeleteStep: (stepId: string) => void
}

function valueSummary(value: Extract<WorkflowStep, { type: 'output' }>['value']): string {
  switch (value.source) {
    case 'literal':
      return JSON.stringify(value.value) ?? 'No value'
    case 'variable':
      return `Variable ${value.variable}`
    case 'step-output':
      return `${value.step_id} → ${value.pointer || '(root)'}`
  }
}

function stepSummary(step: WorkflowStep): string {
  switch (step.type) {
    case 'set-variable':
      return `${step.variable} = ${valueSummary(step.value)}`
    case 'output':
      return valueSummary(step.value)
    case 'wait':
      return `${step.duration_ms} ms`
    case 'tool-action': {
      if (step.tool === 'powers') {
        const channel = step.bindings?.channel
          ? 'Bound channel'
          : `CH${step.arguments.channel ?? '?'}`
        if (step.action === 'set-voltage') {
          const voltage = step.bindings?.voltage
          return `${channel} · ${voltage
            ? voltage.source === 'variable'
              ? `Voltage = ${voltage.variable}`
              : voltage.source === 'literal'
                ? `${valueSummary(voltage)} V`
                : 'Bound value'
            : `${step.arguments.voltage ?? '?'} V`}`
        }
        if (step.action === 'output-on' || step.action === 'output-off') {
          return channel
        }
      }
      return step.id
    }
  }
}

function SequenceEditor({
  steps,
  selectedStepId,
  onSelectStep,
  stepLabel,
  workflowBusy,
  onMoveStep,
  onDeleteStep,
}: SequenceEditorProps) {
  return (
    <section className="sequence-editor" aria-labelledby="sequence-editor-title">
      <h3 id="sequence-editor-title">Sequence</h3>
      {steps.length === 0 ? (
        <p className="sequence-empty">
          No workflow steps yet.<br />
          Choose a step from the palette to begin.
        </p>
      ) : (
        <ol className="sequence-steps">
          {steps.map((step, index) => (
            <li key={step.id} className="sequence-step-row">
              <button
                className="sequence-step-card"
                type="button"
                aria-label={`Step ${index + 1}: ${stepLabel(step)}, ${step.id}`}
                aria-pressed={selectedStepId === step.id}
                onClick={() => onSelectStep(step.id)}
              >
                <span className="sequence-step-order">{index + 1}</span>
                <span className="sequence-step-identity">
                  <span className="sequence-step-label">{stepLabel(step)}</span>
                  <span className="sequence-step-summary" title={stepSummary(step)}>
                    {stepSummary(step)}
                  </span>
                  <code>{step.id}</code>
                </span>
              </button>
              <div className="sequence-step-actions" role="group" aria-label={`Actions for ${step.id}`}>
                <button className="action-button" type="button"
                  disabled={workflowBusy || index === 0}
                  onClick={() => onMoveStep(step.id, -1)}>
                  Up
                </button>
                <button className="action-button" type="button"
                  disabled={workflowBusy || index === steps.length - 1}
                  onClick={() => onMoveStep(step.id, 1)}>
                  Down
                </button>
                <button className="action-button" type="button"
                  disabled={workflowBusy}
                  onClick={() => onDeleteStep(step.id)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export default SequenceEditor
