import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Construct } from 'constructs'
import {
  Duration,
  RemovalPolicy,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_s3 as s3,
} from 'aws-cdk-lib'

// This package (`canopycms-cdk`) is `"type": "module"`, so its compiled
// output is real ESM - `__dirname` is not a global there. Derive it from
// `import.meta.url` instead (mirrors ../../lambda/asset-transform/build.mjs).
const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
 *   no-Docker sharp bundling approach) and its OAC-locked Function URL.
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

  /** The transform Lambda's Function URL - use as a CloudFront origin (see `assetBehaviors()`). */
  public readonly transformFunctionUrl: lambda.FunctionUrl

  /** Effective advisory upload-size cap (see `AssetSupportProps.maxUploadBytes`). */
  public readonly maxUploadBytes: number

  private readonly behaviors: AssetCloudFrontBehaviors

  constructor(scope: Construct, id: string, props: AssetSupportProps) {
    super(scope, id)

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
        // Only `asset-staging/` expires - originals/meta/public/transform
        // outputs are all kept forever by design (content-addressed,
        // immutable - see the design record's "Storage" section).
        lifecycleRules: [
          {
            id: 'expire-asset-staging',
            enabled: true,
            prefix: `${PREFIXES.staging}/`,
            expiration: Duration.days(1),
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

    this.transformFunction = new lambda.Function(this, 'TransformFunction', {
      // Built by `pnpm run build:lambda` (lambda/asset-transform/build.mjs) -
      // esbuild bundle + a real linux/arm64 `npm install sharp` alongside it,
      // no Docker. `cdk synth`/`deploy` need that script run first; it is
      // NOT run automatically here (kept explicit rather than magic - see
      // this construct's class doc comment).
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', '..', 'lambda', 'asset-transform', 'dist'),
      ),
      handler: 'handler.handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: TRANSFORM_LAMBDA_MEMORY_MB,
      timeout: TRANSFORM_LAMBDA_TIMEOUT,
      environment: {
        ASSET_BUCKET: this.bucket.bucketName,
      },
    })

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
    const transformLambdaOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(
      this.transformFunctionUrl,
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
