import { english, type Translate } from './i18n/index.ts'
import { toolInstanceLabel } from './toolInstanceLabel'
import type { ToolInstance } from './toolSetup/types'

export type ResourceIdentity = {
  manufacturer: string | null
  model: string | null
  model_id?: string | null
  serial: string | null
  identity: string | null
}

export type VisaBackend = 'system' | '@py'

export type LiveResourceCandidate = ResourceIdentity & { resource: string }

export function deviceName(identity: ResourceIdentity | null | undefined): string {
  return [identity?.manufacturer?.trim(), identity?.model?.trim()].filter(Boolean).join(' ')
    || identity?.identity?.trim() || ''
}

export function targetLabel(instance: ToolInstance, identity: ResourceIdentity | null | undefined): string {
  const name = identity?.model?.trim() || deviceName(identity)
  const serial = identity?.serial?.trim()
  const detail = [name, serial ? `[${serial}]` : ''].filter(Boolean).join(' ')
  const label = toolInstanceLabel(instance)
  return detail ? `${label} — ${detail}` : label
}

export function formatResourceCandidate(candidate: LiveResourceCandidate): string {
  const name = deviceName(candidate)
  const serial = candidate.serial?.trim()
  const detail = [name, serial ? `[${serial}]` : ''].filter(Boolean).join(' ')
  return detail ? `${detail} — ${candidate.resource}` : candidate.resource
}

export function tcpEndpointParts(resource: string): { host: string; port: string } {
  const bracketed = /^\[(.+)\]:(.*)$/.exec(resource)
  const simple = /^([^:]*):(.*)$/.exec(resource)
  const match = bracketed ?? simple
  return match ? { host: match[1], port: match[2] } : { host: '', port: '' }
}

export function formatTcpEndpoint(host: string, port: string): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`
}

export function formatLiveResourceConfirmation(
  instance: ToolInstance,
  resource: string,
  backend: VisaBackend,
  identity: ResourceIdentity | null | undefined,
  t: Translate = english,
): string {
  const lines = [`${instance.id} (${instance.tool})`]
  const name = deviceName(identity)
  const serial = identity?.serial?.trim()
  const modelId = identity?.model_id?.trim()
  if (modelId) lines.push(t("app.modelId", { value1: modelId }))
  if (name) {
    lines.push(name)
  }
  if (serial) {
    lines.push(`S/N: ${serial}`)
  }
  if (instance.tool === 'serial') lines.push(`${instance.setup.transport === 'tcp' ? t('app.tcpEndpoint') : t('app.comPort')}: ${resource}`)
  else lines.push(t("app.backend", { value1: backend === '@py' ? 'PyVISA-py (@py)' : 'System VISA' }), resource)
  return lines.join('\n')
}
