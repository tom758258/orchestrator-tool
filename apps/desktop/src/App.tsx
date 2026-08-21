import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

type ToolStatus = {
  tool_id: string
  path: string
  source: string
  status: string
}

const STATUS_LABELS: Record<string, string> = {
  available: 'Available',
  missing: 'Missing',
  'not-file': 'Not a file',
}

const SOURCE_LABELS: Record<string, string> = {
  configured: 'Configured',
  portable: 'Portable',
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
                <span className={`status status-${tool.status}`}>
                  {STATUS_LABELS[tool.status] ?? tool.status}
                </span>
              </div>
              <p className="tool-source">{SOURCE_LABELS[tool.source] ?? tool.source}</p>
              <p className="tool-path">{tool.path}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

export default App
