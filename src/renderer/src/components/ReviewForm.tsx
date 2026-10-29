import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { LinkedIssue, PrMetadata } from '@shared/github'
import {
  parsePrUrl,
  validateReviewInput,
  type ReviewInput,
  type TaskSource
} from '@shared/validate'
import {
  clearAutoFilled,
  currentPrKey,
  forceFill,
  isCurrent,
  planFill,
  SOURCE_LABELS,
  taskFromIssue,
  taskFromPr,
  type AutoFilled,
  type FillPlan,
  type TaskText
} from '../review/intake'
import { useGitHubStatus } from '../review/useGitHubStatus'
import { usePrInspection } from '../review/usePrInspection'
import { GitHubStatusChip, GitHubStatusPanel } from './GitHubStatus'
import { FieldIcon, GitHubIcon } from './InterfaceIcons'
import { PrSummary } from './PrSummary'

interface Props {
  onSubmit: (input: ReviewInput) => void
  /** Pre-fills the form, e.g. with the last task when coming back from a review. */
  initialValues?: ReviewInput
}

type Field = 'title' | 'prUrl' | 'description'

/** Which task source is chosen: the PR, "manual", or a linked issue by its URL. */
type Choice = { source: 'pr' | 'manual' } | { source: 'issue'; url: string }

interface PendingFill {
  choice: Choice
  incoming: TaskText
  plan: FillPlan
  fromPr: string | null
}

type AppliedFill = Omit<FillPlan, 'conflicts'> & { conflicts?: FillPlan['conflicts'] }

const EMPTY: ReviewInput = { title: '', prUrl: '', description: '' }
const isMac = navigator.userAgent.includes('Mac')
const FIELD_NAMES: Record<keyof TaskText, string> = { title: 'title', description: 'description' }

