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

export function failurePresentation(message: string, step?: FailureStepContext): FailurePresentation {
  const normalized = message.toLowerCase()

  if (step?.type === 'assert') {
    if (message === assertFailureMessage(step)) {
      return {
        summary: 'This check did not pass.',
        guidance: 'Review the expected condition and the value used by this check.',
      }
    }
    return {
      summary: 'This check could not be evaluated.',
      guidance: 'Review the technical details and the values used by this check.',
    }
  }
  if (normalized.includes('safety cleanup failed')) {
    return {
      summary: 'The run failed while performing safety cleanup.',
      guidance: 'Review the technical details before running again. Any earlier workflow failure is kept in the same diagnostic.',
    }
  }
  if (normalized.includes('worker startup failed') || normalized.includes('failed to start')) {
    return {
      summary: 'The external tool could not start.',
      guidance: 'Check the configured executable and its runtime dependencies.',
    }
  }
  if (normalized.includes('worker fatal error')) {
    return {
      summary: 'The external tool reported an error while executing this operation.',
      guidance: 'Review the technical details below for the original tool or instrument error.',
    }
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return {
      summary: 'The operation did not finish before the timeout.',
      guidance: 'Check that the external tool is responsive and whether the operation needs more time.',
    }
  }
  if (
    normalized.includes('worker http failed')
    || normalized.includes('http request failed')
    || normalized.includes('event channel disconnected')
    || normalized.includes('event i/o error')
  ) {
    return {
      summary: 'Communication with the external tool was interrupted.',
      guidance: 'Check that the external tool is still available and review the connection before trying again.',
    }
  }
  if (
    /\binvalid(?: [a-z0-9-]+)? arguments\b/.test(normalized)
    || /\bunsupported(?: [a-z0-9-]+)? action\b/.test(normalized)
  ) {
    return {
      summary: 'This operation was not valid or supported with the current settings.',
      guidance: 'Check the step settings and whether the selected tool supports this operation.',
    }
  }
  if (
    (normalized.includes('invalid') && normalized.includes('worker response'))
    || normalized.includes('invalid json')
  ) {
    return {
      summary: 'Orchestrator could not understand the response from the external tool.',
      guidance: 'Confirm the external tool version is compatible, then review the technical details.',
    }
  }
  if (normalized.includes('worker shutdown failed') || normalized.includes('worker exited with')) {
    return {
      summary: 'The external tool did not shut down normally.',
      guidance: 'Review the technical details before starting another run.',
    }
  }
  return {
    summary: 'This operation failed while executing.',
    guidance: 'Review the technical details below for the original error.',
  }
}
