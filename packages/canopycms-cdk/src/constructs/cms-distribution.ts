import { Construct } from 'constructs'
import {
  Duration,
  Stack,
  Token,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_certificatemanager as acm,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_lambda as lambda,
} from 'aws-cdk-lib'
import { DEFAULT_CMS_LAMBDA_TIMEOUT, MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT } from './cms-service'
import type { AssetSupport } from './asset-support'
import {
  ASSETS_PATH_PATTERN,
  ASSETS_TRANSFORM_PATH_PATTERN,
  ASSET_BEHAVIOR_SPREAD_MISTAKE_KEYS,
} from './asset-support'

/**
 * Merge caller behaviors over this construct's own, preserving THE CALLER'S
 * ordering for every key they supply.
 *
 * A plain `{ ...defaults, ...caller }` gets the values right and the ORDER
 * wrong: JavaScript keeps an overridden key at its first-insertion index, so a
 * caller who overrides `/_next/static/*` finds it pinned ahead of every other
 * pattern they passed, regardless of the order they wrote. Since CloudFront
 * matches path patterns in order, that silently makes a more specific pattern
 * listed after it unreachable -- exactly the failure the prop's doc comment
 * warns callers to avoid, introduced by the merge itself.
 *
 * Dropping collided defaults FIRST means the caller's own object contributes
 * its keys in its own order.
 */
function mergeBehaviors(
  defaults: Record<string, cloudfront.BehaviorOptions>,
  caller: Record<string, cloudfront.BehaviorOptions> | undefined,
  attachingAssetSupport: boolean,
): Record<string, cloudfront.BehaviorOptions> {
  if (!caller) return defaults
  // Compare NORMALIZED keys here too. CloudFront treats a leading '/' as
  // optional, so a caller passing `'_next/static/*'` did not displace this
  // construct's own `'/_next/static/*'` default and both were emitted -- two
  // behaviors CloudFront reads as the same pattern, which it rejects at
  // deploy. Same reason the hazard checks below normalize.
  const callerPatterns = new Set(Object.keys(caller).map(normalizePathPattern))
  const uncollided = Object.fromEntries(
    Object.entries(defaults).filter(
      ([pattern]) => !callerPatterns.has(normalizePathPattern(pattern)),
    ),
  )
  const normalizedCallerKeys = Object.keys(caller).map(normalizePathPattern)
  const duplicateCallerPattern = normalizedCallerKeys.find(
    (pattern, i) => normalizedCallerKeys.indexOf(pattern) !== i,
  )
  if (duplicateCallerPattern !== undefined) {
    throw new Error(
      `CanopyCmsDistribution: additionalBehaviors has two keys that CloudFront reads as the ` +
        `same path pattern (${JSON.stringify(duplicateCallerPattern)} with and without its ` +
        `leading '/'). CloudFront rejects duplicate path patterns at deploy time. Keep one ` +
        `spelling.`,
    )
  }

  const merged = { ...uncollided, ...caller }
  assertNoAssetBehaviorOrderingHazards(merged, attachingAssetSupport)
  return merged
}

