import { describe, expect, it } from 'vitest'

import { editorDeepLink, resolveEditorUrl } from './editor-url'

const headers =
  (values: Record<string, string>) =>
  (name: string): string | null =>
    values[name.toLowerCase()] ?? null

describe('resolveEditorUrl', () => {
  const claimed = 'https://cms.example.org/edit?branch=old&entry=x#frag'

  it('prefers the configured URL over anything the request says', () => {
    expect(
      resolveEditorUrl({
        configured: 'https://editor.example.org/cms',
        claimed,
        header: headers({ host: 'cms.example.org' }),
      }),
    ).toBe('https://editor.example.org/cms')
  })

  it('accepts the reported URL, without query or fragment, when its host is X-Forwarded-Host', () => {
    expect(
      resolveEditorUrl({
        claimed,
        header: headers({ 'x-forwarded-host': 'cms.example.org', host: 'abc.lambda-url.aws' }),
      }),
    ).toBe('https://cms.example.org/edit')
  })

  it('reads only the first X-Forwarded-Host value and ignores the case of the host', () => {
    expect(
      resolveEditorUrl({
        claimed: 'https://CMS.Example.org/edit',
        header: headers({ 'x-forwarded-host': 'cms.example.ORG, proxy.internal' }),
      }),
    ).toBe('https://cms.example.org/edit')
    expect(
      resolveEditorUrl({
        claimed,
        header: headers({ 'x-forwarded-host': 'proxy.internal, cms.example.org' }),
      }),
    ).toBeUndefined()
  })

  it('falls back to Host when there is no X-Forwarded-Host', () => {
    expect(
      resolveEditorUrl({
        claimed: 'http://localhost:3000/edit',
        header: headers({ host: 'localhost:3000' }),
      }),
    ).toBe('http://localhost:3000/edit')
  })

  it('treats the default port as no port', () => {
    expect(resolveEditorUrl({ claimed, header: headers({ host: 'cms.example.org:443' }) })).toBe(
      'https://cms.example.org/edit',
    )
  })

  it('refuses a reported URL on any other host or port', () => {
    for (const host of ['evil.example', 'cms.example.org:8443', 'abc.lambda-url.aws']) {
      expect(resolveEditorUrl({ claimed, header: headers({ host }) })).toBeUndefined()
    }
    // Behind CloudFront, Host is the Function URL's: only X-Forwarded-Host can match.
    expect(
      resolveEditorUrl({
        claimed,
        header: headers({ 'x-forwarded-host': 'evil.example', host: 'cms.example.org' }),
      }),
    ).toBeUndefined()
  })

  it('refuses a host header that is not a bare host', () => {
    for (const host of ['evil.example/cms.example.org', 'evil.example@cms.example.org', '']) {
      expect(
        resolveEditorUrl({ claimed, header: headers({ 'x-forwarded-host': host }) }),
      ).toBeUndefined()
    }
  })

  it('refuses a reported URL that is not plain http(s)', () => {
    for (const url of [
      'javascript:alert(1)//cms.example.org',
      'ftp://cms.example.org/edit',
      'https://user:pass@cms.example.org/edit',
      '/edit',
      'not a url',
      `https://cms.example.org/${'a'.repeat(2048)}`,
    ]) {
      expect(
        resolveEditorUrl({ claimed: url, header: headers({ host: 'cms.example.org' }) }),
      ).toBeUndefined()
    }
  })

  it('is undefined with no configured URL and no reported URL or headers', () => {
    expect(resolveEditorUrl({})).toBeUndefined()
    expect(resolveEditorUrl({ claimed })).toBeUndefined()
    expect(resolveEditorUrl({ header: headers({ host: 'cms.example.org' }) })).toBeUndefined()
  })
})

describe('editorDeepLink', () => {
  it('sets the branch and, when given, the entry the editor opens on load', () => {
    expect(editorDeepLink('https://cms.example.org/edit', 'feature/a b')).toBe(
      'https://cms.example.org/edit?branch=feature%2Fa+b',
    )
    expect(editorDeepLink('https://cms.example.org/edit', 'f', 'content/blog/a&b')).toBe(
      'https://cms.example.org/edit?branch=f&entry=content%2Fblog%2Fa%26b',
    )
  })
})
