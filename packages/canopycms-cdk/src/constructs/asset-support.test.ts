import { existsSync, readFileSync, renameSync } from 'node:fs'
import * as vm from 'node:vm'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Duration, Stack } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { aws_cloudfront as cloudfront, aws_iam as iam, aws_s3 as s3 } from 'aws-cdk-lib'
import { RetentionDays } from 'aws-cdk-lib/aws-logs'
import { describe, expect, it } from 'vitest'

import { AssetSupport, ASSETS_PATH_PATTERN, ASSETS_TRANSFORM_PATH_PATTERN } from './asset-support'
import { newTestApp } from '../../test-support/test-synth'

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
  const app = newTestApp()
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

describe('AssetSupport - attachTo()', () => {
  it('attaches /assets/t/* before /assets/* via addBehavior (not additionalBehaviors), on the synthesized CacheBehaviors array', () => {
    // Regression guard for the ordering footgun attachTo() exists to make
    // unrepresentable: CloudFront matches path patterns in order and stops at
    // the first match, so if the broader, S3-only '/assets/*' were ever
    // attached before '/assets/t/*', every never-yet-computed transform would
    // 403 permanently. Match.arrayWith is deliberately NOT used here - it is
    // order-insensitive, which is exactly why the pre-existing tests in this
    // file never caught this class of bug. Asserting on the array INDEX is
    // the only way to pin the order.
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    // A minimal concrete distribution to call addBehavior on - reuses the
    // assets origin as the (irrelevant to this test) default behavior origin
    // rather than importing aws_cloudfront_origins just for a placeholder.
    const distribution = new cloudfront.Distribution(stack, 'Dist', {
      defaultBehavior: { origin: assetSupport.assetBehaviors().assets.origin },
    })

    assetSupport.attachTo(distribution)

    const template = Template.fromStack(stack)
    const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0]
    const patterns = (
      dist.Properties.DistributionConfig.CacheBehaviors as { PathPattern: string }[]
    ).map((b) => b.PathPattern)

    expect(patterns).toContain(ASSETS_TRANSFORM_PATH_PATTERN)
    expect(patterns).toContain(ASSETS_PATH_PATTERN)
    expect(patterns.indexOf(ASSETS_TRANSFORM_PATH_PATTERN)).toBeLessThan(
      patterns.indexOf(ASSETS_PATH_PATTERN),
    )
  })
})

