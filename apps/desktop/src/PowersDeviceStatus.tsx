import { useI18n } from './i18n/I18nProvider'
import type { ExecutionMode } from './executionMode'
import type { ToolInstance } from './toolSetup/types'

export type PowersProtectionStatus = {
  protection_tripped: boolean
  over_voltage_tripped: boolean
  over_current_tripped: boolean
  channels: {
    channel: number
    output_enabled: boolean
    over_voltage_tripped: boolean
    over_current_tripped: boolean
  }[]
}

export type PowersStatusState = {
  status: PowersProtectionStatus | null
  error: string | null
  operation: 'refresh' | 'clear' | null
  clearPlan: { channel: number } | null
  clearCompleted: boolean
}

export type PowersClearResult =
  | { mode: 'simulate'; outcome: 'planned'; plan: unknown }
  | { mode: 'live'; outcome: 'completed'; status: PowersProtectionStatus }

type Props = {
  instance: Extract<ToolInstance, { tool: 'powers' }>
  deviceStatus: PowersStatusState | undefined
  executionMode: ExecutionMode
  resourceReady: boolean
  workflowBusy: boolean
  operationBusy: boolean
  toolConfigBusy: string | null
  capabilityChannels: number[]
  statusChannels: number[]
  onRefresh: (instanceId: string) => void | Promise<void>
  onClear: (instanceId: string, channel: PowersProtectionStatus['channels'][number]) => void | Promise<void>
}

export default function PowersDeviceStatus({
  instance,
  deviceStatus,
  executionMode,
  resourceReady,
  workflowBusy,
  operationBusy,
  toolConfigBusy,
  capabilityChannels,
  statusChannels,
  onRefresh,
  onClear,
}: Props) {
  const { t } = useI18n()
  const clearPlan = deviceStatus?.clearPlan ?? null
  const unresolved = deviceStatus?.status?.channels.some(channel =>
    (channel.over_voltage_tripped || channel.over_current_tripped))
  const outputOn = deviceStatus?.status?.channels.some(channel => channel.output_enabled)

  return <div className="live-resource powers-device-status">
    <h5>{t("app.deviceStatus")}</h5>
    <p className="tool-setup-hint">{t("app.notSavedInTemplateStatusIsReadOnlyWhen")}</p>
    {executionMode === 'simulate'
      ? <p className="tool-setup-hint">{t("app.usesTheSimulatorModelNoSavedLiveResourceIs")}</p>
      : !resourceReady && <p className="tool-setup-hint">{t("app.saveTheLiveResourceBelowBeforeUsingDeviceStatus")}</p>}
    <button className="action-button" type="button"
      disabled={!resourceReady || workflowBusy || operationBusy}
      onClick={() => void onRefresh(instance.id)}>
      {deviceStatus?.operation === 'refresh' ? t("app.refreshing") : t("app.refreshStatus")}
    </button>
    {deviceStatus?.operation === 'clear' && <p role="status">{executionMode === 'simulate' ? t("app.generatingClearPlan") : t("app.clearingProtection")}</p>}
    {deviceStatus?.error && <p className="error" role="alert">{deviceStatus.error}</p>}
    {clearPlan !== null && <div className="simulation-plan-result" role="status">
      <strong>{t("app.pLANGENERATEDSIMULATION")}</strong>
      <p>{t("app.nOHARDWAREIO")}</p>
      <p>{t("app.noRealProtectionLatchWasChanged")}</p>
      <details><summary>{t("app.showPlan")}</summary>
        <strong>{t("app.cLEARPROTECTIONPLANSIMULATION")}</strong>
        <dl className="tool-details">
          <div className="detail-row"><dt className="detail-label">{t("app.target")}</dt><dd className="detail-value">{instance.id} {t("app.channel2")}{clearPlan.channel}</dd></div>
          <div className="detail-row"><dt className="detail-label">{t("app.safety")}</dt><dd className="detail-value">{t("app.allPowerOutputsWillBeTurnedOFFFirst")}</dd></div>
          <div className="detail-row"><dt className="detail-label">{t("app.action")}</dt><dd className="detail-value">{t("app.clearChannel")}{clearPlan.channel} {t("app.protection")}</dd></div>
          <div className="detail-row"><dt className="detail-label">{t("app.finalOutput")}</dt><dd className="detail-value">{t("app.remainsOFF")}</dd></div>
          <div className="detail-row"><dt className="detail-label">{t("app.hardwareIO")}</dt><dd className="detail-value">{t("app.none")}</dd></div>
        </dl>
      </details>
    </div>}
    {deviceStatus?.clearCompleted && <p className="validation-success" role="status">{t("app.protectionClearCompletedInLIVEModeRealHardwareWas")}</p>}
    <section className="powers-protection-summary" aria-label={t("app.protectionSummary")}>
      <h6>{t("app.protectionSummary")}</h6>
      <dl>
        {([
          [t("app.protection2"), deviceStatus?.status?.protection_tripped, t("app.cLEAR")],
          ['OVP', deviceStatus?.status?.over_voltage_tripped, t("app.oK")],
          ['OCP', deviceStatus?.status?.over_current_tripped, t("app.oK")],
        ] as const).map(([label, tripped, clearLabel]) => <div key={label}>
          <dt>{label}</dt>
          <dd className={tripped === undefined ? 'powers-status-unknown'
            : tripped ? 'powers-status-tripped' : 'powers-status-clear'}>
            {tripped === undefined ? '—' : tripped ? t("app.tripped") : clearLabel}
          </dd>
        </div>)}
      </dl>
    </section>
    <div className="powers-table-scroll">
      <table className="powers-status-table">
        <thead><tr><th scope="col">{t("app.channel")}</th><th scope="col">{t("app.output")}</th><th scope="col">{t("app.oVP")}</th><th scope="col">{t("app.oCP")}</th><th scope="col">{t("app.action")}</th></tr></thead>
        <tbody>{statusChannels.map(channel => {
          const status = deviceStatus?.status?.channels.find(record => record.channel === channel)
          const canClear = executionMode === 'simulate'
            ? capabilityChannels.includes(channel)
            : Boolean(status && (status.over_voltage_tripped || status.over_current_tripped))
          return <tr key={channel}>
            <th scope="row">{channel}</th>
            <td>{status ? status.output_enabled ? t("app.oN") : t("app.oFF") : '—'}</td>
            <td>{status ? status.over_voltage_tripped ? t("app.tripped") : t("app.oK") : '—'}</td>
            <td>{status ? status.over_current_tripped ? t("app.tripped") : t("app.oK") : '—'}</td>
            <td><button className={`action-button ${executionMode === 'live' ? 'action-button-danger' : ''}`} type="button"
              disabled={!resourceReady || workflowBusy || operationBusy || toolConfigBusy !== null || !canClear}
              onClick={() => void onClear(instance.id, status ?? {
                channel, output_enabled: false, over_voltage_tripped: false, over_current_tripped: false,
              })}>
              {executionMode === 'simulate' ? t("app.generateClearPlan") : t("app.clearProtection")}
            </button></td>
          </tr>
        })}</tbody>
      </table>
    </div>
    {deviceStatus?.status && <>
      {unresolved && <p className="error" role="alert">{t("app.protectionRemainsTripped")}</p>}
      {outputOn && <p className="error" role="alert">{t("app.warningPostOperationStatusReportsAnOutputIsStill")}</p>}
    </>}
    {executionMode === 'live' && <p className="tool-setup-hint">{t("app.ifRemoteClearIsUnsupportedForThisModelClear")}</p>}
  </div>
}
