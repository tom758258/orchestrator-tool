export type RunGate = { current: boolean }

export function lastRunWorkspaceState(hasSnapshot: boolean, running: boolean, hasMetadata: boolean) {
  return {
    starting: hasSnapshot && running && !hasMetadata,
    visible: hasSnapshot && (running || hasMetadata),
  }
}

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

export async function prepareLastRunReplacement<T>(
  loadReplacement: () => Promise<T>,
  currentRunId: number | null,
  clearRun: (runId: number) => Promise<void>,
): Promise<T> {
  const replacement = await loadReplacement()
  if (currentRunId !== null) await clearRun(currentRunId)
  return replacement
}