describe('AssetSupport - transform origin read timeout', () => {
  it('passes readTimeout explicitly rather than relying on CloudFront’s default', () => {
    // CloudFront's 30s default happens to equal TRANSFORM_LAMBDA_TIMEOUT today,
    // so an accidental match would look correct while raising the Lambda's
    // timeout alone silently started 504ing the slow transforms the raise was
    // meant to allow. The CMS origin has this assertion; this one did not.
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    const template = synthWithDistribution(assetSupport, stack)

    const dists = template.findResources('AWS::CloudFront::Distribution')
    // Only CUSTOM origins have a read timeout at all -- the S3 primary of the
    // transform behavior's origin group has no CustomOriginConfig, so filter to
    // the ones that can carry the property before asserting on it.
    const customOrigins = Object.values(dists).flatMap((d) =>
      (
        (d.Properties.DistributionConfig.Origins ?? []) as {
          CustomOriginConfig?: { OriginReadTimeout?: number }
        }[]
      ).filter((o) => o.CustomOriginConfig !== undefined),
    )
    expect(customOrigins.length).toBeGreaterThan(0)
    for (const origin of customOrigins) {
      expect(origin.CustomOriginConfig?.OriginReadTimeout).toBe(30)
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

describe('cms-stack template: the media block names a real API', () => {
  // The scaffold's "uncomment to enable media" block previously named
  // a member that did not exist, and omitted the then-required
  // `editorOrigins` prop -- so an adopter who followed the template's
  // own instructions hit two type errors plus a nonexistent property, then had
  // to reverse-engineer the construct's real API. Template text cannot be
  // type-checked while it is commented out, so assert the API surface it
  // references actually exists.
  // BOTH copies of this block. The scaffold template and the checked-in
  // example stack teach the same thing, and a fix applied to only one is how
  // the dead-API version survived: the template was corrected while
  // examples/aws-deployment/ went on instructing adopters to wire a member
  // that does not exist.
  const repoRoot = path.join(__dirname, '..', '..', '..', '..')
  const MEDIA_BLOCK_SOURCES = [
    path.join(repoRoot, 'packages/canopycms/src/cli/template-files/cms-stack.ts.template'),
    path.join(repoRoot, 'examples/aws-deployment/infrastructure/lib/cms-stack.ts'),
  ]

  it.each(MEDIA_BLOCK_SOURCES)('%s references only members AssetSupport actually has', (file) => {
    const source = readFileSync(file, 'utf-8')
    const referenced = [...source.matchAll(/assetSupport\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
    expect(referenced.length).toBeGreaterThan(0)

    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...BASE_PROPS })
    for (const member of new Set(referenced)) {
      expect(
        member in assetSupport ||
          member in (Object.getPrototypeOf(assetSupport) as Record<string, unknown>),
        `${file} references assetSupport.${member}, which AssetSupport does not have`,
      ).toBe(true)
    }
  })

  it.each(MEDIA_BLOCK_SOURCES)(
    '%s passes editorOrigins -- optional to the construct now, but still what the scaffold should teach',
    (file) => {
      const source = readFileSync(file, 'utf-8')
      expect(/new AssetSupport\(/.test(source)).toBe(true)
      expect(source).toContain('editorOrigins')
    },
  )
})

/**
 * `transformRole` exists so an adopter can compute the transform Lambda's
 * principal ARN without a reference to this construct - see that prop's doc
 * comment for the cross-account asset-bucket case behind it.
 *
 * CDK's `lambda.Function` silently discards the managed policies it would
 * otherwise attach when a role is passed (it builds the list, then uses it only
 * for the role it creates itself), so the construct re-attaches them. This
 * function is NOT VPC-attached, which is exactly what the second test pins:
 * if this call site and `CanopyCmsService`'s were ever collapsed into one, the
 * transform Lambda's role would start carrying ENI permissions it has no use
 * for.
 */
describe('AssetSupport - transformRole', () => {
  const PASSED_ROLE_NAME = 'canopy-transform-passed-role'

  function synthWithPassedRole(): { template: Template; roleLogicalId: string } {
    const stack = makeStack()
    const role = new iam.Role(stack, 'TransformRole', {
      roleName: PASSED_ROLE_NAME,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    })
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS, transformRole: role })

    const template = Template.fromStack(stack)
    const roles = template.findResources('AWS::IAM::Role', {
      Properties: Match.objectLike({ RoleName: PASSED_ROLE_NAME }),
    })
    const ids = Object.keys(roles)
    expect(ids).toHaveLength(1)
    return { template, roleLogicalId: ids[0] }
  }

  it('re-attaches the basic-execution managed policy CDK discards, and points the Lambda at the passed role', () => {
    const { template, roleLogicalId } = synthWithPassedRole()

    const role = template.findResources('AWS::IAM::Role')[roleLogicalId]
    expect(JSON.stringify(role.Properties.ManagedPolicyArns)).toContain(
      'service-role/AWSLambdaBasicExecutionRole',
    )

    const fns = template.findResources('AWS::Lambda::Function')
    const roleRefs = Object.values(fns).map((fn) => JSON.stringify(fn.Properties.Role))
    expect(roleRefs).toHaveLength(1)
    expect(roleRefs[0]).toContain(roleLogicalId)
  })

  it('does NOT attach the VPC-ENI policy - this Lambda is not VPC-attached', () => {
    const { template, roleLogicalId } = synthWithPassedRole()

    const role = template.findResources('AWS::IAM::Role')[roleLogicalId]
    const attached = (role.Properties as { ManagedPolicyArns?: unknown[] }).ManagedPolicyArns

    // Pin the EXACT set rather than only the absence. A bare `not.toContain`
    // against a stringified `undefined` throws a type error instead of
    // reporting a clean failure when the list is missing entirely, so the
    // length assertion is what makes this readable when it breaks - and it
    // also catches a third policy arriving that nobody meant to add.
    expect(attached).toHaveLength(1)
    expect(JSON.stringify(attached)).not.toContain('service-role/AWSLambdaVPCAccessExecutionRole')
  })

  it('still applies the bucket and log-group grants to the passed role', () => {
    const { template, roleLogicalId } = synthWithPassedRole()

    const document = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((policy) => JSON.stringify(policy.Properties.Roles).includes(roleLogicalId))
      .map((policy) => JSON.stringify(policy.Properties.PolicyDocument))
      .join('\n')

    // transformLogGroup.grantWrite - what actually enables logging to the
    // custom-named group, since the basic-execution policy's log statements are
    // scoped to /aws/lambda/* only.
    expect(document).toContain('logs:PutLogEvents')
    // The prefix-scoped bucket grants, which land on the function's
    // grantPrincipal (= the passed role).
    expect(document).toContain('asset-originals/*')
    expect(document).toContain('asset-meta/*')
  })
})

/**
 * Shapes of the CloudFormation fragments the upload-behavior tests read. Named
 * rather than inlined because every one of these assertions is about a
 * property being ABSENT or having one exact value, and an `any`-typed template
 * walk turns a renamed key into a silently vacuous test.
 */
interface EmittedOrigin {
  Id: string
  DomainName: unknown
  CustomOriginConfig?: { OriginProtocolPolicy?: string }
  S3OriginConfig?: unknown
  OriginAccessControlId?: unknown
}

interface EmittedBehavior {
  AllowedMethods?: string[]
  ViewerProtocolPolicy?: string
  TargetOriginId?: string
  CachePolicyId?: unknown
  OriginRequestPolicyId?: { Ref?: string }
  ResponseHeadersPolicyId?: { Ref?: string }
  FunctionAssociations?: { EventType?: string; FunctionARN?: unknown }[]
}

interface UploadDistributionParts {
  template: Template
  behavior: EmittedBehavior
  origins: EmittedOrigin[]
}

/**
 * Synth the topology `uploadBehavior()` documents: a distribution serving the
 * upload route and nothing else, with the behavior as its DEFAULT behavior.
 *
 * Deliberately does NOT also attach the read behaviors. Their OAC-signed S3
 * origin would put an `AWS::CloudFront::OriginAccessControl` in the template
 * and defeat the resource-count tripwire below, and the whole point of the
 * settled topology is that reads are not on this distribution.
 */
function synthUploadDistribution(
  assetSupport: AssetSupport,
  stack: Stack,
): UploadDistributionParts {
  new cloudfront.Distribution(stack, 'UploadDist', {
    defaultBehavior: assetSupport.uploadBehavior(),
  })
  const template = Template.fromStack(stack)
  const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0]
  const config = distribution.Properties.DistributionConfig as {
    DefaultCacheBehavior: EmittedBehavior
    Origins: EmittedOrigin[]
  }
  return { template, behavior: config.DefaultCacheBehavior, origins: config.Origins }
}

/** Resolve a `{ Ref: <logicalId> }` from a behavior to the resource it names. */
function resolveRef(
  template: Template,
  type: string,
  ref: { Ref?: string } | undefined,
): Record<string, unknown> {
  expect(ref?.Ref).toBeTypeOf('string')
  const resources = template.findResources(type)
  const resource = resources[ref?.Ref as string]
  expect(resource).toBeDefined()
  return resource.Properties as Record<string, unknown>
}

/**
 * Load the emitted CloudFront Function and RUN it.
 *
 * Round 3 of review found a matcher bug that every source-text `toContain`
 * assertion in this file walked straight past: the emitted code contained all
 * the right fragments and still answered the wrong thing for a wildcard
 * pattern. A fragment check cannot observe behaviour, so these tests execute
 * the function against CloudFront-shaped events instead. Strict mode is
 * prepended because the CloudFront Functions runtime forces it.
 */
interface EdgeRequest {
  method: string
  uri: string
  headers: Record<string, { value: string }>
}
interface EdgeResponse {
  statusCode?: number
  statusDescription?: string
  headers?: Record<string, { value: string }>
  uri?: string
  method?: string
}

function loadUploadFunction(template: Template): (request: EdgeRequest) => EdgeResponse {
  const functions = template.findResources('AWS::CloudFront::Function')
  const codes = Object.values(functions).map(
    (fn) => (fn.Properties as { FunctionCode: string }).FunctionCode,
  )
  expect(codes).toHaveLength(1)

  const context = vm.createContext({})
  vm.runInContext(`"use strict";\n${codes[0]}`, context)
  const handler = vm.runInContext('handler', context) as (event: {
    request: EdgeRequest
  }) => EdgeResponse
  expect(typeof handler).toBe('function')
  return (request) => handler({ request })
}

function preflight(origin?: string): EdgeRequest {
  return {
    method: 'OPTIONS',
    uri: '/asset-upload/',
    headers: origin === undefined ? {} : { origin: { value: origin } },
  }
}

const UPLOAD_PROPS = { requireDeployableBundle: false, uploadBehavior: {} }

describe('AssetSupport - uploadBehavior()', () => {
  it('puts the upload on an UNSIGNED origin for the bucket - no OAC anywhere on the distribution', () => {
    // The tripwire for the single most likely "helpful" edit to this
    // construct: switching the upload origin to the same
    // `withOriginAccessControl` origin the read behaviors use, on the
    // reasonable-sounding grounds that everything else here is OAC-signed.
    // That fails CLOSED but confusingly - CloudFront signs origin requests
    // and never hashes the body, so S3 answers 400 InvalidArgument naming
    // x-amz-content-sha256, which reads like a client bug rather than an
    // infrastructure one.
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })
    const { template, origins } = synthUploadDistribution(assetSupport, stack)

    expect(origins).toHaveLength(1)
    const [origin] = origins
    // Object.keys throws rather than passing vacuously if the origin entry
    // ever stops being emitted at all.
    expect(Object.keys(origin)).not.toContain('OriginAccessControlId')
    expect(Object.keys(origin)).not.toContain('S3OriginConfig')
    expect(origin.CustomOriginConfig?.OriginProtocolPolicy).toBe('https-only')
    expect(JSON.stringify(origin.DomainName)).toContain('RegionalDomainName')

    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 0)
  })

  it('allows all methods - a POST is 405 on CDK’s GET/HEAD default', () => {
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })
    const { behavior } = synthUploadDistribution(assetSupport, stack)

    expect([...(behavior.AllowedMethods ?? [])].sort()).toEqual([
      'DELETE',
      'GET',
      'HEAD',
      'OPTIONS',
      'PATCH',
      'POST',
      'PUT',
    ])
  })

  it('rewrites every non-preflight request to the bucket root and drops Authorization (executed, not grepped)', () => {
    // POST Object is root-only, and the unconditional rewrite is also what
    // contains ALLOW_ALL: nothing arriving here can address a key.
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })
    const { template } = synthUploadDistribution(assetSupport, stack)
    const run = loadUploadFunction(template)

    const posted = run({
      method: 'POST',
      uri: '/asset-upload/some/deep/key.png',
      headers: { authorization: { value: 'Basic c2VjcmV0' }, 'content-type': { value: 'x' } },
    })
    expect(posted.uri).toBe('/')
    expect(posted.headers).not.toHaveProperty('authorization')
    expect(posted.headers).toHaveProperty('content-type')

    // A GET is rewritten too - key addressability must not come back by method.
    expect(run({ method: 'GET', uri: '/assets/secret.png', headers: {} }).uri).toBe('/')
  })

  it('answers the CORS preflight itself, because the editor\u2019s upload is not a simple request and S3 with no CORS rule 403s an OPTIONS', () => {
    // xhr-upload.ts assigns xhr.upload.onprogress before send(), and ANY
    // listener on XMLHttpRequestUpload disqualifies a request from the
    // simple-request rules regardless of method/headers/content-type. So a real
    // browser upload always preflights. CloudFront does not synthesize
    // preflight responses and the bucket deliberately has no CORS rule, so
    // without this the OPTIONS reaches S3, 403s, and the POST is never sent.
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })
    const { template } = synthUploadDistribution(assetSupport, stack)
    const run = loadUploadFunction(template)

    const response = run(preflight('https://editor.example.com'))
    expect(response.statusCode).toBe(204)
    expect(response.headers?.['access-control-allow-origin']?.value).toBe('*')
    expect(response.headers?.['access-control-allow-methods']?.value).toBe('POST')
    expect(response.headers?.['access-control-max-age']?.value).toBe('3000')
    // It must NOT fall through to the origin-bound branch.
    expect(response.uri).toBeUndefined()
  })

  it('echoes the requesting Origin on a preflight when allowedOrigins is narrowed, and withholds ACAO when it does not match', () => {
    // A preflight may be answered with `*` or exactly one origin, so a
    // multi-entry list cannot be returned verbatim.
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', {
      requireDeployableBundle: false,
      uploadBehavior: { allowedOrigins: ['https://a.example.com', 'https://b.example.com'] },
    })
    const { template } = synthUploadDistribution(assetSupport, stack)
    const run = loadUploadFunction(template)

    expect(
      run(preflight('https://b.example.com')).headers?.['access-control-allow-origin'],
    ).toEqual({ value: 'https://b.example.com' })
    // Never the wildcard, and never another entry from the list.
    expect(
      run(preflight('https://evil.example.com')).headers?.['access-control-allow-origin'],
    ).toBeUndefined()
    expect(run(preflight()).headers?.['access-control-allow-origin']).toBeUndefined()
    // Still a well-formed 204 either way - the browser's own check refuses it.
    expect(run(preflight('https://evil.example.com')).statusCode).toBe(204)
  })

  it('does not treat a list that merely contains "*" as the wildcard', () => {
    // Guarded at construction, so the only way to reach the function is the
    // bare wildcard. This pins the pair: if the guard is ever relaxed, the
    // matcher must be revisited at the same time.
    const stack = makeStack()

    expect(
      () =>
        new AssetSupport(stack, 'Assets', {
          requireDeployableBundle: false,
          uploadBehavior: { allowedOrigins: ['https://a.example.com', '*'] },
        }),
    ).toThrow(/wildcard pattern/)
  })

  it('refuses a leftmost-subdomain wildcard, which the response headers policy would accept but the preflight matcher cannot honour', () => {
    const stack = makeStack()

    expect(
      () =>
        new AssetSupport(stack, 'Assets', {
          requireDeployableBundle: false,
          uploadBehavior: { allowedOrigins: ['https://*.preview.example.com'] },
        }),
    ).toThrow(/compares origins exactly/)
  })

  it('refuses a dotted bucket name, whose regional domain S3\u2019s wildcard certificate does not cover', () => {
    const stack = makeStack()
    const bucket = s3.Bucket.fromBucketName(stack, 'Dotted', 'my.docs.bucket')

    expect(() =>
      new AssetSupport(stack, 'Assets', {
        requireDeployableBundle: false,
        bucket,
        uploadBehavior: {},
      }).uploadBehavior(),
    ).toThrow(/wildcard certificate/)
  })

  it('forwards no cookies, no query strings, and no Host to S3 (Authorization is dropped by the function, not here)', () => {
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })
    const { template, behavior } = synthUploadDistribution(assetSupport, stack)

    const config = resolveRef(
      template,
      'AWS::CloudFront::OriginRequestPolicy',
      behavior.OriginRequestPolicyId,
    ).OriginRequestPolicyConfig as {
      CookiesConfig: { CookieBehavior: string }
      HeadersConfig: { HeaderBehavior: string; Headers?: string[] }
      QueryStringsConfig: { QueryStringBehavior: string }
    }

    // The editor session cookie must never reach S3 or its access logs.
    expect(config.CookiesConfig.CookieBehavior).toBe('none')
    expect(config.QueryStringsConfig.QueryStringBehavior).toBe('none')
    // Exactly the managed ALL_VIEWER_EXCEPT_HOST_HEADER shape. `authorization`
    // is deliberately NOT in this list - naming it in an origin request policy
    // is the one thing here that might be rejected at deploy rather than at
    // synth, so the function below drops it instead.
    expect(config.HeadersConfig.HeaderBehavior).toBe('allExcept')
    expect(config.HeadersConfig.Headers).toEqual(['host'])
  })

  it('disables caching on the upload route', () => {
    // CACHING_DISABLED's all-`none` cache key is also what keeps the origin
    // request policy legal, so this is load-bearing rather than incidental.
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })
    const { behavior } = synthUploadDistribution(assetSupport, stack)

    // The managed CachePolicy.CACHING_DISABLED id.
    expect(behavior.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad')
  })

  it('builds no CloudFront resources when the prop is set but the behavior is never used', () => {
    // Opting in mints a function + two policies, and response headers policies
    // have a default account quota of 20 - so this must not happen per
    // environment for adopters pointing several at one upload distribution.
    // `editorOrigins` is passed alongside purely so the synth validation for
    // "opted in but never attached" does not fire - this test is about
    // laziness, not about that guard, which has its own test below.
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS, uploadBehavior: {} })
    const template = Template.fromStack(stack)

    template.resourceCountIs('AWS::CloudFront::Function', 0)
    template.resourceCountIs('AWS::CloudFront::OriginRequestPolicy', 0)
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0)
  })

  it('is memoized - calling uploadBehavior() twice does not mint a second set of policies', () => {
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })

    expect(assetSupport.uploadBehavior()).toBe(assetSupport.uploadBehavior())

    synthUploadDistribution(assetSupport, stack)
    const template = Template.fromStack(stack)
    template.resourceCountIs('AWS::CloudFront::Function', 1)
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 1)
  })

  it('the preflight function and the response-headers policy agree on the allowed method', () => {
    // Two places tell the browser what it may send; they must not disagree.
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })
    const { template, behavior } = synthUploadDistribution(assetSupport, stack)

    const cors = (
      resolveRef(
        template,
        'AWS::CloudFront::ResponseHeadersPolicy',
        behavior.ResponseHeadersPolicyId,
      ).ResponseHeadersPolicyConfig as {
        CorsConfig: { AccessControlAllowMethods: { Items: string[] } }
      }
    ).CorsConfig
    const code = Object.values(template.findResources('AWS::CloudFront::Function')).map(
      (fn) => (fn.Properties as { FunctionCode: string }).FunctionCode,
    )[0]

    expect(cors.AccessControlAllowMethods.Items).toEqual(['POST'])
    for (const method of cors.AccessControlAllowMethods.Items) {
      expect(code).toContain(`value: '${method}'`)
    }
  })

  it('snapshots allowedOrigins, so mutating the caller\u2019s array cannot slip past the empty-list guard', () => {
    const stack = makeStack()
    const callerOrigins = ['https://editor.example.com']
    const assetSupport = new AssetSupport(stack, 'Assets', {
      requireDeployableBundle: false,
      uploadBehavior: { allowedOrigins: callerOrigins },
    })
    // The guard has already passed; the behaviour is not built until now.
    callerOrigins.length = 0

    const { template, behavior } = synthUploadDistribution(assetSupport, stack)
    const cors = (
      resolveRef(
        template,
        'AWS::CloudFront::ResponseHeadersPolicy',
        behavior.ResponseHeadersPolicyId,
      ).ResponseHeadersPolicyConfig as {
        CorsConfig: { AccessControlAllowOrigins: { Items: string[] } }
      }
    ).CorsConfig

    expect(cors.AccessControlAllowOrigins.Items).toEqual(['https://editor.example.com'])
  })

  it('fails synth when uploadBehavior is opted into and the accessor is never called', () => {
    // Satisfying the constructor guard by setting the prop, then not wiring it,
    // reaches the same no-ACAO-anywhere state the guard exists to refuse.
    const app = newTestApp()
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })

    expect(() => app.synth()).toThrow(/never attached to a distribution/)
    expect(() => app.synth()).toThrow(/uploadBehavior\(\) was never called/)
  })

  it('fails synth when uploadBehavior() is called and its result is discarded', () => {
    // The condition is ATTACHMENT, not the accessor having been called. A
    // memoized accessor cannot tell these apart on its own, and this is the
    // likelier of the two shapes: it is what a half-finished copy of the README
    // snippet, or a refactor that loses the value, leaves behind. The adopter
    // lands in exactly the state the message describes - standalone bucket, no
    // CORS rule, no edge route - so the guard has to fire here too.
    const app = newTestApp()
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })
    assetSupport.uploadBehavior()

    expect(() => app.synth()).toThrow(/never attached to a distribution/)
    // ...and says WHICH of the two shapes this was, since the fixes differ.
    expect(() => app.synth()).toThrow(/its return value was not passed to one/)
  })

  it('passes synth once the upload behavior actually reaches a distribution', () => {
    // The other side of the guard: attaching it satisfies the validation. Pins
    // that the check reads attachment rather than merely "something was built",
    // which would make the two tests above pass for the wrong reason.
    const app = newTestApp()
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })
    new cloudfront.Distribution(stack, 'Uploads', {
      defaultBehavior: assetSupport.uploadBehavior(),
    })

    expect(() => app.synth()).not.toThrow()
  })

  it('counts attachment to a distribution in ANOTHER stack', () => {
    // The upload route is deliberately a separate one-behavior distribution,
    // which an adopter may well put in its own stack. Detection therefore reads
    // the origin's own bind, not the emitted template: a tree search resolves to
    // an Fn::ImportValue in the consuming stack and would fail this correct
    // arrangement at synth.
    const app = newTestApp()
    const env = { account: '123456789012', region: 'us-east-1' }
    const stack = new Stack(app, 'TestStack', { env })
    const uploadStack = new Stack(app, 'UploadStack', { env })
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })
    new cloudfront.Distribution(uploadStack, 'Uploads', {
      defaultBehavior: assetSupport.uploadBehavior(),
    })

    expect(() => app.synth()).not.toThrow()
  })

  it('refuses an empty allowedOrigins rather than silently widening it to the wildcard', () => {
    const stack = makeStack()

    expect(
      () =>
        new AssetSupport(stack, 'Assets', {
          requireDeployableBundle: false,
          uploadBehavior: { allowedOrigins: [] },
        }),
    ).toThrow(/allowedOrigins is an empty array/)
  })

  it('supplies Access-Control-Allow-Origin from the edge, overriding the origin, so no bucket CORS rule is needed', () => {
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })
    const { template, behavior } = synthUploadDistribution(assetSupport, stack)

    const cors = (
      resolveRef(
        template,
        'AWS::CloudFront::ResponseHeadersPolicy',
        behavior.ResponseHeadersPolicyId,
      ).ResponseHeadersPolicyConfig as {
        CorsConfig: {
          AccessControlAllowOrigins: { Items: string[] }
          AccessControlAllowCredentials: boolean
          OriginOverride: boolean
        }
      }
    ).CorsConfig

    expect(cors.AccessControlAllowOrigins.Items).toEqual(['*'])
    expect(cors.AccessControlAllowCredentials).toBe(false)
    expect(cors.OriginOverride).toBe(true)
  })

  it('honours allowedOrigins for adopters who would rather not use the wildcard', () => {
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', {
      requireDeployableBundle: false,
      uploadBehavior: { allowedOrigins: ['https://editor.example.com'] },
    })
    const { template, behavior } = synthUploadDistribution(assetSupport, stack)

    const cors = (
      resolveRef(
        template,
        'AWS::CloudFront::ResponseHeadersPolicy',
        behavior.ResponseHeadersPolicyId,
      ).ResponseHeadersPolicyConfig as {
        CorsConfig: { AccessControlAllowOrigins: { Items: string[] } }
      }
    ).CorsConfig

    expect(cors.AccessControlAllowOrigins.Items).toEqual(['https://editor.example.com'])
  })

  it('answers http:// with 403 rather than redirecting - a 301 turns a POST into a GET and the file is never sent', () => {
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })
    const { behavior } = synthUploadDistribution(assetSupport, stack)

    expect(behavior.ViewerProtocolPolicy).toBe('https-only')
  })

  it('writes no bucket CORS rule when the edge supplies the header instead', () => {
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...UPLOAD_PROPS })
    synthUploadDistribution(assetSupport, stack)
    const template = Template.fromStack(stack)

    const buckets = Object.values(template.findResources('AWS::S3::Bucket'))
    expect(buckets).toHaveLength(1)
    expect(Object.keys(buckets[0].Properties)).not.toContain('CorsConfiguration')
  })

  it('still writes the bucket CORS rule when editorOrigins is passed alongside', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { ...BASE_PROPS, uploadBehavior: {} })
    const template = Template.fromStack(stack)

    template.hasResourceProperties(
      'AWS::S3::Bucket',
      Match.objectLike({
        CorsConfiguration: {
          CorsRules: Match.arrayWith([Match.objectLike({ AllowedOrigins: EDITOR_ORIGINS })]),
        },
      }),
    )
  })

  it('refuses uploadBehavior() unless the prop opted in - the unsigned origin is never implicit', () => {
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { ...BASE_PROPS })

    expect(() => assetSupport.uploadBehavior()).toThrow(/needs the `uploadBehavior` prop/)
  })
})

describe('AssetSupport - editorOrigins is optional, but not absent-by-accident', () => {
  it('refuses to synth a standalone bucket with neither editorOrigins nor uploadBehavior', () => {
    // Neither route means S3 accepts the upload and declines to advertise it:
    // the object lands in asset-staging/ and the browser reports a network
    // error. Nothing downstream of that failure points at CORS.
    const stack = makeStack()

    expect(() => new AssetSupport(stack, 'Assets', { requireDeployableBundle: false })).toThrow(
      /given neither/,
    )
  })

  it('treats an empty editorOrigins array as absent (CloudFormation rejects a CORS rule with no origins)', () => {
    const stack = makeStack()

    expect(
      () =>
        new AssetSupport(stack, 'Assets', { requireDeployableBundle: false, editorOrigins: [] }),
    ).toThrow(/given neither/)
  })

  it('leaves BYO-bucket mode alone - the caller owns that bucket’s CORS configuration', () => {
    const stack = makeStack()
    const bucket = new s3.Bucket(stack, 'Existing')

    expect(
      () =>
        new AssetSupport(stack, 'Assets', {
          requireDeployableBundle: false,
          bucket,
        }),
    ).not.toThrow()
  })
})