/**
 * Guards against the three AssetSupport CloudFront-behavior hazards a manually
 * assembled `additionalBehaviors` can introduce (see
 * `AssetSupport.attachTo()`'s doc comment for the full mechanism):
 *
 * 1. The literal keys `assets`/`assetsTransform` present in `merged` mean
 *    `assetSupport.assetBehaviors()`'s return value was spread directly into
 *    `additionalBehaviors` (a `Record<pathPattern, BehaviorOptions>`) instead
 *    of being attached via `assetSupport.attachTo(distribution)` or this
 *    construct's `assetSupport` prop. This type-checks and deploys clean,
 *    synthesizing two behaviors matching the literal path patterns `assets`
 *    and `assetsTransform`, which nothing ever requests.
 * 2. `/assets/*` listed before `/assets/t/*` means CloudFront's first-match-
 *    wins ordering serves every transform request off the broader, S3-only
 *    `/assets/*` behavior, permanently 403ing any derivative that has not
 *    already been computed (an OAC-signed S3 miss reports 403).
 * 3. Either asset pattern present in `merged` WHILE the `assetSupport` prop is
 *    also passed means both wiring routes are active at once, so each pattern
 *    is attached twice. This is the migration mistake specifically - keeping a
 *    hand-wired block while adopting the prop - and hazard 2 cannot catch it,
 *    because the hand-written order is usually the correct one.
 *
 * `Object.keys` insertion order is spec-guaranteed for string keys like
 * these (none are integer-like array-index strings), so comparing index
 * order here is sound.
 *
 * SCOPE LIMIT: this protects only callers going through
 * `CanopyCmsDistribution`'s own `additionalBehaviors` merge. It cannot help a
 * bespoke `new cloudfront.Distribution(...)` assembled elsewhere -
 * `AssetSupport.attachTo()` is the answer there.
 */
/**
 * CloudFront treats the leading `/` on a path pattern as optional -- `assets/*`
 * and `/assets/*` match exactly the same requests, and AWS's own console and
 * docs frequently show the slash-less spelling. The checks below therefore
 * compare NORMALIZED keys: without this, writing `{ 'assets/*': ..., 'assets/t/*': ... }`
 * walked past all three hazards and synthesized the broad-pattern-first order
 * this guard exists to refuse -- silently, which is the worst of the failure
 * modes here.
 */
function normalizePathPattern(pattern: string): string {
  return pattern.startsWith('/') ? pattern.slice(1) : pattern
}

/** See the three-hazard list documented above `normalizePathPattern`. */
function assertNoAssetBehaviorOrderingHazards(
  merged: Record<string, cloudfront.BehaviorOptions>,
  attachingAssetSupport: boolean,
): void {
  const keys = Object.keys(merged).map(normalizePathPattern)
  const assetsPattern = normalizePathPattern(ASSETS_PATH_PATTERN)
  const transformPattern = normalizePathPattern(ASSETS_TRANSFORM_PATH_PATTERN)

  const spreadMistakeKeys = ASSET_BEHAVIOR_SPREAD_MISTAKE_KEYS.filter((key) => key in merged)
  if (spreadMistakeKeys.length > 0) {
    throw new Error(
      `CanopyCmsDistribution: additionalBehaviors has literal key(s) ` +
        `${spreadMistakeKeys.map((k) => JSON.stringify(k)).join(', ')}, which is not a ` +
        `CloudFront path pattern. This usually means assetSupport.assetBehaviors()'s return ` +
        `value was spread directly into additionalBehaviors instead of attached via ` +
        `assetSupport.attachTo(distribution) or this construct's \`assetSupport\` prop - either ` +
        `of which attaches the real '${ASSETS_PATH_PATTERN}' and '${ASSETS_TRANSFORM_PATH_PATTERN}' ` +
        `path patterns in the required order.`,
    )
  }

  // Both halves wired at once. `attachTo` runs AFTER the distribution is
  // constructed, so its `addBehavior` calls never pass through this function -
  // meaning a caller who keeps a hand-wired asset block AND adopts the
  // `assetSupport` prop gets each pattern attached twice. Measured: CDK does
  // not object, and synthesizes CacheBehaviors
  // ['/assets/t/*','/assets/*','/assets/t/*','/assets/*'], which CloudFront
  // then rejects at deploy time for the duplicate path patterns. That is a
  // late failure of exactly the kind this guard exists to convert into a synth
  // one, and it is the most likely mistake during migration: the correct
  // hand-written order does NOT trip the check below, so nothing else would
  // catch it.
  if (attachingAssetSupport) {
    const alsoWiredByHand = [ASSETS_PATH_PATTERN, ASSETS_TRANSFORM_PATH_PATTERN].filter((pattern) =>
      keys.includes(normalizePathPattern(pattern)),
    )
    if (alsoWiredByHand.length > 0) {
      throw new Error(
        `CanopyCmsDistribution: the \`assetSupport\` prop attaches ` +
          `'${ASSETS_TRANSFORM_PATH_PATTERN}' and '${ASSETS_PATH_PATTERN}' itself, but ` +
          `additionalBehaviors already lists ${alsoWiredByHand.map((p) => `'${p}'`).join(' and ')}. ` +
          `Each pattern would be attached twice and CloudFront rejects duplicate path patterns at ` +
          `deploy time. Remove the asset entries from additionalBehaviors and keep the ` +
          `\`assetSupport\` prop, which also guarantees the required order.`,
      )
    }
  }

  const assetsIndex = keys.indexOf(assetsPattern)
  const transformIndex = keys.indexOf(transformPattern)
  if (assetsIndex !== -1 && transformIndex !== -1 && assetsIndex < transformIndex) {
    throw new Error(
      `CanopyCmsDistribution: additionalBehaviors lists '${ASSETS_PATH_PATTERN}' before ` +
        `'${ASSETS_TRANSFORM_PATH_PATTERN}'. CloudFront matches path patterns in the order given ` +
        `and stops at the first match, so every '${ASSETS_TRANSFORM_PATH_PATTERN}' request would ` +
        `be served by the broader, S3-only '${ASSETS_PATH_PATTERN}' behavior and never fail over ` +
        `to the transform Lambda - a permanent 403 on any derivative that has not already been ` +
        `computed. List '${ASSETS_TRANSFORM_PATH_PATTERN}' first, or use ` +
        `assetSupport.attachTo(distribution) / this construct's \`assetSupport\` prop, which get ` +
        `the order right automatically.`,
    )
  }
}

