import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Construct } from 'constructs'
import {
  Duration,
  RemovalPolicy,
  Stack,
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
 * The transform Lambda's built code asset. Computed ONCE and shared by the
 * deployability guard and `Code.fromAsset()` below - if the check and the
 * bundle ever read two independently-computed paths, the guard can silently
 * start statting a directory that is never the one being deployed, and
 * nothing about either call site would look wrong.
 *
 * The `'..', '..'` walk is correct from both `<pkg>/src/constructs/` (local
 * source) and `<pkg>/dist/constructs/` (published package) only because those
 * sit at the same depth - see the `__dirname` note above.
 */
const transformAssetDir = path.join(__dirname, '..', '..', 'lambda', 'asset-transform', 'dist')

/**
 * Written by `build:lambda` as the last act of a successful FULL build, once
 * the linux/arm64 sharp binary is verified present. See that script's header
 * for why the marker is positive rather than negative: a partial build (a
 * thrown `npm install sharp`, a failed platform check) leaves a sharp-less
 * `dist/` on disk WITHOUT reaching the `--skip-native` branch, so a
 * "is it marked bad?" test would wave exactly that bundle through to a
 * deploy. Requiring proof-of-good instead fails closed on every unexpected
 * path, including the producer's and consumer's paths drifting apart.
 */
const DEPLOYABLE_MARKER = '.deployable'

/**
 * The four S3 key prefixes the asset system uses, mirrored from
 * `packages/canopycms/src/assets/asset-prefixes.ts` (the source of truth).
 * Duplicated as plain string literals - not imported from `canopycms` -
 * because this construct must synth cleanly for ANY consumer's CDK app
 * (e.g. a site's own `infrastructure/` package), which has no reason to
 * have `canopycms` itself resolvable from wherever its CDK code runs. The
 * transform Lambda (../../lambda/asset-transform/handler.ts), by contrast,
 * is bundled at build time from WITHIN this package (where `canopycms` is a
 * real workspace devDependency), so it imports the canonical constants
 * directly from `canopycms/server` instead of duplicating them - see that
 * file's doc comment.
 */
const PREFIXES = {
  originals: 'asset-originals',
  staging: 'asset-staging',
  meta: 'asset-meta',
  public: 'assets',
  transform: 'assets/t',
} as const

/** S3 CORS preflight cache duration for presigned-POST uploads from the editor. */
const CORS_MAX_AGE_SECONDS = 3000

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
 * A reservation is the cheap half of bounding that: it is a CAP carved from the
 * account's concurrency pool, not pre-warmed capacity, so it costs nothing when
 * idle (that is `provisionedConcurrentExecutions`, which this is not).
 *
 * 10 mirrors the CMS Lambda's own reservation. Genuine demand is first-render
 * misses only — every already-generated derivative is served by the S3 primary
 * origin without invoking this function at all — so 10 concurrent transforms
 * covers a cold page of images comfortably while capping a flood.
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
 * re-stores it — one invocation, then it is warm in both CloudFront and S3
 * again. 180 days is set so ordinary traffic never notices and only genuinely
 * cold or abusive objects age out.
 */
const TRANSFORM_OUTPUT_RETENTION = Duration.days(180)

/**
 * `/assets/t/*`-specific cache TTLs. The managed `CachePolicy.CACHING_OPTIMIZED`
 * (used for the plain `/assets/*` static behavior) has a 1-second MIN TTL,
 * which is exactly the bug this policy exists to avoid: the transform
 * Lambda's oversized-output path (handler.ts) returns a `Cache-Control:
 * no-store` 302 redirect specifically so CloudFront never caches it - but a
 * managed policy with ANY nonzero min TTL still caches that response for at
 * least that long regardless of the origin's own `no-store`, so the redirect
 * (to the now-written canonical S3 key) gets cached and re-served, and
 * CloudFront's next hit for that same canonical key 404s/403s off S3 (or
 * hasn't propagated yet), falling back to the Lambda again - a self-sustaining
 * redirect loop. `minTtl: 0` lets an origin's own `Cache-Control` (including
 * `no-store`) be honored immediately; `maxTtl`/`defaultTtl` stay generous so
 * the normal case (an immutable 200 with a real `max-age`) still caches well.
 */
const TRANSFORM_CACHE_MIN_TTL = Duration.seconds(0)
const TRANSFORM_CACHE_DEFAULT_TTL = Duration.days(1)
const TRANSFORM_CACHE_MAX_TTL = Duration.days(365)

/**
 * Distributions that already carry the asset behaviors, tracked at MODULE level
 * rather than per instance.
 *
 * Per-instance (the first version of this) only caught the same `AssetSupport`
 * attaching twice. Two `AssetSupport` constructs attaching to one distribution
 * slipped through and synthesized
 * ['/assets/t/*','/assets/*','/assets/t/*','/assets/*'] - the identical
 * duplicate-path-pattern deploy failure the guard exists to convert into a
 * synth error. There is no legitimate form of that: both instances attach the
 * same two patterns, so the second is always wrong regardless of which
 * construct owns it.
 *
 * A `WeakSet` keyed on the distribution object, so it holds no reference that
 * would outlive the construct tree and cannot leak across CDK apps in a test
 * process.
 */
const distributionsWithAssetBehaviors = new WeakSet<cloudfront.Distribution>()

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
   * bucket-wide CORS rule is not, because **the edge authorises nothing**:
   * measured, a presigned POST with a corrupted signature sent through this
   * exact path returns 403 and nothing lands. Authority is entirely the
   * presigned policy, which pins the bucket, the exact key, the content type,
   * a size range and a 15-minute expiry. So the wildcard widens who may READ
   * the response, not who may write - and the response is an empty 204.
   *
   * Narrow it to your editor origin(s) if you would rather; nothing else here
   * depends on the wildcard.
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
   * Optional since that edge route exists - it was required while the bucket
   * rule was the only route. Standalone mode still refuses to synth with
   * NEITHER, because the resulting failure is a genuinely misleading one (see
   * the error's own text). An empty array counts as absent: CloudFormation
   * rejects a CORS rule with no origins, so it can only ever have been a
   * mistake.
   *
   * @default - no bucket CORS rule; standalone mode then requires `uploadBehavior`
   */
  readonly editorOrigins?: string[]

  /**
   * Build a CloudFront behavior that accepts the editor's presigned-POST
   * uploads - the infrastructure half of `media.uploadUrl` (see the README's
   * "Routing uploads through your own CDN"). Retrieve the result with
   * `uploadBehavior()`, which also documents the distribution it belongs on.
   *
   * OFF unless set, and deliberately so: this is the only thing in this
   * construct that puts a write-capable, OAC-UNSIGNED origin in front of the
   * bucket, and that must never appear in a template by accident. Pass
   * `uploadBehavior: {}` to take the defaults.
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
   * Set to `false` ONLY in this package's own tests, which deliberately
   * synth against the cheap `--skip-native` fixture bundle that
   * `build:test-fixtures` produces - the suite never executes the handler,
   * so the binary is irrelevant to what it asserts, and requiring a real
   * build would put a live `npm install sharp` back in front of every test
   * run (which is what kept these tests out of CI in the first place).
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
   * this construct - the case that motivated the prop is an asset bucket in a
   * different AWS account from the compute, where the resource-policy half of
   * the cross-account grant must be written in the bucket's own stack and needs
   * the principal as a plain string. Reading `transformFunction.role` across an
   * account boundary does not give you that: CDK emits `Fn::GetStackOutput`, a
   * CDK-CLI-only intrinsic resolved at deploy time, so the coupling is
   * invisible to CloudFormation and unusable by any deploy path that is not
   * `cdk deploy`. Create a deterministically NAMED role instead and both stacks
   * can compute `arn:aws:iam::<account>:role/<name>` from literals, with
   * nothing crossing between them.
   *
   * A named IAM role means the consuming stack needs `CAPABILITY_NAMED_IAM`,
   * and cannot be replaced in place without a rename - that trade is yours to
   * make here, which is the point of taking a role rather than a name.
   *
   * `iam.Role`, not `iam.IRole`, ON PURPOSE - an imported role silently
   * discards the managed policies this construct has to re-attach. See
   * `attachLambdaExecutionPolicies` (./lambda-execution-role) for what CDK
   * drops when a role is passed, and why the narrower type is what makes the
   * compensation reliable.
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
 * `uploadBehavior()` deliberately adds NO key here, considered and rejected
 * when it was added. It returns a bare `BehaviorOptions` rather than a named
 * property of a returned object, so there is no spread to get wrong in the
 * first place - and a speculative `'upload'` entry would actively misfire on
 * an adopter whose distribution has a real upload route, since CloudFront
 * treats a path pattern's leading slash as optional and `upload` is a legal
 * spelling of `/upload` (see `normalizePathPattern` in cms-distribution.ts).
 * Keep this list to property names that actually exist on
 * `AssetCloudFrontBehaviors`.
 */
export const ASSET_BEHAVIOR_SPREAD_MISTAKE_KEYS = ['assets', 'assetsTransform'] as const

/**
 * The two CloudFront behavior configs the asset system needs, keyed by the
 * path pattern they belong under. Each value is a full `BehaviorOptions`
 * (origin included).
 *
 * Prefer `AssetSupport.attachTo(distribution)` or `CanopyCmsDistribution`'s
 * `assetSupport` prop over consuming this directly - both encode the
 * required attachment order in exactly one place instead of asking every
 * caller to reproduce it correctly. This return value remains useful as an
 * ESCAPE HATCH for a bespoke `new cloudfront.Distribution(...)` assembled
 * entirely inline (its `additionalBehaviors` is fixed at construction, so
 * there is no distribution yet to call `addBehavior` on) - but manual use
 * must still preserve the ordering shown below, and
 * `CanopyCmsDistribution`'s synth-time guard (`mergeBehaviors`) actively
 * rejects three ways this goes wrong: `/assets/*` listed before
 * `/assets/t/*`; the literal keys `assets`/`assetsTransform` (see
 * `ASSET_BEHAVIOR_SPREAD_MISTAKE_KEYS`) from spreading this object directly
 * into a `Record`; or an asset pattern listed here at all while
 * `CanopyCmsDistribution`'s `assetSupport` prop is also passed. See
 * `assertNoAssetBehaviorOrderingHazards`'s doc comment for the full list.
 *
 * ```ts
 * const behaviors = assetSupport.assetBehaviors()
 *
 * // Building a new distribution inline. CloudFront matches path patterns in
 * // the order they're listed and stops at the first match, so the more
 * // specific '/assets/t/*' MUST come before '/assets/*' - otherwise the
 * // broader S3-only pattern swallows transform requests first and they
 * // 403 with no Lambda fallback.
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
   * configuring both is defense-in-depth). See the SPIKE RESULT in
   * `.claude/future-tasks/assets-media-system.md` - this design is
   * confirmed working with CloudFront caching the failover response.
   */
  readonly assetsTransform: cloudfront.BehaviorOptions
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

  /** The transform Lambda function. */
  public readonly transformFunction: lambda.Function

  /** The transform Lambda's CloudWatch log group (Lambda stdout/stderr). */
  public readonly transformLogGroup: logs.LogGroup

  /** The transform Lambda's Function URL - use as a CloudFront origin (see `assetBehaviors()`). */
  public readonly transformFunctionUrl: lambda.FunctionUrl

  /** Effective advisory upload-size cap (see `AssetSupportProps.maxUploadBytes`). */
  public readonly maxUploadBytes: number

  private readonly behaviors: AssetCloudFrontBehaviors

  /** Built only when `AssetSupportProps.uploadBehavior` is set. */
  private readonly upload?: cloudfront.BehaviorOptions

  constructor(scope: Construct, id: string, props: AssetSupportProps) {
    super(scope, id)

    // Fail closed before anything else: refuse to build a stack around a
    // transform Lambda whose code asset was never verified to contain the
    // linux/arm64 sharp binary. Without this, `pnpm test` (whose
    // canopycms-cdk suite rebuilds that directory as a --skip-native
    // fixture) or any partially-failed build leaves a sharp-less bundle on
    // disk, and a later in-repo `cdk deploy` ships it - producing a Lambda
    // that throws at cold start on the first image request, a long way from
    // the cause. Guarding in the construct rather than at one deploy
    // entrypoint means future entrypoints inherit the protection instead of
    // having to remember it.
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
          'header at the edge.\n' +
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
        //
        // Derivatives were originally in that keep-forever set, on the same
        // "immutable" reasoning. That holds for their CONTENT but not for
        // their COUNT: `assets/t/` is the one prefix an anonymous caller can
        // mint unbounded distinct keys in (see
        // TRANSFORM_LAMBDA_RESERVED_CONCURRENCY), and unlike an original, a
        // derivative that is deleted can simply be recomputed.
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

    // Dedicated CloudWatch log group for the transform Lambda's stdout/
    // stderr. Custom name (NOT the CloudFormation-implicit
    // `/aws/lambda/<function name>`), for two reasons: (1) CDK does not
    // manage that implicit group at all - infinite retention, and
    // `cdk destroy` leaves it behind; (2) Lambda auto-creates
    // `/aws/lambda/<function name>` on first invoke, OUTSIDE CloudFormation -
    // once that has happened (e.g. this construct was already deployed
    // before this log group existed), a CDK `LogGroup` construct using that
    // exact name would fail its `CreateLogGroup` call with "already exists"
    // and block every future `cdk deploy`. Mirrors `CanopyCmsService`'s
    // `workerLogGroup`/`cmsLogGroup` (cms-service.ts), which established this
    // convention.
    this.transformLogGroup = new logs.LogGroup(this, 'TransformFunctionLogs', {
      logGroupName:
        props.transformLogGroupName ?? `/canopycms/${Stack.of(this).stackName}/transform`,
      retention: props.transformLogRetention ?? logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    // Re-attach what CDK silently drops for a caller-supplied role. MUST run
    // for every passed role - see that function's doc comment. This function
    // is not VPC-attached, so it takes basic execution only; the test suite
    // pins the absence of the VPC-ENI policy here specifically, so that this
    // call site and the CMS Lambda's cannot be collapsed into one.
    if (props.transformRole) {
      attachLambdaExecutionPolicies(props.transformRole, { vpc: false })
    }

    this.transformFunction = new lambda.Function(this, 'TransformFunction', {
      // Default (unset) leaves CDK to create the execution role, with its own
      // managed policies intact. See `transformRole`'s doc comment.
      role: props.transformRole,
      // Built by `pnpm run build:lambda` (lambda/asset-transform/build.mjs) -
      // esbuild bundle + a real linux/arm64 `npm install sharp` alongside it,
      // no Docker. `cdk synth`/`deploy` need that script run first; it is
      // NOT run automatically here (kept explicit rather than magic - see
      // this construct's class doc comment).
      code: lambda.Code.fromAsset(transformAssetDir),
      handler: 'handler.handler',
      // nodejs20.x was deprecated 2026-04-30; CDK's CloudFormation validation
      // now fails synth on it. The esbuild bundle targets node20 and runs
      // unchanged on the node22 runtime.
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
    // role's AWSLambdaBasicExecutionRole managed policy (attached by CDK's
    // lambda.Function regardless of `logGroup`, and never adjusted for it -
    // passing `logGroup` only points the function's LoggingConfig at this
    // group, it grants no IAM permissions). That managed policy's
    // logs:CreateLogStream/logs:PutLogEvents statement is scoped to
    // `arn:aws:logs:*:*:log-group:/aws/lambda/*:*` only (its
    // logs:CreateLogGroup statement is the sole one that's unrestricted) -
    // it grants nothing for a custom-named group like this one. Without this
    // grantWrite, log delivery to this group would fail permission checks
    // with no error surfaced anywhere - logs would simply vanish.
    this.transformLogGroup.grantWrite(this.transformFunction)

    // Read access to originals (what it transforms) - deviation from the PR
    // spec's literal "read asset-originals/, write assets/" grant list: the
    // handler must also read `asset-meta/{hash32}.json` to look up kind/ext
    // before it can transform anything, so meta read access is granted too.
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
    this.upload = props.uploadBehavior ? this.buildUploadBehavior(props.uploadBehavior) : undefined
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
   * The behavior that accepts the editor's presigned-POST uploads. Every piece
   * below is load-bearing; see `uploadBehavior()` for where the result goes.
   */
  private buildUploadBehavior(options: AssetUploadBehaviorOptions): cloudfront.BehaviorOptions {
    // A DISTINCT origin for the bucket, with OAC signing OFF - the read
    // behaviors' origin cannot be reused here no matter what this behavior
    // sets, because OAC is a property of the ORIGIN, not the behavior. (On the
    // dedicated distribution `uploadBehavior()` recommends this is the only
    // origin present; the point is that it cannot be the read one.)
    // CloudFront signs origin requests but never hashes
    // the body, so an OAC-signed origin rejects every multipart POST whatever
    // the viewer sent. Measured, that is `400 InvalidArgument`, the body
    // naming the mechanism - `x-amz-content-sha256 must be UNSIGNED-PAYLOAD,
    // ... or a valid sha256 value`. It fails CLOSED, but it is an
    // argument-validation error, NOT the 403 that the Lambda Function URL
    // origin produces in the same situation (docs/deploying-to-aws.md's
    // "CloudFront OAC and request body signing"): there Lambda verifies a
    // SIGNATURE over that header, here S3 validates its VALUE FORMAT. An
    // adopter told to expect 403 goes hunting for a permissions problem that
    // does not exist.
    //
    // `HttpOrigin` rather than `S3BucketOrigin.withBucketDefaults()`, which
    // would also be unsigned, for two reasons. It is the exact shape the
    // adopter measured this whole path against end to end (204, object
    // landed); and it is the only one of the two that can state the
    // CloudFront->S3 protocol, which for a request carrying a live upload
    // credential in its body should be pinned rather than inferred.
    // `withBucketDefaults()` emits `S3OriginConfig`, which has no
    // `OriginProtocolPolicy` field at all.
    const uploadOrigin = new origins.HttpOrigin(this.bucket.bucketRegionalDomainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    })

    // S3's POST Object is only valid at the bucket ROOT - without this rewrite
    // the upload gets 405 MethodNotAllowed. It is also what CONTAINS this
    // behavior: rewriting unconditionally means no request arriving here can
    // address a key at all, so the `ALLOW_ALL` below buys an anonymous caller
    // only the bucket-level operations at `/` (list, create, delete bucket).
    // A bucket this construct creates refuses all of them anonymously
    // (BLOCK_ALL, no public policy); in BYO-bucket mode that is the caller's
    // bucket policy to have got right, as it already is for the read path. The
    // only thing that can WRITE either way is a request carrying a valid
    // presigned policy, and only to the single key that policy names. Do not
    // make the rewrite conditional; that gives key addressability back.
    const rewriteToBucketRoot = new cloudfront.Function(this, 'AssetUploadRewriteFunction', {
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          "  request.uri = '/';",
          '  return request;',
          '}',
        ].join('\n'),
      ),
    })

    // `denyList` emits CloudFormation's `allExcept`, i.e. the managed
    // ALL_VIEWER_EXCEPT_HOST_HEADER policy (which is what the adopter measured
    // against) plus one more exclusion:
    //
    // - `host` because forwarding the viewer's Host to S3 misroutes the
    //   request - the same reason the managed policy exists.
    // - `authorization` because a site behind HTTP basic auth otherwise sends
    //   S3 a credential it cannot parse: `400 InvalidArgument - Unsupported
    //   Authorization Type`. The presigned POST carries its own authority in
    //   the body, so nothing here ever wants an Authorization header.
    //
    // Cookies go through `CookiesConfig`, not the header list, so
    // `cookieBehavior.none()` is what strips them: an upload route mounted on
    // a site's own distribution would otherwise hand S3 - and S3's access logs
    // - the editor session cookie. On the dedicated distribution recommended
    // in `uploadBehavior()` a cross-origin XHR without `withCredentials` sends
    // none in the first place; this makes it true either way.
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      'AssetUploadOriginRequestPolicy',
      {
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.denyList('host', 'authorization'),
        // A presigned POST carries everything in the multipart body.
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
      },
    )

    // The edge supplies Access-Control-Allow-Origin, scoped to this behavior
    // only. This is the measurement that unblocked the whole design: a
    // response-headers policy DOES attach ACAO to a 2xx from an unsigned S3
    // origin on POST with NO bucket CORS configuration at all (204, `ACAO: *`,
    // object landed). Acceptance and advertisement are independent in S3 -
    // bucket CORS governs only whether S3 advertises - which is exactly the
    // property that lets this construct avoid writing a bucket CORS rule.
    //
    // `originOverride: true` so the header is ours deterministically even on a
    // bucket that does have its own CORS configuration.
    //
    // AllowMethods/AllowHeaders/MaxAge take effect only on a CORS PREFLIGHT,
    // which this path does not trigger: `xhr-upload.ts` sends
    // multipart/form-data with no custom headers, a CORS simple request. They
    // are set coherently rather than left to drift, but adding any custom
    // header on that XHR would start requiring a preflight - which S3, with no
    // CORS configuration, would refuse.
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      'AssetUploadResponseHeadersPolicy',
      {
        corsBehavior: {
          accessControlAllowOrigins: options.allowedOrigins ?? ['*'],
          accessControlAllowCredentials: false,
          accessControlAllowMethods: ['POST'],
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
   * The two CloudFront behavior configs this system needs.
   *
   * If you use this rather than `attachTo` -- which now takes an `overrides`
   * parameter, so needing per-behavior options is no longer a reason to fall
   * back here -- you own the ordering, and you should assert it: read the
   * SYNTHESIZED template's `CacheBehaviors` array index, not your own source
   * object, since the property is about emitted order.
   *
   * Prefer `attachTo(distribution)` or `CanopyCmsDistribution`'s
   * `assetSupport` prop, which attach these to a distribution in the only
   * safe order automatically. This method exists as the escape hatch for a
   * distribution assembled entirely by hand - see `AssetCloudFrontBehaviors`'s
   * doc comment for that shape and its ordering requirements.
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
   *
   * No custom domain or certificate is needed - the `d111...cloudfront.net`
   * name is a perfectly good `uploadUrl` - and as the default behavior of a
   * one-route distribution there is no path pattern and so no ordering
   * question of the kind `attachTo()` exists to settle.
   *
   * Two shapes this deliberately is NOT, both settled 2026-09-11 (the record
   * is `.claude/future-tasks/resolved/asset-support-upload-behavior.md`):
   *
   * - NOT a behavior on the site's own distribution. `CustomErrorResponses`
   *   are distribution-wide, so a site that maps 403 to its own 404 page
   *   applies that to S3's upload errors too and the editor reports the
   *   substituted status. The site's cookies and any cached basic-auth
   *   credential are also live hazards there that have to be stripped by
   *   policy (`buildUploadBehavior` does strip both) rather than simply never
   *   being sent. It works; it is just strictly worse.
   * - NOT one shared distribution serving asset reads AND writes for every
   *   environment. One assets distribution means one `AssetSupport`, and
   *   `AssetSupport` owns the transform Lambda - so it would also mean one
   *   transform Lambda shared by every environment, and that Lambda ships
   *   inside this package. A `canopycms-cdk` bump would then move every
   *   environment's asset pipeline at once, which is a graduated rollout
   *   traded away for an upload path. Reads and transforms stay
   *   per-environment; only the upload route moves.
   *
   * The upload route is the one part of this system with no per-environment
   * code in it - it depends on the bucket and nothing else - which is why it
   * is the part that can be split off this way.
   */
  public uploadBehavior(): cloudfront.BehaviorOptions {
    if (!this.upload) {
      throw new Error(
        'AssetSupport: uploadBehavior() needs the `uploadBehavior` prop, which is off by ' +
          'default because it is the only thing this construct builds that puts a ' +
          'write-capable, OAC-UNSIGNED origin in front of the bucket. Pass ' +
          '`uploadBehavior: {}` to opt in and take the defaults.',
      )
    }
    return this.upload
  }

  /**
   * Attach both asset behaviors to a concrete CloudFront distribution, in the
   * only safe order.
   *
   * THIS METHOD EXISTS BECAUSE THE ORDER IS THE WHOLE POINT.
   * `assetBehaviors()` returns `{ assets, assetsTransform }` with no path
   * pattern attached at all (see that method's and `AssetCloudFrontBehaviors`'s
   * doc comments) - so nothing stops a caller from attaching the two in
   * either order. CloudFront matches path patterns in the order given and
   * stops at the first match. `/assets/*` is a broader, S3-only pattern that
   * also matches every `/assets/t/*` request; `/assets/t/*` is an origin
   * group that fails over to the transform Lambda on a miss. Attach
   * `/assets/*` first and every never-yet-computed transform gets a
   * permanent 403 (an OAC-signed S3 miss reports 403) while already-computed
   * transforms keep working - silent, launch-delayed, and permanent.
   * `'/assets/*'` also sorts BEFORE `'/assets/t/*'` lexicographically (`*` =
   * 0x2A, `t` = 0x74), so alphabetizing the keys reproduces exactly this
   * failure, with no synth or deploy error to catch it.
   *
   * `overrides` is merged into BOTH behaviors, and exists because without it
   * this method is unusable by exactly the adopters who most need the ordering
   * guarantee. A distribution that runs a viewer-request function on every
   * behavior - tier basic-auth, most commonly - needs the asset behaviors to
   * carry that same `functionAssociations`, or `/assets/*` is anonymously
   * readable on an authenticated tier. Before this parameter existed such an
   * adopter had to fall back to `assetBehaviors()` plus two hand-ordered
   * `addBehavior` calls: the precise shape this method was added to eliminate,
   * re-entered while believing ordering was handled upstream, which is worse
   * than never having had the method. (`responseHeadersPolicy` is the same
   * story for a repo with a shared security-headers policy.)
   *
   * Merged into both rather than per-behavior on purpose: applying one set to
   * both is what preserves the ordering guarantee as the only thing this
   * method decides. A caller who genuinely needs the two behaviors to differ
   * has left this method's remit and should use `assetBehaviors()` - and keep
   * their own ordering assertion.
   *
   * Typed `Partial<AddBehaviorOptions>` because that is exactly what
   * `addBehavior(pattern, origin, behaviorOptions?)` accepts - `origin` is a
   * POSITIONAL argument there, so `BehaviorOptions` (which is
   * `AddBehaviorOptions` plus `origin`) would let a caller pass a key the call
   * silently ignores. Measured, because the first version of this comment
   * claimed the opposite: widening the parameter and passing an `origin`
   * override changes nothing in the emitted template, so this narrowing
   * prevents a confusing no-op rather than a broken origin group.
   *
   * Needs a concrete `cloudfront.Distribution` - `addBehavior` is an instance
   * method on that class, not on `IDistribution` (what an imported/looked-up
   * distribution reference gives you). For a distribution built entirely
   * inline (its `additionalBehaviors` fixed at construction, with no
   * distribution yet to call `addBehavior` on), call `assetBehaviors()`
   * directly instead and list `/assets/t/*` before `/assets/*` yourself - see
   * `AssetCloudFrontBehaviors`'s doc comment.
   */
  public attachTo(
    distribution: cloudfront.Distribution,
    overrides?: Partial<cloudfront.AddBehaviorOptions>,
  ): void {
    // `addBehavior` does not dedupe, and these calls bypass
    // `CanopyCmsDistribution`'s own synth-time guard because they run after
    // that distribution is constructed. So attaching twice -- passing the
    // `assetSupport` prop AND calling this yourself, most likely, since the
    // prop's doc comment describes them as equivalent -- synthesizes
    // ['/assets/t/*','/assets/*','/assets/t/*','/assets/*'] and fails at
    // deploy time when CloudFront rejects the duplicate patterns. Refuse it
    // here instead, where the message can say which two routes collided.
    if (distributionsWithAssetBehaviors.has(distribution)) {
      throw new Error(
        `AssetSupport: attachTo() was already called for this distribution. Each pattern ` +
          `would be attached twice and CloudFront rejects duplicate path patterns at deploy ` +
          `time. This usually means the distribution was given CanopyCmsDistribution's ` +
          `\`assetSupport\` prop (which calls attachTo for you) as well as an explicit ` +
          `attachTo() call -- keep one.`,
      )
    }
    distributionsWithAssetBehaviors.add(distribution)

    // Drop explicitly-`undefined` keys before merging. A spread copies own
    // enumerable keys INCLUDING ones whose value is undefined, so
    // `{ ...transformRest, ...{ cachePolicy: undefined } }` deletes the
    // construct's choice and lets CDK substitute its own default - which is a
    // DIFFERENT default. Measured: `cachePolicy: undefined` swaps this
    // behavior's custom policy (TRANSFORM_CACHE_MIN_TTL = 0, which exists
    // solely to stop the oversized-output redirect loop documented above) for
    // the managed CACHING_OPTIMIZED and its 1-second min TTL; and
    // `viewerProtocolPolicy: undefined` downgrades BOTH behaviors from
    // redirect-to-https to allow-all, serving assets over plain HTTP.
    //
    // This is not a contrived input - it is what forwarding optional props
    // produces: `attachTo(dist, { cachePolicy: props.maybePolicy })` with the
    // prop unset. It typechecks (every AddBehaviorOptions field is already
    // optional), synthesizes and deploys clean.
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
