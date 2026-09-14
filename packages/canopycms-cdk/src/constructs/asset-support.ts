import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Construct } from 'constructs'
import {
  Duration,
  RemovalPolicy,
  Stack,
  Token,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
} from 'aws-cdk-lib'
import { attachLambdaExecutionPolicies } from './lambda-execution-role'

// This package (`canopycms-cdk`) is `"type": "module"`, so its compiled
// output is real ESM - `__dirname` is not a global there. Derive it from
// `import.meta.url` instead (mirrors ../../lambda/asset-transform/build.mjs).
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The transform Lambda's built code asset. ONE constant shared by the
 * deployability guard and `Code.fromAsset()` below: two independently-computed
 * paths would let the guard stat a directory that is never the one deployed,
 * with nothing wrong-looking at either call site.
 *
 * The `'..', '..'` walk holds from both `<pkg>/src/constructs/` (local source)
 * and `<pkg>/dist/constructs/` (published package) only because those sit at
 * the same depth - see the `__dirname` note above.
 */
const transformAssetDir = path.join(__dirname, '..', '..', 'lambda', 'asset-transform', 'dist')

/**
 * Written by `build:lambda` as the last act of a successful FULL build, once
 * the linux/arm64 sharp binary is verified present. The marker is positive
 * ("this bundle was verified") rather than negative, because a partial build
 * leaves a sharp-less `dist/` on disk WITHOUT reaching the `--skip-native`
 * branch: a "is it marked bad?" test would wave exactly that bundle through to
 * a deploy. See that script's header.
 */
const DEPLOYABLE_MARKER = '.deployable'

/**
 * The four S3 key prefixes the asset system uses. Source of truth is
 * `packages/canopycms/src/assets/asset-prefixes.ts`; these are copied as
 * literals rather than imported so this construct synths in a consumer CDK app
 * that has no `canopycms` resolvable. (The transform Lambda does import them -
 * it is bundled from inside this package; see its handler's doc comment.)
 */
const PREFIXES = {
  originals: 'asset-originals',
  staging: 'asset-staging',
  meta: 'asset-meta',
  public: 'assets',
  transform: 'assets/t',
} as const

/**
 * CORS preflight cache duration for presigned-POST uploads from the editor.
 * Used for the bucket's own CORS rule and, when `uploadBehavior` is on, for
 * both the edge's preflight response and its response headers policy.
 */
const CORS_MAX_AGE_SECONDS = 3000

/**
 * The only method the upload route exists to serve. Shared by the preflight
 * response the CloudFront Function returns and the response headers policy's
 * `Access-Control-Allow-Methods`, so a browser cannot be told two different
 * things about what it may send. (The BEHAVIOR still allows all methods -
 * CloudFront has no narrower set containing POST - which is a separate concern
 * handled by the URI rewrite; see `buildUploadBehavior`.)
 */
const UPLOAD_ALLOWED_METHOD = 'POST'

/**
 * Render a string array as a JavaScript literal for embedding in CloudFront
 * Function source.
 *
 * `JSON.stringify` escapes quotes and backslashes, so an adopter's origin
 * string cannot terminate the literal and inject code. It does NOT escape
 * U+2028/U+2029, legal in JSON but line terminators in JavaScript before
 * ES2019, and the CloudFront Functions runtime is not one to find out about on.
 */
