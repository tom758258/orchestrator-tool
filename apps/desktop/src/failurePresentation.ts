import { english, type Translate } from './i18n/index.ts'
export type FailurePresentation = {
  summary: string
  guidance: string
}

export type FailureStepContext = {
  type: string
  message?: string
}

const STORED_FAILURE_MESSAGE_CHARS = 512

function storedFailureMessage(text: string): string {
  return Array.from(text).slice(0, STORED_FAILURE_MESSAGE_CHARS).join('')
}

function assertFailureMessage(step: FailureStepContext): string {
  const configured = step.message ?? ''
  return storedFailureMessage(configured.trim() === '' ? 'Assertion failed.' : configured)
}

export function failurePresentation(message: string, step?: FailureStepContext, t: Translate = english): FailurePresentation {
  const normalized = message.toLowerCase()

  if (step?.type === 'assert') {
    if (message === assertFailureMessage(step)) {
      return {
        summary: t("failurePresentation.thisCheckDidNotPass"),
        guidance: t("failurePresentation.reviewTheExpectedConditionAndTheValueUsedBy"),
      }
    }
    return {
      summary: t("failurePresentation.thisCheckCouldNotBeEvaluated"),
      guidance: t("failurePresentation.reviewTheTechnicalDetailsAndTheValuesUsedBy"),
    }
  }
  if (normalized.includes('safety cleanup failed')) {
    return {
      summary: t("failurePresentation.theRunFailedWhilePerformingSafetyCleanup"),
      guidance: t("failurePresentation.reviewTheTechnicalDetailsBeforeRunningAgainAnyEarlier"),
    }
  }
  if (normalized.includes('worker startup failed') || normalized.includes('failed to start')) {
    return {
      summary: t("failurePresentation.theExternalToolCouldNotStart"),
      guidance: t("failurePresentation.checkTheConfiguredExecutableAndItsRuntimeDependencies"),
    }
  }
  if (normalized.includes('worker fatal error')) {
    return {
      summary: t("failurePresentation.theExternalToolReportedAnErrorWhileExecutingThis"),
      guidance: t("failurePresentation.reviewTheTechnicalDetailsBelowForTheOriginalTool"),
    }
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return {
      summary: t("failurePresentation.theOperationDidNotFinishBeforeTheTimeout"),
      guidance: t("failurePresentation.checkThatTheExternalToolIsResponsiveAndWhether"),
    }
  }
  if (
    normalized.includes('worker http failed')
    || normalized.includes('http request failed')
    || normalized.includes('event channel disconnected')
    || normalized.includes('event i/o error')
  ) {
    return {
      summary: t("failurePresentation.communicationWithTheExternalToolWasInterrupted"),
      guidance: t("failurePresentation.checkThatTheExternalToolIsStillAvailableAnd"),
    }
  }
  if (
    /\binvalid(?: [a-z0-9-]+)? arguments\b/.test(normalized)
    || /\bunsupported(?: [a-z0-9-]+)? action\b/.test(normalized)
  ) {
    return {
      summary: t("failurePresentation.thisOperationWasNotValidOrSupportedWithThe"),
      guidance: t("failurePresentation.checkTheStepSettingsAndWhetherTheSelectedTool"),
    }
  }
  if (
    (normalized.includes('invalid') && normalized.includes('worker response'))
    || normalized.includes('invalid json')
  ) {
    return {
      summary: t("failurePresentation.orchestratorCouldNotUnderstandTheResponseFromTheExternal"),
      guidance: t("failurePresentation.confirmTheExternalToolVersionIsCompatibleThenReview"),
    }
  }
  if (normalized.includes('worker shutdown failed') || normalized.includes('worker exited with')) {
    return {
      summary: t("failurePresentation.theExternalToolDidNotShutDownNormally"),
      guidance: t("failurePresentation.reviewTheTechnicalDetailsBeforeStartingAnotherRun"),
    }
  }
  return {
    summary: t("failurePresentation.thisOperationFailedWhileExecuting"),
    guidance: t("failurePresentation.reviewTheTechnicalDetailsBelowForTheOriginalError"),
  }
}
