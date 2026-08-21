import { existsSync, renameSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { App, Duration, Stack } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { aws_cloudfront as cloudfront, aws_iam as iam, aws_s3 as s3 } from 'aws-cdk-lib'
import { RetentionDays } from 'aws-cdk-lib/aws-logs'
import { describe, expect, it } from 'vitest'

import { AssetSupport } from './asset-support'

const EDITOR_ORIGINS = ['http://localhost:3000']

/**
 * Every construction below opts out of the deployable-bundle guard, with ONE
 * deliberate exception: the 'deployable-bundle guard' describe block further
 * down constructs `AssetSupport` WITHOUT spreading `BASE_PROPS`, specifically
 * so that one test exercises the guard's real default-on behavior (the one
 * that actually protects a live `cdk deploy`). Every other test here needs
 * the opt-out because...
 *
 * ...this suite synths against the cheap `--skip-native` fixture bundle that
 * `build:test-fixtures` produces (see lambda/asset-transform/build.mjs): it
 * only needs `Code.fromAsset()` to find a directory and never executes the
 * handler, so the linux/arm64 sharp binary is irrelevant to everything
 * asserted here. Requiring a real build would put a live
 * `npm install sharp` in front of every test run - the cost that kept this
 * package's tests out of CI to begin with.
 */
const BASE_PROPS = { editorOrigins: EDITOR_ORIGINS, requireDeployableBundle: false }

/**
 * Same derivation `asset-support.ts` uses for its own module-private
 * `transformAssetDir` (see that file). This test file lives in the same
 * directory (`src/constructs/`), so the identical expression from THIS
 * file's own `import.meta.url` resolves to the identical path - computed
 * independently rather than imported, since the source constant is
 * module-private, but it MUST stay in lockstep with it: if the two ever
 * drift, the guard test below silently stops testing the directory the
 * construct actually checks.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const transformAssetDir = path.join(__dirname, '..', '..', 'lambda', 'asset-transform', 'dist')
const deployableMarkerPath = path.join(transformAssetDir, '.deployable')

/**
 * `AssetSupport` itself never creates a `cloudfront.Distribution` - it only
 * returns `IOrigin` value objects via `assetBehaviors()` (see that method's
 * doc comment). CloudFront resources like the OAC only materialize once
 * something actually binds those origins into a real Distribution, so every
 * test that asserts on CloudFront resources builds one here, exactly as a
 * real consumer (and the canary app) would.
 */
function synthWithDistribution(assetSupport: AssetSupport, stack: Stack): Template {
  const behaviors = assetSupport.assetBehaviors()
  new cloudfront.Distribution(stack, 'Dist', {
    defaultBehavior: behaviors.assets,
    additionalBehaviors: {
      '/assets/t/*': behaviors.assetsTransform,
    },
  })
  return Template.fromStack(stack)
}

function makeStack(): Stack {
  const app = new App()
  return new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } })
}