function toFunctionLiteral(values: string[]): string {
  return JSON.stringify(values)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** Matches packages/canopycms/src/assets/store-s3.ts's `DEFAULT_MAX_UPLOAD_BYTES`. */
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024

const TRANSFORM_LAMBDA_MEMORY_MB = 1536
const TRANSFORM_LAMBDA_TIMEOUT = Duration.seconds(30)

/**
 * Concurrency cap on the transform Lambda.
 *
 * `/assets/t/*` is reachable by any anonymous viewer through CloudFront, and
 * `hash32` is not secret — it appears in every published page's `<img src>`.
 * Width and quality are allowlisted precisely to bound how many cache keys one
 * asset can have, but `crop` is a 4-decimal float rect (~10^16 values), so a
 * scripted loop of unique crops is an unbounded stream of guaranteed
 * CloudFront+S3 misses, each a sharp transform on a 1536MB Lambda plus a
 * permanently stored S3 object.
 *
 * A reservation is a CAP carved from the account's concurrency pool, not
 * pre-warmed capacity, so it costs nothing when idle (that is
 * `provisionedConcurrentExecutions`, which this is not). 10 mirrors the CMS
 * Lambda's own reservation: genuine demand is first-render misses only, since
 * every already-generated derivative is served by the S3 primary origin without
 * invoking this function at all.
 */
const TRANSFORM_LAMBDA_RESERVED_CONCURRENCY = 10

/**
 * Retention for generated derivatives under `assets/t/`.
 *
 * Everything under that prefix is REGENERABLE — source assets live under
 * `asset-originals/` and are never touched by this rule. Without it the bucket
 * keeps every derivative forever, including every object minted by the crop
 * amplifier above.
 *
 * S3 lifecycle is prefix+age based; there is no "expire if not recently read"
 * mode. Expiry is self-healing anyway: the next request for an expired
 * derivative misses S3, fails over to the transform Lambda, regenerates and
 * re-stores it. 180 days is long enough that only genuinely cold or abusive
 * objects age out.
 */
const TRANSFORM_OUTPUT_RETENTION = Duration.days(180)

/**
 * `/assets/t/*`-specific cache TTLs, custom rather than the managed
 * `CACHING_OPTIMIZED` used for plain `/assets/*`, whose 1-second MIN TTL is the
 * bug this policy exists to avoid. The transform Lambda's oversized-output path
 * (handler.ts) returns a `Cache-Control: no-store` 302 to the canonical S3 key;
 * ANY nonzero min TTL caches that redirect regardless of the origin's
 * `no-store`, and re-serving it while CloudFront's hit for the canonical key
 * still 403s/404s off S3 falls back to the Lambda again - a self-sustaining
 * redirect loop. `minTtl: 0` honors the origin's own `Cache-Control`
 * immediately; `maxTtl`/`defaultTtl` stay generous so the normal case (an
 * immutable 200 with a real `max-age`) still caches well.
 */
const TRANSFORM_CACHE_MIN_TTL = Duration.seconds(0)
const TRANSFORM_CACHE_DEFAULT_TTL = Duration.days(1)
const TRANSFORM_CACHE_MAX_TTL = Duration.days(365)

/**
 * Id of the marker construct `attachTo` adds to a distribution to record that
 * the asset behaviors are already on it.
 *
 * The fact recorded is "THIS distribution already carries these two patterns",
 * so the check is keyed on the DISTRIBUTION, not the attacher. Per-instance
 * state lets two different `AssetSupport` constructs attach to one distribution
 * and synthesize ['/assets/t/*','/assets/*','/assets/t/*','/assets/*'], the
 * duplicate-path-pattern deploy failure this guard converts into a synth error.
 * There is no legitimate form of that: both instances attach the same two
 * patterns, so the second is always wrong whichever construct owns it.
 *
 * The marker is a bare `Construct`, which emits nothing into the template.
 */
const ATTACHED_MARKER_ID = 'CanopyAssetBehaviorsAttached'

/**
 * The upload behavior's origin, which records having been bound to a
 * distribution.
 *
 * This lets the synth-time validation below tell "`uploadBehavior()` was
 * CALLED" from "its result actually reached a distribution" - two states a
 * memoized accessor cannot distinguish on its own, and the second is the one
 * that determines whether anything supplies Access-Control-Allow-Origin.
 *
 * CDK calls `bind()` exactly when a `Distribution` takes a behavior: from the
 * constructor for `defaultBehavior` (the topology `uploadBehavior()`
 * recommends), and from `addBehavior` for an additional one. Both bind eagerly
 * at construction, before any validation runs, in a cross-stack distribution
 * too. A behavior that is built and then dropped never binds.
 *
 * Observing the origin rather than searching the tree for the emitted behavior
 * is what makes the cross-stack case work: a consuming stack renders the
 * reference as `Fn::ImportValue`, not as the producing stack's resolved ARN, so
 * a tree search would report "not attached" for a perfectly correct cross-stack
 * distribution.
 */
class UploadOrigin extends origins.HttpOrigin {
  public attachedToDistribution = false

  public bind(
    scope: Construct,
    options: cloudfront.OriginBindOptions,
  ): cloudfront.OriginBindConfig {
    this.attachedToDistribution = true
    return super.bind(scope, options)
  }
}

/**
 * Configuration for the presigned-upload CloudFront behavior. See
 * `AssetSupportProps.uploadBehavior` to switch it on and
 * `AssetSupport.uploadBehavior()` for the topology it belongs in.
 */
export interface AssetUploadBehaviorOptions {
  /**
   * Origins the edge advertises in `Access-Control-Allow-Origin`, scoped to
   * this behavior alone.
   *
   * `['*']` by default, and a wildcard is defensible HERE in a way a
   * bucket-wide CORS rule is not, because **the edge authorises nothing**: a
   * presigned POST with a corrupted signature sent through this exact path
   * returns 403 and nothing lands. Authority is entirely the presigned policy,
   * which pins the bucket, the exact key, the content type, a size range and a
   * 15-minute expiry. So the wildcard widens who may READ the response, not who
   * may write - and the response is an empty 204. Narrow it to your editor
   * origin(s) if you would rather; nothing else here depends on it.
   *
   * ORIGINS ARE MATCHED EXACTLY, and `'*'` is honoured only as the sole entry.
   * CloudFront's response headers policy would accept a leftmost-subdomain
   * pattern (`https://*.preview.example.com`), but the CORS preflight is
   * answered at the edge by a CloudFront Function that compares strings, so a
   * pattern would pass the POST response's policy and fail every preflight.
   * Rather than half-honour it, the constructor refuses any entry containing
   * `*` unless the list is exactly `['*']`.
   *
   * @default ['*']
   */
  readonly allowedOrigins?: string[]
}

export interface AssetSupportProps {
  /**
   * Use an existing bucket (BYO mode - e.g. a site's existing content
   * bucket) instead of creating one. The caller owns that bucket's
   * lifecycle rules and CORS configuration in this mode: `IBucket` (an
   * imported bucket reference) has no CDK-level `addLifecycleRule`/
   * `addCorsRule` - only a bucket this construct creates itself does. See
   * `.claude/future-tasks/docs-site-assets-wiring.md` for the BYO-mode
   * wiring this is designed for.
   *
   * @default - a new private bucket is created (standalone mode)
   */
  readonly bucket?: s3.IBucket

  /**
   * Origins allowed to presigned-POST/PUT/GET upload directly to the bucket
   * (the editor's own origin(s) - e.g. `http://localhost:3000` in dev, or
   * the deployed editor's domain). Only applied in standalone mode (see
   * `bucket`).
   *
   * This exists solely to write the bucket's CORS rule, which is only needed
   * because the browser POSTs presigned uploads cross-origin. `uploadBehavior`
   * is the OTHER way to satisfy that requirement: it supplies
   * `Access-Control-Allow-Origin` from the edge instead, so no bucket rule is
   * written and no exact origin has to be named anywhere.
   *
   * Optional, but standalone mode refuses to synth with NEITHER, because the
   * resulting failure is a genuinely misleading one (see the error's own text).
   * An empty array counts as absent: CloudFormation rejects a CORS rule with no
   * origins, so it can only ever have been a mistake.
   *
   * @default - no bucket CORS rule; standalone mode then requires `uploadBehavior`
   */
  readonly editorOrigins?: string[]

  /**
   * Build a CloudFront behavior that accepts the editor's presigned-POST
   * uploads - the infrastructure half of `media.uploadUrl` (see the README's
   * "Routing uploads through your own CDN"). Retrieve it with
   * `uploadBehavior()`, which documents the distribution it belongs on. OFF
   * unless set, and deliberately so: this is the only thing in this
   * construct that puts a write-capable, OAC-UNSIGNED origin in front of the
   * bucket, and that must never reach a template by accident. Pass
   * `uploadBehavior: {}` for the defaults. BYO-BUCKET CAVEATS:
   *
   * 1. YOUR BUCKET POLICY IS THE ONLY GATE ON THIS ROUTE. The read behaviors go
   *    through an OAC-SIGNED origin, so a permissive policy there is still
   *    gated by a signature CloudFront adds; this origin cannot be signed
   *    (CloudFront never hashes the body, so an OAC-signed origin rejects every
   *    multipart POST). The route is contained by rewriting every request to
   *    `/`, so what your policy grants anonymously AT THE BUCKET ROOT is what is
   *    reachable. A bucket this construct creates refuses all of it (BLOCK_ALL,
   *    no public policy); an existing one is yours, and a read path that already
   *    works is not evidence that it is right.
   * 2. This origin addresses the bucket by `bucketRegionalDomainName`, which for
   *    a bucket imported with `Bucket.fromBucketName()` resolves to the STACK's
   *    region, not the bucket's. The read path tolerates a mismatch because
   *    CloudFront follows S3's region redirect on an S3-type origin; this custom
   *    origin does not, so S3's 301 reaches the browser as an opaque network
   *    error. Import cross-region with `Bucket.fromBucketAttributes({ region })`.
   * 3. A DOT in the bucket name breaks this origin; `buildUploadBehavior`
   *    refuses it at synth, with the reason.
   *
   * @default - no upload behavior is built
   */
  readonly uploadBehavior?: AssetUploadBehaviorOptions

  /**
   * Advisory upload-size cap in bytes. Not enforced by this construct -
   * the actual cap comes from the presigned POST's `content-length-range`
   * condition, set by `S3AssetStoreOptions.maxUploadBytes` at runtime
   * (packages/canopycms/src/assets/store-s3.ts). Exposed here only so the
   * consuming stack can wire the SAME number into the CMS Lambda's
   * environment (e.g. as `MEDIA_MAX_UPLOAD_BYTES`) and keep infra and app
   * config from silently drifting apart.
   *
   * @default 52428800 (50 MiB)
   */
  readonly maxUploadBytes?: number

  /**
   * Enable S3 versioning on the created bucket. Standalone mode only.
   *
   * @default false
   */
  readonly versioned?: boolean

  /**
   * Removal policy for the created bucket. Standalone mode only.
   *
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy

  /**
   * Auto-delete objects when the created bucket is destroyed. Only takes
   * effect alongside `removalPolicy: RemovalPolicy.DESTROY` - useful for
   * ephemeral canary/test stacks. Standalone mode only.
   *
   * @default false
   */
  readonly autoDeleteObjects?: boolean

  /**
   * Require the transform Lambda's code asset to carry proof that it was
   * built with its native sharp binary (the `.deployable` marker written by
   * `build:lambda`). Leave this ON for anything that can reach a real
   * deploy.
   *
   * Set to `false` ONLY in this package's own tests, which synth against the
   * cheap `--skip-native` fixture bundle `build:test-fixtures` produces: the
   * suite never executes the handler, so the binary is irrelevant to what it
   * asserts, and requiring a real build would put a live `npm install sharp` in
   * front of every test run and price the suite out of CI.
   *
   * Adopters never need this: the published package's asset is built by
   * `prepack`'s full `build:lambda`, so the marker is always present.
   *
   * @default true
   */
  readonly requireDeployableBundle?: boolean

  /**
   * Retention for the transform Lambda's CloudWatch log group (default:
   * three months / 90 days).
   */
  readonly transformLogRetention?: logs.RetentionDays

  /**
   * Concurrency cap on the transform Lambda (default: 10).
   *
   * This is a reservation — a CAP carved from the account's concurrency pool,
   * not pre-warmed capacity, so it costs nothing when idle. It bounds the
   * blast radius of the anonymous `/assets/t/*` path; see the default
   * constant's doc comment. Raise it for an unusually image-heavy site;
   * setting it to 0 would disable transforms entirely.
   */
  readonly transformReservedConcurrency?: number

  /**
   * How long generated derivatives under `assets/t/` are kept (default: 180
   * days). Only applies to a bucket this construct creates — in BYO-bucket
   * mode the caller owns lifecycle rules.
   *
   * These objects are regenerable; expiry is self-healing (the next request
   * regenerates and re-stores). Source assets under `asset-originals/` are
   * never affected.
   */
  readonly transformOutputRetention?: Duration

  /**
   * Execution role for the transform Lambda (default: CDK creates one).
   *
   * Set this when the role's ARN has to be computable WITHOUT a reference to
   * this construct - the motivating case is an asset bucket in a different AWS
   * account from the compute, where the resource-policy half of the
   * cross-account grant is written in the bucket's own stack and needs the
   * principal as a plain string. Reading `transformFunction.role` across an
   * account boundary does not give you that: CDK emits `Fn::GetStackOutput`, a
   * CDK-CLI-only intrinsic resolved at deploy time, so the coupling is invisible
   * to CloudFormation and unusable by any deploy path that is not `cdk deploy`.
   * A deterministically NAMED role lets both stacks compute
   * `arn:aws:iam::<account>:role/<name>` from literals instead, with nothing
   * crossing between them - at the cost of `CAPABILITY_NAMED_IAM` in the
   * consuming stack and no in-place replacement without a rename.
   *
   * `iam.Role`, not `iam.IRole`, ON PURPOSE - an imported role silently
   * discards the managed policies this construct has to re-attach. See
   * `attachLambdaExecutionPolicies` (./lambda-execution-role).
   */
  readonly transformRole?: iam.Role

  /**
   * Name for the transform Lambda's CloudWatch log group (default:
   * `/canopycms/<stackName>/transform`). Deliberately NOT
   * `/aws/lambda/<function-name>` - see `transformLogGroup`'s comment in the
   * constructor for why a CDK-managed group must avoid that exact name once
   * the function has ever been deployed without one. Override to follow an
   * org naming convention, or when instantiating this construct twice in one
   * stack (the default name would collide).
   */
  readonly transformLogGroupName?: string
}

/**
 * The two CloudFront path patterns the asset system's behaviors are keyed
 * under, derived from `PREFIXES` above (the single source of truth for these
 * prefixes in this file) rather than spelled out again. Exported so
 * `cms-distribution.ts`'s synth-time ordering guard can recognize them
 * without a second, driftable copy of the literal strings.
 */
export const ASSETS_PATH_PATTERN = `/${PREFIXES.public}/*`
export const ASSETS_TRANSFORM_PATH_PATTERN = `/${PREFIXES.transform}/*`

/**
 * The literal property names of `AssetCloudFrontBehaviors`
 * (`assets`/`assetsTransform`). It is a natural but broken mistake to spread
 * `assetBehaviors()`'s return value directly into `additionalBehaviors` (a
 * `Record<pathPattern, BehaviorOptions>`) - that type-checks and deploys
 * clean, but synthesizes two CloudFront behaviors matching the literal path
 * patterns `assets` and `assetsTransform`, which nothing ever requests,
 * instead of the real `/assets/*` and `/assets/t/*` patterns. Use
 * `attachTo()` (below) or `CanopyCmsDistribution`'s `assetSupport` prop
 * instead. Exported so `cms-distribution.ts`'s synth-time guard can
 * recognize the mistake and name it in its error.
 *
 * `uploadBehavior()` deliberately adds NO key here: it returns a bare
 * `BehaviorOptions` rather than a named property, so there is no spread to get
 * wrong, and a speculative `'upload'` entry would misfire on an adopter whose
 * distribution has a real upload route - CloudFront treats a path pattern's
 * leading slash as optional, so `upload` is a legal spelling of `/upload` (see
 * `normalizePathPattern` in cms-distribution.ts). Keep this list to property
 * names that actually exist on `AssetCloudFrontBehaviors`.
 */
export const ASSET_BEHAVIOR_SPREAD_MISTAKE_KEYS = ['assets', 'assetsTransform'] as const

/**
 * The two CloudFront behavior configs the asset system needs, keyed by the
 * path pattern they belong under. Each value is a full `BehaviorOptions`
 * (origin included).
 *
 * Prefer `AssetSupport.attachTo(distribution)` or `CanopyCmsDistribution`'s
 * `assetSupport` prop over consuming this directly - both encode the required
 * attachment order in exactly one place, and the latter's synth-time guard
 * rejects the three ways manual wiring goes wrong (see
 * `assertNoAssetBehaviorOrderingHazards`). This value is the ESCAPE HATCH for a
 * bespoke `new cloudfront.Distribution(...)` assembled entirely inline, whose
 * `additionalBehaviors` is fixed at construction with no distribution yet to
 * call `addBehavior` on - there you own the ordering:
 *
 * ```ts
 * const behaviors = assetSupport.assetBehaviors()
 *
 * // CloudFront matches path patterns in the order listed and stops at the
 * // first match, so the more specific '/assets/t/*' MUST come before
 * // '/assets/*' - otherwise the broader S3-only pattern swallows transform
 * // requests and they 403 with no Lambda fallback.
 * new cloudfront.Distribution(this, 'Dist', {
 *   defaultBehavior: ...,
 *   additionalBehaviors: {
 *     '/assets/t/*': behaviors.assetsTransform,
 *     '/assets/*': behaviors.assets,
 *   },
 * })
 * ```
 */
export interface AssetCloudFrontBehaviors {
  /**
   * `/assets/*` - static objects only (sanitized SVG/PDF the finalize
   * pipeline wrote, plus already-computed transform outputs under
   * `assets/t/...`, which also live under this prefix). S3 origin only -
   * nothing here is ever computed on demand.
   */
  readonly assets: cloudfront.BehaviorOptions

  /**
   * `/assets/t/*` - transform outputs specifically. Origin group: the same
   * S3 origin as `assets` primary, falling over to the transform Lambda's
   * Function URL on 403 OR 404 (a signed OAC origin reports a miss as 403;
   * configuring both is defense-in-depth). CloudFront caches the failover
   * response.
   */
  readonly assetsTransform: cloudfront.BehaviorOptions
}

/**
 * Options for `assetUploadBehavior` - everything
 * `AssetSupportProps.uploadBehavior` accepts, plus the bucket that the
 * standalone form has no construct to read it from.
 */
export interface AssetUploadBehaviorRouteOptions extends AssetUploadBehaviorOptions {
  /**
   * The bucket presigned uploads land in.
   *
   * ALWAYS the BYO case, and the caveat that goes with it is real: this
   * behavior's origin is deliberately OAC-UNSIGNED (it has to be - see
   * `buildUploadBehavior`), so this bucket's own policy is the only thing
   * standing between an anonymous caller and whatever that policy allows at
   * `/`. The URI rewrite means nothing arriving here can address a key, so
   * that is bucket-level operations only, and a bucket with BLOCK_ALL and no
   * public policy refuses all of them - but it is the bucket policy doing the
   * refusing, not this construct.
   */
  readonly bucket: s3.IBucket
}

/**
 * The `allowedOrigins` guards, shared by both entry points.
 *
 * Separate from `buildUploadBehavior` because `AssetSupport` runs them in its
 * CONSTRUCTOR - eagerly, long before anything builds the behavior - and moving
 * them into the builder would delay the throw to the first `uploadBehavior()`
 * call. `assetUploadBehavior` runs them on entry instead. One implementation,
 * two call sites, so the standalone form cannot quietly accept what the
 * construct refuses.
 *
 * `label` is the options path to name in the message, so each caller's error
 * points at the property the caller actually wrote.
 */
function validateUploadBehaviorOptions(options: AssetUploadBehaviorOptions, label: string): void {
  // An empty `allowedOrigins` is the same class of mistake as an empty
  // `editorOrigins` and gets the same treatment: CloudFormation rejects
  // `AccessControlAllowOrigins` with no items, so silently falling back to
  // the `['*']` default would turn a forwarded-empty-env-var into either a
  // failed deploy or, worse, a wildcard the caller did not ask for.
  if (options.allowedOrigins?.length === 0) {
    throw new Error(
      `${label} is an empty array. CloudFront requires at ` +
        'least one origin, and defaulting an explicitly-empty list to the wildcard would ' +
        "silently widen what you asked for. Omit the property to take the `['*']` default, " +
        'or list the origin(s) the editor is served from.',
    )
  }

  // Two consumers read `allowedOrigins` and they do not share a matcher: the
  // response headers policy (which decides ACAO on the POST response) accepts
  // CloudFront's pattern grammar, including a leftmost-subdomain wildcard
  // like `https://*.preview.example.com`; the preflight responder compiled
  // into the CloudFront Function can only do exact-string comparison, because
  // reimplementing that grammar in an edge function without being able to
  // test it against CloudFront is how the two silently disagree.
  //
  // So a pattern is refused rather than half-honoured. Accepting one would
  // deploy clean and then fail every upload from a matching origin at the
  // PREFLIGHT, with a correct-looking policy sitting right next to it - the
  // same invisible failure the preflight responder was added to remove.
  const wildcardOrigins = (options.allowedOrigins ?? []).filter((origin) => origin.includes('*'))
  const isBareWildcard = options.allowedOrigins?.join() === '*'
  if (wildcardOrigins.length > 0 && !isBareWildcard) {
    throw new Error(
      `${label} contains a wildcard pattern ` +
        `(${wildcardOrigins.map((o) => JSON.stringify(o)).join(', ')}). CloudFront's response ` +
        `headers policy would accept it, but the CORS preflight is answered at the edge by a ` +
        `CloudFront Function that compares origins exactly - so every upload from a matching ` +
        `origin would fail its preflight while the policy looked correct. Use exactly ` +
        `['*'] to allow any origin, or list each editor origin in full.`,
    )
  }
}

/**
 * The behavior that accepts the editor's presigned-POST uploads. Every piece
 * below is load-bearing; see `assetUploadBehavior` and
 * `AssetSupport.uploadBehavior()` for where the result goes.
 *
 * `label` prefixes the one error raised here, so the message names whichever
 * entry point the caller used.
 */
function buildUploadBehavior(
  scope: Construct,
  options: AssetUploadBehaviorRouteOptions,
  label: string,
): cloudfront.BehaviorOptions {
  // A DISTINCT origin for the bucket, with OAC signing OFF. The read
  // behaviors' origin cannot be reused here whatever this behavior sets,
  // because OAC is a property of the ORIGIN, not the behavior. CloudFront
  // signs origin requests but never hashes the body, so an OAC-signed origin
  // rejects every multipart POST whatever the viewer sent: S3 answers `400
  // InvalidArgument` - `x-amz-content-sha256 must be UNSIGNED-PAYLOAD, ... or
  // a valid sha256 value`. It fails CLOSED, but as an
  // argument-validation error, NOT the 403 a Lambda Function URL origin gives
  // in the same situation (docs/deploying-to-aws.md, "CloudFront OAC and
  // request body signing") - there Lambda verifies a SIGNATURE over that
  // header, here S3 validates its VALUE FORMAT.
  //
  // `HttpOrigin` rather than `S3BucketOrigin.withBucketDefaults()`, which
  // would also be unsigned: it is the only one of the two that can state the
  // CloudFront->S3 protocol, which for a request carrying a live upload
  // credential in its body is pinned rather than inferred.
  // `withBucketDefaults()` emits `S3OriginConfig`, which has no
  // `OriginProtocolPolicy` field at all.
  //
  // A DOT in the bucket name breaks this origin specifically: S3's wildcard
  // certificate covers one label (`*.s3.<region>.amazonaws.com`), so
  // `my.docs.bucket.s3.<region>.amazonaws.com` fails TLS validation and
  // CloudFront answers 502 on every upload. This is a CUSTOM origin doing
  // ordinary TLS validation; the read path's S3-type origin is treated
  // differently, so nothing else here would surface it - and dotted names are
  // likeliest in exactly the BYO case this behavior is written for. Only
  // checkable when the name is a real literal, which for an imported bucket it
  // is.
  const bucketName = options.bucket.bucketName
  if (!Token.isUnresolved(bucketName) && bucketName.includes('.')) {
    throw new Error(
      `${label} cannot use bucket "${bucketName}" - a dot in the bucket ` +
        `name puts an extra label in its regional domain name, which S3's wildcard ` +
        `certificate does not cover, so CloudFront fails TLS to the origin and answers 502 on ` +
        `every upload. The read behaviors are unaffected (they use an S3-type origin). Use a ` +
        `dot-free bucket for uploads, or route uploads somewhere other than this construct.`,
    )
  }

  const uploadOrigin = new UploadOrigin(options.bucket.bucketRegionalDomainName, {
    protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
  })

  // S3's POST Object is only valid at the bucket ROOT - without this rewrite
  // the upload gets 405 MethodNotAllowed. The rewrite is also what CONTAINS
  // this behavior: unconditional, no request arriving here can address a key
  // at all, so the `ALLOW_ALL` below buys an anonymous caller only the
  // bucket-level operations at `/` (list, create, delete bucket). A bucket
  // this construct creates refuses all of them anonymously (BLOCK_ALL, no
  // public policy); in BYO-bucket mode that is the caller's bucket policy to
  // have got right, and it is a WEAKER backstop here than on the read path -
  // those behaviors go through an OAC-SIGNED origin, so a too-permissive
  // policy is still gated by a signature CloudFront adds, while this origin is
  // deliberately unsigned and the policy is the ONLY gate. Stated for a BYO
  // adopter in `uploadBehavior()`'s caveat block too.
  //
  // The only thing that can WRITE either way is a request carrying a valid
  // presigned policy, and only to the single key that policy names. Do not
  // make the rewrite conditional; that gives key addressability back.
  const allowedOrigins = options.allowedOrigins ?? ['*']
  const rewriteToBucketRoot = new cloudfront.Function(scope, 'AssetUploadRewriteFunction', {
    code: cloudfront.FunctionCode.fromInline(
      [
        `var ALLOWED_ORIGINS = ${toFunctionLiteral(allowedOrigins)};`,
        'function handler(event) {',
        '  var request = event.request;',
        // The CORS preflight is answered HERE, and without that this route
        // cannot work at all. The editor's upload is NOT a CORS simple request
        // though it looks like one: `xhr-upload.ts` assigns
        // `xhr.upload.onprogress` before `send()`, and registering ANY listener
        // on the `XMLHttpRequestUpload` object disqualifies it independently of
        // method, headers and content type - so every browser upload begins
        // with `OPTIONS /`. Nothing else would answer it: CloudFront does not
        // synthesize preflight responses (a response headers policy only
        // decorates one something else produced), and `ALLOW_ALL` forwards the
        // OPTIONS to S3, which with no CORS configuration answers `403
        // CORSResponse: CORS is not enabled for this bucket`. A preflight that
        // is not 2xx fails the browser's check whatever headers are attached,
        // so the POST is never sent and the upload dies as an opaque network
        // error. An OPTIONS short-circuited here never reaches the origin, so
        // it can address nothing.
        "  if (request.method === 'OPTIONS') {",
        '    var headers = {',
        `      'access-control-allow-methods': { value: '${UPLOAD_ALLOWED_METHOD}' },`,
        "      'access-control-allow-headers': { value: '*' },",
        `      'access-control-max-age': { value: '${CORS_MAX_AGE_SECONDS}' }`,
        '    };',
        // Echo the caller's own Origin when the list is narrowed: a preflight
        // may only be answered with `*` or the single requesting origin, so a
        // multi-entry list cannot be returned verbatim. No match means no
        // ACAO, and the browser's own check refuses the upload - which is the
        // correct outcome, and a clearer one than a 403 here would be.
        "    var origin = request.headers.origin ? request.headers.origin.value : '';",
        "    if (ALLOWED_ORIGINS.length === 1 && ALLOWED_ORIGINS[0] === '*') {",
        "      headers['access-control-allow-origin'] = { value: '*' };",
        '    } else if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {',
        "      headers['access-control-allow-origin'] = { value: origin };",
        '    }',
        "    return { statusCode: 204, statusDescription: 'No Content', headers: headers };",
        '  }',
        "  request.uri = '/';",
        // A site behind HTTP basic auth otherwise sends S3 a credential it
        // cannot parse (`400 InvalidArgument - Unsupported Authorization
        // Type`), and the presigned POST carries its own authority in the body,
        // so nothing on this route ever wants the header. Dropped HERE rather
        // than named in the origin request policy's `allExcept` list below:
        // CloudFront rejects `Authorization` in a header ALLOWLIST outright,
        // and whether the same validation fires on an `allExcept` list is not
        // something synth can tell you - it would surface as a failed `cdk
        // deploy` on the whole stack. At the viewer the header is also gone
        // before any policy runs, so the guarantee does not depend on one.
        '  delete request.headers.authorization;',
        '  return request;',
        '}',
      ].join('\n'),
    ),
  })

  // `denyList('host')` emits CloudFormation's `allExcept`, which in the HEADERS
  // dimension only matches the managed ALL_VIEWER_EXCEPT_HOST_HEADER policy.
  // Do NOT replace this with that policy: it is documented as "Cookies: All,
  // Query strings: All", so adopting it would forward the editor session cookie
  // to S3 - one of the two hazards this policy exists to remove.
  //
  // `Authorization` is handled by the function above, not here.
  //
  // Cookies go through `CookiesConfig`, not the header list (a CloudFront
  // Function does not even see them in `request.headers`), so
  // `cookieBehavior.none()` is what strips them: an upload route mounted on a
  // site's own distribution would otherwise hand S3 - and S3's access logs -
  // the editor session cookie. On the dedicated distribution `uploadBehavior()`
  // recommends, a cross-origin XHR without `withCredentials` sends none anyway;
  // this makes it true either way.
  const originRequestPolicy = new cloudfront.OriginRequestPolicy(
    scope,
    'AssetUploadOriginRequestPolicy',
    {
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.denyList('host'),
      // A presigned POST carries everything in the multipart body.
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
    },
  )

  // The edge supplies Access-Control-Allow-Origin, scoped to this behavior
  // only: a response-headers policy DOES attach ACAO to a 2xx from an unsigned
  // S3 origin on POST with NO bucket CORS configuration at all. Acceptance and
  // advertisement are independent in S3 - bucket CORS governs only whether S3
  // advertises - which is what lets this construct write no bucket CORS rule.
  //
  // `originOverride: true` so the header is ours deterministically even on a
  // bucket that does have its own CORS configuration.
  //
  // AllowMethods/AllowHeaders/MaxAge take effect only on a CORS PREFLIGHT,
  // which the CloudFront Function above answers. They are set here anyway,
  // sharing `UPLOAD_ALLOWED_METHOD` with that function so the two cannot tell a
  // browser different things, and because whether a response headers policy
  // decorates a function-generated response is undocumented. If it does,
  // `originOverride: true` means these values REPLACE the function's identical
  // ones; if it does not, the function's stand alone. Either way the viewer
  // sees exactly one of each, which is what makes it safe not to know.
  const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
    scope,
    'AssetUploadResponseHeadersPolicy',
    {
      corsBehavior: {
        accessControlAllowOrigins: allowedOrigins,
        accessControlAllowCredentials: false,
        accessControlAllowMethods: [UPLOAD_ALLOWED_METHOD],
        accessControlAllowHeaders: ['*'],
        accessControlMaxAge: Duration.seconds(CORS_MAX_AGE_SECONDS),
        originOverride: true,
      },
    },
  )

  return {
    origin: uploadOrigin,
    // A POST is 405 without this. CloudFront offers no narrower set that
    // includes POST - GET_HEAD, GET_HEAD_OPTIONS and ALL are the only three.
    // The URI rewrite above is what makes that acceptable.
    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
    // HTTPS_ONLY, NOT the read behaviors' REDIRECT_TO_HTTPS. CloudFront
    // redirects with 301, and a browser turns a 301'd POST into a GET - so
    // an `http://` upload URL would silently become a bodyless GET that this
    // behavior rewrites to `/` and S3 refuses, with the file never sent.
    // HTTPS_ONLY answers 403 instead: same refusal, visible.
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
    // Nothing on this route is cacheable, and CACHING_DISABLED's all-`none`
    // cache key is also what keeps the origin request policy above legal
    // (CloudFront requires it to be a superset of the cache key).
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    originRequestPolicy,
    responseHeadersPolicy,
    functionAssociations: [
      {
        function: rewriteToBucketRoot,
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
      },
    ],
  }
}

