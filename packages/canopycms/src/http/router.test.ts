import { describe, expect, it } from 'vitest'
import { createCanopyRouter, matchRoute, type RouteDefinition } from './router'
import { RESERVED_ROUTE_BRANCH_NAMES } from '../paths'
import type { CanopyBinaryResponse } from './types'

/** Build a minimal RouteDefinition for synthetic precedence tests. */
const route = (
  method: RouteDefinition['method'],
  pattern: readonly string[],
  tag: string,
): RouteDefinition => ({
  method,
  pattern,
  // Each route gets its own handler function, tagged so tests can identify
  // which route matched without relying on reference equality of a shared
  // closure (a single shared handler would have its tag overwritten by
  // whichever `route(...)` call ran last).
  handler: Object.assign(async () => ({ ok: true as const, status: 200 as const, data: {} }), {
    tag,
  }),
})

const tagOf = (match: ReturnType<typeof matchRoute>): string | undefined =>
  match ? (match.handler as unknown as { tag?: string }).tag : undefined

describe('matchRoute - static vs dynamic vs catch-all precedence (SEC-H3)', () => {
  it('prefers a static segment over a :param at the same position, regardless of registration order', () => {
    const routes = [route('DELETE', [':branch'], 'branch'), route('DELETE', ['assets'], 'assets')]

    expect(tagOf(matchRoute(routes, 'DELETE', ['assets']))).toBe('assets')
    expect(tagOf(matchRoute(routes, 'DELETE', ['some-branch']))).toBe('branch')
  })

  it('prefers the static segment even when it is registered AFTER the dynamic one', () => {
    // Same as above but with the static route registered second, mirroring
    // the real bug: BRANCH_ROUTES (:branch) is registered before
    // ASSET_ROUTES (assets) in buildCanopyRoutes().
    const routes = [route('DELETE', [':branch'], 'branch'), route('DELETE', ['assets'], 'assets')]
    expect(tagOf(matchRoute(routes, 'DELETE', ['assets']))).toBe('assets')
  })

  it('prefers a :param over a ...catchall at the same position', () => {
    const routes = [
      route('GET', [':branch', '...rest'], 'catchall'),
      route('GET', [':branch', ':section'], 'dynamic'),
    ]

    // Both can match a 2-segment path; the fully-dynamic (non-catchall)
    // route is more specific and should win.
    expect(tagOf(matchRoute(routes, 'GET', ['main', 'content']))).toBe('dynamic')
    // Only the catch-all route can match a 3-segment path.
    expect(tagOf(matchRoute(routes, 'GET', ['main', 'content', 'extra']))).toBe('catchall')
  })

  it('prefers a static segment over a ...catchall at the same position', () => {
    const routes = [
      route('GET', [':branch', '...rest'], 'catchall'),
      route('GET', [':branch', 'content'], 'static'),
    ]

    expect(tagOf(matchRoute(routes, 'GET', ['main', 'content']))).toBe('static')
    expect(tagOf(matchRoute(routes, 'GET', ['main', 'other']))).toBe('catchall')
  })

  it('falls back to registration order when two routes are equally specific (ambiguous duplicate)', () => {
    const routes = [
      route('GET', [':branch'], 'first'),
      route('GET', [':branch'], 'second'), // structurally identical - should never happen in practice
    ]
    expect(tagOf(matchRoute(routes, 'GET', ['main']))).toBe('first')
  })

  it('only matches routes for the requested HTTP method', () => {
    const routes = [
      route('GET', ['assets'], 'get-assets'),
      route('DELETE', ['assets'], 'delete-assets'),
    ]
    expect(tagOf(matchRoute(routes, 'DELETE', ['assets']))).toBe('delete-assets')
    expect(tagOf(matchRoute(routes, 'GET', ['assets']))).toBe('get-assets')
  })

  it('returns null when no route matches', () => {
    const routes = [route('GET', ['assets'], 'get-assets')]
    expect(matchRoute(routes, 'GET', ['unknown'])).toBeNull()
    expect(matchRoute(routes, 'POST', ['assets'])).toBeNull()
  })

  it('extracts params correctly for the winning route, not a shadowed route', () => {
    const routes = [route('DELETE', [':branch'], 'branch'), route('DELETE', ['assets'], 'assets')]
    const match = matchRoute(routes, 'DELETE', ['assets'])
    // The static /assets route has no params - if the dynamic :branch route
    // had incorrectly won, params would contain { branch: 'assets' }.
    expect(match?.params).toEqual({})
  })
})

