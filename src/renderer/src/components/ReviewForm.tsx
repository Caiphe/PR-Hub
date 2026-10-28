import { useId, useMemo, useState } from 'react'
import { parsePrUrl, validateReviewInput, type ReviewInput } from '@shared/validate'
import { FieldIcon, GitHubIcon } from './InterfaceIcons'

interface Props {
  onSubmit: (input: ReviewInput) => void
  /** Pre-fills the form, e.g. with the last task when coming back from a review. */
  initialValues?: ReviewInput
}

type Field = keyof ReviewInput

const EMPTY: ReviewInput = { title: '', prUrl: '', description: '' }
const isMac = navigator.userAgent.includes('Mac')

export function ReviewForm({ onSubmit, initialValues }: Props): React.JSX.Element {
  const [values, setValues] = useState<ReviewInput>(initialValues ?? EMPTY)
  // Errors appear only after a field has been left once, so the form doesn't shout while typing.
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({})
  const errors = useMemo(() => validateReviewInput(values), [values])
  const isValid = Object.keys(errors).length === 0
  const id = useId()

  const update = (field: Field) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValues((v) => ({ ...v, [field]: e.target.value }))
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
      description: values.description.trim()
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
          autoFocus
        />
        {errorText('title')}
      </div>

      <div className="field">
        <label htmlFor={`${id}-prUrl`}>
          <FieldIcon kind="link" />
          PR link
        </label>
        <div className="input-with-icon">
          <GitHubIcon className="input-leading-icon" />
          <input
            {...fieldProps('prUrl')}
            type="url"
            inputMode="url"
            placeholder="https://github.com/owner/repo/pull/123"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        {errorText('prUrl')}
        {!shownError('prUrl') && (
          <p className="field-help" id={`${id}-prUrl-help`}>
            Paste the full GitHub pull request URL.
          </p>
        )}
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