/**
 * The presigned-upload CloudFront behavior, built from a bucket alone - the
 * infrastructure half of `media.uploadUrl` for callers who have a bucket and
 * no use for an `AssetSupport`.
 *
 * ```ts
 * const uploads = new cloudfront.Distribution(this, 'AssetUploads', {
 *   defaultBehavior: assetUploadBehavior(this, { bucket: assetBucket }),
 * })
 * // media.uploadUrl = `https://${uploads.distributionDomainName}/`
 * ```
 *
 * Separate from `AssetSupport.uploadBehavior()` because the upload route needs
 * the bucket and nothing else, while that construct's CONSTRUCTOR always builds
 * the transform Lambda, a log group, a Function URL, a role and prefix grants.
 * Those grants never reach the BUCKET policy: `Grant.addToPrincipalOrResource`
 * stops after the identity statement for a same-account grantee, and
 * `addToResourcePolicy` on a bucket CDK does not own is a no-op - an owned
 * bucket, one imported by name, and one imported by ARN in another account all
 * emit zero `AWS::S3::BucketPolicy`, so a cross-account adopter writes the
 * resource half on the bucket's own side. Prefer the method when you already
 * have an `AssetSupport`; both funnel into the same builder and cannot drift.
 *
 * No bucket CORS rule is written and none is needed: the edge supplies
 * `Access-Control-Allow-Origin`, and S3's ACCEPTANCE of a presigned POST is
 * independent of its ADVERTISEMENT of CORS, which is all a bucket rule governs
 * (`AssetSupportProps.editorOrigins` writes one, for the construct). No
 * "built but never attached" guard either: a caller here brings their own
 * bucket, so never reaches the construct's "something must supply ACAO" guard.
 */