export function ReviewForm({ onSubmit, initialValues }: Props): React.JSX.Element {
  const [values, setValues] = useState<ReviewInput>(initialValues ?? EMPTY)
  // Errors appear only after a field has been left once, so the form doesn't shout while typing.
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({})
  // What PR Hub last filled in. Text that differs from it was written by the user and is never
  // replaced without asking. Pre-filled values (coming back from a review) count as the user's.
  const [auto, setAuto] = useState<AutoFilled>({})
  const [choice, setChoice] = useState<Choice>({
    source: initialValues?.taskSource === 'pr' ? 'pr' : 'manual'
  })
  // Where the description text came from; sent with the review so the prompt can mark
  // author-written task text as untrusted.
  const [descriptionSource, setDescriptionSource] = useState<TaskSource>(
    initialValues?.taskSource ?? 'manual'
  )
  const [pending, setPending] = useState<PendingFill | null>(null)
  const [issueState, setIssueState] = useState<{ url: string; error?: string } | null>(null)
  const errors = useMemo(() => validateReviewInput(values), [values])
  const isValid = Object.keys(errors).length === 0
  const id = useId()
  // Guidance only: reviews of public PRs don't need gh, so this never blocks submitting.
  const github = useGitHubStatus()

  // The PR that the auto-filled text came from.
  const [autoFor, setAutoFor] = useState<string | null>(null)

  // Latest form state for async callbacks (inspection and issue replies).
  const stateRef = useRef({ values, auto, autoFor })
  useEffect(() => {
    stateRef.current = { values, auto, autoFor }
  })
  // The issue being loaded; a reply for anything else (or after choosing another source) is dropped.
  const issueRequest = useRef<string | null>(null)

  const applyPlan = (c: Choice, plan: AppliedFill, fromPr: string | null): void => {
    setValues((v) => ({ ...v, ...plan.next }))
    setAuto(plan.auto)
    setAutoFor(fromPr)
    setPending(null)
    // The description decides the source: it's the text the review is graded against.
    if (!plan.conflicts?.includes('description')) {
      setDescriptionSource(c.source)
      setChoice(c)
    }
  }

  /**
   * Fills from PR or issue text. Fields the user edited are kept. When the user picked this
   * source (`ask`), nothing changes until they choose Replace or Keep mine.
   */
  const fill = (c: Choice, incoming: TaskText, ask: boolean, fromPr: string | null): void => {
    const { values: current, auto: filled } = stateRef.current
    const plan = planFill(current, filled, incoming)
    if (ask && plan.conflicts.length > 0) {
      setChoice(c)
      setPending({ choice: c, incoming, plan, fromPr })
    } else {
      applyPlan(c, plan, fromPr)
    }
  }

  // A newly inspected PR fills empty (or still auto-filled) fields; it never asks or overwrites.
  // If the new PR can't be read, text auto-filled from a different PR is removed, since it
  // describes the wrong change. Text the user edited always stays.
  const onSettled = (url: string, inspected: PrMetadata | null): void => {
    issueRequest.current = null
    setIssueState(null)
    if (inspected) return fill({ source: 'pr' }, taskFromPr(inspected), false, url)
    const { values: current, auto: filled, autoFor: filledFrom } = stateRef.current
    if (!filledFrom || filledFrom === url) return
    const cleared = clearAutoFilled(current, filled)
    setValues((v) => ({ ...v, ...cleared }))
    setAuto({})
    setAutoFor(null)
    setPending(null)
    setChoice({ source: 'manual' })
    if (!cleared.description) setDescriptionSource('manual')
  }
  const { inspection, retry } = usePrInspection(values.prUrl, onSettled)
  const pr = inspection?.status === 'ready' ? inspection.pr : null

  const chooseIssue = (issue: LinkedIssue): void => {
    const prUrl = currentPrKey(values.prUrl)
    setPending(null)
    setIssueState({ url: issue.url })
    issueRequest.current = issue.url
    // Ignore the reply if the user moved on to another PR or source meanwhile.
    const stillWanted = (): boolean =>
      issueRequest.current === issue.url &&
      !!prUrl &&
      isCurrent(prUrl, stateRef.current.values.prUrl)
    window.api
      .inspectIssue(issue.url)
      .then((res) => {
        if (!stillWanted()) return
        issueRequest.current = null
        if (!res.ok)
          return setIssueState({ url: issue.url, error: res.problem?.title ?? res.error })
        setIssueState(null)
        fill({ source: 'issue', url: issue.url }, taskFromIssue(res.issue), true, prUrl)
      })
      .catch((error: Error) => {
        if (stillWanted()) setIssueState({ url: issue.url, error: error.message })
      })
  }

  const choose = (c: Choice): void => {
    issueRequest.current = null
    setIssueState(null)
    if (c.source === 'pr' && pr) {
      fill(c, taskFromPr(pr), true, pr.url)
    } else if (c.source === 'manual') {
      setPending(null)
      setValues((v) => ({ ...v, ...clearAutoFilled(v, auto) }))
      setAuto({})
      setAutoFor(null)
      setChoice(c)
      setDescriptionSource('manual')
    }
  }

  const confirmReplace = (): void => {
    if (pending)
      applyPlan(pending.choice, forceFill(pending.plan, pending.incoming), pending.fromPr)
  }

  // Keep the edited fields, but still fill the ones the user hadn't touched.
  const keepMine = (): void => {
    if (!pending) return
    applyPlan(pending.choice, pending.plan, pending.fromPr)
    // The radio shows where the description (which the user kept) came from.
    if (pending.plan.conflicts.includes('description') && descriptionSource !== 'issue') {
      setChoice({ source: descriptionSource })
    }
  }

  const update =
    (field: Field) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value
      setValues((v) => ({ ...v, [field]: value }))
      // Clearing the description entirely means whatever comes next is the user's own.
      if (field === 'description' && value.trim() === '') setDescriptionSource('manual')
    }
  const touch = (field: Field) => () => setTouched((t) => ({ ...t, [field]: true }))
  const shownError = (field: Field): string | undefined =>
    touched[field] ? errors[field] : undefined

  const submit = (): void => {
    if (!isValid) {
      setTouched({ title: true, prUrl: true, description: true })
      return
    }
    onSubmit({
      title: values.title.trim(),
      // Canonical form: drops /files, query strings and anchors.
      prUrl: parsePrUrl(values.prUrl)?.url ?? values.prUrl.trim(),
      description: values.description.trim(),
      taskSource: descriptionSource
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  }

  const fieldProps = (
    field: Field
  ): React.InputHTMLAttributes<HTMLInputElement> &
    React.TextareaHTMLAttributes<HTMLTextAreaElement> => ({
    id: `${id}-${field}`,
    value: values[field],
    onChange: update(field),
    onBlur: touch(field),
    'aria-invalid': Boolean(shownError(field)),
    'aria-describedby': shownError(field)
      ? `${id}-${field}-error`
      : field === 'prUrl'
        ? `${id}-prUrl-help`
        : undefined
  })

  const errorText = (field: Field): React.JSX.Element | null =>
    shownError(field) ? (
      <p className="field-error" id={`${id}-${field}-error`} role="alert">
        {shownError(field)}
      </p>
    ) : null

  const isChosen = (c: Choice): boolean =>
    c.source === choice.source &&
    (c.source !== 'issue' || (choice.source === 'issue' && choice.url === c.url))

  return (
    <form
      className="review-form"
      noValidate
      onKeyDown={handleKeyDown}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="field">
        <div className="field-head">
          <label htmlFor={`${id}-prUrl`}>
            <FieldIcon kind="link" />
            PR link
            <span className="required-mark" aria-hidden="true">
              *
            </span>
          </label>
          <GitHubStatusChip state={github} />
        </div>
        <div className="input-with-icon">
          <GitHubIcon className="input-leading-icon" />
          <input
            {...fieldProps('prUrl')}
            type="url"
            inputMode="url"
            placeholder="https://github.com/owner/repo/pull/123"
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
        </div>
        {errorText('prUrl')}
        {!shownError('prUrl') && !inspection && (
          <p className="field-help" id={`${id}-prUrl-help`}>
            Paste a GitHub pull request link. PR Hub fills in the task from it.
          </p>
        )}
        <GitHubStatusPanel state={github} prUrl={values.prUrl} />
        {inspection && <PrSummary inspection={inspection} onRetry={retry} />}
      </div>

      {pr && (
        <fieldset className="field task-source">
          <legend>Task from</legend>
          {pr.linkedIssues.map((issue) => (
            <label key={issue.url} className="task-source-option">
              <input
                type="radio"
                name={`${id}-source`}
                checked={isChosen({ source: 'issue', url: issue.url })}
                onChange={() => chooseIssue(issue)}
              />
              <span>
                {SOURCE_LABELS.issue}{' '}
                <code>
                  {issue.owner === pr.owner && issue.repo === pr.repo
                    ? `#${issue.number}`
                    : `${issue.owner}/${issue.repo}#${issue.number}`}
                </code>
                <span className="task-source-hint">
                  {issue.relation === 'closes' ? ' · the PR closes it' : ' · linked'}
                </span>
                {issueState?.url === issue.url && !issueState.error && (
                  <span className="task-source-hint" aria-live="polite">
                    {' '}
                    · loading…
                  </span>
                )}
              </span>
            </label>
          ))}
          {(['pr', 'manual'] as const).map((source) => (
            <label key={source} className="task-source-option">
              <input
                type="radio"
                name={`${id}-source`}
                checked={isChosen({ source })}
                onChange={() => choose({ source })}
              />
              <span>{SOURCE_LABELS[source]}</span>
            </label>
          ))}
          {issueState?.error && (
            <p className="field-error" role="alert">
              Couldn&apos;t load the issue: {issueState.error}
            </p>
          )}
          {pending && (
            <div className="fill-confirm" role="alert">
              <p>
                You edited the task{' '}
                {pending.plan.conflicts.map((f) => FIELD_NAMES[f]).join(' and ')}. Replace{' '}
                {pending.plan.conflicts.length > 1 ? 'them' : 'it'} with the{' '}
                {pending.choice.source === 'issue' ? "issue's" : "PR's"} text?
              </p>
              <div className="row">
                <button type="button" className="secondary small-button" onClick={confirmReplace}>
                  Replace
                </button>
                <button type="button" className="secondary small-button" onClick={keepMine}>
                  Keep mine
                </button>
              </div>
            </div>
          )}
          {descriptionSource !== 'manual' && (
            <p className="field-help">
              Filled from the {descriptionSource === 'issue' ? 'issue' : 'PR'}. Check and edit it:
              the review is graded against this text.
            </p>
          )}
        </fieldset>
      )}

      <div className="field">
        <label htmlFor={`${id}-title`}>
          <FieldIcon kind="title" />
          Task title
          <span className="required-mark" aria-hidden="true">
            *
          </span>
        </label>
        <input
          {...fieldProps('title')}
          type="text"
          placeholder="Fix login redirect after session timeout"
        />
        {errorText('title')}
      </div>

      <div className="field field-grow">
        <label htmlFor={`${id}-description`}>
          <FieldIcon kind="description" />
          Task description
        </label>
        <textarea
          {...fieldProps('description')}
          placeholder="What should this PR accomplish? Paste the ticket, acceptance criteria, edge cases…"
        />
        {errorText('description')}
      </div>

      <div className="form-actions">
        <span className="hint">
          <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd>
          <span>+</span>
          <kbd>Enter</kbd>
        </span>
        <button type="submit" className="primary" disabled={!isValid}>
          <GitHubIcon className="button-icon" />
          Review PR
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </form>
  )
}
