export const EXECUTION_WINDOW_SIZE = 200

// Read only the requested newest-first window from chronological storage.
export function executionWindow<T>(executions: readonly T[], offset: number, size: number) {
  const total = executions.length
  const lastOffset = Math.max(0, (Math.ceil(total / size) - 1) * size)
  const boundedOffset = Math.min(Math.max(0, offset), lastOffset)
  const end = Math.min(total, boundedOffset + size)
  const items = Array.from({ length: end - boundedOffset }, (_, index) =>
    executions[total - 1 - boundedOffset - index])
  return {
    items, total, offset: boundedOffset, start: total === 0 ? 0 : boundedOffset + 1, end,
    hasNewer: boundedOffset > 0, hasOlder: end < total,
  }
}
