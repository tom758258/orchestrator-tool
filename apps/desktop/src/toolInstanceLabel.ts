export function toolInstanceLabel(instance: { id: string; display_name?: string }, includeId = true): string {
  const name = instance.display_name?.trim()
  if (!name) return instance.id
  return includeId ? `${name} (${instance.id})` : name
}
