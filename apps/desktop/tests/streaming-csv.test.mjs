import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const streamingFn = source.slice(source.indexOf('function streamingOptions'), source.indexOf('function App()'))
const simulation = source.slice(source.indexOf('const runSimulation'), source.indexOf('const workflowBusy'))
const live = source.slice(source.indexOf('const runLive'), source.indexOf('const runSimulation'))
const panel = source.slice(source.indexOf('streaming-panel'), source.indexOf('csvStreamFeedback}\n                  </section>'))

test('streamingOptions no longer requires a destination CSV or custom output folder', () => {
  assert.doesNotMatch(streamingFn, /Select a destination CSV/)
  assert.doesNotMatch(streamingFn, /Select a destination folder/)
  assert.doesNotMatch(streamingFn, /throw new Error/)
})

test('streamingOptions signature and payload carry only the shared folder contract', () => {
  assert.doesNotMatch(streamingFn, /destinationPath/)
  assert.doesNotMatch(streamingFn, /destination_path/)
  assert.match(streamingFn, /output_folder/)
  assert.match(streamingFn, /timestamp/)
  assert.match(streamingFn, /all_pages/)
})

test('Selected Page explicit CSV destination state is removed', () => {
  assert.doesNotMatch(source, /streamDestination/)
  assert.doesNotMatch(source, /setStreamDestination/)
  assert.match(source, /streamOutputFolder/)
  assert.match(source, /setStreamOutputFolder/)
})

test('Streaming UI no longer offers Select CSV flows', () => {
  assert.doesNotMatch(panel, /Select CSV/)
  assert.doesNotMatch(panel, /Select a new CSV file/)
  assert.match(panel, /Select Folder/)
})

test('Selected Page and All Pages share one folder selection', () => {
  assert.match(panel, /streamOutputFolder/)
  assert.match(panel, /Default: <application folder>\/data/)
  assert.match(panel, /Use Default/)
  assert.match(panel, /setStreamOutputFolder\(null\)/)
  assert.match(panel, /selectOutputFolder\(\)/)
  const folderPicker = source.slice(source.indexOf('async function selectOutputFolder'), source.indexOf('const handleExport'))
  assert.match(folderPicker, /directory: true/)
  assert.match(folderPicker, /setStreamOutputFolder\(folder\)/)
})

test('Use Default and folder controls stay locked while a run is active', () => {
  assert.match(panel, /disabled=\{workflowBusy\}/)
})

test('Simulation still builds streaming options before replacing Last Run state', () => {
  assert.ok(simulation.indexOf('streamingOptions(') < simulation.indexOf('runIdRef.current = null'))
  assert.ok(simulation.indexOf('streamingOptions(') < simulation.indexOf('setRunWorkflowSnapshot(workflowDraft)'))
})

test('Live still builds streaming options before replacing Last Run state', () => {
  assert.ok(live.indexOf('streamingOptions(') < live.indexOf('runIdRef.current = null'))
  assert.ok(live.indexOf('streamingOptions(') < live.indexOf('setRunWorkflowSnapshot(workflowDraft)'))
})
