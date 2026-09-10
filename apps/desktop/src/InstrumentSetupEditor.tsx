// Mirrors the Core InstrumentSetup serialization used by Template schema v1.
export type MetersSetup = {
  measurement: 'voltage-dc' | 'current-dc'
  range_mode: 'auto' | 'manual'
  manual_range: number | null
  nplc: number
  auto_zero: 'on' | 'off' | 'once'
  dcv_input_impedance: 'default' | 'ten-megohm' | 'auto' | null
  current_terminal: number | null
}

export type InstrumentSetup = {
  meters: MetersSetup | null
}

type InstrumentSetupEditorProps = {
  value: InstrumentSetup
  onChange: (value: InstrumentSetup) => void
  disabled: boolean
}

function InstrumentSetupEditor({ value, onChange, disabled }: InstrumentSetupEditorProps) {
  const meters = value.meters

  return (
    <section className="instrument-setup" aria-labelledby="instrument-setup-title">
      <h3 id="instrument-setup-title">Instrument Setup</h3>
      <fieldset disabled={disabled}>
        <legend>Meters</legend>
        <label className="meters-setup-toggle">
          <input type="checkbox" checked={meters !== null} onChange={(event) => onChange({
            ...value,
            meters: event.target.checked ? {
              measurement: 'voltage-dc',
              range_mode: 'auto',
              manual_range: null,
              nplc: 1,
              auto_zero: 'on',
              dcv_input_impedance: null,
              current_terminal: null,
            } : null,
          })} />
          Configure Meters
        </label>
        {!meters && <p className="instrument-setup-hint">Configure Meters before running a sequence with Meter Measure.</p>}
        {meters && (
          <>
            <p className="instrument-setup-hint">Applied before the run starts. Trigger: Software.</p>
            <div className="meters-setup-fields">
              <label className="step-property-field">
                <span className="step-property-label">Measurement</span>
                <select value={meters.measurement} onChange={(event) => {
                  const measurement = event.target.value as MetersSetup['measurement']
                  onChange({ ...value, meters: {
                    ...meters,
                    measurement,
                    dcv_input_impedance: measurement === 'voltage-dc' ? meters.dcv_input_impedance : null,
                    current_terminal: measurement === 'current-dc' ? meters.current_terminal : null,
                  } })
                }}>
                  <option value="voltage-dc">DC Voltage</option>
                  <option value="current-dc">DC Current</option>
                </select>
              </label>
              <label className="step-property-field">
                <span className="step-property-label">Range Mode</span>
                <select value={meters.range_mode} onChange={(event) => onChange({
                  ...value, meters: { ...meters, range_mode: event.target.value as MetersSetup['range_mode'] },
                })}>
                  <option value="auto">Auto</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
              {meters.range_mode === 'manual' && (
                <label className="step-property-field">
                  <span className="step-property-label">Manual Range ({meters.measurement === 'voltage-dc' ? 'V' : 'A'})</span>
                  <input type="number" step="any" required value={meters.manual_range ?? ''}
                    onChange={(event) => onChange({
                      ...value, meters: { ...meters, manual_range: Number.isFinite(event.currentTarget.valueAsNumber) ? event.currentTarget.valueAsNumber : null },
                    })} />
                </label>
              )}
              <label className="step-property-field">
                <span className="step-property-label">NPLC</span>
                <input type="number" step="any" required value={meters.nplc}
                  onChange={(event) => {
                    const nplc = event.currentTarget.valueAsNumber
                    if (Number.isFinite(nplc)) onChange({ ...value, meters: { ...meters, nplc } })
                  }} />
              </label>
              <label className="step-property-field">
                <span className="step-property-label">Auto Zero</span>
                <select value={meters.auto_zero} onChange={(event) => onChange({
                  ...value, meters: { ...meters, auto_zero: event.target.value as MetersSetup['auto_zero'] },
                })}>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                  <option value="once">Once</option>
                </select>
              </label>
              {meters.measurement === 'voltage-dc' && (
                <label className="step-property-field">
                  <span className="step-property-label">Input Impedance</span>
                  <select value={meters.dcv_input_impedance ?? ''} onChange={(event) => onChange({
                    ...value, meters: { ...meters, dcv_input_impedance: (event.target.value || null) as MetersSetup['dcv_input_impedance'] },
                  })}>
                    <option value="">Not specified</option>
                    <option value="default">Default</option>
                    <option value="ten-megohm">10 MΩ</option>
                    <option value="auto">Auto</option>
                  </select>
                </label>
              )}
              {meters.measurement === 'current-dc' && (
                <label className="step-property-field">
                  <span className="step-property-label">Current Terminal (optional)</span>
                  <input type="number" min="0" max="4294967295" step="1" value={meters.current_terminal ?? ''}
                    onChange={(event) => {
                      if (event.currentTarget.validity.valid) onChange({
                        ...value, meters: { ...meters, current_terminal: event.currentTarget.value === '' ? null : event.currentTarget.valueAsNumber },
                      })
                    }} />
                </label>
              )}
            </div>
          </>
        )}
      </fieldset>
    </section>
  )
}

export default InstrumentSetupEditor
