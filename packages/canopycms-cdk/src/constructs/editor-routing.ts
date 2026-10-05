import { Construct } from 'constructs'
import {
  Annotations,
  Duration,
  Stack,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_lambda as lambda,
} from 'aws-cdk-lib'

/** CloudFront's maximum origin read timeout without a service-quota increase. */
export const MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT = Duration.seconds(60)

/**
 * The routes the editor needs from the CMS Lambda on a distribution it shares
 * with a site: the editor page and the catch-all API route `canopycms init`
 * scaffolds. `/edit` and `/edit/*` rather than `/edit*`, which also matches
 * `/editorial` and `/edit-assets/…` and so takes site pages away from the site.
 *
 * Not included, because on a shared distribution they belong to the site:
 * `/_next/static/*` (the CMS build's chunks must be reachable there too) and
 * `/assets/*` (`AssetSupport.attachTo` owns it).
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
 * Throws when CloudFront would cut the Lambda short: an origin read timeout
 * above the 60s ceiling is rejected at deploy, and a lower one than the
 * Lambda's 504s at the edge on requests that succeed.
 */
export function assertOriginReadTimeout(readTimeout: Duration, owner: string): void {
  if (readTimeout.toSeconds() > MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT.toSeconds()) {
    throw new Error(
      `${owner}: originReadTimeout is ${readTimeout.toSeconds()}s, but CloudFront ` +
        `allows at most ${MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT.toSeconds()}s without a service-quota ` +
        `increase. Either lower the CMS Lambda's timeout to match, or request a quota increase for ` +
        `"Origin response timeout" and pass the higher value explicitly. Deploying with a shorter ` +
        `origin timeout than the Lambda's would 504 at the edge on requests that actually succeed.`,
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
 *   own CSP keeps it whole; when that CSP has no `frame-ancestors`, the
 *   `X-Frame-Options` still applies.
 * - `X-Robots-Tag: noindex` overrides: nothing the Lambda serves is meant to
 *   be indexed.
 * - No `Cross-Origin-Opener-Policy`: it severs `window.opener`, which Clerk's
 *   OAuth popup sign-in needs.
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
 * Behavior options for a route the CMS Lambda serves. The managed
 * CACHING_DISABLED policy as it is: CloudFront rejects any non-none cache-key
 * setting on a caching-disabled policy, and the origin still gets the whole
 * viewer request (headers, cookies, query string, minus Host, which would
 * break the OAC signature) through ALL_VIEWER_EXCEPT_HOST_HEADER.
 */
export function lambdaBehaviorOptions(
  viewerRequestFunction: cloudfront.FunctionAssociation['function'],
  responseHeadersPolicy: NonNullable<cloudfront.AddBehaviorOptions['responseHeadersPolicy']>,
): cloudfront.AddBehaviorOptions {
  return {
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
    responseHeadersPolicy,
    functionAssociations: [
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
   * Basic auth: the API answers 401 without `WWW-Authenticate`, and a browser
   * that sees that drops its cached Basic credential and prompts again.
   *
   * @default - a function that sets `x-forwarded-host` and nothing else
   */
  viewerRequestFunction?: cloudfront.IFunction

  /**
   * Options merged into all three editor behaviors, after this construct's
   * own; keys whose value is `undefined` are ignored. A `responseHeadersPolicy`
   * here replaces the editor's framing protection, so it must carry its own.
   * `functionAssociations` here replaces the viewer-request function as well,
   * which is why it cannot be combined with `viewerRequestFunction`.
   *
   * @default - no overrides
   */
  behaviorOverrides?: Partial<cloudfront.AddBehaviorOptions>
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
function shadowedEditorRoutes(distribution: cloudfront.Distribution): string[] {
  const patterns = resolvedConfigList(distribution, 'cacheBehaviors')
    .map((behavior) => behavior.pathPattern)
    .filter((pattern): pattern is string => typeof pattern === 'string')
  const errors: string[] = []
  for (const editorPattern of EDITOR_PATH_PATTERNS) {
    // The last occurrence, so a duplicate of an editor pattern on either side
    // of it is reported too.
    const index = patterns.lastIndexOf(editorPattern)
    const shadow = patterns
      .slice(0, index)
      .find((earlier) =>
        EDITOR_PROBE_PATHS[editorPattern].some((path) =>
          cloudFrontPathPatternMatches(earlier, path),
        ),
      )
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
  const marker = new Construct(distribution, EDITOR_ATTACHED_MARKER_ID)

  // Scoped to the distribution so everything lands in its stack, which may
  // not be the service's.
  const viewerRequestFunction =
    options.viewerRequestFunction ??
    createForwardedHostFunction(distribution, 'CanopyEditorForwardedHostFunction')
  const behavior = lambdaBehaviorOptions(
    viewerRequestFunction,
    options.behaviorOverrides?.responseHeadersPolicy ??
      createEditorResponseHeadersPolicy(distribution, 'CanopyEditorResponseHeadersPolicy'),
  )
  const definedOverrides = Object.fromEntries(
    Object.entries(options.behaviorOverrides ?? {}).filter(([, value]) => value !== undefined),
  )
  const origin = origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl, { readTimeout })
  for (const pattern of EDITOR_PATH_PATTERNS) {
    distribution.addBehavior(pattern, origin, { ...behavior, ...definedOverrides })
  }

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
  marker.node.addValidation({ validate: () => shadowedEditorRoutes(distribution) })
}
