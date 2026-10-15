import { failurePresentation } from './failurePresentation'
import type { WorkflowStep } from './workflow'

export default function FailureDetails({ message, step }: { message: string; step?: WorkflowStep }) {
  const presentation = failurePresentation(message, step)
  return (
    <div className="failure-explanation">
      <p className="failure-summary">{presentation.summary}</p>
      <p className="failure-guidance">{presentation.guidance}</p>
      <p className="failure-technical-label">Technical details</p>
      <p className="run-result-message">{message}</p>
    </div>
  )
}

