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
   */
  readonly editorOrigins: string[]

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
 * The two CloudFront behavior configs the asset system needs, keyed by the
 * path pattern they belong under. Each value is a full `BehaviorOptions`
 * (origin included), so a consumer can use it either way:
 *
 * ```ts
 * const behaviors = assetSupport.assetBehaviors()
 *
 * // Building a new distribution. CloudFront matches path patterns in the
 * // order they're listed and stops at the first match, so the more
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
 *
 * // Adding to an existing distribution: the same first-match-wins ordering
 * // applies to the resulting CacheBehaviors list, so call addBehavior for
 * // '/assets/t/*' before '/assets/*' here too.
 * distribution.addBehavior('/assets/t/*', behaviors.assetsTransform.origin, behaviors.assetsTransform)
 * distribution.addBehavior('/assets/*', behaviors.assets.origin, behaviors.assets)
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
 * - `assetBehaviors()`, the two CloudFront behavior configs a consuming
 *   distribution attaches (see `AssetCloudFrontBehaviors`'s doc comment for
 *   both attachment shapes).
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
        cors: [
          {
            id: 'editor-presigned-upload',
            allowedOrigins: props.editorOrigins,
            allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.PUT, s3.HttpMethods.GET],
            allowedHeaders: ['*'],
            maxAge: CORS_MAX_AGE_SECONDS,
          },
        ],
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

    this.transformFunction = new lambda.Function(this, 'TransformFunction', {
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

  /** The two CloudFront behavior configs this system needs - see `AssetCloudFrontBehaviors`'s doc comment for both attachment shapes. */
  public assetBehaviors(): AssetCloudFrontBehaviors {
    return this.behaviors
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