describe('AssetSupport - standalone mode (creates its own bucket)', () => {
  it('creates exactly one bucket with the asset-staging/ lifecycle rule and editor-origin CORS', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = Template.fromStack(stack)

    template.resourceCountIs('AWS::S3::Bucket', 1)
    template.hasResourceProperties(
      'AWS::S3::Bucket',
      Match.objectLike({
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Status: 'Enabled',
              Prefix: 'asset-staging/',
              ExpirationInDays: 1,
            }),
          ]),
        },
        CorsConfiguration: {
          CorsRules: Match.arrayWith([
            Match.objectLike({
              AllowedOrigins: EDITOR_ORIGINS,
              AllowedMethods: Match.arrayWith(['POST', 'PUT', 'GET']),
            }),
          ]),
        },
        PublicAccessBlockConfiguration: Match.objectLike({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        }),
      }),
    )
  })

  it('configures the transform Lambda: arm64/nodejs22.x, memory/timeout, and the bucket name in its environment', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = Template.fromStack(stack)

    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
        MemorySize: 1536,
        Timeout: 30,
        Environment: Match.objectLike({
          Variables: Match.objectLike({ ASSET_BUCKET: Match.anyValue() }),
        }),
      }),
    )
  })

  it('locks the transform Lambda Function URL to AWS_IAM (not publicly invokable)', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = Template.fromStack(stack)

    template.hasResourceProperties('AWS::Lambda::Url', Match.objectLike({ AuthType: 'AWS_IAM' }))
  })

  it('grants the transform Lambda read on asset-originals/+asset-meta/ and put on assets/ only', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = Template.fromStack(stack)

    const policies = template.findResources('AWS::IAM::Policy')
    const statements = Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as unknown[],
    )
    const resourcePatterns = statements
      .map((s) => (s as { Resource?: unknown }).Resource)
      .flat()
      .map((r) => JSON.stringify(r))
      .join('\n')

    expect(resourcePatterns).toContain('asset-originals/*')
    expect(resourcePatterns).toContain('asset-meta/*')
    expect(resourcePatterns).toContain('assets/*')
    // Never full-bucket wildcard access for the transform Lambda.
    expect(resourcePatterns).not.toContain('asset-staging/*')
  })

  it('assetBehaviors(): the /assets/t/* behavior is an origin group with the same S3 origin as primary, the Lambda Function URL as fallback, and 403+404 failover', () => {
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = synthWithDistribution(assetSupport, stack)

    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/assets/t/*',
            }),
          ]),
        }),
      }),
    )

    // The origin group itself is a top-level DistributionConfig.OriginGroups
    // entry (not visible via hasResourceProperties' per-behavior view).
    const distributions = template.findResources('AWS::CloudFront::Distribution')
    const [distribution] = Object.values(distributions)
    const originGroups = distribution.Properties.DistributionConfig.OriginGroups.Items as Array<{
      FailoverCriteria: { StatusCodes: { Items: number[] } }
      Members: { Items: unknown[] }
    }>
    expect(originGroups).toHaveLength(1)
    expect(originGroups[0].FailoverCriteria.StatusCodes.Items.sort()).toEqual([403, 404])
    expect(originGroups[0].Members.Items).toHaveLength(2)
  })

  it('assetBehaviors(): the /assets/t/* behavior uses a custom cache policy with minTtl 0 (never the managed CACHING_OPTIMIZED, whose 1s min TTL caches the oversized-output no-store redirect)', () => {
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = synthWithDistribution(assetSupport, stack)

    const policies = template.findResources('AWS::CloudFront::CachePolicy')
    const transformPolicy = Object.values(policies).find(
      (policy) =>
        policy.Properties.CachePolicyConfig.Comment !== 'Policy for caching optimized by default',
    )
    expect(transformPolicy).toBeDefined()
    const config = transformPolicy?.Properties.CachePolicyConfig
    expect(config.MinTTL).toBe(0)
    expect(config.DefaultTTL).toBe(Duration.days(1).toSeconds())
    expect(config.MaxTTL).toBe(Duration.days(365).toSeconds())
    expect(config.ParametersInCacheKeyAndForwardedToOrigin).toMatchObject({
      EnableAcceptEncodingGzip: true,
      EnableAcceptEncodingBrotli: true,
    })

    // The behavior itself references this custom policy, not the managed one.
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/assets/t/*',
              CachePolicyId: { Ref: Match.stringLikeRegexp('AssetsTransformCachePolicy') },
            }),
          ]),
        }),
      }),
    )
  })

  it('creates Origin Access Control resources for both the S3 origin and the Lambda Function URL origin', () => {
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = synthWithDistribution(assetSupport, stack)

    const oacs = template.findResources('AWS::CloudFront::OriginAccessControl')
    const originTypes = Object.values(oacs).map(
      (oac) => oac.Properties.OriginAccessControlConfig.OriginAccessControlOriginType,
    )
    expect(originTypes.sort()).toEqual(['lambda', 's3'])
  })

  it('grantUploadAccess(): grants exactly the put/get/delete prefixes S3AssetStore calls for', () => {
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const role = new iam.Role(stack, 'EditorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    })
    assetSupport.grantUploadAccess(role)
    const template = Template.fromStack(stack)

    const policies = template.findResources('AWS::IAM::Policy', {
      Properties: Match.objectLike({
        Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp('EditorRole') }]),
      }),
    })
    const statements = Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as unknown[],
    )
    const resourcePatterns = statements
      .map((s) => (s as { Resource?: unknown }).Resource)
      .flat()
      .map((r) => JSON.stringify(r))
      .join('\n')

    for (const prefix of ['asset-staging/*', 'asset-originals/*', 'asset-meta/*', 'assets/*']) {
      expect(resourcePatterns).toContain(prefix)
    }
  })
})

describe('AssetSupport - bounding the anonymous transform path', () => {
  it('caps the transform Lambda with a reserved-concurrency limit', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = Template.fromStack(stack)

    // /assets/t/* is anonymous and `crop` is an unbounded float rect, so
    // without a cap a scripted loop is an uncapped sharp/S3 amplifier. This is
    // a RESERVATION (a cap), not provisioned concurrency -- it costs nothing.
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({ ReservedConcurrentExecutions: 10 }),
    )
  })

  it('honours an overridden transform concurrency cap', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS, transformReservedConcurrency: 3 })
    Template.fromStack(stack).hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({ ReservedConcurrentExecutions: 3 }),
    )
  })

  it('expires generated derivatives under assets/t/ while keeping originals forever', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = Template.fromStack(stack)

    template.hasResourceProperties(
      'AWS::S3::Bucket',
      Match.objectLike({
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Status: 'Enabled',
              Prefix: 'assets/t/',
              ExpirationInDays: 180,
            }),
          ]),
        },
      }),
    )

    // Source assets and metadata must NOT be swept -- they are not
    // regenerable, unlike everything under assets/t/.
    const buckets = Object.values(template.findResources('AWS::S3::Bucket'))
    const prefixes = buckets.flatMap(
      (b) =>
        (b.Properties.LifecycleConfiguration?.Rules ?? []).map(
          (r: { Prefix?: string }) => r.Prefix,
        ) as (string | undefined)[],
    )
    expect(prefixes).not.toContain('asset-originals/')
    expect(prefixes).not.toContain('asset-meta/')
  })

  it('leaves lifecycle rules to the caller in BYO-bucket mode', () => {
    const stack = makeStack()
    const existing = new s3.Bucket(stack, 'Existing')
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS, bucket: existing })
    const template = Template.fromStack(stack)

    // A default `s3.Bucket` emits no Properties at all, so this reads through
    // optional chaining rather than asserting the key's container exists.
    const buckets = Object.values(template.findResources('AWS::S3::Bucket'))
    expect(buckets).toHaveLength(1)
    expect(buckets[0].Properties?.LifecycleConfiguration).toBeUndefined()
  })
})

describe('AssetSupport - transform Lambda CloudWatch log group', () => {
  it('creates a dedicated transform log group named /canopycms/<stackName>/transform with 90-day default retention and DESTROY removal', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = Template.fromStack(stack)

    template.hasResource(
      'AWS::Logs::LogGroup',
      Match.objectLike({
        Properties: Match.objectLike({
          LogGroupName: '/canopycms/TestStack/transform',
          RetentionInDays: 90,
        }),
        DeletionPolicy: 'Delete',
      }),
    )
  })

  it('honors transformLogRetention to override the default retention', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', {
      ...BASE_PROPS,
      transformLogRetention: RetentionDays.ONE_WEEK,
    })
    const template = Template.fromStack(stack)

    template.hasResourceProperties(
      'AWS::Logs::LogGroup',
      Match.objectLike({ LogGroupName: '/canopycms/TestStack/transform', RetentionInDays: 7 }),
    )
  })

  it('honors transformLogGroupName to override the default name', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', {
      ...BASE_PROPS,
      transformLogGroupName: '/custom/transform',
    })
    const template = Template.fromStack(stack)

    template.hasResourceProperties(
      'AWS::Logs::LogGroup',
      Match.objectLike({ LogGroupName: '/custom/transform' }),
    )
  })

  // Direct regression guard for the deploy-blocking trap: Lambda auto-creates
  // `/aws/lambda/<function-name>` outside CloudFormation on first invoke, so
  // a CDK LogGroup construct using that exact name fails CreateLogGroup with
  // "already exists" the moment it's ever been deployed without one.
  it('the transform log group name does not start with /aws/lambda/', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = Template.fromStack(stack)

    const groups = template.findResources('AWS::Logs::LogGroup')
    const names = Object.values(groups).map(
      (group) => (group.Properties as { LogGroupName?: string }).LogGroupName ?? '',
    )
    expect(names.length).toBeGreaterThanOrEqual(1)
    for (const name of names) {
      expect(name.startsWith('/aws/lambda/')).toBe(false)
    }
  })

  it('the transform Lambda references its dedicated log group via LoggingConfig.LogGroup', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = Template.fromStack(stack)

    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        LoggingConfig: Match.objectLike({
          LogGroup: { Ref: Match.stringLikeRegexp('TransformFunctionLogs') },
        }),
      }),
    )
  })

  it('grants the transform Lambda role a log-group-scoped IAM statement (CreateLogStream + PutLogEvents only), not a broad grant', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = Template.fromStack(stack)

    template.hasResourceProperties(
      'AWS::IAM::Policy',
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              Resource: Match.objectLike({
                'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('TransformFunctionLogs')]),
              }),
            }),
          ]),
        }),
      }),
    )
  })
})

describe('AssetSupport - BYO bucket mode', () => {
  it('does not create a bucket when an existing one is provided', () => {
    const stack = makeStack()
    const existingBucket = s3.Bucket.fromBucketName(stack, 'Existing', 'my-existing-bucket')
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS, bucket: existingBucket })
    const template = Template.fromStack(stack)

    template.resourceCountIs('AWS::S3::Bucket', 0)
  })
})

describe('deployable-bundle guard', () => {
  // Every other test in this file opts out via BASE_PROPS's
  // requireDeployableBundle: false (see its doc comment above), which left
  // the guard's actual default-on branch - the one that protects a real
  // `cdk deploy` - with zero coverage. Flipping asset-support.ts's
  // `(props.requireDeployableBundle ?? true)` to `?? false` broke nothing
  // without this test.
  it('throws when requireDeployableBundle is omitted (defaults on) and the .deployable marker is absent', () => {
    // Fail loudly, not silently-for-the-wrong-reason, if the fixture layout
    // this test depends on ever moves.
    expect(existsSync(transformAssetDir)).toBe(true)

    // Under `pnpm test` the fixture bundle is built --skip-native (see
    // BASE_PROPS's doc comment), so the marker is normally absent and the
    // guard fires naturally. But a developer who has run
    // `pnpm --filter canopycms-cdk run build:lambda` for real will have a
    // genuine marker on disk, which would make this test fail for a reason
    // that has nothing to do with the guard. Move it aside for the duration
    // of this one test - never delete it - and restore it unconditionally.
    const markerWasPresent = existsSync(deployableMarkerPath)
    const backupPath = `${deployableMarkerPath}.testbak`
    if (markerWasPresent) {
      renameSync(deployableMarkerPath, backupPath)
    }
    try {
      const stack = makeStack()
      // Deliberately does NOT spread BASE_PROPS - that sets
      // requireDeployableBundle: false and would silently re-vacuate this
      // test. This is the one construction in the whole suite that exercises
      // the guard's real default.
      expect(() => new AssetSupport(stack, 'Assets', { editorOrigins: EDITOR_ORIGINS })).toThrow(
        /\.deployable/,
      )
    } finally {
      if (markerWasPresent) {
        renameSync(backupPath, deployableMarkerPath)
      }
    }
  })
})
