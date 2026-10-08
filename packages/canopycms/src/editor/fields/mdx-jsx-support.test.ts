import { expect, it, vi } from 'vitest'

// Evaluating the package here at all is the failure: see this module's header.
vi.mock('@mdxeditor/editor', () => {
  throw new Error('mdx-jsx-support loaded @mdxeditor/editor itself')
})

it('loads without loading @mdxeditor/editor, taking it from its caller', async () => {
  const support = await import('./mdx-jsx-support')
  expect(typeof support.createMdxJsxPlugins).toBe('function')
})
