import { useI18n } from './i18n/I18nProvider'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { WorkflowStep } from './workflow'
import type { ToolInstance } from './toolSetup/types'

type PreflightState = { key: string, status: 'checking' | 'passed' | 'failed', errors: string[]; unsaved?: { tool: string; id: string }[] }

export function useLivePreflight(
  executionMode: string, draft: { tool_instances: ToolInstance[], workflow: { steps: WorkflowStep[] } } | null,
  resources: Record<string, string>, resourceDrafts: Record<string, string>,
  identities: Record<string, object | null>, identityDrafts: Record<string, object | null>,
  powersExecutable: string, scopesExecutable: string, configBusy: boolean,
  backends: Record<string, string>, backendDrafts: Record<string, string>,
) {
  const { t } = useI18n()
  const templateJson = JSON.stringify(draft)
  const key = JSON.stringify([executionMode, templateJson, resources, resourceDrafts, identities, identityDrafts, backends, backendDrafts,
    powersExecutable, scopesExecutable, configBusy])
  const [state, setState] = useState<PreflightState | null>(null)
  useEffect(() => {
    if (executionMode !== 'live' || !draft || configBusy) {
      setState(null)
      return
    }
    let cancelled = false
    const unsaved = draft.tool_instances.filter(instance => {
      const saved = identities[instance.id] ?? {}
      const edited = identityDrafts[instance.id] ?? {}
      return (resources[instance.id] ?? '') !== (resourceDrafts[instance.id] ?? '') ||
        (backends[instance.id] ?? 'system') !== (backendDrafts[instance.id] ?? 'system') ||
        Object.keys({ ...saved, ...edited }).some(field =>
          (saved as Record<string, unknown>)[field] !== (edited as Record<string, unknown>)[field])
    })
    if (unsaved.length) {
      setState({ key, status: 'failed', errors: [], unsaved: unsaved.map(({ tool, id }) => ({ tool, id })) })
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
    errors: current.unsaved?.map(instance => t("preflight.unsaved", instance)) ?? current.errors,
    blocked: executionMode === 'live' && current.status !== 'passed',
    reject: (error: string) => setState({ key, status: 'failed', errors: [error] }),
  }
}
