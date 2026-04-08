import { describe, it, expect } from 'vitest'
import { applyComponentTransforms, parseComponentProps } from '../transform-components'
import type { ComponentTransforms } from '../types'

describe('parseComponentProps', () => {
  it('parses double-quoted string props', () => {
    expect(parseComponentProps('type="warning" label="Hello"')).toEqual({
      type: 'warning',
      label: 'Hello',
    })
  })

  it('parses single-quoted string props', () => {
    expect(parseComponentProps("type='info'")).toEqual({ type: 'info' })
  })

  it('parses expression props', () => {
    expect(parseComponentProps('count={42}')).toEqual({ count: '42' })
  })

  it('parses boolean props', () => {
    expect(parseComponentProps('check')).toEqual({ check: 'true' })
  })

  it('parses mixed prop types', () => {
    expect(parseComponentProps('label="Hello" check count={3}')).toEqual({
      label: 'Hello',
      check: 'true',
      count: '3',
    })
  })

  it('returns empty object for empty string', () => {
    expect(parseComponentProps('')).toEqual({})
  })
})

describe('applyComponentTransforms', () => {
  describe('self-closing tags', () => {
    it('transforms self-closing tag', () => {
      const transforms: ComponentTransforms = {
        Spacer: () => '',
      }
      expect(applyComponentTransforms('<Spacer />', transforms)).toBe('')
    })

    it('passes props to self-closing tag transform', () => {
      const transforms: ComponentTransforms = {
        MatrixRow: (props) => `- **${props.label}** (${props.category}): columns ${props.matches}`,
      }
      const input = '<MatrixRow category="Goals" label="Description" matches="1, 3" />'
      expect(applyComponentTransforms(input, transforms)).toBe(
        '- **Description** (Goals): columns 1, 3',
      )
    })
  })

  describe('tags with children', () => {
    it('transforms tag with text children', () => {
      const transforms: ComponentTransforms = {
        Callout: (props, children) => `> **${props.type ?? 'Note'}:** ${children}`,
      }
      const input = '<Callout type="warning">Watch out!</Callout>'
      expect(applyComponentTransforms(input, transforms)).toBe('> **warning:** Watch out!')
    })

    it('transforms tag with multi-line children', () => {
      const transforms: ComponentTransforms = {
        Callout: (_, children) => `> ${children.trim()}`,
      }
      const input = '<Callout>\n  Line one.\n  Line two.\n</Callout>'
      expect(applyComponentTransforms(input, transforms)).toBe('> Line one.\n  Line two.')
    })
  })

  describe('nested components', () => {
    it('transforms inner components first, then outer', () => {
      const transforms: ComponentTransforms = {
        Checklist: (_, children) => children.trim(),
        ChecklistItem: (props, children) =>
          `- [ ] ${props.label ? `**${props.label}:** ` : ''}${children.trim()}`,
      }
      const input = [
        '<Checklist>',
        '  <ChecklistItem>Review the guide</ChecklistItem>',
        '  <ChecklistItem label="Setup">Configure settings</ChecklistItem>',
        '</Checklist>',
      ].join('\n')
      const result = applyComponentTransforms(input, transforms)
      expect(result).toContain('- [ ] Review the guide')
      expect(result).toContain('- [ ] **Setup:** Configure settings')
      expect(result).not.toContain('<Checklist>')
      expect(result).not.toContain('<ChecklistItem')
    })

    it('handles nested same-name components', () => {
      const transforms: ComponentTransforms = {
        Box: (_, children) => `[${children.trim()}]`,
      }
      const input = '<Box>outer <Box>inner</Box> end</Box>'
      expect(applyComponentTransforms(input, transforms)).toBe('[outer [inner] end]')
    })
  })

  describe('mixed content', () => {
    it('preserves markdown around components', () => {
      const transforms: ComponentTransforms = {
        Callout: (_, children) => `> ${children.trim()}`,
      }
      const input = '# Heading\n\nSome text.\n\n<Callout>Important</Callout>\n\nMore text.'
      const result = applyComponentTransforms(input, transforms)
      expect(result).toBe('# Heading\n\nSome text.\n\n> Important\n\nMore text.')
    })

    it('transforms multiple instances of same component', () => {
      const transforms: ComponentTransforms = {
        Note: (_, children) => `> ${children.trim()}`,
      }
      const input = '<Note>First</Note>\n\n<Note>Second</Note>'
      const result = applyComponentTransforms(input, transforms)
      expect(result).toBe('> First\n\n> Second')
    })
  })

  describe('passthrough', () => {
    it('returns undefined to keep original JSX', () => {
      const transforms: ComponentTransforms = {
        Custom: () => undefined,
      }
      const input = '<Custom prop="value">content</Custom>'
      expect(applyComponentTransforms(input, transforms)).toBe(input)
    })

    it('conditional undefined does not skip subsequent instances', () => {
      const transforms: ComponentTransforms = {
        Callout: (props, children) => {
          if (props.type === 'internal') return undefined
          return `> ${children.trim()}`
        },
      }
      const input =
        '<Callout type="internal">keep me</Callout>\n\n<Callout type="tip">transform me</Callout>'
      const result = applyComponentTransforms(input, transforms)
      expect(result).toContain('<Callout type="internal">keep me</Callout>')
      expect(result).toContain('> transform me')
      expect(result).not.toContain('<Callout type="tip">')
    })

    it('leaves unregistered components as-is', () => {
      const transforms: ComponentTransforms = {
        Callout: (_, children) => `> ${children.trim()}`,
      }
      const input = '<Unknown>content</Unknown>'
      expect(applyComponentTransforms(input, transforms)).toBe(input)
    })

    it('leaves HTML tags (lowercase) as-is', () => {
      const transforms: ComponentTransforms = {
        Callout: (_, children) => `> ${children.trim()}`,
      }
      const input = '<div>content</div>'
      expect(applyComponentTransforms(input, transforms)).toBe(input)
    })
  })

  describe('props containing > character', () => {
    it('handles > in double-quoted prop value on self-closing tag', () => {
      const transforms: ComponentTransforms = {
        Callout: (props) => `> ${props.title}`,
      }
      const input = '<Callout title="a > b" />'
      expect(applyComponentTransforms(input, transforms)).toBe('> a > b')
    })

    it('handles > in double-quoted prop value on tag with children', () => {
      const transforms: ComponentTransforms = {
        Callout: (props, children) => `> **${props.title}:** ${children.trim()}`,
      }
      const input = '<Callout title="a > b">Content here</Callout>'
      expect(applyComponentTransforms(input, transforms)).toBe('> **a > b:** Content here')
    })

    it('handles > in single-quoted prop value', () => {
      const transforms: ComponentTransforms = {
        Callout: (props) => `> ${props.title}`,
      }
      const input = "<Callout title='x > y' />"
      expect(applyComponentTransforms(input, transforms)).toBe('> x > y')
    })

    it('handles nested same-name components with > in props', () => {
      const transforms: ComponentTransforms = {
        Box: (props, children) => `[${props.label ?? ''}${children.trim()}]`,
      }
      const input = '<Box label="a > b">outer <Box label="c > d">inner</Box> end</Box>'
      expect(applyComponentTransforms(input, transforms)).toBe('[a > bouter [c > dinner] end]')
    })
  })

  describe('code block preservation', () => {
    it('does not transform components inside fenced code blocks', () => {
      const transforms: ComponentTransforms = {
        Callout: (_, children) => `> ${children.trim()}`,
      }
      const input = [
        '# Example',
        '',
        '```tsx',
        '<Callout type="warning">Example</Callout>',
        '```',
      ].join('\n')
      const result = applyComponentTransforms(input, transforms)
      expect(result).toContain('<Callout type="warning">Example</Callout>')
    })

    it('transforms components outside code blocks while preserving inside', () => {
      const transforms: ComponentTransforms = {
        Callout: (_, children) => `> ${children.trim()}`,
      }
      const input = [
        '<Callout>Transform me</Callout>',
        '',
        '```',
        '<Callout>Keep me</Callout>',
        '```',
      ].join('\n')
      const result = applyComponentTransforms(input, transforms)
      expect(result).toContain('> Transform me')
      expect(result).toContain('<Callout>Keep me</Callout>')
    })

    it('does not transform components inside inline code spans', () => {
      const transforms: ComponentTransforms = {
        Callout: (_, children) => `> ${children.trim()}`,
      }
      const input = 'Use `<Callout>text</Callout>` for callouts.'
      expect(applyComponentTransforms(input, transforms)).toBe(input)
    })

    it('does not transform components inside double-backtick code spans', () => {
      const transforms: ComponentTransforms = {
        Callout: (_, children) => `> ${children.trim()}`,
      }
      const input = 'Use ``<Callout>text</Callout>`` for callouts.'
      expect(applyComponentTransforms(input, transforms)).toBe(input)
    })

    it('transforms components outside inline code while preserving inside', () => {
      const transforms: ComponentTransforms = {
        Callout: (_, children) => `> ${children.trim()}`,
      }
      const input =
        '<Callout>Transform me</Callout>\n\nSee `<Callout>Keep me</Callout>` for syntax.'
      const result = applyComponentTransforms(input, transforms)
      expect(result).toContain('> Transform me')
      expect(result).toContain('`<Callout>Keep me</Callout>`')
    })

    it('does not transform self-closing tags inside inline code', () => {
      const transforms: ComponentTransforms = {
        Spacer: () => '',
      }
      const input = 'Use `<Spacer />` to add space.'
      expect(applyComponentTransforms(input, transforms)).toBe(input)
    })
  })

  describe('real-world examples', () => {
    it('transforms DesignMatrix with MatrixRow children', () => {
      const transforms: ComponentTransforms = {
        DesignMatrix: (_, children) => `### Design Matrix\n\n${children.trim()}`,
        MatrixRow: (props) => `- **${props.label}** (${props.category}): columns ${props.matches}`,
      }
      const input = [
        '<DesignMatrix columns="Engagement, Behavior">',
        '  <MatrixRow category="Goal" label="Description" matches="1" />',
        '  <MatrixRow category="Goal" label="Explanation" matches="2" />',
        '</DesignMatrix>',
      ].join('\n')
      const result = applyComponentTransforms(input, transforms)
      expect(result).toContain('### Design Matrix')
      expect(result).toContain('- **Description** (Goal): columns 1')
      expect(result).toContain('- **Explanation** (Goal): columns 2')
      expect(result).not.toContain('<DesignMatrix')
      expect(result).not.toContain('<MatrixRow')
    })
  })
})
