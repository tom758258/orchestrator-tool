import type { ToolInstance } from './ToolSetupEditor'
import type { StepExecutionDto, WorkflowStep, ForStep, WhileStep } from './workflow'
import { expressionSummary } from './inputValue'

type SequenceEditorProps = {
  instances: ToolInstance[]
  steps: readonly WorkflowStep[]
  runResults: readonly StepExecutionDto[] | null
  formatMeasurement: (output: unknown) => string | null
  selectedStepId: string | null
  onSelectStep: (stepId: string) => void
  stepLabel: (step: WorkflowStep) => string
  workflowBusy: boolean
  onMoveStep: (stepId: string, offset: -1 | 1) => void
  onDeleteStep: (stepId: string) => void
}

function valueSummary(value: Extract<WorkflowStep, { type: 'output' }>['value']): string {
  switch (value.source) {
    case 'expression':
      return expressionSummary(value)
    case 'literal':
      return JSON.stringify(value.value) ?? 'No value'
    case 'variable':
      return `Variable ${value.variable}`
    case 'step-output':
      return `${value.step_id} → ${value.pointer || '(root)'}`
  }
}

function stepSummary(step: WorkflowStep, instances: ToolInstance[]): string {
  switch (step.type) {
    case 'for':
      return `Step ${step.range.step} · ${step.steps.length} body steps`
    case 'while':
    case 'assert':
      return expressionSummary(step)
    case 'set-variable':
      return `${step.variable} = ${valueSummary(step.value)}`
    case 'output':
      return `${step.name} = ${valueSummary(step.value)}`
    case 'wait':
      return `${step.duration_ms} ms`
    case 'tool-action': {
      if (instances.find(instance => instance.id === step.target)?.tool === 'powers') {
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
                : voltage.source === 'expression'
                  ? `Voltage = ${expressionSummary(voltage)}`
                  : 'Bound value'
            : `${step.arguments.voltage ?? '?'} V`}`
        }
        if (step.action === 'output-on' || step.action === 'output-off') {
          return channel
        }
      }
      return step.target
    }
  }
}

function SequenceEditor({
  steps,
  instances,
  runResults,
  formatMeasurement,
  selectedStepId,
  onSelectStep,
  stepLabel,
  workflowBusy,
  onMoveStep,
  onDeleteStep,
}: SequenceEditorProps) {
  function renderSteps(siblings: readonly WorkflowStep[], parent?: ForStep | WhileStep, parentOrder?: string): React.ReactNode {
    return (
      <ol className="sequence-steps">
        {siblings.map((step, index) => {
          const occurrences = runResults?.filter(result => result.step_id === step.id &&
            (parent ? parent.type === 'for'
              ? result.for_iteration?.for_step_id === parent.id
              : result.while_iteration?.while_step_id === parent.id
              : result.for_iteration === null && result.while_iteration === null)) ?? []
          const result = occurrences.find(result => result.status === 'failed')
            ?? (occurrences.length > 0 && occurrences.every(result => result.status === 'succeeded')
              ? occurrences[occurrences.length - 1] : occurrences.find(result => result.status === 'cancelled'))
          const order = parentOrder ? `${parentOrder}.${index + 1}` : `${index + 1}`
          let outputSummary: string | null = null
          if (!parent && result?.status === 'succeeded') {
            outputSummary = formatMeasurement(result.output)
            if (step.type === 'output' && (
              result.output === null ||
              typeof result.output === 'number' ||
              typeof result.output === 'string' ||
              typeof result.output === 'boolean'
            )) {
              outputSummary = JSON.stringify(result.output)
            }
          }

          return (
            <li key={step.id} className="sequence-step-row">
              <button
                className="sequence-step-card"
                type="button"
                aria-label={`Step ${order}: ${stepLabel(step)}, ${step.id}`}
                aria-describedby={result ? `sequence-result-${step.id}` : undefined}
                aria-pressed={selectedStepId === step.id}
                onClick={() => onSelectStep(step.id)}
              >
                <span className="sequence-step-order">{order}</span>
                <span className="sequence-step-identity">
                  <span className="sequence-step-label">{stepLabel(step)}</span>
                  <span className="sequence-step-summary" title={stepSummary(step, instances)}>
                    {stepSummary(step, instances)}
                  </span>
                  <code>{step.id}</code>
                  {result && (
                    <span id={`sequence-result-${step.id}`} className="sequence-step-result">
                      <span className={`run-result-status run-result-${result.status}`}>
                        <span aria-hidden="true">
                          {result.status === 'succeeded' ? '✓' : result.status === 'failed' ? '✕' : '–'}
                        </span>{' '}
                        {result.status}
                      </span>
                      {outputSummary !== null && (
                        <span className="sequence-step-output">{outputSummary}</span>
                      )}
                    </span>
                  )}
                </span>
              </button>
              <div className="sequence-step-actions" role="group" aria-label={`Actions for ${step.id}`}>
                <button className="action-button" type="button"
                  disabled={workflowBusy || index === 0}
                  onClick={() => onMoveStep(step.id, -1)}>
                  Up
                </button>
                <button className="action-button" type="button"
                  disabled={workflowBusy || index === siblings.length - 1}
                  onClick={() => onMoveStep(step.id, 1)}>
                  Down
                </button>
                <button className="action-button" type="button"
                  disabled={workflowBusy}
                  onClick={() => onDeleteStep(step.id)}>
                  Delete
                </button>
              </div>
              {(step.type === 'for' || step.type === 'while') && <div style={{ width: 'calc(100% - 24px)', marginLeft: 24 }}>
                {step.steps.length ? renderSteps(step.steps, step, order) : <p>No body steps. Select this loop and add steps from the palette.</p>}
              </div>}
            </li>
          )
        })}
      </ol>
    )
  }

  return (
    <section className="sequence-editor" aria-labelledby="sequence-editor-title">
      <h3 id="sequence-editor-title">Sequence</h3>
      {steps.length === 0 ? (
        <div className="sequence-empty">
          <h4>Create your first workflow</h4>
          <p>Add steps from the palette to build a workflow. Configure each selected step in Properties.</p>
          <h4>Examples</h4>
          <ul className="sequence-examples">
            <li>
              <strong>Measure Only</strong>
              <p>Meter Measure → Output</p>
              <p>Take one measurement and publish the result.</p>
            </li>
            <li>
              <strong>Power and Measure</strong>
              <p>Power Set Voltage → Power Output ON → Wait → Meter Measure → Output → Power Output OFF</p>
              <p>Power a DUT, wait for settling, measure it, then turn power off.</p>
            </li>
            <li>
              <strong>Reuse a Variable</strong>
              <p>Set Variable → Power Set Voltage</p>
              <p>Define a value once and reuse it in a later step.</p>
            </li>
          </ul>
        </div>
      ) : (
        renderSteps(steps)
      )}
    </section>
  )
}

export default SequenceEditor
