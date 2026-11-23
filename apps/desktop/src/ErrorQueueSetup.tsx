import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState, type ReactNode } from 'react'
import type { ExecutionMode } from './executionMode'
import { useI18n } from './i18n/I18nProvider'
import type { ScopesCapabilities } from './scopesSetup'

export type ErrorQueueTool = 'powers' | 'meters' | 'scopes'

export type ErrorQueueResult = {
  status: 'queue_empty' | 'drained' | 'not_fully_drained' | 'failed'
  entries: { code: string; message: string }[]
  error: string | null
}

const statusLabels = {
  queue_empty: 'app.errorQueueEmpty',
  drained: 'app.errorQueueDrained',
  not_fully_drained: 'app.errorQueueNotFullyDrained',
  failed: 'app.failed',
} as const

export type ErrorQueueSetupProps = {
  tool: ErrorQueueTool
  instanceId: string
  executionMode: ExecutionMode
  savedResource: string | undefined
  savedModelId: string | null
  executableKey: string
  toolRefreshRevision: number
  bindingKey: string
  available: boolean
  disabled: boolean
  onRead: () => Promise<ErrorQueueResult | null>
}

export default function ErrorQueueSetup({ children, tool, instanceId, executionMode, savedResource, savedModelId,
  executableKey, toolRefreshRevision, bindingKey, available, disabled, onRead }: ErrorQueueSetupProps & { children: ReactNode }) {
  const { t } = useI18n()
  const live = executionMode === 'live'
  const modelId = live ? savedModelId : null
  const capabilityKey = JSON.stringify([tool, instanceId, executionMode, modelId, executableKey, toolRefreshRevision])
  const [capability, setCapability] = useState<{ key: string; supported: boolean | null; error?: string } | null>(null)
  const [lastRead, setLastRead] = useState<{ key: string; result: ErrorQueueResult } | null>(null)
  const result = lastRead?.key === bindingKey ? lastRead.result : null
  useEffect(() => {
    if (tool === 'powers' || !available || (tool === 'scopes' && live && !modelId)) return
    let cancelled = false
    const check = tool === 'meters'
      ? invoke<void>('check_meters_error_queue_support', { instanceId, executionMode }).then(() => true)
      : invoke<ScopesCapabilities>('get_scopes_capabilities', { modelId, executionMode })
        .then(caps => caps?.check_error_supported ?? null)
    void check.then(
      supported => {
        if (!cancelled) setCapability({ key: capabilityKey, supported })
      },
      error => { if (!cancelled) setCapability({ key: capabilityKey, supported: null, error: String(error) }) },
    )
    return () => { cancelled = true }
  }, [tool, instanceId, available, live, executionMode, modelId, capabilityKey])

  let unavailable: string | null = null
  if (!available) unavailable = t('app.errorQueueToolUnavailable')
  else if (live && !savedResource?.trim()) unavailable = t('app.errorQueueSaveResource')
  else if (tool === 'meters') {
    if (capability?.key !== capabilityKey) unavailable = t('app.errorQueueLoadingMetersSupport')
    else if (!capability.supported) unavailable = t('app.errorQueueMetersSupportUnavailable', { reason: capability.error ?? '' })
  } else if (tool === 'scopes') {
    if (live && !modelId) unavailable = t('app.errorQueueSaveIdentifiedScope')
    else if (capability?.key !== capabilityKey) unavailable = t('app.errorQueueLoadingScopeCapability')
    else if (capability.supported === null) unavailable = t('app.errorQueueScopeCapabilityUnavailable')
    else if (!capability.supported) unavailable = t('app.errorQueueUnsupportedModel')
  }

  async function read() {
    if (disabled || unavailable) return
    try {
      const reply = await onRead()
      if (reply) setLastRead({ key: bindingKey, result: reply })
    } catch (error) {
      setLastRead({ key: bindingKey, result: { status: 'failed', entries: [], error: String(error) } })
    }
  }

  return <>
    <div className="live-device-columns">
      <div>
        <h5>{t('app.errorQueueResource')}</h5>
        {children}
      </div>
      <div className="error-queue-controls">
        <h5>{t('app.errorQueue')}</h5>
        <button type="button" className="action-button" disabled={disabled || unavailable !== null} onClick={() => void read()}>
          {t('app.readAndDrainErrors')}
        </button>
        {unavailable !== null && <p className="tool-setup-hint">{unavailable}</p>}
        <p className="tool-setup-hint">
          <strong>{t('app.errorQueuePurposeTitle')}</strong><br />
          {t('app.errorQueuePurpose')}
        </p>
        <p className="tool-setup-hint">
          <strong>{t('app.errorQueueBehaviorTitle')}</strong><br />
          {t('app.errorQueueBehavior')}
        </p>
        <p className="tool-setup-hint">
          <strong>{t('app.errorQueueNotesTitle')}</strong><br />
          {t('app.errorQueueNotes')}
        </p>
      </div>
    </div>
    {result && <div className="error-queue-result">
      <p role="status"><strong>{t('app.errorQueueStatus')}</strong>{' '}{t(statusLabels[result.status])}
        {!live && <> · {t('app.errorQueueNoHardware')}</>}
      </p>
      {result.error && <p className="error" role="alert">{result.error}</p>}
      {result.entries.length > 0 && <table>
        <thead><tr><th scope="col">{t('app.errorQueueCode')}</th><th scope="col">{t('app.errorQueueMessage')}</th></tr></thead>
        <tbody>{result.entries.map(({ code, message }, index) => <tr key={index}>
          <td><code>{code}</code></td><td>{message}</td>
        </tr>)}</tbody>
      </table>}
    </div>}
  </>
}