export function assetUploadBehavior(
  scope: Construct,
  options: AssetUploadBehaviorRouteOptions,
): cloudfront.BehaviorOptions {
  validateUploadBehaviorOptions(options, 'assetUploadBehavior: allowedOrigins')
  // `scope` takes the CloudFront Function and the two policies as children
  // under fixed ids, so this is ONE CALL PER SCOPE - a second throws CDK's
  // duplicate-construct-id error. Moving an EXISTING deployment between this
  // function and `AssetSupport.uploadBehavior()` changes their construct path
  // and so their logical IDs, replacing all three CloudFront resources.
  //
  // `allowedOrigins` is snapshotted for the same reason `AssetSupport`
  // snapshots it: the guard above has just read the array, so holding the
  // caller's reference would let a later `origins.length = 0` walk past a check
  // that already passed.
  return buildUploadBehavior(
    scope,
    { ...options, allowedOrigins: options.allowedOrigins?.slice() },
    'assetUploadBehavior',
  )
}

/**
 * Per-site CDK construct for the asset/media delivery system (see
 * `.claude/future-tasks/assets-media-system.md` for the full design record).
 * Wires:
 *
 * - The bucket's asset-prefix lifecycle rule + CORS (standalone mode only).
 * - The transform Lambda (`../../lambda/asset-transform/handler.ts`, built
 *   via `pnpm run build:lambda` - see that script's doc comment for the
 *   no-Docker sharp bundling approach), its dedicated CloudWatch log group
 *   (custom name/retention/removal policy instead of the
 *   CloudFormation-implicit `/aws/lambda/<function-name>` group), and its
 *   OAC-locked Function URL.
 * - `attachTo(distribution)`, which attaches the two CloudFront behaviors a
 *   consuming distribution needs in the only safe order (see its doc comment
 *   for why the order is the whole point); `assetBehaviors()` is the escape
 *   hatch for a distribution built entirely by hand (see
 *   `AssetCloudFrontBehaviors`'s doc comment).
 * - `uploadBehavior()`, opt-in, the write half: a CloudFront behavior that
 *   accepts the editor's presigned-POST uploads, for adopters who set
 *   `media.uploadUrl`. Belongs on its own distribution - see that method.
 * - `grantUploadAccess()`, the exact prefix-scoped grants the CMS/editor
 *   principal needs to run `S3AssetStore` (packages/canopycms/src/assets/store-s3.ts).
 */
