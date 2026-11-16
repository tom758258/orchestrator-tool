import { useI18n } from './i18n/I18nProvider'
import { failurePresentation } from './failurePresentation'
import type { WorkflowStep } from './workflow'

export default function FailureDetails({ message, step }: { message: string; step?: WorkflowStep }) {
  const { t } = useI18n()
  const presentation = failurePresentation(message, step, t)
  return (
    <div className="failure-explanation">
      <p className="failure-summary">{presentation.summary}</p>
      <p className="failure-guidance">{presentation.guidance}</p>
      <p className="failure-technical-label">{t("failureDetails.technicalDetails")}</p>
      <p className="run-result-message">{message}</p>
    </div>
  )
}

