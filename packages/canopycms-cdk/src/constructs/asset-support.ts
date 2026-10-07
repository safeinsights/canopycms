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

/** The content-addressed prefixes, whose objects no correct writer ever replaces. */
const CREATE_ONLY_PREFIXES = [PREFIXES.public, PREFIXES.originals, PREFIXES.meta] as const

/**
 * The tag on every object the transform Lambda writes, copied as literals for
 * the same reason as `PREFIXES`. Source of truth is `LAZY_TRANSFORM_TAG` in
 * `packages/canopycms/src/assets/materialize.ts`.
 */
const LAZY_TRANSFORM_TAG = { key: 'canopy-transform', value: 'lazy' } as const

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

/** Fits a full-size transform at `MAX_INPUT_PIXELS`; see that constant in canopycms. */
const TRANSFORM_LAMBDA_MEMORY_MB = 2048
const TRANSFORM_LAMBDA_TIMEOUT = Duration.seconds(30)

/**
 * Concurrency cap on the lazy transform Lambda. `hash32` is public and `crop`
 * allows ~10^16 rects per asset, so a loop of unique crops is an unbounded
 * stream of misses, each a sharp run plus a stored object. A reservation is a
 * cap, not provisioned capacity, so it costs nothing idle.
 */
const TRANSFORM_LAMBDA_RESERVED_CONCURRENCY = 10

/**
 * Lazy mode's expiry for the Lambda's tagged `assets/t/` outputs, which bounds
 * how long the crop loop above keeps what it stores. The next request
 * regenerates an expired object while the Lambda runs.
 */
const TRANSFORM_OUTPUT_RETENTION = Duration.days(180)

/**
 * Lazy mode's `/assets/t/*` cache TTLs. The Lambda answers an oversized output
 * with a `no-store` 302 to the canonical key, and any nonzero min TTL caches
 * that redirect regardless, looping it back to the Lambda while the key still
 * misses. `minTtl: 0` honors the origin's own `Cache-Control`.
 */
const TRANSFORM_CACHE_MIN_TTL = Duration.seconds(0)

/** Props that configure only the transform Lambda, refused without `lazyPublicTransforms`. */
const LAZY_ONLY_PROPS = [
  'transformOutputRetention',
  'transformReservedConcurrency',
  'transformRole',
  'transformLogGroupName',
  'transformLogRetention',
] as const satisfies readonly (keyof AssetSupportProps)[]

