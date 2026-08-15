import { describe, expect, it } from 'vitest'
import { toPlainText } from '../index'

describe('toPlainText', () => {
  describe('paired custom components', () => {
    it('preserves prose inside a paired component, drops the tags', () => {
      const input = '<Callout type="warning">This is important text.</Callout>'
      expect(toPlainText(input)).toBe('This is important text.')
    })

    it('preserves text around a paired component', () => {
      const input = 'Before. <Note>Middle text.</Note> After.'
      expect(toPlainText(input)).toBe('Before. Middle text. After.')
    })

    it('does not leak attribute values from a paired component', () => {
      const input = '<Panel id="secret-internal-id" theme="dark">Visible text only.</Panel>'
      const result = toPlainText(input)
      expect(result).toBe('Visible text only.')
      expect(result).not.toContain('secret-internal-id')
    })

    it('preserves multi-sentence prose across a component spanning multiple lines', () => {
      const input = ['<Steps>', 'First, do this.', '', 'Then, do that.', '</Steps>'].join('\n')
      const result = toPlainText(input)
      expect(result).toContain('First, do this.')
      expect(result).toContain('Then, do that.')
      expect(result).not.toContain('<Steps>')
      expect(result).not.toContain('</Steps>')
    })
  })

  describe('self-closing components', () => {
    it('removes a self-closing component entirely, keeping surrounding text', () => {
      const input = 'Some intro. <MatrixRow label="Goal" matches="1, 3" /> More text.'
      expect(toPlainText(input)).toBe('Some intro. More text.')
    })

    it('does not leak self-closing component prop values', () => {
      const input = '<Divider color="red" />'
      expect(toPlainText(input)).toBe('')
    })
  })

  describe('nested components', () => {
    it('preserves text through nested paired components', () => {
      const input = '<Outer><Inner>Nested text</Inner> and more</Outer>'
      expect(toPlainText(input)).toBe('Nested text and more')
    })

    it('handles a self-closing component nested inside a paired one', () => {
      const input = '<Card>Before <Icon name="star" /> after</Card>'
      expect(toPlainText(input)).toBe('Before after')
    })

    it('handles three levels of nesting', () => {
      const input = '<A><B><C>deep text</C></B></A>'
      expect(toPlainText(input)).toBe('deep text')
    })
  })

  describe('JSX expressions', () => {
    it('strips a standalone JSX expression from prose', () => {
      const input = 'The count is {count} today.'
      expect(toPlainText(input)).toBe('The count is today.')
    })

    it('strips a JSX expression used as a component child', () => {
      const input = '<Badge>{count}</Badge> items remain.'
      expect(toPlainText(input)).toBe('items remain.')
    })

    it('strips nested braces inside a JSX expression', () => {
      const input = 'Value: {formatValue({ a: 1, b: 2 })} end.'
      expect(toPlainText(input)).toBe('Value: end.')
    })
  })

  describe('code fences', () => {
    it('keeps fenced code content, drops the fence markers and language tag', () => {
      const input = [
        'Some intro text.',
        '',
        '```js',
        'const x = 1;',
        'console.log(x);',
        '```',
        '',
        'More text after.',
      ].join('\n')
      const result = toPlainText(input)
      expect(result).toContain('const x = 1;')
      expect(result).toContain('console.log(x);')
      expect(result).not.toContain('```')
      expect(result).not.toMatch(/```js/)
      expect(result).toContain('Some intro text.')
      expect(result).toContain('More text after.')
    })

    it('does not treat JSX-like syntax inside a code fence as real JSX', () => {
      const input = ['```jsx', '<Example prop="value">child</Example>', '```'].join('\n')
      const result = toPlainText(input)
      expect(result).toContain('<Example prop="value">child</Example>')
    })
  })

  describe('inline code', () => {
    it('unwraps inline code, keeping the content and dropping the backticks', () => {
      const input = 'Use the `foo()` function to bar.'
      expect(toPlainText(input)).toBe('Use the foo() function to bar.')
    })

    it('unwraps double-backtick inline code containing a literal backtick', () => {
      const input = 'Use ``the ` character`` carefully.'
      expect(toPlainText(input)).toContain('the ` character')
    })
  })

  describe('links', () => {
    it('keeps the link text and drops the URL', () => {
      const input = 'See [our docs](https://example.com/docs) for more.'
      expect(toPlainText(input)).toBe('See our docs for more.')
    })

    it('keeps image alt text and drops the URL', () => {
      const input = 'Diagram: ![architecture overview](https://example.com/diagram.png) end.'
      const result = toPlainText(input)
      expect(result).toBe('Diagram: architecture overview end.')
      expect(result).not.toContain('example.com')
    })

    it('handles multiple links in one line', () => {
      const input = '[One](https://a.example) and [Two](https://b.example).'
      expect(toPlainText(input)).toBe('One and Two.')
    })
  })

  describe('headings', () => {
    it('strips heading markers, keeps the text', () => {
      const input = '# Getting Started\n\nWelcome to the guide.'
      expect(toPlainText(input)).toBe('Getting Started\n\nWelcome to the guide.')
    })

    it('strips heading markers at every level', () => {
      const input = '## Section\n\n### Subsection'
      expect(toPlainText(input)).toBe('Section\n\nSubsection')
    })
  })

  describe('frontmatter', () => {
    it('strips YAML frontmatter entirely', () => {
      const input = [
        '---',
        'title: Test Page',
        'date: 2024-01-01',
        '---',
        '',
        '# Heading',
        '',
        'Body text.',
      ].join('\n')
      const result = toPlainText(input)
      expect(result).not.toContain('title:')
      expect(result).not.toContain('Test Page')
      expect(result).not.toContain('2024-01-01')
      expect(result).toBe('Heading\n\nBody text.')
    })

    it('handles content with no frontmatter at all', () => {
      const input = '# Heading\n\nBody text.'
      expect(toPlainText(input)).toBe('Heading\n\nBody text.')
    })
  })

  describe('imports/exports', () => {
    it('strips MDX import/export statements', () => {
      const input = ["import { Callout } from '../components'", '', '# Guide', '', 'Body.'].join(
        '\n',
      )
      const result = toPlainText(input)
      expect(result).not.toContain('import')
      expect(result).toBe('Guide\n\nBody.')
    })
  })

  describe('other common Markdown syntax', () => {
    it('unwraps bold, italic, and strikethrough', () => {
      expect(toPlainText('This is **bold** and *italic* and ~~gone~~.')).toBe(
        'This is bold and italic and gone.',
      )
    })

    it('strips blockquote markers', () => {
      expect(toPlainText('> A quoted line.')).toBe('A quoted line.')
    })

    it('strips list markers', () => {
      const input = ['- First item', '- Second item', '1. Ordered one', '2. Ordered two'].join('\n')
      const result = toPlainText(input)
      expect(result).toBe('First item\nSecond item\nOrdered one\nOrdered two')
    })

    it('strips thematic breaks', () => {
      const input = 'Above.\n\n---\n\nBelow.'
      const result = toPlainText(input)
      expect(result).not.toContain('---')
      expect(result).toContain('Above.')
      expect(result).toContain('Below.')
    })
  })

  describe('whitespace collapsing', () => {
    it('collapses excess blank lines but keeps paragraph breaks', () => {
      const input = 'Paragraph one.\n\n\n\n\nParagraph two.'
      expect(toPlainText(input)).toBe('Paragraph one.\n\nParagraph two.')
    })

    it('trims leading and trailing whitespace', () => {
      expect(toPlainText('\n\n  Hello world.  \n\n')).toBe('Hello world.')
    })

    it('returns an empty string for empty input', () => {
      expect(toPlainText('')).toBe('')
    })
  })

  describe('tag stripping is linear (js/polynomial-redos)', () => {
    it('does not degrade on an unterminated tag followed by a long whitespace run', () => {
      // The former TAG_RE had a redundant `\s*` after ATTR_CONTENT (which already matches
      // whitespace), so an unterminated `<Tag` followed by a whitespace-dominated tail let the
      // engine split the run between the two in every proportion -- quadratic in the run length.
      // Measured at ~26s for this input with the redundant `\s*`; the fixed regex is ~1ms.
      // A generous ceiling still fails loudly if the redundant `\s*` is reintroduced.
      const adversarial = '<Callout\n' + '\n'.repeat(128 * 1024) + 'text'
      const started = performance.now()
      const result = toPlainText(adversarial)
      expect(result).toContain('text')
      expect(performance.now() - started).toBeLessThan(1000)
    })
  })

  describe('fenced-code masking is linear (js/polynomial-redos)', () => {
    it('does not degrade on many unclosed fence openers', () => {
      // The former fence regex (`/^(```|~~~).*\n([\s\S]*?)\n\1\s*$/gm`) has no bound on how far
      // its lazy `[\s\S]*?` must scan looking for a closing backreference that, for an unclosed
      // fence, never arrives -- it exhausts to end-of-string before giving up on that starting
      // line, and /gm retries the same exhaustive scan at every subsequent opener. Measured at
      // ~9s for 32,000 unclosed openers (~530KB); the linear line-scan replacement is <10ms.
      // An ordinary authoring accident (a doc with many code snippets and one forgotten closing
      // fence) triggers the same shape, just at a smaller scale.
      const adversarial = Array.from({ length: 32_000 }, (_, i) => '```js\n' + `line ${i}`).join(
        '\n',
      )
      const started = performance.now()
      const result = toPlainText(adversarial)
      expect(result).toContain('line 0')
      expect(performance.now() - started).toBeLessThan(1000)
    })
  })

  describe('realistic combined document', () => {
    it('handles frontmatter + heading + prose + component + code + link together', () => {
      const input = [
        '---',
        'title: Onboarding Guide',
        '---',
        '',
        '# Onboarding',
        '',
        'Welcome! Read the [setup guide](https://example.com/setup) first.',
        '',
        '<Callout type="tip">',
        'Remember to save your work often.',
        '</Callout>',
        '',
        '```bash',
        'npm install',
        '```',
        '',
        '<Divider />',
        '',
        'That is all for now.',
      ].join('\n')

      const result = toPlainText(input)

      expect(result).not.toContain('title:')
      expect(result).not.toContain('---')
      expect(result).not.toContain('<Callout')
      expect(result).not.toContain('</Callout>')
      expect(result).not.toContain('<Divider')
      expect(result).not.toContain('https://example.com/setup')
      expect(result).not.toContain('```')

      expect(result).toContain('Onboarding')
      expect(result).toContain('Welcome! Read the setup guide first.')
      expect(result).toContain('Remember to save your work often.')
      expect(result).toContain('npm install')
      expect(result).toContain('That is all for now.')
    })
  })
})
