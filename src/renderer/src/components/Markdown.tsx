import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

// Links open in the system browser (main's window-open handler), never inside the app.
const components: Components = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- keep `node` off the DOM
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />
}

// For one-line fields (summary, requirement notes): backticks and emphasis, no paragraphs.
const inlineComponents: Components = {
  ...components,
  p: ({ children }) => <>{children}</>
}

export function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

export function InlineMarkdown({
  children,
  className
}: {
  children: string
  className?: string
}): React.JSX.Element {
  return (
    <span className={`markdown inline ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={inlineComponents}>
        {children}
      </ReactMarkdown>
    </span>
  )
}
