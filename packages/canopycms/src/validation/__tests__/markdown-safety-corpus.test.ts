import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import matter from 'gray-matter'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { findUnsafeMarkdown } from '../markdown-safety'
import { resolveMdxAllowlist } from '../mdx-allowlist'

const repoRoot = path.resolve(__dirname, '../../../../..')
const roots = [
  ...readdirSync(path.join(repoRoot, 'apps')).map((app) => path.join('apps', app, 'content')),
  'packages/canopycms/src/editor/fields/__fixtures__/markdown-corpus',
]

function filesUnder(dir: string): string[] {
  let entries
  try {
    entries = readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const relative = path.join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(relative) : [relative]
  })
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn)
  return []
}

/** Every markdown body, and every string a data file holds, with the dialect it is read in. */
const corpus = roots.flatMap(filesUnder).flatMap((file): Array<[string, string, 'md' | 'mdx']> => {
  const text = readFileSync(path.join(repoRoot, file), 'utf8')
  const strings = (value: unknown) =>
    stringsIn(value).map((s): [string, string, 'mdx'] => [file, s, 'mdx'])
  if (/\.mdx?$/.test(file)) {
    const { content, data } = matter(text)
    return [[file, content, file.endsWith('.mdx') ? 'mdx' : 'md'], ...strings(data)]
  }
  if (file.endsWith('.json')) return strings(JSON.parse(text))
  if (/\.ya?ml$/.test(file)) return strings(parseYaml(text))
  return []
})

const narrow = resolveMdxAllowlist(
  {
    components: { Callout: { props: { type: ['info', 'warning'] } } },
    htmlTags: [],
    expressions: false,
    fragments: false,
  },
  undefined,
)

const fixture = (name: string) =>
  `packages/canopycms/src/editor/fields/__fixtures__/markdown-corpus/${name}`

describe('the policy over the example apps and the editor fixtures', () => {
  it('reads a corpus with markdown and MDX in it', () => {
    expect(corpus.length).toBeGreaterThan(50)
    expect(corpus.filter(([, , dialect]) => dialect === 'mdx').length).toBeGreaterThan(50)
    expect(corpus.some(([file]) => file === fixture('components.mdx'))).toBe(true)
  })

  it('refuses nothing by default but the fixture written to hold an import', () => {
    const found = corpus.flatMap(([file, source, dialect]) =>
      findUnsafeMarkdown(source, dialect).map((item) => `${file}: ${item.message}`),
    )
    expect(found).toEqual([
      `${fixture('component-with-import.mdx')}: import/export statements are not allowed: they run as code (line 2)`,
    ])
  })

  describe('with a Callout-only allowlist, every body read as MDX', () => {
    const found = corpus.flatMap(([file, source]) =>
      findUnsafeMarkdown(source, 'mdx', narrow).map((item) => ({ file, source, ...item })),
    )

    it('refuses only constructs the allowlist excludes', () => {
      expect(found.map(({ file, message }) => `${file}: ${message}`)).toEqual([
        `${fixture('component-with-import.mdx')}: import/export statements are not allowed: they run as code (line 2)`,
        `${fixture('component-with-import.mdx')}: Component <Chart> is not allowed here; allowed: Callout (line 6)`,
        `${fixture('components.mdx')}: Component <Badge> is not allowed here; allowed: Callout (line 2)`,
        `${fixture('components.mdx')}: Component <Icon> is not allowed here; allowed: Callout (line 2)`,
        `${fixture('components.mdx')}: Prop title on <Callout> is not allowed here; allowed: type (line 4)`,
        `${fixture('components.mdx')}: Component <Chart> is not allowed here; allowed: Callout (line 12)`,
        `${fixture('components.mdx')}: Component <Figure> is not allowed here; allowed: Callout (line 14)`,
        expect.stringMatching(
          new RegExp(
            `^${fixture('html-comment.md')}: This MDX does not parse, so it cannot be checked: Unexpected character \`!\``,
          ),
        ),
      ])
    })

    it('names a construct that is on the line it names', () => {
      let checked = 0
      for (const { source, message, line } of found) {
        const construct = /^Prop (\w+)/.exec(message)?.[1] ?? /<(\w+)>/.exec(message)?.[1]
        if (construct === undefined || line === undefined) continue
        expect(source.split('\n')[line - 1]).toContain(construct)
        checked++
      }
      expect(checked).toBe(6)
    })
  })
})
