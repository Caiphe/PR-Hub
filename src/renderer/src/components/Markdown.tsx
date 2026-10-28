import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

// Links open in the system browser (main's window-open handler), never inside the app.
const components: Components = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- keep `node` off the DOM
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />
}

// Module-level so ReactMarkdown sees stable plugin lists across renders.
const remarkPlugins = [remarkGfm]
const rehypePlugins: Parameters<typeof ReactMarkdown>[0]['rehypePlugins'] = [
  [rehypeHighlight, { detect: false }]
]

// For one-line fields (summary, requirement notes): backticks and emphasis, no paragraphs.
const inlineComponents: Components = {
  ...components,
  p: ({ children }) => <>{children}</>
}

// Memoized: parsing and highlighting are the expensive part, and the text rarely changes
// (e.g. ticking a finding's checkbox re-renders every card but not its markdown).
export const Markdown = memo(function Markdown({
  children
}: {
  children: string
}): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
})

export const InlineMarkdown = memo(function InlineMarkdown({
  children,
  className
}: {
  children: string
  className?: string
}): React.JSX.Element {
  return (
    <span className={`markdown inline ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={inlineComponents}>
        {children}
      </ReactMarkdown>
    </span>
  )
})
