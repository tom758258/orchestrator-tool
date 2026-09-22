export type RunGate = { current: boolean }

export function claimRunGate(gate: RunGate): boolean {
  if (gate.current) return false
  gate.current = true
  return true
}

export function releaseRunGate(gate: RunGate): void {
  gate.current = false
}

export function isCurrentRunGeneration(generation: number | null, currentGeneration: number): boolean {
  return generation !== null && generation === currentGeneration
}