export class AssetSupport extends Construct {
  /** The bucket in use (either created here, or the BYO `props.bucket`). */
  public readonly bucket: s3.IBucket

  public readonly transformFunction: lambda.Function

  /** The transform Lambda's CloudWatch log group (Lambda stdout/stderr). */
  public readonly transformLogGroup: logs.LogGroup

  /** The transform Lambda's Function URL - use as a CloudFront origin (see `assetBehaviors()`). */
  public readonly transformFunctionUrl: lambda.FunctionUrl

  /** Effective advisory upload-size cap (see `AssetSupportProps.maxUploadBytes`). */
  public readonly maxUploadBytes: number

  private readonly behaviors: AssetCloudFrontBehaviors

  /** Set only when `AssetSupportProps.uploadBehavior` is set; validated in the constructor. */
  private readonly uploadOptions?: AssetUploadBehaviorOptions

  /**
   * Memoized on the first `uploadBehavior()` call, NOT built in the
   * constructor. Opting in creates three CloudFront resources (function,
   * origin request policy, response headers policy) and response headers
   * policies have a default account quota of 20, so an adopter who sets the
   * prop on a per-environment `AssetSupport` while building the single shared
   * upload distribution the accessor recommends would otherwise mint a set per
   * environment for one route. Deferring is invisible except that calling the
   * accessor AFTER a synth has run modifies the construct tree, which CDK
   * refuses with `ConstructTreeModifiedAfterSynth`. Loud, not silent.
   */
  private upload?: cloudfront.BehaviorOptions

