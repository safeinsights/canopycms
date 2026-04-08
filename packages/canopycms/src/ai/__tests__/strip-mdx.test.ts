import { describe, it, expect } from 'vitest'
import { stripMdxImports } from '../strip-mdx'

describe('stripMdxImports', () => {
  describe('single-line stripping', () => {
    it('removes named imports', () => {
      const input = `import { Callout } from '../components'\n\n# Hello`
      expect(stripMdxImports(input)).toBe('# Hello')
    })

    it('removes default imports', () => {
      const input = `import Layout from './Layout'\n\n# Hello`
      expect(stripMdxImports(input)).toBe('# Hello')
    })

    it('removes side-effect imports', () => {
      const input = `import './styles.css'\n\n# Hello`
      expect(stripMdxImports(input)).toBe('# Hello')
    })

    it('removes multiple import lines', () => {
      const input = [
        "import { Callout } from '../components'",
        "import { DesignMatrix, MatrixRow } from './DesignMatrix'",
        '',
        '# Hello',
      ].join('\n')
      expect(stripMdxImports(input)).toBe('# Hello')
    })

    it('removes export statements', () => {
      const input = `export const meta = { title: 'Hello' }\n\n# Hello`
      expect(stripMdxImports(input)).toBe('# Hello')
    })

    it('removes export default statements', () => {
      const input = `export default Layout\n\n# Hello`
      expect(stripMdxImports(input)).toBe('# Hello')
    })
  })

  describe('multi-line stripping', () => {
    it('removes multi-line import with destructuring', () => {
      const input = [
        'import {',
        '  Callout,',
        '  DesignMatrix,',
        '  MatrixRow,',
        "} from '../components'",
        '',
        '# Hello',
      ].join('\n')
      expect(stripMdxImports(input)).toBe('# Hello')
    })

    it('removes multi-line export const object', () => {
      const input = [
        'export const meta = {',
        '  title: "Hello",',
        '  date: "2024-01-01"',
        '}',
        '',
        '# Hello',
      ].join('\n')
      expect(stripMdxImports(input)).toBe('# Hello')
    })

    it('removes multi-line export with nested braces', () => {
      const input = [
        'export const config = {',
        '  nested: { a: 1, b: 2 },',
        '  other: true',
        '}',
        '',
        'Content here.',
      ].join('\n')
      expect(stripMdxImports(input)).toBe('Content here.')
    })
  })

  describe('fenced code block preservation', () => {
    it('preserves import inside backtick code block', () => {
      const input = [
        '# Example',
        '',
        '```js',
        "import { foo } from 'bar'",
        'export const x = 1',
        '```',
      ].join('\n')
      const result = stripMdxImports(input)
      expect(result).toContain("import { foo } from 'bar'")
      expect(result).toContain('export const x = 1')
    })

    it('preserves import inside tilde code block', () => {
      const input = ['# Example', '', '~~~typescript', "import React from 'react'", '~~~'].join(
        '\n',
      )
      const result = stripMdxImports(input)
      expect(result).toContain("import React from 'react'")
    })

    it('preserves multi-line import inside code block', () => {
      const input = [
        '# Example',
        '',
        '```',
        'import {',
        '  Foo,',
        '  Bar',
        "} from './mod'",
        '```',
      ].join('\n')
      const result = stripMdxImports(input)
      expect(result).toContain('import {')
      expect(result).toContain('  Foo,')
      expect(result).toContain("} from './mod'")
    })

    it('strips top-level import but preserves code block import', () => {
      const input = [
        "import { Callout } from '../components'",
        '',
        '# Guide',
        '',
        'To use this component:',
        '',
        '```tsx',
        "import { Callout } from 'canopycms/components'",
        '```',
      ].join('\n')
      const result = stripMdxImports(input)
      // Top-level import stripped — only the code block import remains
      expect(result).not.toContain("from '../components'")
      expect(result).toContain("import { Callout } from 'canopycms/components'") // code block preserved
    })

    it('preserves export inside code block', () => {
      const input = [
        '# Config Example',
        '',
        '```js',
        'export default {',
        '  plugins: [],',
        '}',
        '```',
      ].join('\n')
      const result = stripMdxImports(input)
      expect(result).toContain('export default {')
      expect(result).toContain('  plugins: [],')
    })
  })

  describe('JSX component preservation', () => {
    it('preserves JSX components intact', () => {
      const input = '<Callout type="warning">Important note</Callout>'
      expect(stripMdxImports(input)).toBe('<Callout type="warning">Important note</Callout>')
    })

    it('preserves self-closing JSX components', () => {
      const input = '<MatrixRow category="Goal" label="Description" matches="1, 3" />'
      expect(stripMdxImports(input)).toBe(input)
    })
  })

  describe('blank line collapsing', () => {
    it('collapses excess blank lines after stripping', () => {
      const input = ["import { Callout } from './components'", '', '', '', '# Hello'].join('\n')
      expect(stripMdxImports(input)).toBe('# Hello')
    })
  })

  describe('passthrough', () => {
    it('handles content with no imports', () => {
      const input = '# Hello\n\nSome content here.'
      expect(stripMdxImports(input)).toBe(input)
    })

    it('handles real-world MDX with imports and components', () => {
      const input = [
        "import { Checklist, ChecklistItem } from '../components/mdx/Checklist'",
        '',
        '# Onboarding',
        '',
        '<Checklist>',
        '  <ChecklistItem>Review the guide</ChecklistItem>',
        '  <ChecklistItem label="Set up meeting">More detail</ChecklistItem>',
        '</Checklist>',
      ].join('\n')
      const result = stripMdxImports(input)
      expect(result).not.toContain('import')
      expect(result).toContain('<Checklist>')
      expect(result).toContain('<ChecklistItem>Review the guide</ChecklistItem>')
      expect(result).toContain('<ChecklistItem label="Set up meeting">More detail</ChecklistItem>')
    })
  })
})
