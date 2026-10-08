import { Construct } from 'constructs'
import {
  Annotations,
  Duration,
  Stack,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_lambda as lambda,
} from 'aws-cdk-lib'
import { ASSETS_PATH_PATTERN, ASSETS_TRANSFORM_PATH_PATTERN } from './asset-support'

/** CloudFront's maximum origin read timeout without a service-quota increase. */
export const MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT = Duration.seconds(60)

/**
 * The routes the editor needs from the CMS Lambda on a distribution it shares
 * with a site: the editor page and the catch-all API route `canopycms init`
 * scaffolds. `/edit` and `/edit/*` rather than `/edit*`, which also matches
 * `/editorial` and `/edit-assets/…` and so takes site pages away from the site.
 *
 * Not included, because on a shared distribution they belong to the site:
 * `/_next/static/*` (the CMS build moves its chunks out of it with Next's
 * `assetPrefix`; see `editorAssetPrefix`) and `/assets/*`
 * (`AssetSupport.attachTo` owns it).
 */
export const EDITOR_PATH_PATTERNS = ['/edit', '/edit/*', '/api/canopycms/*'] as const

/**
 * One request path per editor pattern that only that pattern serves. A
 * behavior listed earlier that matches any of these takes the request first.
 */
const EDITOR_PROBE_PATHS: Record<(typeof EDITOR_PATH_PATTERNS)[number], string[]> = {
  '/edit': ['/edit'],
  '/edit/*': ['/edit/', '/edit/x'],
  '/api/canopycms/*': ['/api/canopycms/x'],
}

/** A path pattern this module attaches, with the request paths only it serves. */
interface EditorRoute {
  pattern: string
  probes: string[]
}

const EDITOR_ROUTES: EditorRoute[] = EDITOR_PATH_PATTERNS.map((pattern) => ({
  pattern,
  probes: EDITOR_PROBE_PATHS[pattern],
}))

/** Patterns a prefix option must not overlap in either direction. */
const RESERVED_ROUTES: EditorRoute[] = [
  ...EDITOR_ROUTES,
  { pattern: '/_next/*', probes: ['/_next/x'] },
  { pattern: ASSETS_TRANSFORM_PATH_PATTERN, probes: ['/assets/t/x'] },
  { pattern: ASSETS_PATH_PATTERN, probes: ['/assets/x'] },
]

/** Id of the marker construct `attachEditorBehaviors` adds to the distribution. */
const EDITOR_ATTACHED_MARKER_ID = 'CanopyEditorBehaviorsAttached'

/**
 * Whether a CloudFront path pattern matches a request path: `*` is any run of
 * characters, `?` exactly one, matching is case-sensitive, and the pattern's
 * leading `/` is optional.
 */
export function cloudFrontPathPatternMatches(pattern: string, path: string): boolean {
  const glob = pattern.startsWith('/') ? pattern : `/${pattern}`
  // Greedy wildcard match: on a mismatch, let the most recent `*` absorb one
  // more character and retry from there.
  let g = 0
  let p = 0
  let star = -1
  let resume = 0
  while (p < path.length) {
    if (g < glob.length && (glob[g] === '?' || glob[g] === path[p])) {
      g++
      p++
    } else if (g < glob.length && glob[g] === '*') {
      star = g++
      resume = p
    } else if (star !== -1) {
      g = star + 1
      p = ++resume
    } else {
      return false
    }
  }
  while (glob[g] === '*') g++
  return g === glob.length
}

/**
 * Throws when the origin read timeout exceeds the 60s CloudFront accepts
 * without a quota increase, which it would reject at deploy. Neither construct
 * takes a higher, quota-raised value.
 */
export function assertOriginReadTimeout(readTimeout: Duration, owner: string): void {
  if (readTimeout.toSeconds() > MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT.toSeconds()) {
    throw new Error(
      `${owner}: originReadTimeout is ${readTimeout.toSeconds()}s, but CloudFront ` +
        `allows at most ${MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT.toSeconds()}s without a service-quota ` +
        `increase, and these constructs do not take a higher value. Lower the CMS Lambda's ` +
        `timeout to ${MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT.toSeconds()}s or less. A shorter origin ` +
        `timeout than the Lambda's would 504 at the edge on requests that actually succeed.`,
    )
  }
}

/**
 * The viewer-request function every Lambda behavior needs. CloudFront gives
 * the origin the Function URL's own Host (forwarding the viewer Host would
 * break the OAC SigV4 signature), and Lambda Web Adapter adds no
 * `x-forwarded-*` headers, so without this Clerk/Next derive sign-in redirect
 * URLs from the IAM-authed Function URL host and the redirect 403s.
 *
 * Only `x-forwarded-host`: `x-forwarded-proto` is on CloudFront Functions'
 * disallowed list and setting it fails every request with a 502. The viewer
 * side is HTTPS-only, so proto is unambiguous anyway.
 */
