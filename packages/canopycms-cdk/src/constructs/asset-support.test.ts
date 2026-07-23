import { App, Duration, Stack } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { aws_cloudfront as cloudfront, aws_iam as iam, aws_s3 as s3 } from 'aws-cdk-lib'
import { describe, expect, it } from 'vitest'

import { AssetSupport } from './asset-support'

const EDITOR_ORIGINS = ['http://localhost:3000']

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
    new AssetSupport(stack, 'Assets', { editorOrigins: EDITOR_ORIGINS })
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

  it('configures the transform Lambda: arm64/nodejs20.x, memory/timeout, and the bucket name in its environment', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { editorOrigins: EDITOR_ORIGINS })
    const template = Template.fromStack(stack)

    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Runtime: 'nodejs20.x',
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
    new AssetSupport(stack, 'Assets', { editorOrigins: EDITOR_ORIGINS })
    const template = Template.fromStack(stack)

    template.hasResourceProperties('AWS::Lambda::Url', Match.objectLike({ AuthType: 'AWS_IAM' }))
  })

  it('grants the transform Lambda read on asset-originals/+asset-meta/ and put on assets/ only', () => {
    const stack = makeStack()
    new AssetSupport(stack, 'Assets', { editorOrigins: EDITOR_ORIGINS })
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
    const assetSupport = new AssetSupport(stack, 'Assets', { editorOrigins: EDITOR_ORIGINS })
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
    const assetSupport = new AssetSupport(stack, 'Assets', { editorOrigins: EDITOR_ORIGINS })
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
    const assetSupport = new AssetSupport(stack, 'Assets', { editorOrigins: EDITOR_ORIGINS })
    const template = synthWithDistribution(assetSupport, stack)

    const oacs = template.findResources('AWS::CloudFront::OriginAccessControl')
    const originTypes = Object.values(oacs).map(
      (oac) => oac.Properties.OriginAccessControlConfig.OriginAccessControlOriginType,
    )
    expect(originTypes.sort()).toEqual(['lambda', 's3'])
  })

  it('grantUploadAccess(): grants exactly the put/get/delete prefixes S3AssetStore calls for', () => {
    const stack = makeStack()
    const assetSupport = new AssetSupport(stack, 'Assets', { editorOrigins: EDITOR_ORIGINS })
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

describe('AssetSupport - BYO bucket mode', () => {
  it('does not create a bucket when an existing one is provided', () => {
    const stack = makeStack()
    const existingBucket = s3.Bucket.fromBucketName(stack, 'Existing', 'my-existing-bucket')
    new AssetSupport(stack, 'Assets', { bucket: existingBucket, editorOrigins: EDITOR_ORIGINS })
    const template = Template.fromStack(stack)

    template.resourceCountIs('AWS::S3::Bucket', 0)
  })
})