/** S3 statuses that send a read to `replicaBucket`. A miss (403) never does. */
const REPLICA_FAILOVER_STATUS_CODES = [500, 502, 503, 504]
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
 * The marker is a bare `Construct`, which emits nothing into the template. A child construct
 * rather than a module-level `WeakSet` keyed on the distribution: the scoping is then a property
 * of the tree, not of process lifetime, and `node.children` lets a test assert the guard's state.
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
   * Deny every `s3:PutObject` to `assets/*`, `asset-originals/*` and `asset-meta/*` that carries
   * no `If-None-Match`, so no principal can replace an object under those content-addressed
   * prefixes. Standalone mode only: with a BYO `bucket` the prop is refused, and the same statement
   * belongs in that bucket's own policy (see docs/deploying-to-aws.md).
   *
   * Opt-in because the Deny binds every principal, including the CMS Lambda, which runs the
   * `canopycms` your app installs: upgrade `canopycms` to a release whose asset stores write
   * create-only, then enable this. It also denies `aws s3 cp` without `--if-none-match`, and every
   * multipart upload. Replication is authorized as `s3:ReplicateObject`, so it is not denied.
   *
   * To replace a bad object, delete it, then rerun `materialize-assets`. On a versioned bucket the
   * delete writes a delete marker and the bad version stays restorable; a replica keeps serving
   * it unless delete-marker replication is on.
   *
   * @default false
   */
  readonly enforceCreateOnlyWrites?: boolean

  /**
   * A replica of the bucket's `assets/` prefix. Both public behaviors fail over
   * to it on 500, 502, 503 or 504 from the primary, never on a miss: the
   * replica only holds what the primary has. With `lazyPublicTransforms`,
   * `/assets/t/*`'s one fallback slot is the transform Lambda, so only
   * `/assets/*` gets the replica.
   *
   * It is read through its own OAC, whose grant CDK writes only on a bucket it
   * owns: an imported replica's policy must allow this distribution itself.
   * Import one in another region with `Bucket.fromBucketAttributes({ bucketName,
   * region })` so its regional domain name is right. Replication must cover
   * `assets/`; `materialize-assets` writes only the primary.
   *
   * @default - no failover
   */
  readonly replicaBucket?: s3.IBucket

  /**
   * Compute a missing `/assets/t/*` derivative on request with a transform
   * Lambda, instead of serving only what `canopycms materialize-assets` wrote.
   * Off, the public path computes nothing and an unmaterialized URL is a miss,
   * which is also what a live preview on another origin than the editor shows
   * for a draft's new crop.
   *
   * On, anyone can mint any allowlisted transform of a public asset - bounded
   * per asset except crop, at ~10^16 rects - capped by reserved concurrency and
   * an `assets/t/` expiry that applies only to objects the Lambda writes, which
   * carry the tag `canopy-transform=lazy`: what `materialize-assets` writes is
   * never expired. On a BYO `bucket` this construct cannot write that rule, so
   * lazy mode there requires an explicit `transformOutputRetention`.
   *
   * @default false
   */
  readonly lazyPublicTransforms?: boolean

  /**
   * Require the transform Lambda's code asset to carry the `.deployable`
   * marker a full `build:lambda` writes, proving it has its native sharp
   * binary. Checked only with `lazyPublicTransforms`. Set `false` ONLY in this
   * package's own tests, which synth against the `--skip-native` fixture.
   *
   * @default true
   */
  readonly requireDeployableBundle?: boolean

  /** Lazy mode only. Retention for the transform Lambda's log group (default 90 days). */
  readonly transformLogRetention?: logs.RetentionDays

  /**
   * Lazy mode only. Concurrency cap on the transform Lambda (default 10), a
   * reservation that costs nothing idle. 0 disables transforms.
   */
  readonly transformReservedConcurrency?: number

  /**
   * Lazy mode only. How long the Lambda's `assets/t/` outputs are kept
   * (default 180 days), written as a lifecycle rule on a bucket this construct
   * creates. On a BYO `bucket` nothing is written and the prop is required:
   * passing it states that your bucket expires them itself, filtering on the
   * tag `canopy-transform=lazy` so what `materialize-assets` writes survives,
   * and on a versioned bucket also expiring noncurrent versions. Remove that
   * rule before leaving lazy mode: a key the Lambda wrote first stays tagged
   * after a build references it. A cross-account bucket's policy must also
   * grant the transform role `s3:PutObjectTagging` on `assets/t/*`.
   */
  readonly transformOutputRetention?: Duration

  /**
   * Lazy mode only. Execution role for the transform Lambda (default: CDK creates one).
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
   * Lazy mode only. Name for the transform Lambda's CloudWatch log group (default:
   * `/canopycms/<stackName>/transform`). Deliberately NOT
   * `/aws/lambda/<function-name>` - see the log group's comment in
   * `buildTransformLambda` for why. Override to follow an
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
 * // CloudFront stops at the first matching pattern, so '/assets/t/*' MUST
 * // come before '/assets/*', or lazy mode's misses never reach the Lambda.
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
   * `/assets/*`: the S3 read origin (an origin group with `replicaBucket`).
   */
  readonly assets: cloudfront.BehaviorOptions

  /**
   * `/assets/t/*`: the same read origin as `assets`, or with
   * `lazyPublicTransforms` an origin group falling over to the transform
   * Lambda on 403 or 404.
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
 * the bucket and nothing else. Prefer the method when you already have an
 * `AssetSupport`; both funnel into the same builder and cannot drift.
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
 * `.claude/future-tasks/resolved/assets-media-system.md` for the full design record).
 * Wires:
 *
 * - The bucket's asset-prefix lifecycle rule + CORS (standalone mode only).
 * - The public read path: `/assets/*` and `/assets/t/*` served from S3 (plus
 *   `replicaBucket` on 5xx). It computes nothing; derivatives come from
 *   `canopycms materialize-assets`.
 * - With `lazyPublicTransforms`, the transform Lambda
 *   (`../../lambda/asset-transform/handler.ts`, built by `build:lambda`), its
 *   log group and its OAC-locked Function URL, behind `/assets/t/*`.
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

  /** The lazy transform Lambda; undefined unless `lazyPublicTransforms`. */
  public readonly transformFunction: lambda.Function | undefined

  /** The transform Lambda's CloudWatch log group; undefined unless `lazyPublicTransforms`. */
  public readonly transformLogGroup: logs.LogGroup | undefined

  /** The transform Lambda's Function URL; undefined unless `lazyPublicTransforms`. */
  public readonly transformFunctionUrl: lambda.FunctionUrl | undefined

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

    const lazy = props.lazyPublicTransforms ?? false
    if (!lazy) {
      // A retention silently ignored here is the dangerous case: materialized derivatives are
      // kept forever, so the adopter would believe in an expiry that does not exist.
      const lambdaOnly = LAZY_ONLY_PROPS.filter((name) => props[name] !== undefined)
      if (lambdaOnly.length > 0) {
        throw new Error(
          `AssetSupport: ${lambdaOnly.join(', ')} only appl${lambdaOnly.length === 1 ? 'ies' : 'y'} ` +
            'with `lazyPublicTransforms: true`. Without it there is no transform Lambda and ' +
            'materialized derivatives under assets/t/ are kept forever. Remove the prop(s), or ' +
            'set `lazyPublicTransforms: true` if you mean to compute derivatives on request.',
        )
      }
    } else if (props.bucket && props.transformOutputRetention === undefined) {
      throw new Error(
        'AssetSupport: `lazyPublicTransforms` on a BYO `bucket` needs an explicit ' +
          '`transformOutputRetention`. This construct cannot write lifecycle rules on a bucket ' +
          'it did not create, and anonymous callers can mint objects under assets/t/ in lazy ' +
          'mode. Add an expiry rule for the assets/t/ prefix and the canopy-transform=lazy tag ' +
          '(on a versioned bucket, also expiring noncurrent versions) to your bucket and pass ' +
          'its duration as `transformOutputRetention`, or drop ' +
          '`lazyPublicTransforms` and run `canopycms materialize-assets` in your release ' +
          'pipeline instead.',
      )
    }

    if (props.bucket && props.enforceCreateOnlyWrites) {
      throw new Error(
        'AssetSupport: `enforceCreateOnlyWrites` writes its Deny into the policy of a bucket this ' +
          'construct creates, and cannot write one on a BYO `bucket`. Drop the prop and add the ' +
          "statement to your bucket's own policy: Deny s3:PutObject to any principal on " +
          `${CREATE_ONLY_PREFIXES.map((prefix) => `${prefix}/*`).join(', ')} under the condition ` +
          '{ Null: { "s3:if-none-match": "true" } }.',
      )
    }

    // Fail closed: a bundle without the marker has no linux/arm64 sharp and
    // throws at cold start on the first image request, far from the cause.
    // `pnpm test` leaves exactly such a fixture on disk.
    if (
      lazy &&
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
        // Everything else is content-addressed and kept forever, materialized
        // derivatives included; only the Lambda's tagged outputs expire. On a
        // versioned bucket an expiry only adds a delete marker, so each rule
        // also expires noncurrent versions or it would free nothing.
        lifecycleRules: [
          {
            id: 'expire-asset-staging',
            enabled: true,
            prefix: `${PREFIXES.staging}/`,
            expiration: Duration.days(1),
            noncurrentVersionExpiration: Duration.days(1),
          },
          ...(lazy
            ? [
                {
                  id: 'expire-transform-outputs',
                  enabled: true,
                  prefix: `${PREFIXES.transform}/`,
                  tagFilters: { [LAZY_TRANSFORM_TAG.key]: LAZY_TRANSFORM_TAG.value },
                  expiration: props.transformOutputRetention ?? TRANSFORM_OUTPUT_RETENTION,
                  noncurrentVersionExpiration: Duration.days(1),
                },
              ]
            : []),
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

    if (props.enforceCreateOnlyWrites) {
      this.bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'DenyAssetOverwrites',
          effect: iam.Effect.DENY,
          principals: [new iam.StarPrincipal()],
          actions: ['s3:PutObject'],
          resources: CREATE_ONLY_PREFIXES.map((prefix) => this.bucket.arnForObjects(`${prefix}/*`)),
          conditions: { Null: { 's3:if-none-match': 'true' } },
        }),
      )
    }

    if (lazy) {
      const transform = this.buildTransformLambda(props)
      this.transformFunction = transform.fn
      this.transformLogGroup = transform.logGroup
      this.transformFunctionUrl = transform.url
    }

    this.behaviors = this.buildBehaviors(props.replicaBucket)

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

  private buildTransformLambda(props: AssetSupportProps): {
    fn: lambda.Function
    logGroup: logs.LogGroup
    url: lambda.FunctionUrl
  } {
    // Custom-named, never `/aws/lambda/<function name>`: Lambda auto-creates that
    // group outside CloudFormation on first invoke, after which a CDK `LogGroup`
    // of the same name fails every deploy with "already exists". Same convention
    // as `CanopyCmsService`'s log groups.
    const logGroup = new logs.LogGroup(this, 'TransformFunctionLogs', {
      logGroupName:
        props.transformLogGroupName ?? `/canopycms/${Stack.of(this).stackName}/transform`,
      retention: props.transformLogRetention ?? logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    // Re-attach what CDK silently drops for a caller-supplied role. This function
    // is not VPC-attached, so it takes basic execution only.
    if (props.transformRole) {
      attachLambdaExecutionPolicies(props.transformRole, { vpc: false })
    }

    const fn = new lambda.Function(this, 'TransformFunction', {
      role: props.transformRole,
      // Built by `build:lambda` (lambda/asset-transform/build.mjs), not here.
      code: lambda.Code.fromAsset(transformAssetDir),
      handler: 'handler.handler',
      // build.mjs targets node22 to match; move the two together.
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: TRANSFORM_LAMBDA_MEMORY_MB,
      timeout: TRANSFORM_LAMBDA_TIMEOUT,
      reservedConcurrentExecutions:
        props.transformReservedConcurrency ?? TRANSFORM_LAMBDA_RESERVED_CONCURRENCY,
      // `logGroup`, not `logRetention`: CDK refuses both on one function.
      logGroup,
      environment: {
        ASSET_BUCKET: this.bucket.bucketName,
      },
    })

    // The managed basic-execution policy's log statement covers only
    // `/aws/lambda/*`, so without this a custom-named group silently gets no logs.
    logGroup.grantWrite(fn)

    // `grantRead` includes s3:ListBucket, so an unknown hash is a 404 rather than
    // a 403 the store throws on, and `readOriginal` can list when the meta's ext
    // misses. `assets/*` covers `assets/t/*`, and `grantPut` includes the
    // s3:PutObjectTagging a tagged PutObject needs.
    this.bucket.grantRead(fn, `${PREFIXES.originals}/*`)
    this.bucket.grantRead(fn, `${PREFIXES.meta}/*`)
    this.bucket.grantPut(fn, `${PREFIXES.public}/*`)

    // AWS_IAM: reachable only through CloudFront's OAC.
    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM })
    return { fn, logGroup, url }
  }

  private buildBehaviors(replicaBucket: s3.IBucket | undefined): AssetCloudFrontBehaviors {
    // READ only, so a miss is 403: without s3:ListBucket, S3 does not reveal
    // whether a key exists. LIST would make it 404 but lets any behavior that
    // reaches the bucket root list it, and CDK warns on every synth.
    const readOrigin = (bucket: s3.IBucket) =>
      origins.S3BucketOrigin.withOriginAccessControl(bucket)
    const primary = readOrigin(this.bucket)
    // Materialized mode gives both behaviors this one object, so the distribution
    // emits one origin (or one origin group), not two. Lazy mode's `/assets/t/*`
    // group binds `primary` again, as a second origin.
    const read = replicaBucket
      ? new origins.OriginGroup({
          primaryOrigin: primary,
          fallbackOrigin: readOrigin(replicaBucket),
          fallbackStatusCodes: REPLICA_FAILOVER_STATUS_CODES,
        })
      : primary

    const assets: cloudfront.BehaviorOptions = {
      origin: read,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      compress: true,
    }
    if (!this.transformFunctionUrl) {
      return { assets, assetsTransform: { ...assets } }
    }

    // Directives live in the path and the response varies by nothing else, so
    // nothing enters the cache key.
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
      // The group's one fallback slot is the Lambda, so no replica here. An
      // OAC miss is 403; 404 is listed too for a bucket whose policy grants list.
      origin: new origins.OriginGroup({
        primaryOrigin: primary,
        // readTimeout explicit: CloudFront's 30s default only happens to equal
        // the Lambda's timeout, and raising one alone would 504 slow transforms.
        fallbackOrigin: origins.FunctionUrlOrigin.withOriginAccessControl(
          this.transformFunctionUrl,
          { readTimeout: TRANSFORM_LAMBDA_TIMEOUT },
        ),
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
   *   environment. That means one `AssetSupport`, so a `canopycms-cdk` bump
   *   would move every environment's asset pipeline at once. Only the upload route moves;
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
   * CloudFront stops at the first matching pattern, and `/assets/*` also
   * matches every `/assets/t/*` request. With `lazyPublicTransforms`, attaching
   * it first means no miss ever reaches the transform Lambda, with no synth or
   * deploy error; `'/assets/*'` also sorts first alphabetically. The two
   * behaviors are identical otherwise, and the order is kept so that switching
   * modes changes nothing else.
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

    // Drop explicitly-`undefined` keys: a spread copies them, so forwarding an
    // unset optional prop would replace the construct's choice with CDK's
    // default - lazy mode's minTtl-0 policy with CACHING_OPTIMIZED, and
    // redirect-to-https with allow-all on both behaviors.
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