export function createForwardedHostFunction(scope: Construct, id: string): cloudfront.Function {
  return new cloudfront.Function(scope, id, {
    code: cloudfront.FunctionCode.fromInline(
      [
        'function handler(event) {',
        '  var request = event.request;',
        "  request.headers['x-forwarded-host'] = { value: request.headers.host.value };",
        '  return request;',
        '}',
      ].join('\n'),
    ),
  })
}

/**
 * Response headers for everything the CMS Lambda serves.
 *
 * - `frame-ancestors 'self'` (plus `X-Frame-Options: SAMEORIGIN` for browsers
 *   that ignore it) stops other sites framing the editor. `'self'` keeps the
 *   editor's own preview iframe working, which frames same-origin site pages.
 * - Both framing headers have `override: false`, so an origin that sends its
 *   own CSP keeps it whole; when that CSP has no `frame-ancestors` and the
 *   origin sends no `X-Frame-Options`, this one applies.
 * - `X-Robots-Tag: noindex` overrides: nothing the Lambda serves is meant to
 *   be indexed.
 * - No `Cross-Origin-Opener-Policy`: it can cut the `window.opener` link a
 *   popup-based OAuth sign-in reports back through.
 */
export function createEditorResponseHeadersPolicy(
  scope: Construct,
  id: string,
): cloudfront.ResponseHeadersPolicy {
  return new cloudfront.ResponseHeadersPolicy(scope, id, {
    securityHeadersBehavior: {
      contentSecurityPolicy: { contentSecurityPolicy: "frame-ancestors 'self'", override: false },
      frameOptions: { frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN, override: false },
      contentTypeOptions: { override: true },
      strictTransportSecurity: {
        accessControlMaxAge: Duration.days(365),
        includeSubdomains: false,
        override: false,
      },
    },
    customHeadersBehavior: {
      customHeaders: [{ header: 'X-Robots-Tag', value: 'noindex', override: true }],
    },
  })
}

/**
 * A year-long cache for content-hashed build output. The cache key carries no
 * header, cookie or query string, so every viewer shares one copy.
 */
export function createStaticCachePolicy(scope: Construct, id: string): cloudfront.CachePolicy {
  return new cloudfront.CachePolicy(scope, id, {
    defaultTtl: Duration.days(365),
    maxTtl: Duration.days(365),
    minTtl: Duration.days(365),
    headerBehavior: cloudfront.CacheHeaderBehavior.none(),
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    cookieBehavior: cloudfront.CacheCookieBehavior.none(),
  })
}

/**
 * Behavior options for a route the CMS Lambda serves. The managed
 * CACHING_DISABLED policy as it is: CloudFront rejects any non-none cache-key
 * setting on a caching-disabled policy, and the origin still gets the whole
 * viewer request (headers, cookies, query string, minus Host, which would
 * break the OAC signature) through ALL_VIEWER_EXCEPT_HOST_HEADER.
 */
