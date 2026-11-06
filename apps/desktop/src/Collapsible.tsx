import { useState, type ReactNode } from 'react'

export default function Collapsible({ title, children, actions, headingActions, className = '', framed = false }: {
  title: string; children: ReactNode; actions?: ReactNode; headingActions?: ReactNode; className?: string; framed?: boolean
}) {
  const [expanded, setExpanded] = useState(true)
  const heading = <h3><button className="collapse-button" type="button" aria-expanded={expanded}
    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${title}`} onClick={() => setExpanded(value => !value)}>
    {expanded ? '−' : '+'}</button> {title}</h3>
  if (framed) return <fieldset className={`output-section ${className}`} role="region" aria-label={title}>
    <legend>{headingActions ? <div className="collapsible-legend-row">{heading}{headingActions}</div> : heading}</legend>
    <div hidden={!expanded}>{actions}{children}</div>
  </fieldset>
  return <section className={className} aria-label={title}>
    <div className="section-header">
      {heading}
      {actions}
    </div>
    <div hidden={!expanded}>{children}</div>
  </section>
}