export interface CanopyCmsDistributionProps {
  /** Lambda Function URL from CanopyCmsService */
  functionUrl: lambda.FunctionUrl

  /** Domain name for the CMS (e.g., 'cms.docs.example.org') */
  domainName: string

  /** Route53 hosted zone domain (e.g., 'example.org') */
  hostedZoneDomain: string

  /** Optional: provide an existing hosted zone instead of looking up by domain */
  hostedZone?: route53.IHostedZone

  /** Optional: provide an existing ACM certificate instead of creating one */
  certificate?: acm.ICertificate

  /**
   * How long CloudFront waits for the origin to respond.
   *
   * Defaults to {@link DEFAULT_CMS_LAMBDA_TIMEOUT}, matching the CMS Lambda's
   * own default. Pass `cmsService.timeout` when you override the Lambda's
   * timeout, so the two cannot drift.
   *
   * Left unset on the origin, CloudFront applies its service default of **30
   * seconds** — which silently caps a 60s Lambda at half its budget. Every
   * request landing in the 30-60s band is answered 504 at the edge while the
   * invocation continues to completion behind it: server-side success,
   * viewer-facing failure, and nothing in either log explaining the other
   * half. First-touch branch provisioning does a full `git clone` onto EFS
   * inside the request, so this is a real path.
   *
   * Capped at 60s: CloudFront rejects more without a service-quota increase.
   */
  originReadTimeout?: Duration