export function lambdaBehaviorOptions(
  viewerRequestFunction: cloudfront.FunctionAssociation['function'] | undefined,
  responseHeadersPolicy: NonNullable<cloudfront.AddBehaviorOptions['responseHeadersPolicy']>,
): cloudfront.AddBehaviorOptions {
  return {
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
    responseHeadersPolicy,
    functionAssociations: viewerRequestFunction && [
      { function: viewerRequestFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
    ],
  }
}

/** Options for `CanopyCmsService.attachTo`. */
export interface CanopyCmsAttachOptions {
  /**
   * Viewer-request function for the editor behaviors, in place of the
   * `x-forwarded-host` function `attachTo` otherwise creates. CloudFront allows
   * one per behavior, so pass this when the distribution's own function must
   * run on every route.
   *
   * It must set `x-forwarded-host` from the viewer's Host, or sign-in
   * redirects point at the Function URL and 403. It must not gate on HTTP
   * Basic auth; the CMS authenticates these routes itself. A Basic-gated site sets
   * the CMS config's `unauthenticatedStatus: 419` (see docs/deploying-to-aws.md).
   *
   * @default - a function that sets `x-forwarded-host` and nothing else
   */
  viewerRequestFunction?: cloudfront.IFunction

  /**
   * Options merged into the editor and preview behaviors, after this construct's
   * own; keys whose value is `undefined` are ignored. A `responseHeadersPolicy`
   * here replaces the editor's framing protection, so it must carry its own.
   * `functionAssociations` here replaces the viewer-request function as well,
   * which is why it cannot be combined with `viewerRequestFunction`.
   *
   * @default - no overrides
   */
  behaviorOverrides?: Partial<cloudfront.AddBehaviorOptions>

  /**
   * The CMS build's Next `assetPrefix`, such as `'/edit-assets'`: adds a
   * `/<prefix>/*` behavior to the Lambda with a year-long cache, since the
   * chunks under it are content-hashed.
   *
   * A CMS build that shares a distribution with a static site needs one.
   * Without it the editor page loads its chunks from `/_next/static/*`, which
   * the site serves, and they 404. Set `assetPrefix` in the CMS build's
   * `next.config` only (not the static export's) and pass the same value here.
   *
   * A path starting with `/`, without a trailing `/` or wildcards, and
   * overlapping neither the editor's routes, `/_next/*` nor AssetSupport's
   * `/assets/*`. Of `behaviorOverrides`, only `responseHeadersPolicy` applies
   * to this behavior.
   *
   * @default - no asset-prefix behavior
   */
  editorAssetPrefix?: string

  /**
   * The path of the CMS-only preview route, the same value as
   * `editor.previewPrefix` in the CanopyCMS config (e.g. `'/preview'`): adds
   * `<prefix>` and `<prefix>/*` behaviors with the editor routes' options, so
   * the editor's preview pane reaches the CMS rather than the site.
   *
   * Validated like `editorAssetPrefix`, and must not overlap it either. An
   * absolute `https://` `previewPrefix` is another origin and needs nothing
   * here.
   *
   * @default - no preview behaviors
   */
  previewPrefix?: string
}

/**
 * The routes a prefix option adds, after refusing a prefix that is not a
 * plain path below the root or that overlaps `reserved` in either direction.
 */
function prefixRoutes(
  option: 'editorAssetPrefix' | 'previewPrefix',
  prefix: string,
  reserved: EditorRoute[],
): EditorRoute[] {
  const fail = (reason: string) =>
    new Error(`CanopyCmsService.attachTo: ${option} '${prefix}' ${reason}.`)
  if (!prefix.startsWith('/') || prefix === '/') {
    throw fail("must start with '/' and name a path below the root")
  }
  if (prefix.endsWith('/')) throw fail("must not end with a trailing '/'")
  // CloudFront collapses `//` in request paths, so a pattern holding one never matches.
  if (prefix.includes('//')) throw fail("must not contain '//'")
  if (/[*?]/.test(prefix))
    throw fail('must not contain * or ?, which CloudFront reads as wildcards')
  if (!/^[A-Za-z0-9_\-.$/~"'@:+&]+$/.test(prefix)) {
    throw fail(
      `may hold only the characters CloudFront allows in a path pattern: A-Z a-z 0-9 _-.$/~"'@:+&`,
    )
  }
  const routes: EditorRoute[] =
    option === 'previewPrefix'
      ? [
          { pattern: prefix, probes: [prefix] },
          { pattern: `${prefix}/*`, probes: [`${prefix}/`, `${prefix}/x`] },
        ]
      : [{ pattern: `${prefix}/*`, probes: [`${prefix}/x`] }]
  const overlaps = (a: EditorRoute, b: EditorRoute) =>
    b.probes.some((path) => cloudFrontPathPatternMatches(a.pattern, path))
  const clash = reserved.find((route) =>
    routes.some((own) => overlaps(route, own) || overlaps(own, route)),
  )
  if (clash) {
    throw fail(
      `overlaps '${clash.pattern}', so CloudFront would send one route's requests to the ` +
        `other's behavior. Pick a prefix of its own, such as '/edit-assets' or '/preview'`,
    )
  }
  return routes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One list from a distribution's L1 config, resolved but still camelCased. */
function resolvedConfigList(
  distribution: cloudfront.Distribution,
  field: 'cacheBehaviors' | 'customErrorResponses',
): Record<string, unknown>[] {
  const cfn = distribution.node.defaultChild
  if (!(cfn instanceof cloudfront.CfnDistribution)) return []
  const config: unknown = cfn.distributionConfig
  if (!isRecord(config)) return []
  const list: unknown = Stack.of(distribution).resolve(config[field])
  return Array.isArray(list) ? list.filter(isRecord) : []
}

/**
 * Error messages for every behavior that CloudFront would match before one of
 * the editor's, which leaves that editor route unreachable.
 */
function shadowedEditorRoutes(
  distribution: cloudfront.Distribution,
  routes: EditorRoute[],
): string[] {
  const patterns = resolvedConfigList(distribution, 'cacheBehaviors')
    .map((behavior) => behavior.pathPattern)
    .filter((pattern): pattern is string => typeof pattern === 'string')
  const errors: string[] = []
  for (const { pattern: editorPattern, probes } of routes) {
    // The last occurrence, so a duplicate of an editor pattern on either side
    // of it is reported too.
    const index = patterns.lastIndexOf(editorPattern)
    const shadow = patterns
      .slice(0, index)
      .find((earlier) => probes.some((path) => cloudFrontPathPatternMatches(earlier, path)))
    if (index !== -1 && shadow !== undefined) {
      errors.push(
        `CanopyCmsService.attachTo: the distribution's '${shadow}' behavior is listed before ` +
          `the editor's '${editorPattern}' and matches the same requests, so CloudFront never ` +
          `reaches the editor behavior. Remove hand-wired editor behaviors (such as '/edit*') ` +
          `and let attachTo add them.`,
      )
    }
  }
  return errors
}

/**
 * The status codes of custom error responses that replace the origin's
 * response. A TTL-only entry changes caching, not the response.
 */
function rewrittenErrorCodes(distribution: cloudfront.Distribution): number[] {
  return resolvedConfigList(distribution, 'customErrorResponses')
    .filter((entry) => entry.responseCode !== undefined || entry.responsePagePath !== undefined)
    .map((entry) => entry.errorCode)
    .filter((code): code is number => typeof code === 'number')
}

/**
 * Attach the editor's behaviors to a distribution. See
 * `CanopyCmsService.attachTo`, which is the public entry point.
 */
export function attachEditorBehaviors(
  distribution: cloudfront.Distribution,
  functionUrl: lambda.IFunctionUrl,
  readTimeout: Duration,
  options: CanopyCmsAttachOptions = {},
): void {
  if (distribution.node.tryFindChild(EDITOR_ATTACHED_MARKER_ID)) {
    throw new Error(
      'CanopyCmsService: attachTo() was already called for this distribution. Each editor ' +
        'pattern would be attached twice and CloudFront rejects duplicate path patterns at ' +
        'deploy time.',
    )
  }
  if (options.viewerRequestFunction && options.behaviorOverrides?.functionAssociations) {
    throw new Error(
      'CanopyCmsService.attachTo: pass viewerRequestFunction or ' +
        'behaviorOverrides.functionAssociations, not both. The overrides replace the whole ' +
        'functionAssociations list, so the viewerRequestFunction would be silently dropped.',
    )
  }
  assertOriginReadTimeout(readTimeout, 'CanopyCmsService.attachTo')
  const assetRoutes =
    options.editorAssetPrefix === undefined
      ? []
      : prefixRoutes('editorAssetPrefix', options.editorAssetPrefix, RESERVED_ROUTES)
  const previewRoutes =
    options.previewPrefix === undefined
      ? []
      : prefixRoutes('previewPrefix', options.previewPrefix, [...RESERVED_ROUTES, ...assetRoutes])
  const marker = new Construct(distribution, EDITOR_ATTACHED_MARKER_ID)

  // Scoped to the distribution so everything lands in its stack, which may
  // not be the service's.
  // None at all when the overrides bring their own associations, which would
  // otherwise leave a deployed function associated with nothing.
  const viewerRequestFunction =
    options.viewerRequestFunction ??
    (options.behaviorOverrides?.functionAssociations
      ? undefined
      : createForwardedHostFunction(distribution, 'CanopyEditorForwardedHostFunction'))
  const responseHeadersPolicy =
    options.behaviorOverrides?.responseHeadersPolicy ??
    createEditorResponseHeadersPolicy(distribution, 'CanopyEditorResponseHeadersPolicy')
  const behavior = lambdaBehaviorOptions(viewerRequestFunction, responseHeadersPolicy)
  const definedOverrides = Object.fromEntries(
    Object.entries(options.behaviorOverrides ?? {}).filter(([, value]) => value !== undefined),
  )
  const origin = origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl, { readTimeout })
  for (const { pattern } of [...EDITOR_ROUTES, ...previewRoutes]) {
    distribution.addBehavior(pattern, origin, { ...behavior, ...definedOverrides })
  }
  for (const { pattern } of assetRoutes) {
    distribution.addBehavior(pattern, origin, {
      cachePolicy: createStaticCachePolicy(distribution, 'CanopyEditorAssetCachePolicy'),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      responseHeadersPolicy,
    })
  }
  const routes = [...EDITOR_ROUTES, ...previewRoutes, ...assetRoutes]

  // Custom error responses are fixed at construction, so they are known now.
  const rewritten = rewrittenErrorCodes(distribution)
  if (rewritten.length > 0) {
    Annotations.of(distribution).addWarningV2(
      'canopycms:editor-custom-error-responses',
      `This distribution rewrites ${rewritten.join(', ')} responses, and CloudFront custom ` +
        `error responses are distribution-wide: they also replace the editor API's JSON errors, ` +
        `so the editor reports "Unexpected response from server" instead of the real error. ` +
        `See "Custom error responses" in docs/deploying-to-aws.md.`,
    )
  }

  // Behaviors can still be added after this call, so shadowing is checked at synth.
  marker.node.addValidation({ validate: () => shadowedEditorRoutes(distribution, routes) })
}
