'use client'

import React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'

const components: React.ComponentProps<typeof Markdown>['components'] = {
  pre({ children }) {
    // Strip Tailwind Typography's <pre> styling — SyntaxHighlighter provides its own
    return <>{children}</>
  },
  code({ className, children, ...rest }) {
    const match = /language-(\w+)/.exec(className || '')
    const codeString = String(children).replace(/\n$/, '')

    if (match) {
      return (
        <SyntaxHighlighter
          style={oneLight}
          language={match[1]}
          customStyle={{ borderRadius: '0.375rem', margin: '1em 0' }}
        >
          {codeString}
        </SyntaxHighlighter>
      )
    }

    return (
      <code className={className} {...rest}>
        {children}
      </code>
    )
  },
}

export const MarkdownBody: React.FC<{ content: string }> = ({ content }) => (
  <Markdown remarkPlugins={[remarkGfm]} components={components}>
    {content}
  </Markdown>
)
