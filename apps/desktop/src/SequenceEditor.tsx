import type { WorkflowStep } from './App'

type SequenceEditorProps = {
  steps: readonly WorkflowStep[]
  selectedStepId: string | null
  onSelectStep: (stepId: string) => void
  stepLabel: (step: WorkflowStep) => string
}

function SequenceEditor({
  steps,
  selectedStepId,
  onSelectStep,
  stepLabel,
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
            <li key={step.id}>
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
                  <code>{step.id}</code>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export default SequenceEditor
