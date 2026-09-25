import type { ToolActionStep } from './workflow'

export type PowerSetpoint = 'voltage' | 'current'

export function hasPowerSetpoint(step: ToolActionStep, name: PowerSetpoint): boolean {
  return Object.hasOwn(step.arguments, name) || Object.hasOwn(step.bindings ?? {}, name)
}

export function togglePowerSetpoint(step: ToolActionStep, name: PowerSetpoint, enabled: boolean): ToolActionStep {
  if (!enabled && !hasPowerSetpoint(step, name === 'voltage' ? 'current' : 'voltage')) return step

  const arguments_ = { ...step.arguments }
  const bindings = { ...step.bindings }
  delete arguments_[name]
  delete bindings[name]
  if (enabled) arguments_[name] = name === 'voltage' ? 5.0 : 1.0

  const updated: ToolActionStep = { ...step, arguments: arguments_, bindings }
  if (Object.keys(bindings).length === 0) delete updated.bindings
  return updated
}
