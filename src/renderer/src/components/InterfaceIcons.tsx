type IconProps = {
  className?: string
}

export function BrandMark({ className = '' }: IconProps): React.JSX.Element {
  return (
    <span className={`brand-mark ${className}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="7" cy="5" r="2.25" />
        <circle cx="7" cy="19" r="2.25" />
        <circle cx="18" cy="19" r="2.25" />
        <path d="M7 7.25v9.5M18 16.75v-5.5A3.25 3.25 0 0 0 14.75 8H12" />
        <path d="m14.5 5.5-2.75 2.5 2.75 2.5" />
      </svg>
    </span>
  )
}

export function FieldIcon({ kind }: { kind: 'title' | 'link' | 'description' }): React.JSX.Element {
  if (kind === 'link') {
    return (
      <svg className="field-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="m8.1 11.9 3.8-3.8" />
        <path d="m6.25 13.75-1.1 1.1a3.05 3.05 0 0 1-4.3-4.3l2.5-2.5a3.05 3.05 0 0 1 4.3 0" />
        <path d="m13.75 6.25 1.1-1.1a3.05 3.05 0 0 1 4.3 4.3l-2.5 2.5a3.05 3.05 0 0 1-4.3 0" />
      </svg>
    )
  }

  if (kind === 'description') {
    return (
      <svg className="field-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M3 4.5h14M3 9h10M3 13.5h12M3 18h7" />
      </svg>
    )
  }

  return (
    <svg className="field-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M5 2.5h7l3 3v12H5z" />
      <path d="M12 2.5v3h3M7.5 10h5M7.5 13h5" />
    </svg>
  )
}

export function GitHubIcon({ className = '' }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.56 9.56 0 0 1 12 6.82c.85 0 1.7.11 2.5.34 1.9-1.29 2.74-1.02 2.74-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.86V21c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  )
}