  /**
   * Extra CloudFront behaviors, merged with this construct's own.
   *
   * The reason this exists: `AssetSupport.assetBehaviors()` returns the two
   * behaviors a media-enabled deployment needs (`/assets/*` and
   * `/assets/t/*`), and without a way to pass them in there was no route to
   * attach them to the distribution the scaffold generates — making the
   * scaffold's own "uncomment to enable media" path a dead end.
   *
   * ORDER MATTERS. CloudFront matches path patterns in the order given, so a
   * more specific pattern must be listed before a more general one that also
   * matches: `/assets/t/*` before `/assets/*`, or every transform request is
   * served by the static S3-only behavior and never fails over to the
   * transform Lambda.
   *
   * Keys here override this construct's own behaviors on collision, which is
   * deliberate — the caller is more specific than the default — and an
   * overridden key takes YOUR position in this object, not the position the
   * default held. (A plain object spread would do the opposite; see
   * `mergeBehaviors`.)
   *
   * Prefer the `assetSupport` prop over wiring `AssetSupport`'s behaviors in
   * here by hand — but if you do it by hand anyway, `mergeBehaviors` throws
   * at synth if it sees any of the three AssetSupport footguns: `/assets/*`
   * listed before `/assets/t/*`; the literal keys `assets`/`assetsTransform`
   * (from spreading `assetBehaviors()`'s return value directly into this
   * object instead of keying it by path pattern); or an asset pattern listed
   * here at all while the `assetSupport` prop is also passed (see that
   * prop's own doc comment). See `assertNoAssetBehaviorOrderingHazards`'s
   * doc comment for the full list.
   */
  additionalBehaviors?: Record<string, cloudfront.BehaviorOptions>

  /**
   * Attach `AssetSupport`'s CloudFront behaviors (`/assets/*` and
   * `/assets/t/*`) to the distribution this construct builds, in the only
   * safe order - see `AssetSupport.attachTo()`'s doc comment for why the
   * order matters. Calls `assetSupport.attachTo(distribution)` for you right
   * after construction, with nothing to forget.
   *
   * If the asset behaviors need per-behavior options - a viewer-request
   * function for tier auth being the motivating case, since without it
   * `/assets/*` is anonymously readable on an authenticated tier - pass
   * `assetBehaviorOverrides` alongside this prop. That requirement used to mean
   * dropping this prop and hand-calling `attachTo` after construction, which
   * sent exactly the adopter who most needs the ordering guarantee back to the
   * manual path this prop exists to replace.
   *
   * Prefer this over passing `assetSupport.assetBehaviors()` through
   * `additionalBehaviors` by hand - that stays available as an escape hatch
   * (e.g. for behaviors that are not from `AssetSupport` at all), and this
   * construct's synth-time guard (`mergeBehaviors`) still checks it for the
   * three ways that manual wiring is known to go wrong: see
   * `additionalBehaviors`'s own doc comment.
   *
   * No ordering logic lives in this construct beyond calling this method -
   * ordering is encoded exactly once, in `AssetSupport.attachTo()` itself.
   *
   * @default - no asset behaviors are attached
   */
  assetSupport?: AssetSupport

  /**
   * Per-behavior options merged into BOTH asset behaviors, forwarded verbatim
   * to `AssetSupport.attachTo()`'s `overrides` parameter - see that method's
   * doc comment for the merge semantics and for why the same set goes to both.
   *
   * The motivating case is a distribution running a viewer-request function on
   * every behavior (tier basic-auth): without the same `functionAssociations`
   * on the asset behaviors, `/assets/*` is anonymously readable on an
   * authenticated tier.
   *
   * Useless without `assetSupport`, and silently so - there would be no
   * behaviors to merge it into - so that combination throws from this
   * construct's CONSTRUCTOR rather than being ignored. (A constructor throw,
   * not an `addValidation`: nothing later can make the combination valid. An
   * adopter sharing one props object across tiers, with `assetSupport` present
   * on only some of them, should make the whole prop conditional rather than
   * the overrides object.)
   *
   * @default - the asset behaviors are attached with no overrides
   */
  assetBehaviorOverrides?: Partial<cloudfront.AddBehaviorOptions>
}

/**
 * Optional CDK construct for CanopyCMS CloudFront distribution.
 *
 * Use this if you don't have existing CloudFront infrastructure.
 * If you do, use the functionUrl output from CanopyCmsService
 * and wire it into your own CloudFront setup.
 *
 * Creates:
 * - ACM certificate (DNS validated) — unless provided
 * - CloudFront distribution with Function URL origin
 * - Route53 A/AAAA alias records
 * - Cache policies: no-cache for /api/* and /edit*, cache /_next/static/*
 * - Viewer-request CloudFront Function setting x-forwarded-host (redirect-URL
 *   derivation behind the Host-stripping OAC origin)
 * - `AssetSupport`'s `/assets/*` and `/assets/t/*` behaviors, in the required
 *   order, when the `assetSupport` prop is passed
 */
