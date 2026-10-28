import { useState } from 'react'
import type { Finding, Findings, Requirement } from '@shared/findings'
import { codeFence, languageForFile, looksLikeProse } from '@shared/markdown'
import { VERDICTS } from '../review/verdict'
import { InlineMarkdown, Markdown } from './Markdown'

const REQUIREMENT_STATUS: Record<Requirement['status'], { label: string; tone: string }> = {
  done: { label: 'Done', tone: 'good' },
  partial: { label: 'Partial', tone: 'warn' },
  missing: { label: 'Missing', tone: 'bad' }
}

const GROUPS: Array<{ severity: Finding['severity']; title: string; tone: string }> = [
  { severity: 'blocking', title: 'Blocking', tone: 'bad' },
  { severity: 'should_fix', title: 'Should fix', tone: 'warn' },
  { severity: 'nit', title: 'Nits', tone: 'muted' }
]

function location(finding: Finding): string | null {
  if (!finding.file) return null
  return finding.line ? `${finding.file}:${finding.line}` : finding.file
}

/** Present when findings can be picked for posting to GitHub. */
export interface FindingSelection {
  selected: Set<string>
  posted: Set<string>
  toggle: (id: string) => void
}

function FindingCard({
  finding,
  selection
}: {
  finding: Finding
  selection?: FindingSelection
}): React.JSX.Element {
  // Nits start collapsed; anything that needs action starts open.
  const [open, setOpen] = useState(finding.severity !== 'nit')
  const loc = location(finding)
  const bodyId = `finding-${finding.id}`
  const posted = selection?.posted.has(finding.id) ?? false

  return (
    <article className={`finding-card ${open ? 'is-open' : ''}`}>
      <div className="finding-row">
        {selection && (
          // A sibling of the toggle button: interactive elements can't nest inside a button.
          <input
            type="checkbox"
            className="finding-check"
            checked={selection.selected.has(finding.id)}
            onChange={() => selection.toggle(finding.id)}
            aria-label={`Include "${finding.title}" when posting to GitHub`}
          />
        )}
        <button
          type="button"
          className="finding-head"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="chevron" aria-hidden="true">
            ›
          </span>
          <span className="finding-title">{finding.title}</span>
          {posted && <span className="pill pill-good">Posted</span>}
          {loc && <code className="location">{loc}</code>}
        </button>
      </div>
      {open && (
        <div className="finding-body" id={bodyId}>
          {finding.body && <Markdown>{finding.body}</Markdown>}
          {finding.suggestion &&
            (looksLikeProse(finding.suggestion) ? (
              <>
                <div className="suggestion-label">Suggested fix</div>
                <Markdown>{finding.suggestion}</Markdown>
              </>
            ) : (
              <>
                <div className="suggestion-label">Suggested change</div>
                <Markdown>{codeFence(finding.suggestion, languageForFile(finding.file))}</Markdown>
              </>
            ))}
        </div>
      )}
    </article>
  )
}

export function FindingsPanel({
  findings,
  selection
}: {
  findings: Findings
  selection?: FindingSelection
}): React.JSX.Element {
  const verdict = VERDICTS[findings.verdict]
  const groups = GROUPS.map((g) => ({
    ...g,
    items: findings.findings.filter((f) => f.severity === g.severity)
  })).filter((g) => g.items.length > 0)

  return (
    <div className="findings-panel">
      <section className="verdict">
        <span className={`pill pill-${verdict.tone} pill-lg`}>{verdict.label}</span>
        {findings.summary && (
          <p>
            <InlineMarkdown>{findings.summary}</InlineMarkdown>
          </p>
        )}
      </section>

      {findings.requirements.length > 0 && (
        <section>
          <h2 className="section-title">Does it do the task?</h2>
          <ul className="requirements">
            {findings.requirements.map((r, i) => {
              const status = REQUIREMENT_STATUS[r.status]
              return (
                <li key={i}>
                  <span className={`pill pill-${status.tone}`}>{status.label}</span>
                  <div>
                    <div>
                      <InlineMarkdown>{r.text}</InlineMarkdown>
                    </div>
                    {r.notes && (
                      <div className="muted small">
                        <InlineMarkdown>{r.notes}</InlineMarkdown>
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {groups.length === 0 ? (
        <p className="muted">No issues found.</p>
      ) : (
        groups.map((g) => (
          <section key={g.severity}>
            <h2 className="section-title">
              <span className={`dot dot-${g.tone}`} aria-hidden="true" />
              {g.title} <span className="count">{g.items.length}</span>
            </h2>
            <div className="finding-list">
              {g.items.map((f) => (
                <FindingCard key={f.id} finding={f} selection={selection} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
