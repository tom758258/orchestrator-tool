import { useState, type ReactNode } from 'react'

export default function Collapsible({ title, children, actions, className = '' }: {
  title: string; children: ReactNode; actions?: ReactNode; className?: string
}) {
  const [expanded, setExpanded] = useState(true)
  return <section className={className} aria-label={title}>
    <div className="section-header">
      <h3><button className="collapse-button" type="button" aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${title}`} onClick={() => setExpanded(value => !value)}>
        {expanded ? '−' : '+'}</button> {title}</h3>
      {actions}
    </div>
    <div hidden={!expanded}>{children}</div>
  </section>
}