export class CanopyCmsDistribution extends Construct {
  /** The CloudFront distribution */
  public readonly distribution: cloudfront.Distribution

  constructor(scope: Construct, id: string, props: CanopyCmsDistributionProps) {
    super(scope, id)

    // Overrides with nothing to override. They are merged into the asset
    // behaviors and there are none, so the only outcome is that whatever the
    // caller asked for - a tier-auth viewer function, most likely - silently
    // does not happen.
    if (props.assetBehaviorOverrides && !props.assetSupport) {
      throw new Error(
        'CanopyCmsDistribution: `assetBehaviorOverrides` was passed without `assetSupport`. ' +
          'The overrides are merged into the asset behaviors, so with no AssetSupport to attach ' +
          'there is nothing for them to apply to and they would be silently dropped - including ' +
          'a viewer-request function for tier auth. Pass `assetSupport` as well, or drop the ' +
          'overrides.',
      )
    }

    // ========================================================================
    // DNS — Hosted Zone lookup
    // ========================================================================

    const hostedZone =
      props.hostedZone ??
      route53.HostedZone.fromLookup(this, 'Zone', {
        domainName: props.hostedZoneDomain,
      })

    // ========================================================================
    // ACM Certificate
    // ========================================================================

    // CloudFront requires its ACM certificate to live in us-east-1, and this
    // construct creates one in the STACK's region. Nothing in the construct,
    // the scaffold, or docs/deploying-to-aws.md said so -- the scaffold merely
    // asks for an AWS_REGION variable with us-east-1 as an example -- so an
    // adopter elsewhere got an opaque region error and had to research both
    // workarounds themselves. Fail with the answer instead.
    //
    // Only when the region is actually known at synth: a region-agnostic stack
    // resolves to a token, and rejecting that would break `cdk synth` for
    // everyone (the token is not us-east-1 as a string). Those deploys are
    // rejected by CloudFront at deploy time as before.
    const stackRegion = Stack.of(this).region
    if (!props.certificate && !Token.isUnresolved(stackRegion) && stackRegion !== 'us-east-1') {
      throw new Error(
        `CanopyCmsDistribution: CloudFront requires its ACM certificate in us-east-1, but this ` +
          `stack is in ${stackRegion}, so the certificate this construct would create cannot be ` +
          `used. Either (a) create the certificate in a us-east-1 stack and pass it as the ` +
          `\`certificate\` prop, or (b) deploy this stack in us-east-1. See ` +
          `docs/deploying-to-aws.md.`,
      )
    }

    const certificate =
      props.certificate ??
      new acm.Certificate(this, 'Cert', {
        domainName: props.domainName,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      })

    // ========================================================================
    // CloudFront Distribution
    // ========================================================================

    // Origin: Lambda Function URL secured with Origin Access Control (OAC).
    // CloudFront signs each origin request with SigV4 so the AWS_IAM-protected
    // Function URL only accepts traffic from this distribution — direct hits to
    // the Function URL are rejected (DEP-H2). withOriginAccessControl creates
    // the OAC and grants CloudFront lambda:InvokeFunctionUrl automatically.
    //
    // readTimeout is passed EXPLICITLY. aws-cdk-lib emits it as
    // `originReadTimeout: this.props.readTimeout?.toSeconds()` — omitted
    // entirely when unset, so CloudFront's 30s service default applies and
    // silently halves the CMS Lambda's 60s budget. See the prop's doc comment.
    const readTimeout = props.originReadTimeout ?? DEFAULT_CMS_LAMBDA_TIMEOUT
    if (readTimeout.toSeconds() > MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT.toSeconds()) {
      throw new Error(
        `CanopyCmsDistribution: originReadTimeout is ${readTimeout.toSeconds()}s, but CloudFront ` +
          `allows at most ${MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT.toSeconds()}s without a service-quota ` +
          `increase. Either lower the CMS Lambda's timeout to match, or request a quota increase for ` +
          `"Origin response timeout" and pass the higher value explicitly. Deploying with a shorter ` +
          `origin timeout than the Lambda's would 504 at the edge on requests that actually succeed.`,
      )
    }
    const origin = origins.FunctionUrlOrigin.withOriginAccessControl(props.functionUrl, {
      readTimeout,
    })

    // Cache policy for API/editor routes: AWS's managed CACHING_DISABLED
    // policy. Deploy-proven (deploy-test epic, 2026-07-23): CloudFront
    // rejects ANY non-none cache-key setting on a caching-disabled policy -
    // Authorization in a header allowlist (aws/aws-cdk#16977) but also
    // cookieBehavior/queryStringBehavior `all()` ("The parameter
    // CookieBehavior is invalid for policy with caching disabled"). With
    // TTL 0 the cache key is meaningless anyway; the origin still receives
    // the full viewer request (headers/cookies/query string, minus Host -
    // forwarding Host would break the OAC-signed Function URL) via the
    // ALL_VIEWER_EXCEPT_HOST_HEADER origin request policy on the behavior.
    const noCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED

    // Cache policy for static assets
    const staticCachePolicy = new cloudfront.CachePolicy(this, 'StaticCachePolicy', {
      defaultTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      minTtl: Duration.days(365),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    })

    // CloudFront gives the origin the Function URL's own Host (forwarding the
    // viewer Host would break the OAC SigV4 signature), and Lambda Web Adapter
    // forwards no `x-forwarded-*` headers of its own - so without this
    // function, Clerk/Next derive sign-in redirect URLs from the IAM-authed
    // Function URL host instead of the public domain, and the redirect 403s
    // (direct Function URL hits are rejected). Deploy-proven (deploy-test
    // epic, 2026-07-23): x-forwarded-proto is on CloudFront Functions'
    // DISALLOWED header list - setting it fails every request with 502
    // FunctionValidationError. Only x-forwarded-host is set; proto is
    // unambiguous anyway (viewer-facing CloudFront is HTTPS-only via
    // REDIRECT_TO_HTTPS).
    const forwardedHostFunction = new cloudfront.Function(this, 'ForwardedHostFunction', {
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

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [props.domainName],
      certificate,
      defaultBehavior: {
        origin,
        cachePolicy: noCachePolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [
          {
            function: forwardedHostFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: mergeBehaviors(
        {
          '/_next/static/*': {
            origin,
            cachePolicy: staticCachePolicy,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          },
        },
        props.additionalBehaviors,
        props.assetSupport !== undefined,
      ),
    })

    // Attach AssetSupport's behaviors (if provided), in the only safe order -
    // see AssetSupport.attachTo()'s doc comment. This is the ONLY place this
    // construct deals with the asset behaviors' ordering; the actual ordering
    // logic lives exactly once, inside attachTo() itself. Callers who instead
    // pass `assetSupport.assetBehaviors()` through `additionalBehaviors` by
    // hand are covered by `mergeBehaviors`'s synth-time guard above instead.
    //
    // `assetBehaviorOverrides` is forwarded so that needing per-behavior
    // options is not a reason to leave this prop - and so the ordering
    // guarantee survives the tier-auth case that most needs it.
    props.assetSupport?.attachTo(this.distribution, props.assetBehaviorOverrides)

    // ========================================================================
    // DNS Records
    // ========================================================================

    new route53.ARecord(this, 'ARecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
    })

    new route53.AaaaRecord(this, 'AaaaRecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
    })
  }
}