  /**
   * The origin inside `upload`, kept so the validation below can ask whether
   * that behavior was ever attached to a distribution - see `UploadOrigin`.
   * Set by `uploadBehavior()`, i.e. at the same moment as `upload`: the
   * builder is shared with `assetUploadBehavior`, which has no construct to
   * record anything on, so recovering the origin from the returned behavior is
   * this class's job rather than the builder's.
   */
  private uploadOrigin?: UploadOrigin

  constructor(scope: Construct, id: string, props: AssetSupportProps) {
    super(scope, id)

    // Fail closed before anything else: refuse to build a stack around a
    // transform Lambda whose code asset was never verified to contain the
    // linux/arm64 sharp binary. `pnpm test` (whose canopycms-cdk suite rebuilds
    // that directory as a --skip-native fixture) and any partially-failed build
    // leave a sharp-less bundle on disk, and a later in-repo `cdk deploy` ships
    // it - a Lambda that throws at cold start on the first image request, a
    // long way from the cause. In the construct rather than at one deploy
    // entrypoint, so future entrypoints inherit the protection.
    if (
      (props.requireDeployableBundle ?? true) &&
      !existsSync(path.join(transformAssetDir, DEPLOYABLE_MARKER))
    ) {
      throw new Error(
        `The transform Lambda code asset at ${transformAssetDir} carries no ${DEPLOYABLE_MARKER} ` +
          'marker, so it was not built with its native sharp binary and must not be deployed. ' +
          'This is usually a --skip-native fixture bundle left behind by `pnpm test`, or a ' +
          '`build:lambda` run that failed partway through its sharp install.\n' +
          'Build it for real:\n' +
          '  pnpm --filter canopycms-cdk run build:lambda',
      )
    }

    this.maxUploadBytes = props.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES

    // An empty array is treated as absent throughout: CloudFormation rejects a
    // CORS rule whose AllowedOrigins is empty, so `editorOrigins: []` could
    // only ever have been a mistake, and it is better caught by the check
    // below than by a deploy-time template rejection.
    const editorOrigins = props.editorOrigins ?? []

    // A browser presigned upload needs an Access-Control-Allow-Origin from
    // SOMEWHERE - the bucket's own CORS rule (`editorOrigins`) or the edge
    // (`uploadBehavior`). Standalone mode owns the bucket, so it can tell that
    // neither is configured and say so here rather than let it be discovered
    // in a browser. BYO-bucket mode cannot: the caller owns that bucket's CORS
    // configuration and this construct has no way to read it (`IBucket` has no
    // `addCorsRule`, which is the same reason `editorOrigins` is inert there).
    if (!props.bucket && editorOrigins.length === 0 && !props.uploadBehavior) {
      throw new Error(
        'AssetSupport: standalone mode creates the bucket, and a browser presigned upload needs ' +
          'Access-Control-Allow-Origin from either the bucket or the edge - this construct was ' +
          'given neither. Pass `editorOrigins` (the editor origin(s) that POST uploads), or ' +
          '`uploadBehavior` to route uploads through a CloudFront distribution that supplies the ' +
          'header at the edge. If you have wired an equivalent upload path yourself, outside ' +
          'this construct, pass `editorOrigins` anyway - a bucket CORS rule your own path makes ' +
          'redundant is harmless, and this check cannot see that path.\n' +
          'Worth knowing why this is worth failing on: S3 ACCEPTS a cross-origin presigned POST ' +
          'with no CORS rule at all and simply declines to ADVERTISE it (measured: 204, no ' +
          'ACAO header, object landed). So the object reaches asset-staging/ and the browser ' +
          'still reports the upload as a network error - a failure that looks like anything ' +
          'except missing CORS.',
      )
    }

    if (props.bucket) {
      this.bucket = props.bucket
    } else {
      this.bucket = new s3.Bucket(this, 'Bucket', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        versioned: props.versioned ?? false,
        removalPolicy: props.removalPolicy ?? RemovalPolicy.RETAIN,
        autoDeleteObjects: props.autoDeleteObjects ?? false,
        // `asset-staging/` expires after a day, and generated derivatives
        // under `assets/t/` after `transformOutputRetention`. Originals, meta
        // and the public prefix are kept forever by design (content-addressed,
        // immutable - see the design record's "Storage" section).
        lifecycleRules: [
          {
            id: 'expire-asset-staging',
            enabled: true,
            prefix: `${PREFIXES.staging}/`,
            expiration: Duration.days(1),
          },
          {
            id: 'expire-transform-outputs',
            enabled: true,
            prefix: `${PREFIXES.transform}/`,
            expiration: props.transformOutputRetention ?? TRANSFORM_OUTPUT_RETENTION,
          },
        ],
        // Omitted entirely when `editorOrigins` is absent - the upload is then
        // going through `uploadBehavior`, which supplies ACAO at the edge, and
        // writing a rule with no origins would be an invalid template anyway.
        cors:
          editorOrigins.length > 0
            ? [
                {
                  id: 'editor-presigned-upload',
                  allowedOrigins: editorOrigins,
                  allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.PUT, s3.HttpMethods.GET],
                  allowedHeaders: ['*'],
                  maxAge: CORS_MAX_AGE_SECONDS,
                },
              ]
            : undefined,
      })
    }

    // Dedicated CloudWatch log group for the transform Lambda's stdout/stderr,
    // custom-named and NOT the CloudFormation-implicit
    // `/aws/lambda/<function name>`: CDK does not manage that group at all
    // (infinite retention, and `cdk destroy` leaves it behind), and Lambda
    // auto-creates it on first invoke OUTSIDE CloudFormation, after which a CDK
    // `LogGroup` using that exact name fails `CreateLogGroup` with "already
    // exists" and blocks every future `cdk deploy`. Same convention as
    // `CanopyCmsService`'s log groups (cms-service.ts).
    this.transformLogGroup = new logs.LogGroup(this, 'TransformFunctionLogs', {
      logGroupName:
        props.transformLogGroupName ?? `/canopycms/${Stack.of(this).stackName}/transform`,
      retention: props.transformLogRetention ?? logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    // Re-attach what CDK silently drops for a caller-supplied role. MUST run
    // for every passed role - see that function's doc comment. This function is
    // not VPC-attached, so it takes basic execution only and must NOT be
    // collapsed into the CMS Lambda's `vpc: true` call site.
    if (props.transformRole) {
      attachLambdaExecutionPolicies(props.transformRole, { vpc: false })
    }

    this.transformFunction = new lambda.Function(this, 'TransformFunction', {
      // Default (unset) leaves CDK to create the execution role, with its own
      // managed policies intact. See `transformRole`'s doc comment.
      role: props.transformRole,
      // Built by `pnpm run build:lambda` (lambda/asset-transform/build.mjs) -
      // esbuild bundle + a real linux/arm64 `npm install sharp` alongside it,
      // no Docker. `cdk synth`/`deploy` need that script run first; it is NOT
      // run automatically here.
      code: lambda.Code.fromAsset(transformAssetDir),
      handler: 'handler.handler',
      // nodejs20.x is deprecated and CDK's CloudFormation validation fails synth
      // on it. The esbuild bundle (lambda/asset-transform/build.mjs) targets
      // node22 to match; move the two together.
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: TRANSFORM_LAMBDA_MEMORY_MB,
      timeout: TRANSFORM_LAMBDA_TIMEOUT,
      // See the constant's doc comment: this is an anonymous, uncapped compute
      // and storage amplifier without it.
      reservedConcurrentExecutions:
        props.transformReservedConcurrency ?? TRANSFORM_LAMBDA_RESERVED_CONCURRENCY,
      // Pass the pre-created group via `logGroup`, NOT `logRetention` (CDK
      // throws LogRetentionLogGroupConflict/ConflictingLogPolicyOptions if
      // both are set on the same function) - the removal policy lives on the
      // LogGroup construct above instead.
      logGroup: this.transformLogGroup,
      environment: {
        ASSET_BUCKET: this.bucket.bucketName,
      },
    })

    // Explicit, scoped grant - NOT a reliance on the auto-created execution
    // role's AWSLambdaBasicExecutionRole managed policy, which CDK attaches
    // regardless of `logGroup` and never adjusts for it (passing `logGroup`
    // only points the function's LoggingConfig at this group; it grants no
    // IAM). That policy's logs:CreateLogStream/logs:PutLogEvents statement is
    // scoped to `arn:aws:logs:*:*:log-group:/aws/lambda/*:*`, so it grants
    // nothing for a custom-named group. Without this grantWrite, log delivery
    // fails its permission check with no error surfaced anywhere - logs simply
    // vanish.
    this.transformLogGroup.grantWrite(this.transformFunction)

    // Originals are what it transforms; `asset-meta/{hash32}.json` carries the
    // kind/ext it must look up before it can transform anything, so meta is
    // read too.
    this.bucket.grantRead(this.transformFunction, `${PREFIXES.originals}/*`)
    this.bucket.grantRead(this.transformFunction, `${PREFIXES.meta}/*`)
    // Write access to `assets/*` covers both the public prefix and
    // `assets/t/*` (transform outputs nest under it) in one grant.
    this.bucket.grantPut(this.transformFunction, `${PREFIXES.public}/*`)

    // AWS_IAM (not NONE): only reachable through CloudFront's Origin Access
    // Control, matching CanopyCmsService/CanopyCmsDistribution's existing
    // Function URL pattern (see cms-service.ts / cms-distribution.ts) -
    // direct hits to the Function URL are rejected.
    this.transformFunctionUrl = this.transformFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    })

    this.behaviors = this.buildBehaviors()

    // Validated eagerly, built lazily (see `upload`'s comment) - the accessor
    // may never be called, and a bad `allowedOrigins` should not wait for it
    // to find out. The guards themselves are shared with
    // `assetUploadBehavior`, which runs them on entry instead; see
    // `validateUploadBehaviorOptions` for what they refuse and why.
    if (props.uploadBehavior) {
      validateUploadBehaviorOptions(
        props.uploadBehavior,
        'AssetSupport: uploadBehavior.allowedOrigins',
      )
    }

    // Snapshotted, not aliased. The guard above runs now but `allowedOrigins`
    // is not READ until the accessor builds the behavior, so holding the
    // caller's array by reference would let `origins.length = 0` in between
    // walk straight past the check just made.
    this.uploadOptions = props.uploadBehavior && {
      ...props.uploadBehavior,
      allowedOrigins: props.uploadBehavior.allowedOrigins?.slice(),
    }

    // Setting `uploadBehavior` SATISFIES the standalone guard above, but only
    // ATTACHING the behavior to a distribution actually produces an
    // Access-Control-Allow-Origin from anywhere. Opting in and stopping there -
    // a half-finished copy of the README snippet - lands a standalone bucket
    // with no CORS rule and no edge route: the silent failure that guard's own
    // text calls misleading, reached through it rather than around it.
    //
    // The condition is ATTACHMENT, not `uploadBehavior()` having been called.
    // The accessor memoizes, so a caller who invokes it and loses the value in
    // a refactor sets every flag an accessor can set and still lands in exactly
    // that state. `UploadOrigin` (above) is what makes the difference
    // observable from here.
    //
    // A synth-time validation is the only place this can be caught: the
    // constructor cannot know what the caller will do next, so it cannot
    // express "and nothing used it".
    this.node.addValidation({
      validate: () => {
        if (
          props.uploadBehavior &&
          editorOrigins.length === 0 &&
          !props.bucket &&
          !this.uploadOrigin?.attachedToDistribution
        ) {
          return [
            'AssetSupport: `uploadBehavior` was set but the upload behavior was never attached ' +
              'to a distribution' +
              (this.upload
                ? ' - uploadBehavior() was called, but its return value was not passed to one'
                : ' - uploadBehavior() was never called') +
              ', so nothing supplies Access-Control-Allow-Origin. With no `editorOrigins` ' +
              'either, a browser upload will land the object in asset-staging/ and still ' +
              'report a network error. Pass the behavior to a distribution (see ' +
              "uploadBehavior()'s doc comment), or pass `editorOrigins` instead. If you " +
              'built the upload route from this bucket with the `assetUploadBehavior` free ' +
              'function, ACAO IS supplied and this check cannot see it - it observes only ' +
              'the origin this construct minted. Call uploadBehavior() here instead; you ' +
              'already have the construct, so the free function buys you nothing.',
          ]
        }
        return []
      },
    })
  }

  private buildBehaviors(): AssetCloudFrontBehaviors {
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket)
    // readTimeout passed EXPLICITLY, matching the transform Lambda's own
    // timeout. Unset, CloudFront applies its 30s service default, which
    // happens to equal TRANSFORM_LAMBDA_TIMEOUT today -- an accidental match,
    // not an asserted one: raising the Lambda's timeout alone would silently
    // start 504ing the slow transforms the raise was meant to allow.
    const transformLambdaOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(
      this.transformFunctionUrl,
      { readTimeout: TRANSFORM_LAMBDA_TIMEOUT },
    )

    const assets: cloudfront.BehaviorOptions = {
      origin: s3Origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      compress: true,
    }

    // Custom (not managed CACHING_OPTIMIZED) - see TRANSFORM_CACHE_MIN_TTL's
    // doc comment for why this behavior specifically needs minTtl: 0.
    // Directives live entirely in the path (no query string), and the
    // response never varies by cookie/request header, so nothing is
    // forwarded into the cache key.
    const transformCachePolicy = new cloudfront.CachePolicy(this, 'AssetsTransformCachePolicy', {
      minTtl: TRANSFORM_CACHE_MIN_TTL,
      defaultTtl: TRANSFORM_CACHE_DEFAULT_TTL,
      maxTtl: TRANSFORM_CACHE_MAX_TTL,
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    })

    const assetsTransform: cloudfront.BehaviorOptions = {
      origin: new origins.OriginGroup({
        primaryOrigin: s3Origin,
        fallbackOrigin: transformLambdaOrigin,
        // A signed OAC origin reports a miss as 403 (not 404, since it
        // never reveals object existence) - CloudFront's own S3 origin
        // handling can still surface 404 in some paths, so both are
        // configured. Confirmed working end-to-end by the sandbox spike
        // (.claude/future-tasks/assets-media-system.md's SPIKE RESULT).
        fallbackStatusCodes: [403, 404],
      }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: transformCachePolicy,
    }

    return { assets, assetsTransform }
  }

  /**
   * The two CloudFront behavior configs this system needs.
   *
   * Prefer `attachTo(distribution)` or `CanopyCmsDistribution`'s `assetSupport`
   * prop, which attach these in the only safe order automatically; `attachTo`
   * takes an `overrides` parameter, so needing per-behavior options is not a
   * reason to fall back here. Use this only for a distribution assembled
   * entirely by hand - you then own the ordering, and should assert it against
   * the SYNTHESIZED template's `CacheBehaviors` array index rather than your own
   * source object, since the property is about emitted order.
   */
  public assetBehaviors(): AssetCloudFrontBehaviors {
    return this.behaviors
  }

  /**
   * The CloudFront behavior that accepts the editor's presigned-POST uploads -
   * the infrastructure half of `media.uploadUrl`. Requires
   * `AssetSupportProps.uploadBehavior`.
   *
   * GIVE IT ITS OWN DISTRIBUTION, serving this route and nothing else:
   *
   * ```ts
   * const uploads = new cloudfront.Distribution(this, 'AssetUploads', {
   *   defaultBehavior: assetSupport.uploadBehavior(),
   * })
   * // media.uploadUrl = `https://${uploads.distributionDomainName}/`
   * ```
   * No custom domain or certificate is needed, and as the default behavior of a
   * one-route distribution there is no path pattern, so no ordering question of
   * the kind `attachTo()` settles. Two shapes this deliberately is NOT:
   *
   * - NOT a behavior on the site's own distribution. `CustomErrorResponses` are
   *   distribution-wide, so a site mapping 403 to its own 404 page applies that
   *   to S3's upload errors and the editor reports the substituted status; the
   *   site's cookies and any cached basic-auth credential are live hazards
   *   there, stripped by policy and function rather than never sent at all.
   * - NOT one shared distribution serving asset reads AND writes for every
   *   environment. That means one `AssetSupport`, which owns the transform
   *   Lambda shipping inside this package, so a `canopycms-cdk` bump would move
   *   every environment's asset pipeline at once. Only the upload route moves;
   *   it depends on the bucket and nothing else, the same property that lets
   *   `assetUploadBehavior` build it from a bucket alone.
   */
  public uploadBehavior(): cloudfront.BehaviorOptions {
    if (!this.uploadOptions) {
      throw new Error(
        'AssetSupport: uploadBehavior() needs the `uploadBehavior` prop, which is off by ' +
          'default because it is the only thing this construct builds that puts a ' +
          'write-capable, OAC-UNSIGNED origin in front of the bucket. Pass ' +
          '`uploadBehavior: {}` to opt in and take the defaults.',
      )
    }
    // Memoized: calling this twice must not attach two sets of policies, and
    // must not fail on duplicate construct ids.
    //
    // `scope` is `this`, which is what keeps the three child ids where the
    // emitted template already has them; moving them replaces deployed
    // CloudFront resources.
    //
    // `validateUploadBehaviorOptions` is NOT re-run here: the constructor
    // already ran it on these same options, and `this.uploadOptions` is its
    // own snapshot, so there is nothing a second pass could catch.
    this.upload ??= buildUploadBehavior(
      this,
      { ...this.uploadOptions, bucket: this.bucket },
      'AssetSupport: uploadBehavior',
    )
    // The builder returns the origin it made; the attach guard needs a
    // reference to it (see `UploadOrigin`), and this is the only place that
    // knows the two belong to the same construct.
    if (this.upload.origin instanceof UploadOrigin) {
      this.uploadOrigin = this.upload.origin
    }
    return this.upload
  }

  /**
   * Attach both asset behaviors to a concrete CloudFront distribution, in the
   * only safe order.
   *
   * THE ORDER IS THE WHOLE POINT. CloudFront matches path patterns in the order
   * given and stops at the first match. `/assets/*` is a broader, S3-only
   * pattern that also matches every `/assets/t/*` request; `/assets/t/*` is an
   * origin group that fails over to the transform Lambda on a miss. Attach
   * `/assets/*` first and every never-yet-computed transform gets a permanent
   * 403 (an OAC-signed S3 miss reports 403) while already-computed transforms
   * keep working. `'/assets/*'` also sorts BEFORE `'/assets/t/*'`
   * lexicographically (`*` = 0x2A, `t` = 0x74), so alphabetizing the keys
   * reproduces exactly this failure with no synth or deploy error to catch it -
   * and `assetBehaviors()` attaches no path pattern, so nothing there stops a
   * caller getting it wrong.
   *
   * `overrides` is merged into BOTH behaviors. The motivating case is a
   * distribution running a viewer-request function on every behavior - tier
   * basic-auth - where without the same `functionAssociations` `/assets/*` is
   * anonymously readable on an authenticated tier (`responseHeadersPolicy` is
   * the same story for a shared security-headers policy). One set for both is
   * what keeps ordering the only thing this method decides; a caller who needs
   * the two to differ should use `assetBehaviors()` and assert their own order.
   *
   * Typed `Partial<AddBehaviorOptions>`, not `BehaviorOptions`: `addBehavior`
   * takes `origin` positionally, so an `origin` key here is a silent no-op. It
   * needs a concrete `cloudfront.Distribution` too - `addBehavior` is an
   * instance method on that class, not on `IDistribution`. For a distribution
   * built entirely inline, call `assetBehaviors()` and order it yourself.
   */
  public attachTo(
    distribution: cloudfront.Distribution,
    overrides?: Partial<cloudfront.AddBehaviorOptions>,
  ): void {
    // `addBehavior` does not dedupe, and these calls bypass
    // `CanopyCmsDistribution`'s own synth-time guard because they run after
    // that distribution is constructed. Attaching twice - passing the
    // `assetSupport` prop AND calling this yourself - synthesizes
    // ['/assets/t/*','/assets/*','/assets/t/*','/assets/*'] and fails at deploy
    // time when CloudFront rejects the duplicate patterns. Refuse it here
    // instead, where the message can say which two routes collided.
    if (distribution.node.tryFindChild(ATTACHED_MARKER_ID)) {
      throw new Error(
        `AssetSupport: attachTo() was already called for this distribution. Each pattern ` +
          `would be attached twice and CloudFront rejects duplicate path patterns at deploy ` +
          `time. This usually means the distribution was given CanopyCmsDistribution's ` +
          `\`assetSupport\` prop (which calls attachTo for you) as well as an explicit ` +
          `attachTo() call -- keep one.`,
      )
    }
    new Construct(distribution, ATTACHED_MARKER_ID)

    // Drop explicitly-`undefined` keys before merging. A spread copies own
    // enumerable keys INCLUDING ones whose value is undefined, so
    // `{ ...transformRest, ...{ cachePolicy: undefined } }` deletes the
    // construct's choice and lets CDK substitute a DIFFERENT default:
    // `cachePolicy: undefined` swaps this behavior's custom policy
    // (TRANSFORM_CACHE_MIN_TTL = 0, which exists solely to stop the
    // oversized-output redirect loop) for the managed CACHING_OPTIMIZED and its
    // 1-second min TTL, and `viewerProtocolPolicy: undefined` downgrades BOTH
    // behaviors from redirect-to-https to allow-all, serving assets over plain
    // HTTP. Not a contrived input: `attachTo(dist, { cachePolicy:
    // props.maybePolicy })` with the prop unset typechecks (every
    // AddBehaviorOptions field is already optional), synthesizes and deploys
    // clean.
    const definedOverrides = Object.fromEntries(
      Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined),
    )

    const { origin: transformOrigin, ...transformRest } = this.behaviors.assetsTransform
    const { origin: assetsOrigin, ...assetsRest } = this.behaviors.assets
    distribution.addBehavior(ASSETS_TRANSFORM_PATH_PATTERN, transformOrigin, {
      ...transformRest,
      ...definedOverrides,
    })
    distribution.addBehavior(ASSETS_PATH_PATTERN, assetsOrigin, {
      ...assetsRest,
      ...definedOverrides,
    })
  }

  /**
   * Grant the CMS/editor principal (the CMS Lambda's role, typically) the
   * exact permissions `S3AssetStore` (packages/canopycms/src/assets/store-s3.ts)
   * calls for:
   *
   * - put on `asset-staging/` (presigned POST + proxied `writeStaging`)
   * - get on `asset-staging/` + `asset-originals/` + `asset-meta/` + `assets/`
   * - put on `asset-originals/` + `asset-meta/` + `assets/`
   * - delete on `asset-staging/` + `asset-meta/`
   */
  public grantUploadAccess(grantee: iam.IGrantable): void {
    this.bucket.grantPut(grantee, `${PREFIXES.staging}/*`)

    this.bucket.grantRead(grantee, `${PREFIXES.staging}/*`)
    this.bucket.grantRead(grantee, `${PREFIXES.originals}/*`)
    this.bucket.grantRead(grantee, `${PREFIXES.meta}/*`)
    this.bucket.grantRead(grantee, `${PREFIXES.public}/*`)

    this.bucket.grantPut(grantee, `${PREFIXES.originals}/*`)
    this.bucket.grantPut(grantee, `${PREFIXES.meta}/*`)
    this.bucket.grantPut(grantee, `${PREFIXES.public}/*`)

    this.bucket.grantDelete(grantee, `${PREFIXES.staging}/*`)
    this.bucket.grantDelete(grantee, `${PREFIXES.meta}/*`)
  }
}
