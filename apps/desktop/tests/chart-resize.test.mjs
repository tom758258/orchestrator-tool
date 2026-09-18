import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'

test('Chart resize coalesces observations, ignores invalid/unchanged sizes and cancels on cleanup', () => {
  const source = readFileSync(new URL('../src/ChartPlot.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('  useEffect(() => {')
  const end = source.indexOf('  }, [charts, panel.id])', start)
  assert.ok(start >= 0 && end > start)
  const code = stripTypeScriptTypes('(() => {' + source.slice(start + '  useEffect(() => {'.length, end) + '})')
  let size = { width: 800, height: 400 }
  let observe, frame, disconnected = false, themeDisconnected = false, disposed = false
  let scheduled = 0, cancelled = 0
  const sizes = [], widths = []
  const chart = {
    getWidth: () => 800, getHeight: () => 400,
    resize(value) { sizes.push([value.width, value.height]) },
    dispose() { disposed = true },
  }
  const context = {
    container: { current: { getBoundingClientRect: () => size } },
    tooltip: { current: {} }, pointer: { current: {} }, instance: { current: null },
    lastValidSizeRef: { current: null }, resizeFrameRef: { current: null },
    charts: new Map(), panel: { id: 1 }, init: () => chart,
    setWidth(value) { widths.push(value) }, setThemeRevision() {},
    document: { documentElement: {} },
    ResizeObserver: class {
      constructor(callback) { observe = callback }
      observe() {}
      disconnect() { disconnected = true }
    },
    MutationObserver: class {
      observe() {}
      disconnect() { themeDisconnected = true }
    },
    requestAnimationFrame(callback) { frame = callback; return ++scheduled },
    cancelAnimationFrame() { frame = null; cancelled++ },
  }
  const cleanup = runInNewContext(code, context)()
  observe(); observe(); observe()
  assert.equal(scheduled, 1)
  size = { width: 900.9, height: 450.9 }
  frame()
  assert.deepEqual(sizes, [[900, 450]])
  assert.deepEqual(widths, [800, 900])
  for (const invalidOrSame of [
    { width: 0, height: 450 }, { width: 900, height: 0 },
    { width: NaN, height: 450 }, { width: Infinity, height: 450 },
    { width: 900.1, height: 450.1 },
  ]) {
    size = invalidOrSame
    observe(); frame()
  }
  assert.equal(sizes.length, 1)
  assert.deepEqual(widths, [800, 900])
  size = { width: 900, height: 500 }
  observe(); frame()
  assert.deepEqual(sizes, [[900, 450], [900, 500]])
  assert.deepEqual(widths, [800, 900])
  observe()
  cleanup()
  assert.equal(cancelled, 1)
  assert.equal(frame, null)
  assert.ok(disconnected && themeDisconnected && disposed)
  assert.equal(context.resizeFrameRef.current, null)
  assert.equal(context.charts.size, 0)
})