describe('createCanopyRouter - real route table (SEC-H3 regression)', () => {
  it('dispatches DELETE /assets to the asset delete handler, not the branch delete handler', () => {
    const router = createCanopyRouter()

    const assetsRoute = router.routes.find(
      (r) => r.method === 'DELETE' && r.pattern.join('/') === 'assets',
    )
    const branchRoute = router.routes.find(
      (r) => r.method === 'DELETE' && r.pattern.join('/') === ':branch',
    )
    expect(assetsRoute).toBeDefined()
    expect(branchRoute).toBeDefined()

    const match = router.match('DELETE', ['assets'])
    expect(match).not.toBeNull()
    expect(match?.handler).toBe(assetsRoute?.handler)
    expect(match?.handler).not.toBe(branchRoute?.handler)
    expect(match?.params).toEqual({})
  })

  it('still dispatches DELETE /:branch to the branch delete handler for a non-"assets" segment', () => {
    const router = createCanopyRouter()

    const branchRoute = router.routes.find(
      (r) => r.method === 'DELETE' && r.pattern.join('/') === ':branch',
    )
    expect(branchRoute).toBeDefined()

    const match = router.match('DELETE', ['some-branch'])
    expect(match).not.toBeNull()
    expect(match?.handler).toBe(branchRoute?.handler)
    expect(match?.params).toEqual({ branch: 'some-branch' })
  })

  it('resolves GET /branches (static) without leaking a :branch param', () => {
    const router = createCanopyRouter()
    const match = router.match('GET', ['branches'])
    expect(match).not.toBeNull()
    expect(match?.params).toEqual({})
  })

  it('resolves POST /assets/upload to the proxied upload handler (bodyFormat: multipart)', () => {
    const router = createCanopyRouter()
    const uploadRoute = router.routes.find(
      (r) => r.method === 'POST' && r.pattern.join('/') === 'assets/upload',
    )
    expect(uploadRoute).toBeDefined()
    expect(uploadRoute?.bodyFormat).toBe('multipart')

    const match = router.match('POST', ['assets', 'upload'])
    expect(match?.handler).toBe(uploadRoute?.handler)
    expect(match?.bodyFormat).toBe('multipart')
  })

  it('resolves POST /assets/presign and POST /assets/finalize as ordinary JSON routes', () => {
    const router = createCanopyRouter()

    const presignMatch = router.match('POST', ['assets', 'presign'])
    expect(presignMatch).not.toBeNull()
    expect(presignMatch?.bodyFormat).toBeUndefined()

    const finalizeMatch = router.match('POST', ['assets', 'finalize'])
    expect(finalizeMatch).not.toBeNull()
    expect(finalizeMatch?.bodyFormat).toBeUndefined()
  })

  it('resolves GET /assets/raw/{key...} via the catch-all pattern', () => {
    const router = createCanopyRouter()
    const match = router.match('GET', ['assets', 'raw', 'assets', 'abc123', 'slug.svg'])
    expect(match).not.toBeNull()
    expect(match?.params).toEqual({ key: 'assets/abc123/slug.svg' })
  })

  it('resolves GET /whoami (static) correctly', () => {
    const router = createCanopyRouter()
    const match = router.match('GET', ['whoami'])
    expect(match).not.toBeNull()
    expect(match?.params).toEqual({})
  })

  it('resolves PATCH /:branch/access with a branch param', () => {
    const router = createCanopyRouter()
    const match = router.match('PATCH', ['my-branch', 'access'])
    expect(match).not.toBeNull()
    expect(match?.params).toEqual({ branch: 'my-branch' })
  })

  it('resolves a catch-all route (/:branch/content/...path) and extracts the full sub-path', () => {
    const router = createCanopyRouter()
    const match = router.match('GET', ['main', 'content', 'posts', 'hello'])
    expect(match).not.toBeNull()
    expect(match?.params).toEqual({ branch: 'main', path: 'posts/hello' })
  })

  it('returns null for unknown method/path combinations', () => {
    const router = createCanopyRouter()
    expect(router.match('DELETE', ['unknown', 'nested', 'path'])).toBeNull()
  })
})

describe('matchRoute - decoding (C5)', () => {
  // Synthetic routes (not the real table) so these tests isolate matchRoute's
  // decode step from guard execution - a guard short-circuiting on a missing
  // `branch` param would otherwise also produce a 400, for an unrelated
  // reason, and mask a decode regression.
  it('decodes a :param value exactly once', () => {
    const routes = [route('GET', [':branch'], 'branch')]
    const match = matchRoute(routes, 'GET', ['my%20branch'])
    expect(match?.params).toEqual({ branch: 'my branch' })
  })

  it('decodes a catch-all value uniformly with :param, instead of leaving it raw', () => {
    const routes = [route('GET', [':branch', 'content', '...path'], 'content')]
    const match = matchRoute(routes, 'GET', ['main', 'content', 'posts', 'hello%20world'])
    expect(match?.params).toEqual({ branch: 'main', path: 'posts/hello world' })
  })

  it('a malformed % escape in a :param segment produces a 400 response instead of throwing', async () => {
    const routes = [route('GET', [':branch'], 'branch')]
    expect(() => matchRoute(routes, 'GET', ['%zz'])).not.toThrow()
    const match = matchRoute(routes, 'GET', ['%zz'])
    expect(match).not.toBeNull()
    const result = await match?.handler()
    expect(result).toMatchObject({ ok: false, status: 400 })
    // The malformed input must never reach the real route's handler.
    expect(tagOf(match)).toBeUndefined()
  })

  it('a malformed % escape in a catch-all segment produces a 400 response instead of throwing', async () => {
    const routes = [route('GET', [':branch', 'content', '...path'], 'content')]
    const match = matchRoute(routes, 'GET', ['main', 'content', 'posts', '%zz'])
    expect(match).not.toBeNull()
    const result = await match?.handler()
    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(tagOf(match)).toBeUndefined()
  })
})

