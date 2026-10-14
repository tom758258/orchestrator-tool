import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { allWorkflowSteps, type WorkflowStep } from './workflow'
import type { ToolInstance } from './ToolSetupEditor'

type PreflightState = { key: string, status: 'checking' | 'passed' | 'failed', errors: string[] }

export function useLivePreflight(
  executionMode: string, draft: { tool_instances: ToolInstance[], workflow: { steps: WorkflowStep[] } } | null,
  resources: Record<string, string>, resourceDrafts: Record<string, string>,
  identities: Record<string, object | null>, identityDrafts: Record<string, object | null>,
  powersExecutable: string, scopesExecutable: string, configBusy: boolean,
) {
  const templateJson = JSON.stringify(draft)
  const key = JSON.stringify([executionMode, templateJson, resources, resourceDrafts, identities, identityDrafts,
    powersExecutable, scopesExecutable, configBusy])
  const [state, setState] = useState<PreflightState | null>(null)
  useEffect(() => {
    if (executionMode !== 'live' || !draft || configBusy) {
      setState(null)
      return
    }
    let cancelled = false
    const referenced = draft.tool_instances.filter(instance => allWorkflowSteps(draft.workflow.steps)
      .some(step => step.type === 'tool-action' && step.target === instance.id))
    const unsaved = referenced.filter(instance => {
      const saved = identities[instance.id] ?? {}
      const edited = identityDrafts[instance.id] ?? {}
      return (resources[instance.id] ?? '') !== (resourceDrafts[instance.id] ?? '') ||
        Object.keys({ ...saved, ...edited }).some(field =>
          (saved as Record<string, unknown>)[field] !== (edited as Record<string, unknown>)[field])
    })
    if (unsaved.length) {
      setState({ key, status: 'failed', errors: unsaved.map(instance =>
        `${instance.tool} (${instance.id}): unsaved Live Resource or identity changes. Save Resource before running Live.`) })
      return
    }
    setState({ key, status: 'checking', errors: [] })
    const timer = setTimeout(() => {
      void invoke<string[]>('check_live_preflight', { templateJson }).then(errors => {
        if (!cancelled) setState({ key, status: errors.length ? 'failed' : 'passed', errors })
      }).catch(error => {
        if (!cancelled) setState({ key, status: 'failed', errors: [String(error)] })
      })
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [key])
  const current = state?.key === key ? state : { key, status: 'checking' as const, errors: [] }
  return {
    ...current,
    blocked: executionMode === 'live' && current.status !== 'passed',
    reject: (error: string) => setState({ key, status: 'failed', errors: [error] }),
  }
}
