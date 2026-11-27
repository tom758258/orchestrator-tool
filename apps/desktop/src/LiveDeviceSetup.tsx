import { useState } from 'react'
import { useI18n } from './i18n/I18nProvider'
import ErrorQueueSetup, { type ErrorQueueSetupProps } from './ErrorQueueSetup'
import { deviceName, formatResourceCandidate, tcpEndpointParts, formatTcpEndpoint, type ResourceIdentity, type LiveResourceCandidate, type VisaBackend } from './resourceFormatting'
import type { ExecutionMode } from './executionMode'
import type { ToolInstance } from './toolSetup/types'

type LiveDeviceInstance = Exclude<ToolInstance, { tool: 'wavegen' }>

type Props = {
  instance: LiveDeviceInstance
  executionMode: ExecutionMode
  resourceIdentity: ResourceIdentity | null | undefined
  resourceDraft: string | undefined
  backendDraft: VisaBackend | undefined
  discoveredResources: LiveResourceCandidate[] | undefined
  discoveryError: string | null | undefined
  loading: boolean
  workflowBusy: boolean
  toolConfigBusy: string | null
  powersOperationBusy: string | null
  errorQueue?: ErrorQueueSetupProps
  onBackendChange: (instanceId: string, backend: VisaBackend) => void
  onTcpHostChange: (instanceId: string, host: string) => void
  onTcpPortChange: (instanceId: string, port: string) => void
  onResourceDraftChange: (instanceId: string, resource: string) => void
  onListResources: (instance: LiveDeviceInstance) => void | Promise<void>
  onSaveResource: (instanceId: string, clear: boolean) => void | Promise<void>
  onResourceCandidateSelect: (instanceId: string, resource: string) => void
}

export default function LiveDeviceSetup({
  instance,
  executionMode,
  resourceIdentity,
  resourceDraft,
  backendDraft,
  discoveredResources,
  discoveryError,
  loading,
  workflowBusy,
  toolConfigBusy,
  powersOperationBusy,
  errorQueue,
  onBackendChange,
  onTcpHostChange,
  onTcpPortChange,
  onResourceDraftChange,
  onListResources,
  onSaveResource,
  onResourceCandidateSelect,
}: Props) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(true)
  const id = instance.id

  const resourceEditor = <>
    <div className="live-device">
      {deviceName(resourceIdentity) && <span>{deviceName(resourceIdentity)}</span>}
      {resourceIdentity?.serial?.trim() && <span>{t("app.sN")}{resourceIdentity?.serial?.trim()}</span>}
      <code>{resourceDraft || t("app.noResourceConfigured")}</code>
      <span className="tool-setup-hint">{t("app.lastKnownIdentityNotAConnectionCheck")}</span>
    </div>
    <p className="tool-setup-hint">{t("app.storedLocallyNotIncludedInTemplateSaveResourceTo")}</p>
    {executionMode === 'simulate' && <p className="tool-setup-hint">{t("app.storedForLiveModeCurrentExecutionModeIsSimulation")}</p>}
    {instance.tool !== 'serial' && <label className="step-property-field">
      <span className="step-property-label">{t("app.vISABackend")}</span>
      <select value={backendDraft ?? 'system'}
        disabled={toolConfigBusy !== null || workflowBusy || loading || powersOperationBusy !== null}
        onChange={event => onBackendChange(id, event.target.value as VisaBackend)}>
        <option value="system">{t("app.systemVISA")}</option>
        <option value="@py">{t("app.pyVISAPyPy")}</option>
      </select>
    </label>}
    {instance.tool === 'serial' && instance.setup.transport === 'tcp' ? <>
      <label className="step-property-field">
        <span className="step-property-label">{t("app.tCPHost")}</span>
        <input type="text" value={tcpEndpointParts(resourceDraft ?? '').host}
          disabled={toolConfigBusy !== null || workflowBusy || loading}
          onChange={event => onTcpHostChange(id, event.target.value)} />
      </label>
      <label className="step-property-field">
        <span className="step-property-label">{t("app.tCPPort")}</span>
        <input type="number" min={1} max={65535} step={1}
          value={tcpEndpointParts(resourceDraft ?? '').port}
          disabled={toolConfigBusy !== null || workflowBusy || loading}
          onChange={event => onTcpPortChange(id, event.target.value)} />
      </label>
      <p className="tool-setup-hint">{t("app.enterTCPHostAndTCPPortAndSaveResource")}</p>
    </> : <label className="step-property-field">
      <span className="step-property-label">{instance.tool === 'serial' ? t("app.cOMPort") : t("app.liveResource")}</span>
      <input
        type="text"
        value={resourceDraft ?? ''}
        disabled={toolConfigBusy !== null || workflowBusy || loading}
        onChange={event => onResourceDraftChange(id, event.target.value)}
      />
    </label>}
    <div className="tool-actions">
      {(instance.tool !== 'serial' || instance.setup.transport !== 'tcp') && <button
        className="action-button"
        type="button"
        disabled={toolConfigBusy !== null || workflowBusy || loading}
        onClick={() => void onListResources(instance)}
      >
        {instance.tool === 'serial' ? t("app.listPorts") : t("app.listResources")}
      </button>}
      <button
        className="action-button"
        type="button"
        disabled={toolConfigBusy !== null || workflowBusy || loading ||
          (instance.tool === 'serial' && instance.setup.transport === 'tcp' && (
            !tcpEndpointParts(resourceDraft ?? '').host.trim()
            || !Number.isInteger(Number(tcpEndpointParts(resourceDraft ?? '').port))
            || Number(tcpEndpointParts(resourceDraft ?? '').port) < 1
            || Number(tcpEndpointParts(resourceDraft ?? '').port) > 65535
          ))}
        onClick={() => void onSaveResource(id, false)}
      >
        {t("app.saveResource")}</button>
      <button
        className="action-button"
        type="button"
        disabled={toolConfigBusy !== null || workflowBusy || loading}
        onClick={() => void onSaveResource(id, true)}
      >
        {t("app.clearResource")}</button>
    </div>
    {(instance.tool !== 'serial' || instance.setup.transport !== 'tcp') && discoveryError && (
      <p className="error" role="alert">{discoveryError}</p>
    )}
    {(instance.tool !== 'serial' || instance.setup.transport !== 'tcp') && discoveredResources?.length === 0 && (
      <p role="status">{t("app.noLiveResourcesFound")}</p>
    )}
    {(instance.tool !== 'serial' || instance.setup.transport !== 'tcp') && (discoveredResources?.length ?? 0) > 0 && (
      <label className="step-property-field discovered-resources">
        <span className="step-property-label">{t("app.discoveredResources")}</span>
        <select
          value=""
          disabled={toolConfigBusy !== null || workflowBusy || loading}
          onChange={event => onResourceCandidateSelect(id, event.target.value)}
        >
          <option value="">{t("app.selectDiscoveredResource")}</option>
          {discoveredResources?.map((candidate, index) => (
            <option key={index} value={candidate.resource}>{formatResourceCandidate(candidate)}</option>
          ))}
        </select>
      </label>
    )}
  </>

  return <div className="live-resource">
    <h4>
      <button type="button" className="action-button tool-setup-toggle" aria-expanded={expanded}
        aria-label={t("app.liveDevice", { value1: expanded ? t("app.collapse") : t("app.expand") })} onClick={() => setExpanded(!expanded)}>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>{t("app.liveDevice2")}</h4>
    <div hidden={!expanded}>
      {errorQueue ? <ErrorQueueSetup {...errorQueue}>{resourceEditor}</ErrorQueueSetup> : resourceEditor}
    </div>
  </div>
}
