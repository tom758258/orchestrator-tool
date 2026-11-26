import { useI18n } from '../i18n/I18nProvider'
import { useState } from 'react'
import type { SerialSetup } from './types'

export default function SerialSetupFields({ value, onChange }: { value: SerialSetup; onChange: (v: SerialSetup) => void }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(true)
  const update = (change: Partial<SerialSetup>) => onChange({ ...value, ...change })
  const tcp = value.transport === 'tcp'
  return <>
    <h4 className="powers-section-heading">
      <button type="button" className="action-button tool-setup-toggle" aria-expanded={expanded}
        aria-label={t("toolSetupEditor.communicationSetup", { value1: expanded ? t("toolSetupEditor.collapse") : t("toolSetupEditor.expand") })} onClick={() => setExpanded(!expanded)}>
        {expanded ? '−' : '+'}
      </button>{t("toolSetupEditor.communicationSetup2")}</h4>
    <div hidden={!expanded}>
    <div className="serial-setup-fields">
    <label className="step-property-field"><span className="step-property-label">{t("toolSetupEditor.transport")}</span>
      <select aria-label={t("toolSetupEditor.transport")} value={value.transport}
        onChange={e => update({ transport: e.target.value as 'serial' | 'tcp' })}>
        <option value="serial">{t("toolSetupEditor.uARTCOMPort")}</option>
        <option value="tcp">{t("toolSetupEditor.tCPClient")}</option>
      </select></label>
    {tcp ? <>
      <label className="step-property-field"><span className="step-property-label">{t("toolSetupEditor.connectTimeoutMs")}</span>
        <input type="number" min={1} step={1} value={value.connect_timeout_ms ?? 3000}
          onChange={e => update({ connect_timeout_ms: Number(e.target.value) })} /></label>
      <p className="tool-setup-hint">{t("toolSetupEditor.tcpConnectTimeoutHelp")}</p>
      <label className="step-property-field"><span className="step-property-label">{t("toolSetupEditor.iOTimeoutMs")}</span>
        <input type="number" min={1} step={1} value={value.io_timeout_ms ?? 1000}
          onChange={e => update({ io_timeout_ms: Number(e.target.value) })} /></label>
      <p className="tool-setup-hint">{t("toolSetupEditor.tcpIOTimeoutHelp")}</p>
    </> : <>
      <label className="step-property-field"><span className="step-property-label">{t("toolSetupEditor.baudRate")}</span>
        <input type="number" min={1} step={1} value={value.baud} onChange={e => update({ baud: Number(e.target.value) })} /></label>
      <label className="step-property-field"><span className="step-property-label">{t("toolSetupEditor.dataBits")}</span>
        <select value={value.data_bits} onChange={e => update({ data_bits: Number(e.target.value) })}>
          {[5, 6, 7, 8].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
      <label className="step-property-field"><span className="step-property-label">{t("toolSetupEditor.parity")}</span>
        <select value={value.parity} onChange={e => update({ parity: e.target.value as SerialSetup['parity'] })}>
          <option value="none">{t("toolSetupEditor.none")}</option><option value="odd">{t("toolSetupEditor.odd")}</option><option value="even">{t("toolSetupEditor.even")}</option></select></label>
      <label className="step-property-field"><span className="step-property-label">{t("toolSetupEditor.stopBits")}</span>
        <select value={value.stop_bits} onChange={e => update({ stop_bits: Number(e.target.value) })}>
          <option value={1}>1</option><option value={2}>2</option></select></label>
      <label className="step-property-field"><span className="step-property-label">{t("toolSetupEditor.flowControl")}</span>
        <select value={value.flow_control} onChange={e => update({ flow_control: e.target.value as SerialSetup['flow_control'] })}>
          <option value="none">{t("toolSetupEditor.none")}</option><option value="software">{t("toolSetupEditor.software")}</option><option value="hardware">{t("toolSetupEditor.hardware")}</option></select></label>
      <label className="step-property-field"><span className="step-property-label">{t("toolSetupEditor.timeoutMs")}</span>
        <input type="number" min={0} step={1} value={value.timeout_ms} onChange={e => update({ timeout_ms: Number(e.target.value) })} /></label>
      <p className="tool-setup-hint">{t("toolSetupEditor.uartIOTimeoutHelp")}</p>
    </>}
    </div>
    </div>
  </>
}