describe('matchRoute + route.validate - decoding once still catches real traversal (C5)', () => {
  // Uses the real route table (DELETE /:branch/entries/...entryPath, whose
  // Zod params schema validates entryPath with logicalPathSchema) so this
  // exercises the actual decode-then-validate composition end to end, not a
  // synthetic route.
  it('a doubly percent-encoded ".." decodes to a harmless literal (not a smuggled traversal) after the single router decode', () => {
    const router = createCanopyRouter()
    // '..' percent-encoded twice: %2e -> %252e (the '%' of the first
    // encoding re-encoded as %25).
    const match = router.match('DELETE', ['main', 'entries', 'posts', '%252e%252e'])
    expect(match).not.toBeNull()
    // Exactly one decode pass: '%252e' -> '%2e' (only the %25 escape is
    // consumed), not '..' - if this ever reads '..' here, something is
    // decoding twice again and the traversal check below is no longer
    // meaningful.
    expect(match?.params.entryPath).toBe('posts/%2e%2e')
    const validated = match?.validate?.({ params: match?.params })
    expect(validated?.ok).toBe(true)
  })

  it('a real (single-encoded) ".." traversal attempt is still rejected after the router decode', () => {
    const router = createCanopyRouter()
    const match = router.match('DELETE', ['main', 'entries', 'posts', '%2e%2e'])
    expect(match).not.toBeNull()
    expect(match?.params.entryPath).toBe('posts/..')
    const validated = match?.validate?.({ params: match?.params })
    expect(validated?.ok).toBe(false)
  })

  // content.ts's `...path` catch-all previously received the raw, never
  // router-decoded segment (the inconsistency the C5 finding calls out) -
  // it now gets the same uniform decode + Zod (logicalPathSchema) traversal
  // check as entries.ts and schema.ts, entirely from the router-level fix,
  // with no content.ts code change required.
  it('GET /:branch/content/...path also decodes and rejects traversal after the router decode', () => {
    const router = createCanopyRouter()
    const encoded = router.match('GET', ['main', 'content', 'posts', 'hello%20world'])
    expect(encoded?.params.path).toBe('posts/hello world')
    expect(encoded?.validate?.({ params: encoded?.params })?.ok).toBe(true)

    const traversal = router.match('GET', ['main', 'content', 'posts', '%2e%2e'])
    expect(traversal?.params.path).toBe('posts/..')
    expect(traversal?.validate?.({ params: traversal?.params })?.ok).toBe(false)
  })
})

describe('matchRoute - CanopyHandler may return a CanopyBinaryResponse (M2 plumbing)', () => {
  it('matches a route whose handler returns a binary response and leaves the result unchanged', async () => {
    const binaryResult: CanopyBinaryResponse = {
      kind: 'binary',
      status: 200,
      body: new Uint8Array([9, 9]),
      headers: { contentType: 'application/octet-stream' },
    }
    const routes: RouteDefinition[] = [
      {
        method: 'GET',
        pattern: ['assets', 'binary'],
        // Type-checks against the widened CanopyHandler return type without
        // any cast - proof that the router table can carry a binary route
        // alongside ordinary ApiResponse-returning ones.
        handler: async () => binaryResult,
      },
    ]

    const match = matchRoute(routes, 'GET', ['assets', 'binary'])
    expect(match).not.toBeNull()

    const result = await match?.handler()
    expect(result).toEqual(binaryResult)
  })

  // Keeps paths/branch-name.ts's RESERVED_ROUTE_BRANCH_NAMES honest. That
  // constant cannot be computed from the router at runtime -- api/validators.ts
  // is imported BY the route modules, so importing the router from the
  // validation side would be a cycle -- so it is maintained by hand and pinned
  // here instead. Adding a new static top-level namespace fails this test until
  // the constant is updated, which is exactly the reminder we want.
  describe('reserved branch names', () => {
    it('matches the static top-level namespaces of the live route table', () => {
      const staticFirstSegments = new Set(
        createCanopyRouter()
          .routes.map((route) => route.pattern[0])
          .filter((segment) => segment && !segment.startsWith(':') && !segment.startsWith('...')),
      )

      expect([...staticFirstSegments].sort()).toEqual([...RESERVED_ROUTE_BRANCH_NAMES].sort())
    })
  })
})
