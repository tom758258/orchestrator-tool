import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

type ToolStatus = {
  tool_id: string
  path: string | null
  source: string | null
  executable_status: string
  compatibility: string
  tool_version: string | null
  worker_schema_versions: number[]
  reason: string | null
}

const EXECUTABLE_LABELS: Record<string, string> = {
  available: 'Available',
  missing: 'Missing',
  'not-file': 'Not a file',
  error: 'Error',
}

const COMPATIBILITY_LABELS: Record<string, string> = {
  compatible: 'Compatible',
  incompatible: 'Incompatible',
  'not-probed': '—',
  error: 'Error',
}

const SOURCE_LABELS: Record<string, string> = {
  configured: 'Configured',
  portable: 'Portable',
}

function formatWorkerSchemas(versions: number[]): string {
  if (versions.length === 0) {
    return '—'
  }
  return versions.join(', ')
}

function App() {
  const [tools, setTools] = useState<ToolStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const statuses = await invoke<ToolStatus[]>('get_tool_status')
      setTools(statuses)
      setError(null)
    } catch (message) {
      setError(String(message))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <main className="app">
      <header className="app-header">
        <h1>orchestrator-tool</h1>
        <h2>External Tools</h2>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </header>

      {error && (
        <p className="error" role="alert">
          Failed to load tool status: {error}
        </p>
      )}

      {loading && tools.length === 0 && !error && <p>Loading tool status…</p>}

      {!error && tools.length > 0 && (
        <ul className="tool-list">
          {tools.map((tool) => (
            <li key={tool.tool_id} className="tool-card">
              <div className="tool-title">
                <span className="tool-id">{tool.tool_id}</span>
                <span className={`status status-${tool.executable_status}`}>
                  {EXECUTABLE_LABELS[tool.executable_status] ?? tool.executable_status}
                </span>
              </div>
              <dl className="tool-details">
                <div className="detail-row">
                  <dt className="detail-label">Executable</dt>
                  <dd className="detail-value">
                    {EXECUTABLE_LABELS[tool.executable_status] ?? tool.executable_status}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt className="detail-label">Compatibility</dt>
                  <dd className={`detail-value compatibility-${tool.compatibility}`}>
                    {COMPATIBILITY_LABELS[tool.compatibility] ?? tool.compatibility}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt className="detail-label">Version</dt>
                  <dd className="detail-value">{tool.tool_version ?? '—'}</dd>
                </div>
                <div className="detail-row">
                  <dt className="detail-label">Worker Schema</dt>
                  <dd className="detail-value">
                    {formatWorkerSchemas(tool.worker_schema_versions)}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt className="detail-label">Source</dt>
                  <dd className="detail-value">
                    {tool.source ? (SOURCE_LABELS[tool.source] ?? tool.source) : '—'}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt className="detail-label">Path</dt>
                  <dd className="detail-value tool-path">{tool.path ?? '—'}</dd>
                </div>
                {tool.reason && (
                  <div className="detail-row">
                    <dt className="detail-label">Reason</dt>
                    <dd className="detail-value tool-reason">{tool.reason}</dd>
                  </div>
                )}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

export default App
