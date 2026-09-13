import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { CfnElement, Duration, Fn, Stack, Token } from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { RetentionDays } from 'aws-cdk-lib/aws-logs'
import { Manifest } from 'aws-cdk-lib/cloud-assembly-schema'
import { AssetManifestArtifact } from 'aws-cdk-lib/cx-api'
import {
  aws_ecr as ecr,
  aws_ecr_assets as ecrAssets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_route53 as route53,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_s3 as s3,
} from 'aws-cdk-lib'
import { CanopyCmsService, DEFAULT_CMS_LAMBDA_TIMEOUT } from './cms-service'
import type { CanopyCmsServiceProps } from './cms-service'
import { CanopyCmsDistribution } from './cms-distribution'
import { AssetSupport, ASSETS_PATH_PATTERN, ASSETS_TRANSFORM_PATH_PATTERN } from './asset-support'
// Test-only imports across the package boundary, deliberately: the constructs
// in this directory do not import `canopycms` (see isValidDeploymentName's doc
// comment in cms-service.ts for the real reason, and for why the older "the
// package has no runtime dependency on canopycms" version of it was false),
// but this SUITE can, which is what makes the duplicated deployment-name rule
// a red test on drift rather than a comment asking nicely.
// Both modules are dependency-free apart from canopycms's own logger shim.
import { isValidDeploymentName } from '../../../canopycms/src/operating-mode/deployment-name'
import {
  VALID_DEPLOYMENT_NAMES,
  INVALID_DEPLOYMENT_NAMES,
} from '../../../canopycms/src/operating-mode/deployment-name-fixtures'
import { newTestApp } from '../../test-support/test-synth'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Synthesizes a stack with the CMS service (and optionally the distribution) so
 * the emitted CloudFormation template can be asserted against. Guards the
 * Cluster B deploy blockers: Lambda↔EFS egress (DEP-C1) and the CloudFront-only
 * Function URL (DEP-H2).
 */
/**
 * Memoized default synth.
 *
 * 33 of this file's tests call `synth()` with no arguments, i.e. they all
 * assert against the *same* template. Each call was doing a full CDK synth of
 * an identical stack, so the suite paid that cost 33 times over. That was
 * merely wasteful under aws-cdk-lib 2.192; under 2.260+ a single synth got
 * slow enough that whichever no-arg test ran first blew vitest's 5s default
 * and failed the run -- so the timeout was the symptom and the redundant work
 * was the cause.
 *
 * Caching is safe because `Template` is a read-only assertions facade: tests
 * call `hasResourceProperties`/`findResources`/etc. and never mutate it.
 * Calls WITH arguments are deliberately not cached -- `overrides` can carry
 * construct instances, which are not soundly comparable as a cache key, and
 * guessing at one is how a stale template would silently satisfy the wrong
 * assertion.
 */
let defaultTemplate: Template | undefined

function synth(withDistribution = false, overrides: Partial<CanopyCmsServiceProps> = {}): Template {
  const isDefault = withDistribution === false && Object.keys(overrides).length === 0
  if (isDefault && defaultTemplate) return defaultTemplate
  const template = synthUncached(withDistribution, overrides)
  if (isDefault) defaultTemplate = template
  return template
}

function synthUncached(
  withDistribution = false,
  overrides: Partial<CanopyCmsServiceProps> = {},
): Template {
  const app = newTestApp()
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  })
  const service = new CanopyCmsService(stack, 'Cms', {
    cmsDockerImage: lambda.DockerImageCode.fromEcr(
      ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
    ),
    githubOwner: 'acme',
    githubRepo: 'site',
    ...overrides,
  })

  if (withDistribution) {
    new CanopyCmsDistribution(stack, 'Dist', {
      functionUrl: service.functionUrl,
      domainName: 'cms.example.org',
      hostedZoneDomain: 'example.org',
      // Provide overrides so the test never performs a Route53/ACM lookup.
      hostedZone: route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
        hostedZoneId: 'Z123456789',
        zoneName: 'example.org',
      }),
      certificate: acm.Certificate.fromCertificateArn(
        stack,
        'Cert',
        'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      ),
    })
  }

  return Template.fromStack(stack)
}

/**
 * Concatenated JSON of every worker UserData-bearing resource in the
 * template. M4 migrated the worker off AutoScalingGroup's deprecated
 * LaunchConfiguration shorthand onto an explicit LaunchTemplate, so UserData
 * now lives on AWS::EC2::LaunchTemplate instead of
 * AWS::AutoScaling::LaunchConfiguration. Stringifying both keeps these
 * assertions correct regardless of which resource type actually carries it.
 */
function workerUserDataBlobs(template: Template): string {
  return (
    JSON.stringify(template.findResources('AWS::AutoScaling::LaunchConfiguration')) +
    JSON.stringify(template.findResources('AWS::EC2::LaunchTemplate'))
  )
}

/**
 * A complete, valid GitHub App configuration.
 *
 * Module-level because three separate describes below need the same one, and
 * because an App configuration is only ever valid as a SET -- the construct
 * refuses two of the three. Keeping the trio in one constant means a test that
 * wants App auth cannot accidentally half-configure it and end up asserting
 * against the all-or-nothing guard instead of the thing it meant to test.
 *
 * The IDs are strings, not numbers, and deliberately so: they reach the worker
 * through its `.env`, where everything is a string.
 */
const APP_KEY_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:app-key-AbCdEf'
const APP_PROPS: Partial<CanopyCmsServiceProps> = {
  githubAppId: '123456',
  githubAppInstallationId: '78901234',
  githubAppPrivateKeySecretArn: APP_KEY_ARN,
}

describe('CanopyCmsService deploy blockers', () => {
  it('DEP-C1: the Lambda security group has egress to EFS on 2049', () => {
    const template = synth()
    // The Lambda SG is allowAllOutbound:false, so a dedicated egress rule to the
    // EFS SG on the NFS port must exist or the mount is blocked at request time.
    template.hasResourceProperties(
      'AWS::EC2::SecurityGroupEgress',
      Match.objectLike({
        IpProtocol: 'tcp',
        FromPort: 2049,
        ToPort: 2049,
        GroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('LambdaSg'), 'GroupId'] },
      }),
    )
  })

  it('DEP-H2: the Function URL requires AWS_IAM (not public)', () => {
    const template = synth()
    template.hasResourceProperties('AWS::Lambda::Url', Match.objectLike({ AuthType: 'AWS_IAM' }))
    // Guard against regressing to a publicly reachable URL.
    const urls = template.findResources('AWS::Lambda::Url')
    for (const url of Object.values(urls)) {
      expect(url.Properties.AuthType).not.toBe('NONE')
    }
  })
})

describe('CanopyCmsDistribution: origin read timeout matches the Lambda timeout', () => {
  /** Every CloudFront origin's OriginReadTimeout, keyed by origin id. */
  function originReadTimeouts(template: Template): (number | undefined)[] {
    const dists = template.findResources('AWS::CloudFront::Distribution')
    return Object.values(dists).flatMap((d) =>
      (d.Properties.DistributionConfig.Origins ?? []).map(
        (o: { CustomOriginConfig?: { OriginReadTimeout?: number } }) =>
          o.CustomOriginConfig?.OriginReadTimeout,
      ),
    )
  }

  it('emits OriginReadTimeout equal to the CMS Lambda timeout, not CloudFront’s 30s default', () => {
    const template = synth(true)
    // Left unset, aws-cdk-lib omits the property entirely and CloudFront
    // applies 30s -- halving the Lambda's 60s budget and 504ing at the edge on
    // requests that actually succeed (first-touch branch provisioning clones
    // onto EFS inside the request).
    const lambdaTimeout = Object.values(
      template.findResources('AWS::Lambda::Function', {
        Properties: { Timeout: Match.anyValue() },
      }),
    ).find((fn) => fn.Properties.Timeout === DEFAULT_CMS_LAMBDA_TIMEOUT.toSeconds())
    expect(lambdaTimeout).toBeDefined()

    expect(originReadTimeouts(template)).toContain(DEFAULT_CMS_LAMBDA_TIMEOUT.toSeconds())
    expect(originReadTimeouts(template)).not.toContain(undefined)
  })

  it('follows an overridden Lambda timeout when the pair is wired through', () => {
    const app = newTestApp()
    const stack = new Stack(app, 'PairStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    const service = new CanopyCmsService(stack, 'Cms', {
      cmsDockerImage: lambda.DockerImageCode.fromEcr(
        ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
      ),
      githubOwner: 'acme',
      githubRepo: 'site',
      timeout: Duration.seconds(45),
    })
    new CanopyCmsDistribution(stack, 'Dist', {
      functionUrl: service.functionUrl,
      domainName: 'cms.example.org',
      hostedZoneDomain: 'example.org',
      originReadTimeout: service.timeout,
      hostedZone: route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
        hostedZoneId: 'Z123456789',
        zoneName: 'example.org',
      }),
      certificate: acm.Certificate.fromCertificateArn(
        stack,
        'Cert',
        'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      ),
    })

    expect(originReadTimeouts(Template.fromStack(stack))).toContain(45)
  })

  it('fails at synth rather than deploying a timeout CloudFront would reject', () => {
    const app = newTestApp()
    const stack = new Stack(app, 'TooLongStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    const service = new CanopyCmsService(stack, 'Cms', {
      cmsDockerImage: lambda.DockerImageCode.fromEcr(
        ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
      ),
      githubOwner: 'acme',
      githubRepo: 'site',
      timeout: Duration.seconds(120),
    })
    expect(
      () =>
        new CanopyCmsDistribution(stack, 'Dist', {
          functionUrl: service.functionUrl,
          domainName: 'cms.example.org',
          hostedZoneDomain: 'example.org',
          originReadTimeout: service.timeout,
          hostedZone: route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
            hostedZoneId: 'Z123456789',
            zoneName: 'example.org',
          }),
          certificate: acm.Certificate.fromCertificateArn(
            stack,
            'Cert',
            'arn:aws:acm:us-east-1:123456789012:certificate/abc',
          ),
        }),
    ).toThrow(/service-quota increase/)
  })
})

describe('CanopyCmsDistribution: us-east-1 certificate restriction', () => {
  function distInRegion(region: string, withCertificate: boolean) {
    const app = newTestApp()
    const stack = new Stack(app, `RegionStack${region.replace(/-/g, '')}`, {
      env: { account: '123456789012', region },
    })
    const service = new CanopyCmsService(stack, 'Cms', {
      cmsDockerImage: lambda.DockerImageCode.fromEcr(
        ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
      ),
      githubOwner: 'acme',
      githubRepo: 'site',
    })
    return () =>
      new CanopyCmsDistribution(stack, 'Dist', {
        functionUrl: service.functionUrl,
        domainName: 'cms.example.org',
        hostedZoneDomain: 'example.org',
        hostedZone: route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
          hostedZoneId: 'Z123456789',
          zoneName: 'example.org',
        }),
        ...(withCertificate
          ? {
              certificate: acm.Certificate.fromCertificateArn(
                stack,
                'Cert',
                'arn:aws:acm:us-east-1:123456789012:certificate/abc',
              ),
            }
          : {}),
      })
  }

  it('throws at synth outside us-east-1, naming both workarounds', () => {
    // CloudFront requires its certificate in us-east-1; this construct creates
    // one in the STACK's region. The restriction was documented nowhere, so an
    // adopter in eu-west-1 got an opaque error and had to research the fix.
    expect(distInRegion('eu-west-1', false)).toThrow(/us-east-1/)
    expect(distInRegion('eu-west-1', false)).toThrow(/certificate` prop/)
  })

  it('allows any region when the caller supplies its own certificate', () => {
    // A pre-created us-east-1 certificate is one of the two documented
    // workarounds, so it must not be rejected.
    expect(distInRegion('eu-west-1', true)).not.toThrow()
  })

  it('allows us-east-1', () => {
    expect(distInRegion('us-east-1', false)).not.toThrow()
  })
})

describe('CanopyCmsDistribution: additionalBehaviors', () => {
  it('merges caller behaviors alongside the built-in ones', () => {
    // Without this prop there was no way to attach AssetSupport's behaviors to
    // the distribution the scaffold generates, so its own "uncomment to enable
    // media" instructions were a dead end.
    const app = newTestApp()
    const stack = new Stack(app, 'BehaviorStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    const service = new CanopyCmsService(stack, 'Cms', {
      cmsDockerImage: lambda.DockerImageCode.fromEcr(
        ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
      ),
      githubOwner: 'acme',
      githubRepo: 'site',
    })
    new CanopyCmsDistribution(stack, 'Dist', {
      functionUrl: service.functionUrl,
      domainName: 'cms.example.org',
      hostedZoneDomain: 'example.org',
      hostedZone: route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
        hostedZoneId: 'Z123456789',
        zoneName: 'example.org',
      }),
      certificate: acm.Certificate.fromCertificateArn(
        stack,
        'Cert',
        'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      ),
      additionalBehaviors: {
        '/custom/*': {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl),
        },
      },
    })

    const template = Template.fromStack(stack)
    const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0]
    const patterns = (
      dist.Properties.DistributionConfig.CacheBehaviors as { PathPattern: string }[]
    ).map((b) => b.PathPattern)
    // Both the construct's own behavior and the caller's survive the merge.
    expect(patterns).toContain('/_next/static/*')
    expect(patterns).toContain('/custom/*')
  })

  it('preserves the CALLER’s ordering even for a key that collides with a default', () => {
    // CloudFront matches path patterns in order, so a more specific pattern
    // must precede a more general one that also matches. A plain object spread
    // keeps an overridden key at its FIRST-insertion index, which would pin an
    // overridden `/_next/static/*` ahead of everything else the caller passed
    // -- silently making their more specific pattern unreachable, which is
    // exactly what the prop's own doc warns them to avoid.
    const app = newTestApp()
    const stack = new Stack(app, 'OrderStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    const service = new CanopyCmsService(stack, 'Cms', {
      cmsDockerImage: lambda.DockerImageCode.fromEcr(
        ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
      ),
      githubOwner: 'acme',
      githubRepo: 'site',
    })
    const anyOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
    new CanopyCmsDistribution(stack, 'Dist', {
      functionUrl: service.functionUrl,
      domainName: 'cms.example.org',
      hostedZoneDomain: 'example.org',
      hostedZone: route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
        hostedZoneId: 'Z123456789',
        zoneName: 'example.org',
      }),
      certificate: acm.Certificate.fromCertificateArn(
        stack,
        'Cert',
        'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      ),
      additionalBehaviors: {
        // Specific first, as the caller intends and the docs instruct.
        '/_next/static/chunks/*': { origin: anyOrigin },
        // Collides with the construct's own default.
        '/_next/static/*': { origin: anyOrigin },
      },
    })

    const dist = Object.values(
      Template.fromStack(stack).findResources('AWS::CloudFront::Distribution'),
    )[0]
    const patterns = (
      dist.Properties.DistributionConfig.CacheBehaviors as { PathPattern: string }[]
    ).map((b) => b.PathPattern)

    expect(patterns.indexOf('/_next/static/chunks/*')).toBeGreaterThanOrEqual(0)
    expect(patterns.indexOf('/_next/static/chunks/*')).toBeLessThan(
      patterns.indexOf('/_next/static/*'),
    )
  })
})

describe('CanopyCmsDistribution: assetSupport prop', () => {
  /** Builds a stack with a CanopyCmsService and an AssetSupport, ready to pass to CanopyCmsDistribution. */
  function buildServiceAndAssets(stackId: string) {
    const app = newTestApp()
    const stack = new Stack(app, stackId, {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    const service = new CanopyCmsService(stack, 'Cms', {
      cmsDockerImage: lambda.DockerImageCode.fromEcr(
        ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
      ),
      githubOwner: 'acme',
      githubRepo: 'site',
    })
    const assetSupport = new AssetSupport(stack, 'Assets', {
      editorOrigins: ['http://localhost:3000'],
      // See asset-support.test.ts's BASE_PROPS doc comment - this suite
      // synths against the cheap --skip-native fixture bundle.
      requireDeployableBundle: false,
    })
    return { stack, service, assetSupport }
  }

  function distributionCommonProps(stack: Stack, functionUrl: lambda.FunctionUrl) {
    return {
      functionUrl,
      domainName: 'cms.example.org',
      hostedZoneDomain: 'example.org',
      hostedZone: route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
        hostedZoneId: 'Z123456789',
        zoneName: 'example.org',
      }),
      certificate: acm.Certificate.fromCertificateArn(
        stack,
        'Cert',
        'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      ),
    }
  }

  it('attaches both AssetSupport behaviors in the right order, alongside the construct’s own /_next/static/*', () => {
    const { stack, service, assetSupport } = buildServiceAndAssets('AssetPropStack')
    new CanopyCmsDistribution(stack, 'Dist', {
      ...distributionCommonProps(stack, service.functionUrl),
      assetSupport,
    })

    const dist = Object.values(
      Template.fromStack(stack).findResources('AWS::CloudFront::Distribution'),
    )[0]
    const patterns = (
      dist.Properties.DistributionConfig.CacheBehaviors as { PathPattern: string }[]
    ).map((b) => b.PathPattern)

    expect(patterns).toContain(ASSETS_TRANSFORM_PATH_PATTERN)
    expect(patterns).toContain(ASSETS_PATH_PATTERN)
    expect(patterns).toContain('/_next/static/*')
    // The whole point: the more specific transform pattern must precede the
    // broader static one, or CloudFront's first-match-wins ordering serves
    // every transform request off the S3-only behavior and never fails over
    // to the transform Lambda.
    expect(patterns.indexOf(ASSETS_TRANSFORM_PATH_PATTERN)).toBeLessThan(
      patterns.indexOf(ASSETS_PATH_PATTERN),
    )
  })

  it('throws at construction when a hand-written additionalBehaviors lists /assets/* before /assets/t/*', () => {
    const { stack, service } = buildServiceAndAssets('WrongOrderStack')
    const anyOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
    expect(
      () =>
        new CanopyCmsDistribution(stack, 'Dist', {
          ...distributionCommonProps(stack, service.functionUrl),
          additionalBehaviors: {
            // Wrong order: the broader pattern listed first swallows every
            // transform request before CloudFront ever reaches the more
            // specific one.
            [ASSETS_PATH_PATTERN]: { origin: anyOrigin },
            [ASSETS_TRANSFORM_PATH_PATTERN]: { origin: anyOrigin },
          },
        }),
    ).toThrow(/first-match-wins|permanent 403|matches path patterns in the order/i)
  })

  it('throws at construction when additionalBehaviors carries the literal assets/assetsTransform spread-mistake keys', () => {
    const { stack, service } = buildServiceAndAssets('SpreadMistakeStack')
    const anyOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
    expect(
      () =>
        new CanopyCmsDistribution(stack, 'Dist', {
          ...distributionCommonProps(stack, service.functionUrl),
          // The mistake this guards against: spreading assetBehaviors()'s
          // return value directly into additionalBehaviors instead of keying
          // it by path pattern.
          additionalBehaviors: {
            assets: { origin: anyOrigin },
            assetsTransform: { origin: anyOrigin },
          },
        }),
    ).toThrow(/literal key/i)
  })

  it('a slash-less caller key displaces the construct default rather than duplicating it', () => {
    // CloudFront treats a leading '/' as optional, so '_next/static/*' and
    // '/_next/static/*' are the same pattern. The collision filter compared raw
    // keys, so both were emitted -- which CloudFront rejects at deploy.
    const { stack, service } = buildServiceAndAssets('SlashlessCollisionStack')
    const anyOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
    new CanopyCmsDistribution(stack, 'Dist', {
      ...distributionCommonProps(stack, service.functionUrl),
      additionalBehaviors: { '_next/static/*': { origin: anyOrigin } },
    })
    const res = Object.values(
      Template.fromStack(stack).findResources('AWS::CloudFront::Distribution'),
    )[0]
    const patterns = (
      res.Properties.DistributionConfig.CacheBehaviors as Array<{ PathPattern: string }>
    ).map((b) => b.PathPattern)
    expect(patterns).toContain('_next/static/*')
    expect(patterns, 'the slashed default must not also be emitted').not.toContain(
      '/_next/static/*',
    )
  })

  it('refuses two caller keys that normalize to the same pattern', () => {
    const { stack, service } = buildServiceAndAssets('DuplicateSpellingStack')
    const anyOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
    expect(
      () =>
        new CanopyCmsDistribution(stack, 'Dist', {
          ...distributionCommonProps(stack, service.functionUrl),
          additionalBehaviors: {
            'api/*': { origin: anyOrigin },
            '/api/*': { origin: anyOrigin },
          },
        }),
    ).toThrow(/same path pattern/i)
  })

  it('does NOT throw when additionalBehaviors uses the correct manual order (negative control)', () => {
    // Guards against a vacuous guard: the two throwing tests above would
    // "pass" even if the check fired on every additionalBehaviors call, so
    // this pins that the hand-written-correct shape templates still show
    // (assetBehaviors().assetsTransform / .assets, transform first) is
    // accepted.
    const { stack, service } = buildServiceAndAssets('CorrectOrderStack')
    const anyOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
    expect(
      () =>
        new CanopyCmsDistribution(stack, 'Dist', {
          ...distributionCommonProps(stack, service.functionUrl),
          additionalBehaviors: {
            [ASSETS_TRANSFORM_PATH_PATTERN]: { origin: anyOrigin },
            [ASSETS_PATH_PATTERN]: { origin: anyOrigin },
          },
        }),
    ).not.toThrow()
  })

  it('throws when the assetSupport prop is combined with a hand-wired asset block', () => {
    // The migration mistake: an adopter who already hand-wired the behaviors
    // adopts the `assetSupport` prop without deleting the old block. Note the
    // hand-written order here is the CORRECT one, so the ordering check above
    // cannot catch this - and `attachTo` runs after the distribution is
    // constructed, so its addBehavior calls never reach mergeBehaviors.
    // Measured before this guard existed: CDK raised nothing and synthesized
    // CacheBehaviors ['/assets/t/*','/assets/*','/assets/t/*','/assets/*'],
    // leaving CloudFront to reject the duplicate patterns at deploy time.
    const { stack, service, assetSupport } = buildServiceAndAssets('DoubleWiredStack')
    const anyOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
    expect(
      () =>
        new CanopyCmsDistribution(stack, 'Dist', {
          ...distributionCommonProps(stack, service.functionUrl),
          assetSupport,
          additionalBehaviors: {
            [ASSETS_TRANSFORM_PATH_PATTERN]: { origin: anyOrigin },
            [ASSETS_PATH_PATTERN]: { origin: anyOrigin },
          },
        }),
    ).toThrow(/attached twice|duplicate path pattern/i)
  })

  it('catches the wrong order even when written without leading slashes', () => {
    // CloudFront treats a leading '/' on a path pattern as optional, and AWS's
    // own console and docs often show the slash-less spelling. Before the
    // guard normalized, `{ 'assets/*': ..., 'assets/t/*': ... }` synthesized
    // the broad-pattern-first order with no error at all -- the silent
    // permanent-403 this whole guard exists to refuse.
    const { stack, service } = buildServiceAndAssets('SlashlessWrongOrderStack')
    const anyOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
    expect(
      () =>
        new CanopyCmsDistribution(stack, 'Dist', {
          ...distributionCommonProps(stack, service.functionUrl),
          additionalBehaviors: {
            'assets/*': { origin: anyOrigin },
            'assets/t/*': { origin: anyOrigin },
          },
        }),
    ).toThrow(/first-match-wins|permanent 403|matches path patterns in the order/i)
  })

  it('catches a slash-less hand-wired block combined with the assetSupport prop', () => {
    const { stack, service, assetSupport } = buildServiceAndAssets('SlashlessDoubleWiredStack')
    const anyOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
    expect(
      () =>
        new CanopyCmsDistribution(stack, 'Dist', {
          ...distributionCommonProps(stack, service.functionUrl),
          assetSupport,
          additionalBehaviors: {
            'assets/*': { origin: anyOrigin },
          },
        }),
    ).toThrow(/attached twice|duplicate path pattern/i)
  })

  it('merges attachTo overrides into BOTH behaviors, keeping the order', () => {
    // Adopter request #41. A distribution running a viewer-request function on
    // every behavior (tier basic-auth) needs the asset behaviors to carry the
    // same functionAssociations, or /assets/* is anonymously readable on an
    // authenticated tier. Without an overrides parameter such an adopter had to
    // fall back to assetBehaviors() plus two hand-ordered addBehavior calls --
    // the shape attachTo exists to eliminate.
    const { stack, service, assetSupport } = buildServiceAndAssets('AttachOverridesStack')
    const fn = new cloudfront.Function(stack, 'ViewerFn', {
      code: cloudfront.FunctionCode.fromInline('function handler(e){return e.request}'),
    })
    const dist = new CanopyCmsDistribution(stack, 'Dist', {
      ...distributionCommonProps(stack, service.functionUrl),
    })
    assetSupport.attachTo(dist.distribution, {
      functionAssociations: [
        { function: fn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
      ],
    })

    const synthesized = Object.values(
      Template.fromStack(stack).findResources('AWS::CloudFront::Distribution'),
    )[0]
    const behaviors = synthesized.Properties.DistributionConfig.CacheBehaviors as Array<{
      PathPattern: string
      FunctionAssociations?: unknown[]
    }>
    const patterns = behaviors.map((b) => b.PathPattern)

    for (const pattern of [ASSETS_TRANSFORM_PATH_PATTERN, ASSETS_PATH_PATTERN]) {
      const behavior = behaviors.find((b) => b.PathPattern === pattern)
      expect(behavior, `${pattern} should be attached`).toBeDefined()
      expect(
        behavior?.FunctionAssociations,
        `${pattern} must carry the viewer-request function, or it is anonymously readable`,
      ).toHaveLength(1)
    }
    expect(patterns.indexOf(ASSETS_TRANSFORM_PATH_PATTERN)).toBeLessThan(
      patterns.indexOf(ASSETS_PATH_PATTERN),
    )
  })

  it('keeps the transform behavior on an origin group when overrides are passed', () => {
    // NOT a guard against an `origin` override: measured, that is a no-op,
    // because `addBehavior(pattern, origin, options)` takes the origin
    // POSITIONALLY and ignores an `origin` key in the options. An earlier
    // version of this test claimed to guard that and passed with the parameter
    // widened to `Partial<BehaviorOptions>` and an `origin` supplied -- i.e. it
    // was vacuous.
    //
    // What it pins instead is real and refactor-sensitive: the transform
    // behavior must still target an origin GROUP after overrides are merged,
    // since that group is the 403/404 failover to the transform Lambda. It
    // goes red if buildBehaviors ever stops using one.
    const { stack, service, assetSupport } = buildServiceAndAssets('AttachOriginGuardStack')
    const dist = new CanopyCmsDistribution(stack, 'Dist', {
      ...distributionCommonProps(stack, service.functionUrl),
    })
    assetSupport.attachTo(dist.distribution, { compress: false })

    const synthesized = Object.values(
      Template.fromStack(stack).findResources('AWS::CloudFront::Distribution'),
    )[0]
    const config = synthesized.Properties.DistributionConfig
    const transform = (
      config.CacheBehaviors as Array<{ PathPattern: string; TargetOriginId: string }>
    ).find((b) => b.PathPattern === ASSETS_TRANSFORM_PATH_PATTERN)
    expect(transform).toBeDefined()
    const groupIds = ((config.OriginGroups?.Items ?? []) as Array<{ Id: string }>).map((g) => g.Id)
    expect(groupIds, 'an origin group must still exist').not.toHaveLength(0)
    expect(groupIds).toContain(transform?.TargetOriginId)
  })

  it('ignores explicitly-undefined override keys rather than falling back to CDK defaults', () => {
    // A spread copies keys whose value is undefined, so `{ cachePolicy: undefined }`
    // used to DELETE the construct's choice and let CDK substitute its own --
    // a different default. Measured before the fix: the transform behavior's
    // custom policy (minTtl 0, which exists to stop the oversized-output
    // redirect loop) became managed CACHING_OPTIMIZED with its 1s min TTL, and
    // viewerProtocolPolicy went from redirect-to-https to allow-all on BOTH
    // behaviors, serving assets over plain HTTP. Not contrived: it is what
    // forwarding an unset optional prop produces.
    const bare = buildServiceAndAssets('OverrideUndefBareStack')
    const bareDist = new CanopyCmsDistribution(bare.stack, 'Dist', {
      ...distributionCommonProps(bare.stack, bare.service.functionUrl),
    })
    bare.assetSupport.attachTo(bareDist.distribution)

    const undef = buildServiceAndAssets('OverrideUndefStack')
    const undefDist = new CanopyCmsDistribution(undef.stack, 'Dist', {
      ...distributionCommonProps(undef.stack, undef.service.functionUrl),
    })
    undef.assetSupport.attachTo(undefDist.distribution, {
      cachePolicy: undefined,
      viewerProtocolPolicy: undefined,
    })

    const transformOf = (stack: Stack) => {
      const res = Object.values(
        Template.fromStack(stack).findResources('AWS::CloudFront::Distribution'),
      )[0]
      const behaviors = res.Properties.DistributionConfig.CacheBehaviors as Array<{
        PathPattern: string
        CachePolicyId: unknown
        ViewerProtocolPolicy: string
      }>
      const found = behaviors.find((b) => b.PathPattern === ASSETS_TRANSFORM_PATH_PATTERN)
      expect(found, 'transform behavior should be attached').toBeDefined()
      return found!
    }

    const baseline = transformOf(bare.stack)
    const withUndef = transformOf(undef.stack)
    expect(withUndef.CachePolicyId).toEqual(baseline.CachePolicyId)
    expect(withUndef.ViewerProtocolPolicy).toBe(baseline.ViewerProtocolPolicy)
    expect(withUndef.ViewerProtocolPolicy).toBe('redirect-to-https')
  })

  it('refuses two AssetSupport instances attaching to one distribution', () => {
    // The guard was per-instance, so this pair slipped through and synthesized
    // the same duplicate-path-pattern deploy failure the guard exists to catch.
    const { stack, service, assetSupport } = buildServiceAndAssets('TwoInstancesStack')
    const second = new AssetSupport(stack, 'Assets2', {
      editorOrigins: ['http://localhost:3000'],
      requireDeployableBundle: false,
    })
    const dist = new CanopyCmsDistribution(stack, 'Dist', {
      ...distributionCommonProps(stack, service.functionUrl),
    })
    assetSupport.attachTo(dist.distribution)
    expect(() => second.attachTo(dist.distribution)).toThrow(/already called/i)
  })

  it('forwards assetBehaviorOverrides from the prop to BOTH asset behaviors', () => {
    // The tier-auth adopter is the one who most needs attachTo's ordering
    // guarantee, and before this prop existed needing overrides sent them off
    // the guarded path entirely: the assetSupport prop could not pass them, so
    // the documented advice was to drop the prop and hand-call attachTo. This
    // pins that the guarded path now covers that case.
    const { stack, service, assetSupport } = buildServiceAndAssets('PropOverridesStack')
    const fn = new cloudfront.Function(stack, 'ViewerFn', {
      code: cloudfront.FunctionCode.fromInline('function handler(e){return e.request}'),
    })
    new CanopyCmsDistribution(stack, 'Dist', {
      ...distributionCommonProps(stack, service.functionUrl),
      assetSupport,
      assetBehaviorOverrides: {
        functionAssociations: [
          { function: fn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
    })

    const synthesized = Object.values(
      Template.fromStack(stack).findResources('AWS::CloudFront::Distribution'),
    )[0]
    const behaviors = synthesized.Properties.DistributionConfig.CacheBehaviors as Array<{
      PathPattern: string
      FunctionAssociations?: unknown[]
    }>
    const patterns = behaviors.map((b) => b.PathPattern)

    for (const pattern of [ASSETS_TRANSFORM_PATH_PATTERN, ASSETS_PATH_PATTERN]) {
      const behavior = behaviors.find((b) => b.PathPattern === pattern)
      expect(behavior, `${pattern} should be attached`).toBeDefined()
      expect(
        behavior?.FunctionAssociations,
        `${pattern} must carry the viewer-request function, or it is anonymously readable`,
      ).toHaveLength(1)
    }
    // The overrides must not cost the ordering guarantee the prop exists for.
    expect(patterns.indexOf(ASSETS_TRANSFORM_PATH_PATTERN)).toBeLessThan(
      patterns.indexOf(ASSETS_PATH_PATTERN),
    )
  })

  it('refuses assetBehaviorOverrides passed without assetSupport', () => {
    // Otherwise the overrides have nothing to merge into and vanish, taking a
    // tier-auth viewer function with them -- silently, at the one spot where
    // that means anonymously readable assets.
    const { stack, service } = buildServiceAndAssets('OverridesWithoutSupportStack')
    expect(
      () =>
        new CanopyCmsDistribution(stack, 'Dist', {
          ...distributionCommonProps(stack, service.functionUrl),
          assetBehaviorOverrides: { compress: false },
        }),
    ).toThrow(/without `assetSupport`/)
  })

  it('records attachment on the distribution itself, not in module state', () => {
    // The duplicate-attachment guard is keyed on the distribution, so the fact
    // lives on it as a child construct rather than in a module-level registry.
    // Asserting the marker (not just the error) is what makes the guard's state
    // inspectable, and pins that the scoping is the construct tree's.
    const { stack, service, assetSupport } = buildServiceAndAssets('AttachMarkerStack')
    const dist = new CanopyCmsDistribution(stack, 'Dist', {
      ...distributionCommonProps(stack, service.functionUrl),
    })
    const markerIds = () => dist.distribution.node.children.map((c) => c.node.id)

    expect(markerIds()).not.toContain('CanopyAssetBehaviorsAttached')
    assetSupport.attachTo(dist.distribution)
    expect(markerIds()).toContain('CanopyAssetBehaviorsAttached')

    // A distribution that was never attached to keeps its own state -- the
    // check cannot be a process-wide "has any distribution been attached to".
    const other = buildServiceAndAssets('AttachMarkerStack2')
    const untouched = new CanopyCmsDistribution(other.stack, 'Dist', {
      ...distributionCommonProps(other.stack, other.service.functionUrl),
    })
    expect(untouched.distribution.node.children.map((c) => c.node.id)).not.toContain(
      'CanopyAssetBehaviorsAttached',
    )
    // ...and can still be attached to, which a sticky module-level flag would
    // have to get right by luck of ordering.
    expect(() => other.assetSupport.attachTo(untouched.distribution)).not.toThrow()

    // The marker must stay inert. It is a bare Construct today, so it emits
    // nothing and shifts no logical id - but "the guard writes to the template"
    // is exactly the regression that would follow from someone later hanging a
    // CfnResource off it to carry data. Asserted rather than left to the comment.
    const marker = dist.distribution.node.findChild('CanopyAssetBehaviorsAttached')
    const emitted = marker.node.findAll().filter((c) => CfnElement.isCfnElement(c))
    expect(emitted, 'the attachment marker must not emit into the template').toEqual([])
  })

  it('refuses a second attachTo for the same distribution', () => {
    // The other door into the duplicate-attachment hazard: the prop calls
    // attachTo for you, so a caller who also calls it by hand attaches each
    // pattern twice -- and those calls bypass mergeBehaviors entirely, so the
    // synth guard above cannot see them.
    const { stack, service, assetSupport } = buildServiceAndAssets('DoubleAttachStack')
    const dist = new CanopyCmsDistribution(stack, 'Dist', {
      ...distributionCommonProps(stack, service.functionUrl),
      assetSupport,
    })
    expect(() => assetSupport.attachTo(dist.distribution)).toThrow(/already called/i)
  })

  it('does NOT throw when the assetSupport prop is combined with unrelated additionalBehaviors', () => {
    // Negative control for the check above: passing the prop must stay
    // compatible with a caller who has their own, non-asset behaviors.
    const { stack, service, assetSupport } = buildServiceAndAssets('PropPlusUnrelatedStack')
    const anyOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
    expect(
      () =>
        new CanopyCmsDistribution(stack, 'Dist', {
          ...distributionCommonProps(stack, service.functionUrl),
          assetSupport,
          additionalBehaviors: {
            '/api/*': { origin: anyOrigin },
          },
        }),
    ).not.toThrow()
  })
})

describe('CanopyCmsDistribution origin access control', () => {
  it('DEP-H2: CloudFront reaches the Function URL through an OAC that signs with SigV4', () => {
    const template = synth(true)
    template.hasResourceProperties(
      'AWS::CloudFront::OriginAccessControl',
      Match.objectLike({
        OriginAccessControlConfig: Match.objectLike({
          OriginAccessControlOriginType: 'lambda',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4',
        }),
      }),
    )
  })

  it('DEP-H2: only CloudFront may invoke the Function URL', () => {
    const template = synth(true)
    template.hasResourceProperties(
      'AWS::Lambda::Permission',
      Match.objectLike({
        Action: 'lambda:InvokeFunctionUrl',
        Principal: 'cloudfront.amazonaws.com',
      }),
    )
  })
})

describe('CanopyCmsDistribution B5/B9: cache policy cache-key hygiene', () => {
  it('B5a/B5b/B5c: no CachePolicy in the template allowlists Authorization/Host/Cookie as a header - the no-cache policy uses headerBehavior none(), with cookies/query strings carried by their own (non-header) config', () => {
    const template = synth(true)
    const policies = template.findResources('AWS::CloudFront::CachePolicy')
    const configs = Object.values(policies).map((policy) => policy.Properties.CachePolicyConfig)
    expect(configs.length).toBeGreaterThan(0)

    for (const config of configs) {
      const headersConfig = config.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig
      // headerBehavior must be 'none' everywhere - allowlisting Authorization
      // here is a deploy-time rejection when all TTLs are 0 (aws/aws-cdk#16977),
      // and allowlisting Host forwards the viewer Host header to the Lambda
      // Function URL origin, breaking its OAC signature.
      expect(headersConfig.HeaderBehavior).toBe('none')
      expect(headersConfig.Headers).toBeUndefined()
    }

    // Deploy-proven (deploy-test epic, 2026-07-23): CloudFront rejects ANY
    // non-none cache-key setting on a caching-disabled policy, so no custom
    // TTL-0 policy may exist at all - the default behavior must use the
    // managed CACHING_DISABLED policy instead.
    const ttlZeroPolicies = configs.filter((config) => config.MinTTL === 0 && config.MaxTTL === 0)
    expect(ttlZeroPolicies).toHaveLength(0)
  })

  it('the default behavior uses the managed CACHING_DISABLED cache policy', () => {
    const template = synth(true)
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            // Managed "CachingDisabled" cache policy id.
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
          }),
        }),
      }),
    )
  })

  it('the default behavior forwards the full viewer request to the origin via the ALL_VIEWER_EXCEPT_HOST_HEADER managed origin request policy', () => {
    const template = synth(true)
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            // Managed "AllViewerExceptHostHeader" origin request policy id.
            OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
          }),
        }),
      }),
    )
  })

  it("does not hardcode account-unique CachePolicy names (they'd collide across stacks) - lets CDK auto-generate them instead", () => {
    const template = synth(true)
    const policies = template.findResources('AWS::CloudFront::CachePolicy')
    const names = Object.values(policies).map((policy) => policy.Properties.CachePolicyConfig.Name)
    // The old hardcoded names this construct used to emit, given the 'Dist'
    // construct id used by this test's synth() helper.
    expect(names).not.toContain('Dist-no-cache')
    expect(names).not.toContain('Dist-static')
  })
})

describe('CanopyCmsDistribution: x-forwarded-host viewer-request function', () => {
  it('sets x-forwarded-host (and never the disallowed x-forwarded-proto) in a CloudFront Function', () => {
    const template = synth(true)
    const fns = template.findResources('AWS::CloudFront::Function')
    const codes = Object.values(fns).map(
      (fn) => (fn.Properties as { FunctionCode: string }).FunctionCode,
    )
    expect(codes.length).toBeGreaterThan(0)
    expect(codes.some((code) => code.includes('x-forwarded-host'))).toBe(true)
    // Deploy-proven: x-forwarded-proto is on CloudFront Functions' disallowed
    // header list - setting it 502s every request.
    for (const code of codes) {
      expect(code).not.toContain('x-forwarded-proto')
    }
  })

  it('associates the function as viewer-request on the default behavior', () => {
    const template = synth(true)
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            FunctionAssociations: Match.arrayWith([
              Match.objectLike({ EventType: 'viewer-request' }),
            ]),
          }),
        }),
      }),
    )
  })
})

describe('CanopyCmsService B1: the Lambda can actually reach S3', () => {
  it('adds an S3 gateway VPC endpoint (the PRIVATE_ISOLATED subnet has no NAT/IGW route to S3 otherwise)', () => {
    const template = synth()
    template.hasResourceProperties(
      'AWS::EC2::VPCEndpoint',
      Match.objectLike({
        ServiceName: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
        VpcEndpointType: 'Gateway',
      }),
    )
    // ServiceName is built from a region/service-name join - assert the
    // literal 's3' fragment is present rather than the whole Fn::Join shape.
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint')
    const serviceNames = Object.values(endpoints).map((e) =>
      JSON.stringify(e.Properties.ServiceName),
    )
    expect(serviceNames.some((s) => s.includes('.s3'))).toBe(true)
  })

  it('adds Lambda SG egress on 443 (for the S3 gateway endpoint)', () => {
    const template = synth()
    // A plain-CIDR egress rule (no reciprocal ingress rule on the peer) is
    // inlined by CDK directly onto the `AWS::EC2::SecurityGroup` resource
    // rather than synthesized as a standalone `AWS::EC2::SecurityGroupEgress`
    // - unlike the NFS rule above, which involves TWO security groups that
    // reference each other (Lambda egress -> EFS, EFS ingress <- Lambda) and
    // so CDK breaks that cycle by emitting a standalone resource instead.
    // Both shapes are functionally identical at the AWS API level.
    template.hasResourceProperties(
      'AWS::EC2::SecurityGroup',
      Match.objectLike({
        GroupDescription: 'CanopyCMS Lambda',
        SecurityGroupEgress: Match.arrayWith([
          Match.objectLike({
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            CidrIp: '0.0.0.0/0',
          }),
        ]),
      }),
    )
  })

  it('grants the CMS Lambda role prefix-scoped access to an optional assetBucket', () => {
    const app = newTestApp()
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    const assetBucket = new s3.Bucket(stack, 'AssetBucket')
    new CanopyCmsService(stack, 'Cms', {
      cmsDockerImage: lambda.DockerImageCode.fromEcr(
        ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
      ),
      githubOwner: 'acme',
      githubRepo: 'site',
      assetBucket,
    })
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

    for (const prefix of ['asset-staging/*', 'asset-originals/*', 'asset-meta/*', 'assets/*']) {
      expect(resourcePatterns).toContain(prefix)
    }
  })

  it('does not grant any asset bucket access when assetBucket is omitted', () => {
    const template = synth()
    const policies = template.findResources('AWS::IAM::Policy')
    const statements = Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as unknown[],
    )
    const resourcePatterns = statements
      .map((s) => (s as { Resource?: unknown }).Resource)
      .flat()
      .map((r) => JSON.stringify(r))
      .join('\n')

    expect(resourcePatterns).not.toContain('asset-originals/*')
  })
})

/**
 * A build context holding only a Dockerfile. Synth stages and fingerprints it
 * as an image asset but never runs `docker build`, so no Docker is needed.
 */
const DOCKER_IMAGE_ASSET_FIXTURE = path.join(
  __dirname,
  '..',
  '..',
  'test-support',
  'fixtures',
  'docker-image-asset',
)

/** `Architectures` of every image-backed Lambda in the template (undefined where unset). */
function imageFunctionArchitectures(template: Template): (string[] | undefined)[] {
  const fns = template.findResources('AWS::Lambda::Function', {
    Properties: Match.objectLike({ PackageType: 'Image' }),
  })
  return Object.values(fns).map(
    (fn) => (fn.Properties as { Architectures?: string[] }).Architectures,
  )
}

/**
 * Synthesizes the service around a real `fromImageAsset` image, which the
 * `fromEcr` image every other synth in this file uses cannot exercise: an ECR
 * image has no build, so nothing to give a platform.
 *
 * Returns the platform of every Docker image asset, read from the asset
 * manifest -- where CDK records the platform `cdk deploy` builds the image
 * for, and which the CloudFormation template never contains -- beside the
 * `Architectures` of every image-backed function in the template.
 */
function synthWithImageAsset(
  overrides: Partial<CanopyCmsServiceProps> = {},
  assetProps: lambda.AssetImageCodeProps = {},
): { dockerPlatforms: (string | undefined)[]; architectures: (string[] | undefined)[] } {
  const app = newTestApp()
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  })
  new CanopyCmsService(stack, 'Cms', {
    cmsDockerImage: lambda.DockerImageCode.fromImageAsset(DOCKER_IMAGE_ASSET_FIXTURE, assetProps),
    githubOwner: 'acme',
    githubRepo: 'site',
    ...overrides,
  })
  const assembly = app.synth()

  const dockerPlatforms = assembly.artifacts
    .filter(AssetManifestArtifact.isAssetManifestArtifact)
    .flatMap((artifact) =>
      Object.values(Manifest.loadAssetManifest(artifact.file).dockerImages ?? {}).map(
        (image) => image.source.platform,
      ),
    )
  return {
    dockerPlatforms,
    architectures: imageFunctionArchitectures(
      Template.fromJSON(assembly.getStackByName(stack.stackName).template),
    ),
  }
}

describe('CanopyCmsService: Lambda architecture and image platform', () => {
  it('defaults to arm64 when architecture is omitted', () => {
    expect(imageFunctionArchitectures(synth())).toEqual([['arm64']])
  })

  it('passes an explicit Architecture.X86_64 through', () => {
    const template = synth(false, { architecture: lambda.Architecture.X86_64 })
    expect(imageFunctionArchitectures(template)).toEqual([['x86_64']])
  })

  // The platform half. CDK sets a `fromImageAsset` image's build platform from
  // the architecture the function binds it with, and records it in the asset
  // manifest. The arm64 test fails if the construct ever passes `architecture`
  // through unresolved again: with none bound, CDK records no platform at all and
  // Docker builds for whatever machine runs `cdk deploy`. The amd64 test pins that
  // an explicit architecture still reaches the platform.
  it('builds a fromImageAsset image for linux/arm64 when architecture is omitted', () => {
    expect(synthWithImageAsset()).toEqual({
      dockerPlatforms: ['linux/arm64'],
      architectures: [['arm64']],
    })
  })

  it('builds a fromImageAsset image for linux/amd64 when architecture is X86_64', () => {
    expect(synthWithImageAsset({ architecture: lambda.Architecture.X86_64 })).toEqual({
      dockerPlatforms: ['linux/amd64'],
      architectures: [['x86_64']],
    })
  })

  // Pins the warning in `architecture`'s doc comment, which is why the
  // scaffold and docs say to omit `platform`: an explicit one beats the derived
  // value, leaving an image and a function that disagree. If a CDK upgrade
  // changes that precedence, this fails and that guidance needs revisiting.
  it('lets an explicit fromImageAsset platform override the derived one', () => {
    expect(synthWithImageAsset({}, { platform: ecrAssets.Platform.LINUX_AMD64 })).toEqual({
      dockerPlatforms: ['linux/amd64'],
      architectures: [['arm64']],
    })
  })
})

describe('CanopyCmsService B1: Lambda and worker resolve the same EFS directory', () => {
  it('sets the Lambda workspace root and auth cache path under the access-point-relative /mnt/efs', () => {
    const template = synth()
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            CANOPYCMS_WORKSPACE_ROOT: '/mnt/efs',
            CANOPY_AUTH_CACHE_PATH: '/mnt/efs/.cache',
          }),
        }),
      }),
    )
  })

  it('lambda workspace root and worker workspace path resolve to the same EFS directory', () => {
    const template = synth()
    // Lambda mounts EFS through the WorkspaceAP access point, which is
    // already rooted at EFS:/workspace - so the Lambda's /mnt/efs IS
    // EFS:/workspace.
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({ CANOPYCMS_WORKSPACE_ROOT: '/mnt/efs' }),
        }),
      }),
    )
    // The worker instead mounts the filesystem ROOT at /mnt/efs and reaches
    // the same EFS:/workspace directory via /mnt/efs/workspace - assert its
    // UserData actually references that mount-root + workspace path.
    expect(workerUserDataBlobs(template)).toContain('/mnt/efs/workspace')
    // Guard the other half of the split: the access point itself must be
    // rooted at /workspace, or drift there (e.g. to /other) would silently
    // desync from the Lambda/worker paths asserted above while still passing.
    template.hasResourceProperties(
      'AWS::EFS::AccessPoint',
      Match.objectLike({
        RootDirectory: Match.objectLike({ Path: '/workspace' }),
      }),
    )
  })
})

describe('CanopyCmsService B7: git dubious-ownership workaround', () => {
  it('does NOT rely on GIT_CONFIG_* env (simple-git hard-blocks env config; the fix is the image system gitconfig)', () => {
    const template = synth()
    const fns = template.findResources('AWS::Lambda::Function')
    type LambdaProps = { Environment?: { Variables?: Record<string, unknown> } }
    const cms = Object.values(fns).find(
      (fn) =>
        (fn.Properties as LambdaProps).Environment?.Variables?.CANOPYCMS_WORKSPACE_ROOT ===
        '/mnt/efs',
    )
    expect(cms).toBeDefined()
    const cmsProps = cms?.Properties as LambdaProps
    // Deploy-proven 2026-07-24: these were dead config - simple-git refuses
    // to pass env-based git config to spawned processes. safe.directory is
    // set via `git config --system` in Dockerfile.cms.template instead.
    expect(cmsProps.Environment?.Variables?.GIT_CONFIG_COUNT).toBeUndefined()
    expect(cmsProps.Environment?.Variables?.GIT_CONFIG_KEY_0).toBeUndefined()
  })
})

describe('CanopyCmsService B8: worker region resolution', () => {
  it('writes an AWS_REGION line into the worker UserData env file', () => {
    const template = synth()
    expect(/AWS_REGION=/.test(workerUserDataBlobs(template))).toBe(true)
  })
})

describe('CanopyCmsService: worker SSM observability', () => {
  it('grants the worker role AmazonSSMManagedInstanceCore', () => {
    const template = synth()
    const roles = template.findResources('AWS::IAM::Role', {
      Properties: Match.objectLike({ Description: 'CanopyCMS EC2 Worker role' }),
    })
    const managedPolicyArns = Object.values(roles).flatMap(
      (role) => (role.Properties as { ManagedPolicyArns?: unknown[] }).ManagedPolicyArns ?? [],
    )
    const serialized = managedPolicyArns.map((arn) => JSON.stringify(arn)).join('\n')
    expect(serialized).toContain('AmazonSSMManagedInstanceCore')
  })
})

describe('CanopyCmsService: boot ordering vs EFS mount targets', () => {
  it('makes the worker ASG depend on the EFS mount targets being available', () => {
    const template = synth()
    const mountTargetIds = Object.keys(template.findResources('AWS::EFS::MountTarget'))
    expect(mountTargetIds.length).toBeGreaterThan(0)

    const asgs = template.findResources('AWS::AutoScaling::AutoScalingGroup')
    const asgEntries = Object.values(asgs)
    expect(asgEntries).toHaveLength(1)

    const dependsOnRaw = (asgEntries[0] as { DependsOn?: string | string[] }).DependsOn
    const dependsOn = Array.isArray(dependsOnRaw)
      ? dependsOnRaw
      : dependsOnRaw
        ? [dependsOnRaw]
        : []

    for (const mountTargetId of mountTargetIds) {
      expect(dependsOn).toContain(mountTargetId)
    }
  })
})

describe('CanopyCmsService: EFS mount survives instance reboots', () => {
  it('writes an fstab entry and gates the worker unit on the mount', () => {
    const template = synth()
    const all = workerUserDataBlobs(template)
    expect(all).toContain('>> /etc/fstab')
    expect(all).toContain('RequiresMountsFor=/mnt/efs')
  })
})

describe('CanopyCmsService worker UserData: ESM bundle bootstrapping', () => {
  it('installs unzip and writes a type:module package.json next to the ESM worker bundle', () => {
    const template = synth()
    const all = workerUserDataBlobs(template)
    expect(all).toContain('dnf install -y git unzip')
    expect(all).toContain('{\\"type\\":\\"module\\"}')
  })
})

describe('CanopyCmsService: worker boot cannot fail silently', () => {
  it('installs Node from AL2023 rather than piping a third-party installer into bash', () => {
    const all = workerUserDataBlobs(synth())
    // `curl https://rpm.nodesource.com/... | bash -` under `set -e` made every
    // instance replacement -- which the ASG performs on every `cdk deploy` --
    // depend on a third party being reachable.
    expect(all).not.toContain('rpm.nodesource.com')
    expect(all).toContain('dnf install -y nodejs22')
  })

  it('runs the worker from the version-pinned node binary, not the alternatives symlink', () => {
    const all = workerUserDataBlobs(synth())
    // AL2023 installs /usr/bin/node-22 and points /usr/bin/node at some
    // installed version via `alternatives`, whose selection AWS documents as
    // able to change at any time.
    expect(all).toContain('ExecStart=/usr/bin/node-22 index.js')
    expect(all).not.toContain('ExecStart=/usr/bin/node index.js')
  })

  it('shuts the instance down when user-data fails, so the ASG replaces it', () => {
    const all = workerUserDataBlobs(synth())
    // Without this, a failed boot script left an instance that runs, passes the
    // EC2-only health check forever, and does nothing -- while `cdk deploy`
    // reported success.
    expect(all).toContain('trap ')
    expect(all).toContain('shutdown -h now')
    expect(all).toContain('ERR')
  })

  it('disarms the fail-fast trap before the best-effort CloudWatch section', () => {
    // The trap must cover everything the worker needs to EXIST, and nothing
    // after that. Left armed, a package-mirror outage during the agent install
    // would shut down an already-healthy worker, and the ASG would relaunch
    // straight into the same outage -- turning degraded log shipping into a
    // replacement loop. That silently revokes the "shipping is best-effort"
    // invariant this section has always documented, while the ordering test
    // below still passed.
    const all = workerUserDataBlobs(synth())
    const trapIdx = all.indexOf('trap ')
    const disarmIdx = all.indexOf('trap - ERR')
    const workerStartIdx = all.indexOf('systemctl start canopy-worker')
    const agentIdx = all.indexOf('dnf install -y amazon-cloudwatch-agent')

    expect(trapIdx).toBeGreaterThanOrEqual(0)
    // Asserted explicitly: without it, a reworded start command would make
    // indexOf return -1 and the `disarmIdx > workerStartIdx` check below pass
    // vacuously.
    expect(workerStartIdx).toBeGreaterThanOrEqual(0)
    expect(agentIdx).toBeGreaterThanOrEqual(0)
    expect(disarmIdx).toBeGreaterThan(trapIdx)
    // Disarmed only AFTER the worker is running, and BEFORE the agent install.
    expect(disarmIdx).toBeGreaterThan(workerStartIdx)
    expect(disarmIdx).toBeLessThan(agentIdx)
  })

  it('retries the network-dependent boot steps', () => {
    const all = workerUserDataBlobs(synth())
    expect(all).toContain('retry()')
    for (const step of [
      'retry dnf install -y git unzip',
      'retry dnf install -y nodejs22',
      'retry dnf install -y amazon-efs-utils',
      'retry aws s3 cp',
      'retry dnf install -y amazon-cloudwatch-agent',
    ]) {
      expect(all).toContain(step)
    }
  })
})

describe('CanopyCmsService: secret ARN props feed the IAM policy', () => {
  /** Resources on every GetSecretValue statement in the template. */
  function secretResources(template: Template): string[] {
    const policies = template.findResources('AWS::IAM::Policy')
    return Object.values(policies).flatMap((p) =>
      (p.Properties.PolicyDocument.Statement as { Action?: unknown; Resource?: unknown }[])
        .filter((s) => JSON.stringify(s.Action).includes('secretsmanager:GetSecretValue'))
        .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]))
        .filter((r): r is string => typeof r === 'string'),
    )
  }

  const GITHUB_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:gh-AbCdEf'
  const CLERK_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:clerk-AbCdEf'

  it('grants the individual ARN props even when secretsArns is omitted', () => {
    // The construct carried two disconnected representations of "the secrets
    // the worker reads": secretsArns fed IAM, the individual props fed only the
    // worker's .env. Setting the latter alone deployed clean and produced a
    // worker that knew WHICH secret to read and had no permission to read it --
    // AccessDenied, exit, systemd restart-loop every 5s, forever.
    const template = synthUncached(false, {
      githubTokenSecretArn: GITHUB_ARN,
      clerkSecretKeySecretArn: CLERK_ARN,
    })
    expect(secretResources(template)).toEqual(expect.arrayContaining([GITHUB_ARN, CLERK_ARN]))
  })

  it('does not list an ARN twice when it is passed both ways', () => {
    const template = synthUncached(false, {
      secretsArns: [GITHUB_ARN],
      githubTokenSecretArn: GITHUB_ARN,
    })
    const occurrences = secretResources(template).filter((r) => r === GITHUB_ARN)
    expect(occurrences).toHaveLength(1)
  })

  it('still grants extra ARNs that only secretsArns names', () => {
    const other = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:other-AbCdEf'
    const template = synthUncached(false, {
      secretsArns: [other],
      githubTokenSecretArn: GITHUB_ARN,
    })
    expect(secretResources(template)).toEqual(expect.arrayContaining([other, GITHUB_ARN]))
  })

  it('grants the GitHub App private-key ARN', () => {
    // The App private key is read by the same getSecret call path, from the
    // same instance profile, as the token it replaces -- so leaving it out of
    // the union reproduces the AccessDenied restart-loop above exactly, on the
    // credential path an adopter reaches for BECAUSE the token was not good
    // enough. No githubTokenSecretArn here: the two are mutually exclusive.
    const template = synthUncached(false, {
      ...APP_PROPS,
      clerkSecretKeySecretArn: CLERK_ARN,
    })
    expect(secretResources(template)).toEqual(expect.arrayContaining([APP_KEY_ARN, CLERK_ARN]))
  })

  it('grants the App private-key ARN exactly once when it is passed in secretsArns too', () => {
    // Pins that the ARN is granted by ONE statement, not also by a second,
    // separate `addToPolicy` -- the realistic regression, since the union above
    // is assembled from prop families that were once granted separately.
    //
    // aws-cdk-lib 2.265 hides that regression twice over, so the setup matters:
    // - `PolicyStatement` collapses a repeated `resources` entry itself, so this
    //   does NOT pin the construct's own `new Set`
    //   (.claude/future-tasks/iam-dedupe-tests-pass-vacuously.md).
    // - `PolicyDocument` also drops a statement that renders byte-identical to
    //   another. With `secretsArns: [APP_KEY_ARN]` alone, a stray single-ARN grant
    //   rendered exactly like the union and was collapsed away, so this test
    //   stayed green with that bug reintroduced.
    // `other` defeats the second: the union now lists two ARNs, a stray grant of
    // one renders as a distinct statement, and `secretResources` -- which reads
    // across every statement -- sees the ARN twice.
    const other = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:other-AbCdEf'
    const template = synthUncached(false, {
      ...APP_PROPS,
      secretsArns: [APP_KEY_ARN, other],
    })
    const occurrences = secretResources(template).filter((r) => r === APP_KEY_ARN)
    expect(occurrences).toHaveLength(1)
  })

  it('a JSON-field prop leaves the policy byte-identical -- a field is not a grantable resource', () => {
    // GetSecretValue returns the WHOLE secret value and the worker picks the
    // field out of it in getSecret, so the grant that already exists for the
    // ARN covers the field too. Asserted rather than assumed because the
    // deduped union above exists precisely because someone once assumed the
    // opposite about these two prop families -- and the cheap wrong fix here
    // is to append the field to the ARN in the policy Resource, which produces
    // a resource that matches nothing.
    const base: Partial<CanopyCmsServiceProps> = {
      githubTokenSecretArn: GITHUB_ARN,
      clerkSecretKeySecretArn: CLERK_ARN,
    }
    const withoutField = secretResources(synthUncached(false, base))
    const withField = secretResources(
      synthUncached(false, {
        ...base,
        githubTokenSecretJsonField: 'CANOPYCMS_GITHUB_TOKEN',
        clerkSecretKeySecretJsonField: 'CLERK_SECRET_KEY',
      }),
    )
    // Positive anchor: `toEqual` between two empty arrays would pass happily.
    expect(withoutField).toEqual(expect.arrayContaining([GITHUB_ARN, CLERK_ARN]))
    expect(withField).toEqual(withoutField)
  })
})

/**
 * `githubTokenSecretJsonField` / `clerkSecretKeySecretJsonField` ->
 * `CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD` / `CLERK_SECRET_KEY_SECRET_JSON_FIELD`
 * in the worker's `.env`.
 *
 * That `.env` is the ONLY way `getSecret`'s `jsonField` option can be reached on
 * a deployed worker: user-data rewrites /opt/canopy-worker/.env on every
 * instance launch and `cdk deploy` rolls the ASG, so a hand-edited value does
 * not survive. Until these props existed, the worker warned an adopter with a
 * JSON secret to set a variable that nothing could set.
 */
describe('CanopyCmsService: secret JSON-field props -> worker .env', () => {
  const GITHUB_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:gh-AbCdEf'
  const CLERK_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:clerk-AbCdEf'
  const BOTH_ARNS: Partial<CanopyCmsServiceProps> = {
    githubTokenSecretArn: GITHUB_ARN,
    clerkSecretKeySecretArn: CLERK_ARN,
  }
  // Deliberately NOT the real key names an adopter would use
  // ('CANOPYCMS_GITHUB_TOKEN', 'CLERK_SECRET_KEY'): each of those is a prefix
  // of an env-var name stamped into the same .env, so an implementation that
  // wrote a variable's own NAME as its value would pass every assertion here.
  const GITHUB_FIELD = 'ghFieldProbe'
  const CLERK_FIELD = 'clerkFieldProbe'

  it('stamps both JSON-field vars when the props are set', () => {
    const all = workerUserDataBlobs(
      synthUncached(false, {
        ...BOTH_ARNS,
        githubTokenSecretJsonField: GITHUB_FIELD,
        clerkSecretKeySecretJsonField: CLERK_FIELD,
      }),
    )
    expect(all).toContain(`CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD=${GITHUB_FIELD}`)
    expect(all).toContain(`CLERK_SECRET_KEY_SECRET_JSON_FIELD=${CLERK_FIELD}`)
  })

  it('stamps neither JSON-field var when the props are omitted', () => {
    const all = workerUserDataBlobs(synthUncached(false, BOTH_ARNS))
    // Positive anchors FIRST. The two `not.toContain`s below are the assertions
    // that matter -- an absent var and an empty one are not the same to
    // getSecret, which takes the whole-value path only when the var is unset --
    // but on their own they pass just as happily against a blob that lost its
    // .env entirely, or against a renamed resource type.
    expect(all).toContain(`CANOPYCMS_GITHUB_TOKEN_SECRET_ARN=${GITHUB_ARN}`)
    expect(all).toContain(`CLERK_SECRET_KEY_SECRET_ARN=${CLERK_ARN}`)
    expect(all).not.toContain('CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD')
    expect(all).not.toContain('CLERK_SECRET_KEY_SECRET_JSON_FIELD')
  })

  it('stamps one without the other', () => {
    const all = workerUserDataBlobs(
      synthUncached(false, { ...BOTH_ARNS, clerkSecretKeySecretJsonField: CLERK_FIELD }),
    )
    expect(all).toContain(`CLERK_SECRET_KEY_SECRET_JSON_FIELD=${CLERK_FIELD}`)
    expect(all).not.toContain('CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD')
  })

  describe('a JSON field without its secret ARN is refused at synth', () => {
    // Stamping the field with no ARN reads the credential from nowhere, and
    // both halves fail mutely: Clerk leaves refreshAuthCache undefined, which
    // disables auth-cache refresh with no log line at all, and GitHub reports
    // "CANOPYCMS_GITHUB_TOKEN or ..._SECRET_ARN is required" against a stack
    // that visibly configures a GitHub secret.
    it('githubTokenSecretJsonField without githubTokenSecretArn', () => {
      expect(() =>
        synthUncached(false, { githubTokenSecretJsonField: 'CANOPYCMS_GITHUB_TOKEN' }),
      ).toThrow(/githubTokenSecretJsonField is set but githubTokenSecretArn is not/)
    })

    it('clerkSecretKeySecretJsonField without clerkSecretKeySecretArn', () => {
      expect(() =>
        synthUncached(false, { clerkSecretKeySecretJsonField: 'CLERK_SECRET_KEY' }),
      ).toThrow(/clerkSecretKeySecretJsonField is set but clerkSecretKeySecretArn is not/)
    })

    it('names the missing prop, so the message says what to add', () => {
      expect(() =>
        synthUncached(false, { githubTokenSecretJsonField: 'CANOPYCMS_GITHUB_TOKEN' }),
      ).toThrow(/Set githubTokenSecretArn, or drop githubTokenSecretJsonField/)
    })
  })

  describe('an empty JSON field is refused at synth', () => {
    // The worker reads a blank value as "no field configured" (`|| undefined`
    // at both call sites in worker/index.ts), so stamping it would discard an
    // explicitly set prop silently. assertEnvSafe catches none of these: an
    // empty string has no newline, no leading quote, no ENVEOF and no
    // backslash, and it equals its own `.trim()`, so even the whitespace rule
    // added for the cases below passes it through.
    it('githubTokenSecretJsonField', () => {
      expect(() => synthUncached(false, { ...BOTH_ARNS, githubTokenSecretJsonField: '' })).toThrow(
        /githubTokenSecretJsonField must name a key/,
      )
    })

    it('clerkSecretKeySecretJsonField', () => {
      expect(() =>
        synthUncached(false, { ...BOTH_ARNS, clerkSecretKeySecretJsonField: '' }),
      ).toThrow(/clerkSecretKeySecretJsonField must name a key/)
    })

    // systemd strips surrounding whitespace from an EnvironmentFile value, so
    // ' ' arrives at the worker as '' and takes the same silently-ignored path
    // -- the empty case again, by a route a bare `=== ''` check cannot see.
    for (const value of [' ', '\t', '  ']) {
      it(`whitespace-only ${JSON.stringify(value)} is refused like an empty one`, () => {
        expect(() =>
          synthUncached(false, { ...BOTH_ARNS, githubTokenSecretJsonField: value }),
        ).toThrow(/githubTokenSecretJsonField must name a key/)
      })
    }
  })

  describe("a secret ARN carrying the ECS ':KEY::' suffix is refused at synth", () => {
    // The suffix is a CloudFormation-dynamic-reference / ECS `valueFrom`
    // convention. GetSecretValue does not parse it, and the string lands
    // verbatim in the worker's IAM Resource where it matches nothing --
    // AccessDenied at boot, then systemd's Restart=always every 5s forever.
    const SUFFIXED_GITHUB = `${GITHUB_ARN}:CANOPYCMS_GITHUB_TOKEN::`
    const SUFFIXED_CLERK = `${CLERK_ARN}:CLERK_SECRET_KEY::`

    it('githubTokenSecretArn', () => {
      expect(() => synthUncached(false, { githubTokenSecretArn: SUFFIXED_GITHUB })).toThrow(
        /githubTokenSecretArn .* carries a ':KEY::' JSON-field suffix/,
      )
    })

    it('clerkSecretKeySecretArn', () => {
      expect(() => synthUncached(false, { clerkSecretKeySecretArn: SUFFIXED_CLERK })).toThrow(
        /clerkSecretKeySecretArn .* carries a ':KEY::' JSON-field suffix/,
      )
    })

    it('secretsArns, which has no JSON-field prop but the same IAM failure', () => {
      expect(() => synthUncached(false, { secretsArns: [GITHUB_ARN, SUFFIXED_CLERK] })).toThrow(
        /secretsArns\[1\] .* carries a ':KEY::' JSON-field suffix/,
      )
    })

    it('a suffix built on a NAME-ONLY ARN, which is the form ECS documentation shows', () => {
      // The first version of this guard anchored on the six random characters
      // AWS appends, so an ARN without them carried the suffix straight through
      // to the IAM policy -- the failure the guard exists to prevent.
      //
      // Fully-specified version parts, deliberately: the far commoner
      // `…:MY_KEY::` spelling ends in two colons, so the empty-version-tail
      // check below would catch it whatever the regex did, and this case would
      // pass without proving anything about the regex at all.
      expect(() =>
        synthUncached(false, {
          githubTokenSecretArn:
            'arn:aws:secretsmanager:us-east-1:123456789012:secret:gh:CANOPYCMS_GITHUB_TOKEN:AWSCURRENT:v1',
        }),
      ).toThrow(/carries a ':KEY::' JSON-field suffix/)
    })

    it('the same name-only ARN with empty version parts', () => {
      expect(() =>
        synthUncached(false, {
          githubTokenSecretArn:
            'arn:aws:secretsmanager:us-east-1:123456789012:secret:gh:CANOPYCMS_GITHUB_TOKEN::',
        }),
      ).toThrow(/carries a ':KEY::' JSON-field suffix/)
    })

    it('a suffix appended to an unresolved CDK token', () => {
      // `${secret.secretArn}:KEY::` has no ':secret:' to anchor on at synth,
      // because the ARN is still a token. The empty version tail is all that is
      // left to recognise, and no well-formed ARN ends in two colons.
      expect(() =>
        synthUncached(false, {
          githubTokenSecretArn: '${Token[TOKEN.42]}:CANOPYCMS_GITHUB_TOKEN::',
        }),
      ).toThrow(/carries a ':KEY::' JSON-field suffix/)
    })

    it('a secretsArns entry that is not a string names the prop rather than raising a TypeError', () => {
      // `secretsArns: [process.env.EXTRA_SECRET_ARN!]` with the variable unset,
      // which is the idiom a CDK app that reads its config from the environment
      // reaches for -- the scaffolded bin/app.ts does exactly that everywhere
      // else. Before the suffix guard the entry was dropped from the IAM policy
      // in silence and the worker got AccessDenied at boot; adding the guard
      // turned that into an anonymous "Cannot read properties of undefined".
      // Neither names the prop, which is the whole job of a synth-time error.
      expect(() => synthUncached(false, { secretsArns: [undefined as unknown as string] })).toThrow(
        /secretsArns\[0\] must be a non-empty secret ARN string/,
      )
    })

    it('points the adopter at the supported prop instead of just refusing', () => {
      expect(() => synthUncached(false, { githubTokenSecretArn: SUFFIXED_GITHUB })).toThrow(
        /name the key with githubTokenSecretJsonField instead/,
      )
    })
  })

  describe('plain complete ARNs are still accepted', () => {
    // The guard above keys on a colon AFTER the six-character suffix. These
    // pin that it cannot swallow ordinary ARNs -- a secret name may contain
    // hyphens, and may itself end in something that looks like a suffix.
    for (const arn of [
      GITHUB_ARN,
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-with-dashes-AbCdEf',
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:prod-Ab12Cd-Ef34Gh',
      // A name-based (incomplete) ARN. Wrong for a different reason -- the IAM
      // Resource never matches -- but not this guard's business, and the
      // scaffolded stack's fromSecretCompleteArn already rejects it.
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:gh',
    ]) {
      it(`accepts ${arn}`, () => {
        expect(() =>
          synthUncached(false, {
            githubTokenSecretArn: arn,
            githubTokenSecretJsonField: 'CANOPYCMS_GITHUB_TOKEN',
          }),
        ).not.toThrow()
      })
    }
  })
})

/**
 * The `githubApp*` props -> the worker's `.env` (adopter request #45).
 *
 * That `.env` is the only way the worker entrypoint can be told to authenticate
 * as a GitHub App at all: user-data rewrites /opt/canopy-worker/.env on every
 * instance launch and `cdk deploy` rolls the ASG, so a hand-edited value does
 * not survive. `worker/index.ts` reads exactly these four names.
 */
describe('CanopyCmsService: githubApp* props -> worker .env', () => {
  const GITHUB_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:gh-AbCdEf'
  // Not the name of any env var stamped into the same .env -- an
  // implementation that wrote a variable's own NAME as its value would
  // otherwise pass.
  const APP_KEY_FIELD = 'appKeyFieldProbe'

  it('stamps all three App vars when the props are set', () => {
    const all = workerUserDataBlobs(synthUncached(false, APP_PROPS))
    expect(all).toContain('CANOPYCMS_GITHUB_APP_ID=123456')
    expect(all).toContain('CANOPYCMS_GITHUB_APP_INSTALLATION_ID=78901234')
    expect(all).toContain(`CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN=${APP_KEY_ARN}`)
  })

  it('stamps none of them on a token-authenticated deployment', () => {
    const all = workerUserDataBlobs(synthUncached(false, { githubTokenSecretArn: GITHUB_ARN }))
    // Positive anchor FIRST: every assertion below is an absence, and all four
    // pass just as happily against a blob that lost its .env entirely or whose
    // resource type was renamed.
    expect(all).toContain(`CANOPYCMS_GITHUB_TOKEN_SECRET_ARN=${GITHUB_ARN}`)
    expect(all).not.toContain('CANOPYCMS_GITHUB_APP_ID')
    expect(all).not.toContain('CANOPYCMS_GITHUB_APP_INSTALLATION_ID')
    expect(all).not.toContain('CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN')
    expect(all).not.toContain('CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD')
  })

  it('stamps the App private key JSON field when that prop is set', () => {
    const all = workerUserDataBlobs(
      synthUncached(false, { ...APP_PROPS, githubAppPrivateKeySecretJsonField: APP_KEY_FIELD }),
    )
    expect(all).toContain(`CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD=${APP_KEY_FIELD}`)
  })

  it('omits the JSON-field var when only the App trio is set', () => {
    const all = workerUserDataBlobs(synthUncached(false, APP_PROPS))
    // An absent var and an empty one are not the same to getSecret: it takes
    // the whole-value path only when the var is unset, so stamping an empty one
    // would send a PEM-bearing secret down the JSON-field path with the field
    // name ''.
    expect(all).toContain(`CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN=${APP_KEY_ARN}`)
    expect(all).not.toContain('CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD')
  })

  it('does not stamp a GitHub token var on an App-authenticated deployment', () => {
    const all = workerUserDataBlobs(synthUncached(false, APP_PROPS))
    expect(all).toContain('CANOPYCMS_GITHUB_APP_ID=123456')
    expect(all).not.toContain('CANOPYCMS_GITHUB_TOKEN_SECRET_ARN')
  })

  describe('the three App props are all-or-nothing at synth', () => {
    // Two of three is not a partial configuration that could still work: an
    // installation token is minted from all three together. Refused at synth
    // rather than at boot, where systemd's Restart=always turns it into a
    // 5-second restart loop that `cdk deploy` reports as success.
    const NAMES = [
      'githubAppId',
      'githubAppInstallationId',
      'githubAppPrivateKeySecretArn',
    ] as const

    for (const only of NAMES) {
      it(`${only} alone throws, naming the two that are missing`, () => {
        const missing = NAMES.filter((n) => n !== only)
        expect(() => synthUncached(false, { [only]: APP_PROPS[only] })).toThrow(
          // A substring match, not a RegExp built from a non-literal (the names
          // come from the fixed tuple above, but a dynamic RegExp still trips
          // eslint-plugin-security's detect-non-literal-regexp).
          `${missing[0]} and ${missing[1]} are not set`,
        )
      })
    }

    for (const omitted of NAMES) {
      it(`the other two without ${omitted} throw, naming it`, () => {
        const partial: Partial<CanopyCmsServiceProps> = { ...APP_PROPS }
        delete partial[omitted]
        expect(() => synthUncached(false, partial)).toThrow(`${omitted} is not set`)
      })
    }

    it('all three together synthesize', () => {
      expect(() => synthUncached(false, APP_PROPS)).not.toThrow()
    })
  })

  describe('an App and a static token together are refused at synth', () => {
    // EXACTLY one, which is the rule core enforces too
    // (resolveWorkerGitHubAuth, packages/canopycms/src/worker/github-auth.ts):
    // neither is an error AND both is an error. Both is rejected rather than
    // resolved by precedence, because it would otherwise be undefined which
    // identity a push or a pull request acts as -- and a PR opened by the wrong
    // identity is not something an adopter notices quickly.
    it('throws', () => {
      expect(() =>
        synthUncached(false, { ...APP_PROPS, githubTokenSecretArn: GITHUB_ARN }),
      ).toThrow(/configure either the githubToken\* props or the githubApp\* props, not both/)
    })

    it('says which one to drop, rather than only refusing', () => {
      expect(() =>
        synthUncached(false, { ...APP_PROPS, githubTokenSecretArn: GITHUB_ARN }),
      ).toThrow(/drop githubTokenSecretArn/)
    })

    it('the token alone still synthesizes -- it is the default path, not deprecated', () => {
      expect(() => synthUncached(false, { githubTokenSecretArn: GITHUB_ARN })).not.toThrow()
    })

    it('neither is NOT a synth error', () => {
      // The worker can also be handed CANOPYCMS_GITHUB_TOKEN directly, outside
      // this construct, and core refuses the genuinely empty case at boot
      // naming both options. Pinned because an earlier statement of this rule
      // said "configuring neither is the only error", which is the opposite of
      // what ships: exactly one, so neither AND both are errors.
      expect(() => synthUncached(false, {})).not.toThrow()
    })
  })

  describe('the App identifiers must be numeric', () => {
    // The two wrong values are on the same settings page as the right one: the
    // app's slug, and its 'Iv1.…' OAuth client id. They fail DIFFERENTLY at
    // boot and both are worse than failing here -- `createAppAuth` names a bad
    // appId, but checks installationId only for falsiness, so a non-numeric one
    // is interpolated into /app/installations/NaN/access_tokens and returns a
    // 404 that reads as "the app is not installed".
    for (const bad of ['my-app-slug', 'Iv1.a1b2c3d4e5f6', '12345 ', '12.5']) {
      it(`rejects githubAppId=${JSON.stringify(bad)}`, () => {
        expect(() => synthUncached(false, { ...APP_PROPS, githubAppId: bad })).toThrow(
          /githubAppId must be the numeric id/,
        )
      })
    }

    it('rejects a non-numeric githubAppInstallationId', () => {
      expect(() =>
        synthUncached(false, { ...APP_PROPS, githubAppInstallationId: 'my-org' }),
      ).toThrow(/githubAppInstallationId must be the numeric id/)
    })

    it('names both the slug and the client id, which are what adopters reach for', () => {
      expect(() => synthUncached(false, { ...APP_PROPS, githubAppId: 'my-app-slug' })).toThrow(
        /slug and its 'Iv1/,
      )
    })

    it('accepts ordinary numeric ids -- negative control', () => {
      // Without this, every assertion above would pass against a guard that
      // rejected everything.
      expect(() =>
        synthUncached(false, { ...APP_PROPS, githubAppId: '1', githubAppInstallationId: '9' }),
      ).not.toThrow()
    })

    it('reports an EMPTY id as absent, not as malformed', () => {
      // `process.env.GITHUB_APP_ID ?? ''` and an Actions `vars.` reference to a
      // variable nobody created both produce ''. That is an absent id, not a
      // wrong one, and "must be the numeric id (got \"\")" would send the
      // adopter to correct a value they never set.
      expect(() => synthUncached(false, { ...APP_PROPS, githubAppId: '' })).toThrow(
        /githubAppId is not set/,
      )
    })

    it('accepts an unresolved CDK token, which cannot be checked here either way', () => {
      // `ssm.StringParameter.valueForStringParameter(...)` / `Fn.importValue(...)`
      // is a legitimate way to supply an id, and refusing it would make that
      // configuration unrepresentable. githubAppPrivateKeySecretArn already
      // accepts one, so this keeps the App props consistent.
      const stack = new Stack(newTestApp(), 'TokenStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      })
      const tokenId = Fn.importValue('CanopyGitHubAppId')
      expect(Token.isUnresolved(tokenId)).toBe(true)
      expect(
        () =>
          new CanopyCmsService(stack, 'Cms', {
            cmsDockerImage: lambda.DockerImageCode.fromEcr(
              ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
            ),
            githubOwner: 'acme',
            githubRepo: 'site',
            ...APP_PROPS,
            githubAppId: tokenId,
          }),
      ).not.toThrow()
    })

    it('the numeric check runs BEFORE the all-or-nothing one', () => {
      // A partial set carrying a bad id. Ordering is unpinned otherwise --
      // measured: moving both assertNumericId calls after the two throws left
      // every other test in this file green.
      expect(() => synthUncached(false, { githubAppId: 'my-app-slug' })).toThrow(
        /githubAppId must be the numeric id/,
      )
    })
  })

  describe('which credential is decided before whether each is well formed', () => {
    it('an App alongside a leftover token JSON field names the real problem', () => {
      // The exact state docs/adopter-migration.md step 2 leads to when an
      // adopter removes githubTokenSecretArn and overlooks its JSON field.
      // Reversed, assertSecretPropPair answers first with "Set
      // githubTokenSecretArn, or drop githubTokenSecretJsonField" -- pointing
      // back at the credential they were just told to delete, and at a
      // configuration the exclusivity rule would refuse anyway.
      expect(() =>
        synthUncached(false, {
          ...APP_PROPS,
          githubTokenSecretJsonField: 'CANOPYCMS_GITHUB_TOKEN',
        }),
      ).toThrow(/configure either the githubToken\* props or the githubApp\* props, not both/)
    })

    it('names the leftover prop specifically, so the fix is unambiguous', () => {
      expect(() =>
        synthUncached(false, {
          ...APP_PROPS,
          githubTokenSecretJsonField: 'CANOPYCMS_GITHUB_TOKEN',
        }),
      ).toThrow(/drop githubTokenSecretJsonField when you adopt it/)
    })

    it('still reports a stranded token JSON field when no App is configured', () => {
      // The reorder must not cost the token-only path its own diagnosis;
      // assertGitHubAuthProps is silent when no App prop is set.
      expect(() =>
        synthUncached(false, { githubTokenSecretJsonField: 'CANOPYCMS_GITHUB_TOKEN' }),
      ).toThrow(/githubTokenSecretJsonField is set but githubTokenSecretArn is not/)
    })
  })

  describe('a PEM passed where an ARN or an identifier belongs is named at synth', () => {
    // There is deliberately no plaintext private-key prop: the value would go
    // into the worker's .env, which systemd reads as EnvironmentFile where a
    // newline begins a new variable. So the realistic mistake is pasting the
    // key into the prop whose name contains "PrivateKey". Without this guard
    // that lands on assertEnvSafe's generic rule and reports "must not contain
    // a newline" about an ARN -- the mechanism, not the mistake.
    const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIB\n-----END RSA PRIVATE KEY-----\n'

    it('githubAppPrivateKeySecretArn', () => {
      expect(() =>
        synthUncached(false, { ...APP_PROPS, githubAppPrivateKeySecretArn: PEM }),
      ).toThrow(/githubAppPrivateKeySecretArn looks like a PEM private key, not a secret ARN/)
    })

    it('names the ARN-only rule and what to do instead', () => {
      expect(() =>
        synthUncached(false, { ...APP_PROPS, githubAppPrivateKeySecretArn: PEM }),
      ).toThrow(/Store the PEM in Secrets Manager and pass that secret's full ARN/)
    })

    it('githubAppId, where the same misunderstanding also puts it', () => {
      expect(() => synthUncached(false, { ...APP_PROPS, githubAppId: PEM })).toThrow(
        /githubAppId looks like a PEM private key, not an identifier/,
      )
    })

    it('beats the generic newline rule to it', () => {
      // assertEnvSafe would also refuse this value, with a message about .env
      // line structure that explains nothing about the actual error. The named
      // guard has to run first, or it may as well not exist.
      expect(() =>
        synthUncached(false, { ...APP_PROPS, githubAppPrivateKeySecretArn: PEM }),
      ).not.toThrow(/must not contain a newline/)
    })
  })
})

/**
 * The scaffold templates and the checked-in example teach the same wiring, and
 * scaffold-synth.test.ts exercises only the templates -- it runs the real CLI,
 * which never reads `examples/`. So the example is exactly the copy that can
 * rot unnoticed, and it has: the media block in `asset-support.test.ts` grew
 * these same tests because a fix landed in the template while
 * `examples/aws-deployment/` went on teaching a dead API.
 *
 * Textual, and deliberately so -- these are template and example FILES, not
 * modules this suite can import and execute. It catches a copy that was never
 * updated, which is the observed failure; it cannot catch one updated wrongly.
 * The behavioural half lives in scaffold-synth.test.ts, which synthesizes the
 * generated project and asserts the value reaches the worker's .env.
 */
describe('secret JSON-field wiring: the scaffold template and the example stay in step', () => {
  const repoRoot = path.join(__dirname, '..', '..', '..', '..')
  const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf-8')

  const PAIRS: Array<[string, string, string[]]> = [
    [
      'infrastructure/lib/cms-stack.ts',
      'packages/canopycms/src/cli/template-files/cms-stack.ts.template',
      [
        'githubTokenSecretJsonField?: string',
        'clerkSecretKeySecretJsonField?: string',
        'githubTokenSecretJsonField: props.githubTokenSecretJsonField,',
        'clerkSecretKeySecretJsonField: props.clerkSecretKeySecretJsonField,',
        // GitHub App auth (#45). The token prop went optional in the same
        // change -- an App-authenticated stack has no token to point at, and
        // the construct refuses both at once -- so the `?` is load-bearing and
        // pinned with the rest.
        'githubTokenSecretArn?: string',
        'githubAppId: props.githubAppId,',
        'githubAppInstallationId: props.githubAppInstallationId,',
        'githubAppPrivateKeySecretArn: githubAppPrivateKey?.secretArn,',
        'githubAppPrivateKeySecretJsonField: props.githubAppPrivateKeySecretJsonField,',
      ],
    ],
    [
      'infrastructure/bin/app.ts',
      'packages/canopycms/src/cli/template-files/cdk-app.ts.template',
      [
        'githubTokenSecretJsonField: process.env.GITHUB_TOKEN_SECRET_JSON_FIELD || undefined,',
        'clerkSecretKeySecretJsonField: process.env.CLERK_SECRET_KEY_SECRET_JSON_FIELD || undefined,',
        // `|| undefined`, never `required()`: App auth is optional, and a
        // `required()` here would make every existing token deployment fail at
        // synth the moment it upgraded.
        'githubAppInstallationId: process.env.GITHUB_APP_INSTALLATION_ID || undefined,',
        'githubAppPrivateKeySecretArn: process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN || undefined,',
        // The token ARN stays `required()` on the token path -- an unset one
        // must still fail loudly at synth -- and is only relaxed when the App
        // variables are set.
        "required('GITHUB_TOKEN_SECRET_ARN')",
        // ANY of the three App variables, not just the app id. Gating on the id
        // alone answers a two-of-three configuration with "GITHUB_TOKEN_SECRET_ARN
        // must be set" -- telling the adopter to restore the credential the
        // migration guide just told them to remove.
        'githubTokenSecretArn: usingGitHubApp',
      ],
    ],
    [
      'deploy-cms.yml',
      'packages/canopycms/src/cli/template-files/deploy-cms.yml.template',
      [
        'GITHUB_TOKEN_SECRET_JSON_FIELD: ${{ vars.CANOPY_GITHUB_TOKEN_SECRET_JSON_FIELD }}',
        'CLERK_SECRET_KEY_SECRET_JSON_FIELD: ${{ vars.CLERK_SECRET_KEY_SECRET_JSON_FIELD }}',
        // CANOPY_-prefixed on the GitHub side, unprefixed on the env side.
        // GitHub refuses to CREATE an Actions secret or variable whose name
        // starts with GITHUB_, so the prefixed spelling is the only one that
        // can exist -- and this trap has already bitten twice in this epic.
        'GITHUB_APP_ID: ${{ vars.CANOPY_GITHUB_APP_ID }}',
        'GITHUB_APP_INSTALLATION_ID: ${{ vars.CANOPY_GITHUB_APP_INSTALLATION_ID }}',
        'GITHUB_APP_PRIVATE_KEY_SECRET_ARN: ${{ secrets.CANOPY_GITHUB_APP_PRIVATE_KEY_SECRET_ARN }}',
      ],
    ],
  ]

  const examplePathFor = (relative: string): string => `examples/aws-deployment/${relative}`

  for (const [exampleRelative, templatePath, required] of PAIRS) {
    const examplePath = examplePathFor(exampleRelative)

    it(`${templatePath} carries the JSON-field wiring`, () => {
      const source = read(templatePath)
      for (const line of required) expect(source).toContain(line)
    })

    it(`${examplePath} carries the same wiring as its template`, () => {
      const source = read(examplePath)
      for (const line of required) expect(source).toContain(line)
    })
  }

  it('neither copy reaches for the ECS :KEY:: ARN suffix the construct refuses', () => {
    // [A-Za-z0-9_]+, with the digits: a JSON key may contain one, and
    // `GITHUB_TOKEN2` slipped past the first version of this class.
    const ECS_SUFFIX = /:secret:[^:'"`\s]*:[A-Za-z0-9_]+::/

    // POSITIVE CONTROL, first. Every assertion below is an absence, and an
    // absence checked with a regex that matches nothing passes because the
    // instrument is broken rather than because the files are clean. Both
    // spellings, since the digit-bearing one is what got through before.
    for (const sample of [
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:gh-AbCdEf:CANOPYCMS_GITHUB_TOKEN::',
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:gh-AbCdEf:GITHUB_TOKEN2::',
    ]) {
      expect(sample).toMatch(ECS_SUFFIX)
    }

    // The suffix form is the obvious-looking thing to write, and a scaffold
    // that taught it would hand every adopter a synth error. Both copies, not
    // just the templates: the example is the one this describe exists for.
    for (const [exampleRelative, templatePath] of PAIRS) {
      for (const file of [templatePath, examplePathFor(exampleRelative)]) {
        expect(read(file), file).not.toMatch(ECS_SUFFIX)
      }
    }
  })

  it('neither copy reads a repository secret or variable named GITHUB_*', () => {
    // GitHub refuses to CREATE an Actions secret OR variable whose name starts
    // with GITHUB_, so a workflow referencing one reads an empty string forever
    // and the deploy fails at synth -- or, for an optional value, succeeds with
    // the feature silently inert, which is worse. This trap has now been hit
    // twice in this line of work, so it is checked mechanically rather than
    // remembered: every such value is stored CANOPY_-prefixed and mapped onto
    // the unprefixed env var the CDK app reads.
    //
    // `secrets.GITHUB_TOKEN` is carved out and is the ONE legitimate spelling:
    // Actions provides it automatically, so it is not a secret anyone created.
    const USER_CREATED_GITHUB_REF = /\$\{\{\s*(?:secrets|vars)\.GITHUB_(?!TOKEN\s*\}\})/

    // POSITIVE CONTROL first: this assertion is an absence, and an absence
    // checked with a regex that matches nothing passes because the instrument
    // is broken. Both kinds, since the variable half is the half people forget.
    for (const sample of [
      'GITHUB_APP_ID: ${{ vars.GITHUB_APP_ID }}',
      'ARN: ${{ secrets.GITHUB_TOKEN_SECRET_ARN }}',
    ]) {
      expect(sample).toMatch(USER_CREATED_GITHUB_REF)
    }
    // ...and a negative control, so the carve-out is not silently swallowing
    // everything it was meant to admit alone.
    expect('token: ${{ secrets.GITHUB_TOKEN }}').not.toMatch(USER_CREATED_GITHUB_REF)

    for (const [exampleRelative, templatePath] of PAIRS) {
      if (!exampleRelative.endsWith('.yml')) continue
      for (const file of [templatePath, examplePathFor(exampleRelative)]) {
        expect(read(file), file).not.toMatch(USER_CREATED_GITHUB_REF)
      }
    }
  })

  it("both copies build the image with NEXT_PUBLIC_CANOPY_MODE: 'prod'", () => {
    // Not JSON-field wiring, but the same drift class and found by the same
    // review round: the example had lost this line while the template kept it,
    // so an adopter who copied the example shipped an editor bundle built in
    // DEV browser mode -- dev auth rather than Clerk -- while the server half
    // came up prod and the deploy looked clean. scaffold-synth.test.ts pins the
    // generated path; nothing could see the example.
    for (const [exampleRelative, templatePath] of PAIRS) {
      if (!exampleRelative.endsWith('cms-stack.ts')) continue
      for (const file of [templatePath, examplePathFor(exampleRelative)]) {
        expect(read(file), file).toContain("NEXT_PUBLIC_CANOPY_MODE: 'prod'")
      }
    }
  })
})

describe('CanopyCmsService M4: worker ASG uses a LaunchTemplate, not LaunchConfiguration', () => {
  it('synth produces zero LaunchConfigurations and exactly one LaunchTemplate', () => {
    // AWS accounts created after ~mid-2023 cannot create
    // AWS::AutoScaling::LaunchConfiguration resources at all, so relying on
    // AutoScalingGroup's deprecated instanceType/machineImage/... shorthand
    // (which synthesizes one) would hard-fail `cdk deploy` for fresh adopter
    // accounts. Pin the migration to an explicit LaunchTemplate.
    const template = synth()
    const launchConfigs = template.findResources('AWS::AutoScaling::LaunchConfiguration')
    const launchTemplates = template.findResources('AWS::EC2::LaunchTemplate')
    expect(Object.keys(launchConfigs)).toHaveLength(0)
    expect(Object.keys(launchTemplates)).toHaveLength(1)
  })
})

describe('CanopyCmsService: worker ASG rolling update policy', () => {
  it('synthesizes a rolling UpdatePolicy with MinInstancesInService: 0, so a changed launch template actually replaces the running instance', () => {
    // Without this, CloudFormation's default behavior for an ASG behind a
    // changed launch template is to update the template resource and do
    // NOTHING else - the running instance (and its stale worker bundle)
    // survives until a spot interruption or manual terminate. Asserting on
    // the raw synthesized UpdatePolicy (not just that the construct prop was
    // passed) pins the actual CloudFormation behavior.
    const template = synth()
    template.hasResource(
      'AWS::AutoScaling::AutoScalingGroup',
      Match.objectLike({
        UpdatePolicy: Match.objectLike({
          AutoScalingRollingUpdate: Match.objectLike({
            MinInstancesInService: 0,
          }),
        }),
      }),
    )
  })
})

describe('CanopyCmsService: worker ASG health check', () => {
  it('synthesizes an EC2 health check with a 5-minute grace period', () => {
    // Pins the template, not the construct prop: the move from the deprecated
    // `healthCheck: HealthCheck.ec2({ grace })` to `healthChecks:
    // HealthChecks.ec2({ gracePeriod })` was only safe because both render these
    // two properties identically. A change here alters every deployed worker ASG.
    synth().hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      HealthCheckType: 'EC2',
      HealthCheckGracePeriod: 300,
    })
  })
})

describe('CanopyCmsService: deploymentName validation', () => {
  for (const [why, value] of INVALID_DEPLOYMENT_NAMES) {
    it(`throws at synth for a deploymentName with ${why}: ${JSON.stringify(value)}`, () => {
      expect(() => synth(false, { deploymentName: value })).toThrow(/invalid deploymentName/i)
    })
  }

  for (const value of VALID_DEPLOYMENT_NAMES) {
    it(`accepts the deploymentName ${JSON.stringify(value)}`, () => {
      expect(() => synth(false, { deploymentName: value })).not.toThrow()
    })
  }

  // The drift check the duplicated rule never had (PR #172 finding 3). The
  // construct deliberately avoids importing the runtime predicate here -- see
  // isValidDeploymentName's doc comment in cms-service.ts -- so this TEST
  // imports it instead and requires the two verdicts to match. The dangerous
  // direction is a rule tightened at runtime but not here: the stack would
  // synth clean and then crash-loop the Lambda at boot, which is what the
  // synth guard exists to prevent.
  it('agrees with the runtime predicate on every fixture name', () => {
    const candidates = [
      ...VALID_DEPLOYMENT_NAMES,
      ...INVALID_DEPLOYMENT_NAMES.map(([, value]) => value),
    ]
    for (const value of candidates) {
      let synthRejected = false
      try {
        synth(false, { deploymentName: value })
      } catch {
        synthRejected = true
      }
      expect(
        synthRejected,
        `synth and operating-mode/deployment-name.ts disagree about ${JSON.stringify(value)}`,
      ).toBe(!isValidDeploymentName(value))
    }
  })
})

/**
 * Branch-name cases for `baseBranch`/`settingsBranch`, which get
 * `assertValidGitBranchName` rather than `deploymentName`'s single-component
 * charset.
 *
 * NOT the shared `deployment-name-fixtures` list, deliberately. That list
 * declares `'team/prod'` INVALID, which is right for a value interpolated into
 * `canopycms-settings-<name>` and wrong for a whole branch name -- reusing it
 * here refused `cdk synth` for an adopter whose default branch is
 * `release/v2`. The first entry below is the regression test for that.
 *
 * These live here rather than in a cross-package fixture because there is no
 * runtime counterpart to drift from: nothing in `canopycms` validates a branch
 * name, the worker uses the string as given.
 */
const VALID_BRANCH_NAMES = [
  'release/v2',
  'epic/int-202608-b',
  'feature/a/b/c',
  'main',
  'trunk',
  'release.2026',
  'v2',
  'canopycms-settings-prod',
  'x.locked',
] as const

const INVALID_BRANCH_NAMES = [
  ['whitespace', 'my branch'],
  ['a leading dash (parses as a git option)', '-branch'],
  ['a colon', 'branch:1'],
  ['dot-dot', 'a..b'],
  ['a leading dot', '.branch'],
  ['a dot-led path component', 'feature/.hidden'],
  ['a trailing dot', 'branch.'],
  ['a .lock suffix', 'branch.lock'],
  ['a .lock path component', 'feature/x.lock'],
  ['a tilde', 'branch~1'],
  ['a caret', 'branch^1'],
  ['a question mark', 'branch?'],
  ['an asterisk', 'branch*'],
  ['an open bracket', 'branch['],
  ['a backslash', 'branch\\1'],
  ['a reflog selector', 'branch@{1}'],
  ['a leading slash', '/branch'],
  ['a trailing slash', 'branch/'],
  ['an empty path component', 'a//b'],
  ['a lone @', '@'],
  ['HEAD, which names the symbolic ref rather than a branch', 'HEAD'],
  ['the empty string', ''],
  ['a newline (would inject a line into the worker .env)', 'branch\nEVIL=1'],
] as const

/**
 * `baseBranch` gets a synth-time git-ref guard it previously lacked -- before
 * this it went only through the generic `assertEnvSafe` newline/ENVEOF check
 * exercised by the heredoc-safe table above, so a value git itself refuses
 * synthesized and deployed clean and then crash-looped the worker.
 */
describe('CanopyCmsService: baseBranch validation', () => {
  for (const [why, value] of INVALID_BRANCH_NAMES) {
    it(`throws at synth for a baseBranch with ${why}: ${JSON.stringify(value)}`, () => {
      expect(() => synth(false, { baseBranch: value })).toThrow(/invalid baseBranch/i)
    })
  }

  for (const value of VALID_BRANCH_NAMES) {
    it(`accepts the baseBranch ${JSON.stringify(value)}`, () => {
      expect(() => synth(false, { baseBranch: value })).not.toThrow()
    })
  }

  it('stamps a slash-bearing baseBranch through to the worker .env', () => {
    // The regression this guard must not reintroduce: a slash is legal and
    // conventional in a branch name, and the worker keeps the raw name for git
    // refs (sanitizing only for workspace directory names).
    const all = workerUserDataBlobs(synth(false, { baseBranch: 'release/v2' }))
    expect(all).toContain('CANOPYCMS_BASE_BRANCH=release/v2')
  })

  it('stamps CANOPYCMS_BASE_BRANCH with a non-main value, building on the existing trunk case', () => {
    const all = workerUserDataBlobs(synth(false, { baseBranch: 'release.2026' }))
    expect(all).toContain('CANOPYCMS_BASE_BRANCH=release.2026')
    expect(all).not.toContain('CANOPYCMS_BASE_BRANCH=main')
  })
})

describe('CanopyCmsService: worker CloudWatch log shipping', () => {
  it('creates a dedicated worker log group named /canopycms/<stackName>/worker with 90-day default retention and DESTROY removal', () => {
    const template = synth()
    template.hasResourceProperties(
      'AWS::Logs::LogGroup',
      Match.objectLike({
        LogGroupName: '/canopycms/TestStack/worker',
        RetentionInDays: 90,
      }),
    )
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete' })
  })

  it('honors workerLogRetention to override the default retention', () => {
    const template = synth(false, { workerLogRetention: RetentionDays.ONE_WEEK })
    template.hasResourceProperties('AWS::Logs::LogGroup', Match.objectLike({ RetentionInDays: 7 }))
  })

  it('honors workerLogGroupName to override the default name', () => {
    const template = synth(false, { workerLogGroupName: '/custom/worker' })
    template.hasResourceProperties(
      'AWS::Logs::LogGroup',
      Match.objectLike({ LogGroupName: '/custom/worker' }),
    )
  })

  it('grants the worker role a log-group-scoped IAM statement (CreateLogStream + PutLogEvents only), not a broad grant', () => {
    const template = synth()
    template.hasResourceProperties(
      'AWS::IAM::Policy',
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              Resource: Match.objectLike({
                'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('WorkerLogs')]),
              }),
            }),
          ]),
        }),
      }),
    )
  })

  it('does not grant the worker role the broad CloudWatchAgentServerPolicy managed policy', () => {
    const template = synth()
    const roles = template.findResources('AWS::IAM::Role', {
      Properties: Match.objectLike({ Description: 'CanopyCMS EC2 Worker role' }),
    })
    // Guard against a vacuous pass: if the role description ever changes, the
    // filter would match nothing and the negative assertion below would
    // "succeed" while pinning nothing.
    expect(Object.keys(roles).length).toBeGreaterThan(0)
    const managedPolicyArns = Object.values(roles).flatMap(
      (role) => (role.Properties as { ManagedPolicyArns?: unknown[] }).ManagedPolicyArns ?? [],
    )
    const serialized = managedPolicyArns.map((arn) => JSON.stringify(arn)).join('\n')
    expect(serialized).not.toContain('CloudWatchAgentServerPolicy')
  })

  it('wires the CloudWatch agent into UserData: installs it, points it at the worker log file, and starts it', () => {
    const template = synth()
    const blobs = JSON.stringify(template.findResources('AWS::AutoScaling::LaunchConfiguration'))
    const ltBlobs = JSON.stringify(template.findResources('AWS::EC2::LaunchTemplate'))
    const all = blobs + ltBlobs
    expect(all).toContain('dnf install -y amazon-cloudwatch-agent')
    expect(all).toContain('/var/log/canopy-worker/worker.log')
    expect(all).toContain('\\"log_stream_name\\": \\"{instance_id}\\"')
    expect(all).toContain('amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s')
  })

  it('parses the worker-emitted timestamp instead of ingestion time, and groups multi-line output into one event', () => {
    const template = synth()
    const all = workerUserDataBlobs(template)
    // The worker prefixes every line with ISO-8601 UTC
    // (packages/canopycms/src/worker/log.ts). These three keys are what make
    // CloudWatch use that timestamp rather than the moment the agent shipped
    // the line, and keep a stack trace as ONE event instead of one event per
    // line. Without timezone, the trailing `Z` is ignored and the timestamp is
    // read in the instance's local zone.
    expect(all).toContain('\\"timestamp_format\\": \\"%Y-%m-%dT%H:%M:%S.%f\\"')
    expect(all).toContain('\\"timezone\\": \\"UTC\\"')
    expect(all).toContain('\\"multi_line_start_pattern\\": \\"{timestamp_format}\\"')
  })

  it('references the WorkerLogs log group logical id as a deploy-time token in UserData (pins the implicit CFN dependency)', () => {
    const template = synth()
    const blobs = JSON.stringify(template.findResources('AWS::AutoScaling::LaunchConfiguration'))
    const ltBlobs = JSON.stringify(template.findResources('AWS::EC2::LaunchTemplate'))
    const all = blobs + ltBlobs
    // The agent config's log_group_name is interpolated from `this.workerLogGroup.logGroupName`,
    // an unresolved CDK token - it must show up as an Fn::Join-embedded Ref to the WorkerLogs
    // logical id (not a plain string), or the CFN dependency on the log group would be silently lost.
    expect(/"Ref":"[^"]*WorkerLogs[^"]*"/.test(all)).toBe(true)
  })

  it('rewrites the systemd unit for file-based output (not journal) and installs logrotate', () => {
    const template = synth()
    const blobs = JSON.stringify(template.findResources('AWS::AutoScaling::LaunchConfiguration'))
    const ltBlobs = JSON.stringify(template.findResources('AWS::EC2::LaunchTemplate'))
    const all = blobs + ltBlobs
    expect(all).toContain('StandardOutput=append:/var/log/canopy-worker/worker.log')
    expect(all).toContain('LogsDirectory=canopy-worker')
    expect(all).not.toContain('StandardOutput=journal')
    expect(all).toContain('/etc/logrotate.d/canopy-worker')
  })

  it('installs/starts the CloudWatch agent AFTER the worker service starts (best-effort: agent failure must not block the worker)', () => {
    const template = synth()
    const launchConfigs = template.findResources('AWS::AutoScaling::LaunchConfiguration')
    const launchTemplates = template.findResources('AWS::EC2::LaunchTemplate')
    const blobs = [
      ...Object.values(launchConfigs).map((r) => JSON.stringify(r)),
      ...Object.values(launchTemplates).map((r) => JSON.stringify(r)),
    ]
    expect(blobs.length).toBeGreaterThan(0)
    for (const blob of blobs) {
      const startIdx = blob.indexOf('systemctl start canopy-worker')
      // The failure-isolation invariant is that the ENTIRE agent block runs
      // after worker start under set -euo pipefail — the dnf install is the
      // first (and most failure-prone: network + repo) command of that block,
      // so pin it explicitly, not just the final ctl call.
      const yumIdx = blob.indexOf('dnf install -y amazon-cloudwatch-agent')
      const agentIdx = blob.indexOf('amazon-cloudwatch-agent-ctl')
      expect(startIdx).toBeGreaterThanOrEqual(0)
      expect(yumIdx).toBeGreaterThanOrEqual(0)
      expect(agentIdx).toBeGreaterThanOrEqual(0)
      expect(startIdx).toBeLessThan(yumIdx)
      expect(startIdx).toBeLessThan(agentIdx)
    }
  })

  it('pre-creates /var/log/canopy-worker BEFORE starting the worker (systemd#27591 crash-loop guard)', () => {
    const template = synth()
    const launchConfigs = template.findResources('AWS::AutoScaling::LaunchConfiguration')
    const launchTemplates = template.findResources('AWS::EC2::LaunchTemplate')
    const blobs = [
      ...Object.values(launchConfigs).map((r) => JSON.stringify(r)),
      ...Object.values(launchTemplates).map((r) => JSON.stringify(r)),
    ]
    expect(blobs.length).toBeGreaterThan(0)
    for (const blob of blobs) {
      // systemd opens StandardOutput=append: targets before it creates
      // LogsDirectory= dirs (systemd#27591): if this mkdir ever moves after
      // the first `systemctl start canopy-worker`, every fresh instance
      // fails exec with 209/STDOUT and Restart=always crash-loops forever —
      // the worker would be silently down while the ASG sees a healthy box.
      const mkdirIdx = blob.indexOf('mkdir -p /var/log/canopy-worker')
      const startIdx = blob.indexOf('systemctl start canopy-worker')
      expect(mkdirIdx).toBeGreaterThanOrEqual(0)
      expect(startIdx).toBeGreaterThanOrEqual(0)
      expect(mkdirIdx).toBeLessThan(startIdx)
    }
  })
})

describe('CanopyCmsService: CMS Lambda CloudWatch log group', () => {
  it('creates a dedicated CMS log group named /canopycms/<stackName>/cms with 90-day default retention and DESTROY removal', () => {
    const template = synth()
    template.hasResource(
      'AWS::Logs::LogGroup',
      Match.objectLike({
        Properties: Match.objectLike({
          LogGroupName: '/canopycms/TestStack/cms',
          RetentionInDays: 90,
        }),
        DeletionPolicy: 'Delete',
      }),
    )
  })

  it('honors cmsLogRetention to override the default retention', () => {
    const template = synth(false, { cmsLogRetention: RetentionDays.ONE_WEEK })
    template.hasResourceProperties(
      'AWS::Logs::LogGroup',
      Match.objectLike({ LogGroupName: '/canopycms/TestStack/cms', RetentionInDays: 7 }),
    )
  })

  it('honors cmsLogGroupName to override the default name', () => {
    const template = synth(false, { cmsLogGroupName: '/custom/cms' })
    template.hasResourceProperties(
      'AWS::Logs::LogGroup',
      Match.objectLike({ LogGroupName: '/custom/cms' }),
    )
  })

  // Direct regression guard for the deploy-blocking trap: Lambda auto-creates
  // `/aws/lambda/<function-name>` outside CloudFormation on first invoke, so
  // a CDK LogGroup construct using that exact name fails CreateLogGroup with
  // "already exists" the moment it's ever been deployed without one.
  it('neither the CMS nor the worker log group name starts with /aws/lambda/', () => {
    const template = synth()
    const groups = template.findResources('AWS::Logs::LogGroup')
    const names = Object.values(groups).map(
      (group) => (group.Properties as { LogGroupName?: string }).LogGroupName ?? '',
    )
    expect(names.length).toBeGreaterThanOrEqual(2) // worker + cms
    for (const name of names) {
      expect(name.startsWith('/aws/lambda/')).toBe(false)
    }
  })

  it('the CMS Lambda references its dedicated log group via LoggingConfig.LogGroup', () => {
    const template = synth()
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        LoggingConfig: Match.objectLike({
          LogGroup: { Ref: Match.stringLikeRegexp('CmsFunctionLogs') },
        }),
      }),
    )
  })

  it('grants the CMS Lambda role a log-group-scoped IAM statement (CreateLogStream + PutLogEvents only), not a broad grant', () => {
    const template = synth()
    template.hasResourceProperties(
      'AWS::IAM::Policy',
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
              Resource: Match.objectLike({
                'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('CmsFunctionLogs')]),
              }),
            }),
          ]),
        }),
      }),
    )
  })
})

describe('CanopyCmsService: deploymentName -> CANOPYCMS_DEPLOYMENT_NAME (settings-branch namespacing)', () => {
  it('defaults CANOPYCMS_DEPLOYMENT_NAME to "prod" in the Lambda environment', () => {
    const template = synth()
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({ CANOPYCMS_DEPLOYMENT_NAME: 'prod' }),
        }),
      }),
    )
  })

  it('honors deploymentName in the Lambda environment', () => {
    const template = synth(false, { deploymentName: 'acme' })
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({ CANOPYCMS_DEPLOYMENT_NAME: 'acme' }),
        }),
      }),
    )
  })

  it('lets an explicit environment.CANOPYCMS_DEPLOYMENT_NAME override deploymentName', () => {
    const template = synth(false, {
      deploymentName: 'acme',
      environment: { CANOPYCMS_DEPLOYMENT_NAME: 'explicit-override' },
    })
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({ CANOPYCMS_DEPLOYMENT_NAME: 'explicit-override' }),
        }),
      }),
    )
  })

  it('defaults to "prod" in the worker .env UserData when deploymentName is unset', () => {
    const template = synth()
    const all = workerUserDataBlobs(template)
    expect(all).toContain('CANOPYCMS_DEPLOYMENT_NAME=prod')
  })

  it('honors deploymentName in the worker .env UserData', () => {
    const template = synth(false, { deploymentName: 'acme' })
    const all = workerUserDataBlobs(template)
    expect(all).toContain('CANOPYCMS_DEPLOYMENT_NAME=acme')
    expect(all).not.toContain('CANOPYCMS_DEPLOYMENT_NAME=prod')
  })
})

/**
 * PR #172 finding 1. `environment` is spread into the Lambda's variables, so
 * CANOPYCMS_DEPLOYMENT_NAME set there used to (a) skip the synth guard, so an
 * invalid value deployed clean and crash-looped the Lambda at boot, and (b)
 * apply to the Lambda only, leaving the worker on `props.deploymentName` --
 * the two halves resolving different settings branches, which is exactly the
 * condition pushSettingsBranches's [SYNC-M3] warning was added to detect.
 */
describe('CanopyCmsService: the CANOPYCMS_DEPLOYMENT_NAME escape hatch is validated and mirrored', () => {
  for (const [why, value] of INVALID_DEPLOYMENT_NAMES) {
    it(`fails at synth, not at boot, for an environment override with ${why}`, () => {
      expect(() => synth(false, { environment: { CANOPYCMS_DEPLOYMENT_NAME: value } })).toThrow(
        /invalid deploymentName/i,
      )
    })
  }

  it('names the environment override as the source in the error', () => {
    expect(() =>
      synth(false, {
        deploymentName: 'fine',
        environment: { CANOPYCMS_DEPLOYMENT_NAME: 'bad name' },
      }),
    ).toThrow(/environment\.CANOPYCMS_DEPLOYMENT_NAME/)
  })

  // The mirror. One deployment resolves ONE settings branch
  // (`canopycms-settings-<name>`), so every supported way of setting the name
  // must land the same string on both halves.
  const ways: Array<[string, Partial<CanopyCmsServiceProps>, string]> = [
    ['neither prop nor environment (the default)', {}, 'prod'],
    ['the deploymentName prop', { deploymentName: 'acme' }, 'acme'],
    [
      'the environment escape hatch alone',
      { environment: { CANOPYCMS_DEPLOYMENT_NAME: 'from-env' } },
      'from-env',
    ],
    [
      'the environment escape hatch overriding the prop',
      { deploymentName: 'acme', environment: { CANOPYCMS_DEPLOYMENT_NAME: 'from-env' } },
      'from-env',
    ],
  ]

  for (const [why, overrides, expected] of ways) {
    it(`resolves the same deployment name on the Lambda and the worker with ${why}`, () => {
      const template = synth(false, overrides)
      template.hasResourceProperties(
        'AWS::Lambda::Function',
        Match.objectLike({
          Environment: Match.objectLike({
            Variables: Match.objectLike({ CANOPYCMS_DEPLOYMENT_NAME: expected }),
          }),
        }),
      )
      expect(workerUserDataBlobs(template)).toContain(`CANOPYCMS_DEPLOYMENT_NAME=${expected}`)
    })
  }
})

/**
 * Baseline review E4. A deployed Lambda has to reach prod mode: dev mode
 * resolves its workspace to `<cwd>/.canopy-dev`, and Lambda's filesystem is
 * read-only outside /tmp, so the first write fails EROFS. The switch is
 * CANOPY_MODE, read at runtime by resolveOperatingMode
 * (packages/canopycms/src/operating-mode/mode-env.ts).
 */
describe('CanopyCmsService: operating mode', () => {
  it('stamps CANOPY_MODE=prod on the Lambda', () => {
    const template = synth()
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({ Variables: Match.objectLike({ CANOPY_MODE: 'prod' }) }),
      }),
    )
  })

  it('keeps CANOPY_MODE=prod even when an environment escape hatch is supplied', () => {
    const template = synth(false, { environment: { CANOPY_MODE: 'prod' } })
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({ Variables: Match.objectLike({ CANOPY_MODE: 'prod' }) }),
      }),
    )
  })

  for (const value of ['dev', 'production', 'PROD', '']) {
    it(`rejects environment.CANOPY_MODE=${JSON.stringify(value)} at synth`, () => {
      expect(() => synth(false, { environment: { CANOPY_MODE: value } })).toThrow(
        /invalid environment\.CANOPY_MODE/i,
      )
    })
  }
})

/**
 * PR #172 finding 2. Every value interpolated into the worker's `.env` goes
 * through assertEnvSafe, not just deploymentName. Robustness rather than a
 * security boundary -- the heredoc delimiter is quoted and these values are
 * adopter-supplied -- but a newline silently injects an extra environment
 * line, and an ENVEOF-bearing value ends the heredoc early so the remainder
 * runs as user-data shell commands.
 */
describe('CanopyCmsService: worker .env values are heredoc-safe', () => {
  const fields: Array<[string, (value: string) => Partial<CanopyCmsServiceProps>]> = [
    ['githubOwner', (value) => ({ githubOwner: value })],
    ['githubRepo', (value) => ({ githubRepo: value })],
    ['baseBranch', (value) => ({ baseBranch: value })],
    ['settingsBranch', (value) => ({ settingsBranch: value })],
    ['deploymentName', (value) => ({ deploymentName: value })],
    ['githubTokenSecretArn', (value) => ({ githubTokenSecretArn: value })],
    ['clerkSecretKeySecretArn', (value) => ({ clerkSecretKeySecretArn: value })],
    // The JSON-field props carry their matching ARN, because a field without
    // its ARN is refused by an EARLIER guard (assertSecretPropPair in
    // cms-service.ts) with a different message -- these cases are about
    // assertEnvSafe, so they have to reach it.
    [
      'githubTokenSecretJsonField',
      (value) => ({
        githubTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:gh-AbCdEf',
        githubTokenSecretJsonField: value,
      }),
    ],
    [
      'clerkSecretKeySecretJsonField',
      (value) => ({
        clerkSecretKeySecretArn:
          'arn:aws:secretsmanager:us-east-1:123456789012:secret:clerk-AbCdEf',
        clerkSecretKeySecretJsonField: value,
      }),
    ],
    // Each App prop carries its two siblings, because an incomplete App set is
    // refused by an EARLIER guard (assertGitHubAuthProps) with a different
    // message -- these cases are about assertEnvSafe, so they have to reach it.
    // Same reason the JSON-field entries above carry their ARNs.
    ['githubAppId', (value) => ({ ...APP_PROPS, githubAppId: value })],
    ['githubAppInstallationId', (value) => ({ ...APP_PROPS, githubAppInstallationId: value })],
    [
      'githubAppPrivateKeySecretArn',
      (value) => ({ ...APP_PROPS, githubAppPrivateKeySecretArn: value }),
    ],
    [
      'githubAppPrivateKeySecretJsonField',
      (value) => ({ ...APP_PROPS, githubAppPrivateKeySecretJsonField: value }),
    ],
  ]

  // baseBranch/settingsBranch/deploymentName each have their OWN stricter
  // guard (assertValidGitBranchName for the first two -- a whole-ref guard,
  // since a branch name may contain '/' -- or deploymentName's own
  // ref-COMPONENT fold, which forbids '/') that runs before assertEnvSafe's
  // generic newline/ENVEOF checks -- a value that fails the charset never
  // reaches assertEnvSafe at all, so these three throw "invalid <field> ..."
  // instead of the generic message.
  const GIT_REF_VALIDATED_FIELDS = new Set(['baseBranch', 'settingsBranch', 'deploymentName'])

  // The two GitHub App identifiers are the same situation one step stricter:
  // `assertNumericId` allows digits ONLY, so no value that could offend
  // assertEnvSafe can reach it -- a numeric string has no newline, no quote, no
  // backslash, no whitespace and no ENVEOF. They stay in the table because
  // membership is the point: a prop dropped from it is a prop nobody notices
  // has stopped being guarded, whichever guard does the rejecting.
  const NUMERIC_ID_FIELDS = new Set(['githubAppId', 'githubAppInstallationId'])

  /**
   * The numeric guard runs before assertEnvSafe, so for those two fields every
   * hostile value below is rejected by IT rather than by the rule under test.
   * Applied per-rule rather than folded into a single helper with
   * GIT_REF_VALIDATED_FIELDS, because the two sets do not carve out the same
   * rules: an ENVEOF-bearing branch name passes the git-ref charset and DOES
   * reach assertEnvSafe, while a numeric id never reaches it at all.
   */
  const numericIdOr = (field: string, otherwise: string | RegExp): string | RegExp =>
    NUMERIC_ID_FIELDS.has(field) ? 'must be the numeric id' : otherwise

  for (const [field, build] of fields) {
    it(`rejects a newline in ${field}`, () => {
      expect(() => synth(false, build('acme\nCANOPYCMS_DEPLOYMENT_NAME=hijacked'))).toThrow(
        // toThrow(string) is a substring match, not a regexp -- avoids
        // constructing a RegExp from a non-literal (field names come from the
        // fixed `fields` array above, but a dynamic RegExp still trips
        // eslint-plugin-security's detect-non-literal-regexp).
        numericIdOr(
          field,
          GIT_REF_VALIDATED_FIELDS.has(field) ? `invalid ${field}` : 'must not contain a newline',
        ),
      )
    })

    it(`rejects an ENVEOF-bearing ${field}`, () => {
      expect(() => synth(false, build('acmeENVEOFrm'))).toThrow(
        numericIdOr(field, /must not contain "ENVEOF"/i),
      )
    })

    it(`rejects a leading quote in ${field}`, () => {
      // systemd reads this file as EnvironmentFile=, where a value whose FIRST
      // character is a quote opens a quoted value that keeps consuming lines
      // until a matching quote -- so one leading quote silently empties the
      // rest of the worker's environment (AWS_REGION, the secret ARNs, the
      // deployment name), rather than corrupting the one line it appears on.
      // git accepts such a branch name, so assertValidGitBranchName passes it
      // through and assertEnvSafe is what must catch it. deploymentName is the
      // exception: its charset rule rejects the quote first.
      expect(() => synth(false, build('"acme'))).toThrow(
        numericIdOr(
          field,
          field === 'deploymentName' ? `invalid ${field}` : 'must not start with a quote',
        ),
      )
    })

    it(`rejects a backslash in ${field}`, () => {
      // systemd's EnvironmentFile parser reads a backslash as an escape, and a
      // TRAILING one continues the value onto the next line -- consuming the
      // .env entry that follows. Same class as the leading quote, but it
      // corrupts a neighbouring variable rather than its own.
      expect(() => synth(false, build('acme\\'))).toThrow(
        numericIdOr(
          field,
          GIT_REF_VALIDATED_FIELDS.has(field) ? `invalid ${field}` : 'must not contain a backslash',
        ),
      )
    })

    it(`rejects surrounding whitespace in ${field}`, () => {
      // Stripped by that same parser, so the worker would see a different value
      // than the one configured here -- and for a JSON field that means the
      // whole-document fallback, silently.
      expect(() => synth(false, build(' acme'))).toThrow(
        numericIdOr(
          field,
          GIT_REF_VALIDATED_FIELDS.has(field)
            ? `invalid ${field}`
            : 'must not start or end with whitespace',
        ),
      )
    })
  }

  it('still writes ordinary values through', () => {
    const all = workerUserDataBlobs(
      synth(false, { githubOwner: 'acme', githubRepo: 'site', baseBranch: 'trunk' }),
    )
    expect(all).toContain('CANOPYCMS_GITHUB_OWNER=acme')
    expect(all).toContain('CANOPYCMS_GITHUB_REPO=site')
    expect(all).toContain('CANOPYCMS_BASE_BRANCH=trunk')
  })
})

/**
 * `settingsBranch` -> `CANOPYCMS_SETTINGS_BRANCH` in the worker's `.env`.
 * Mirrors the `deploymentName` -> `CANOPYCMS_DEPLOYMENT_NAME` suite above,
 * plus the branch-name validation it shares with `baseBranch` (see
 * `assertValidGitBranchName` in cms-service.ts).
 */
describe('CanopyCmsService: settingsBranch -> CANOPYCMS_SETTINGS_BRANCH', () => {
  it('does not stamp CANOPYCMS_SETTINGS_BRANCH at all when settingsBranch is unset', () => {
    const all = workerUserDataBlobs(synth())
    expect(all).not.toContain('CANOPYCMS_SETTINGS_BRANCH')
  })

  it('stamps CANOPYCMS_SETTINGS_BRANCH in the worker .env when settingsBranch is set', () => {
    const all = workerUserDataBlobs(synth(false, { settingsBranch: 'canopycms-settings-custom' }))
    expect(all).toContain('CANOPYCMS_SETTINGS_BRANCH=canopycms-settings-custom')
  })

  it('throws at synth for an empty settingsBranch rather than silently omitting the stamp', () => {
    expect(() => synth(false, { settingsBranch: '' })).toThrow(/invalid settingsBranch/i)
  })

  for (const [why, value] of INVALID_BRANCH_NAMES) {
    it(`throws at synth for a settingsBranch with ${why}: ${JSON.stringify(value)}`, () => {
      // The empty-string case is asserted on its own above with a more specific
      // message; skip the duplicate here.
      if (value === '') return
      expect(() => synth(false, { settingsBranch: value })).toThrow(/invalid settingsBranch/i)
    })
  }

  for (const value of VALID_BRANCH_NAMES) {
    it(`accepts the settingsBranch ${JSON.stringify(value)}`, () => {
      expect(() => synth(false, { settingsBranch: value })).not.toThrow()
    })
  }
})

/**
 * `lambdaRole` exists so an adopter can compute the CMS Lambda's principal ARN
 * without holding a reference to this construct - the cross-account
 * asset-bucket case, where the resource-policy half of the grant is written in
 * the bucket's own stack. See `CanopyCmsServiceProps.lambdaRole`.
 *
 * What these tests defend is the FOOTGUN underneath it, not the plumbing.
 * CDK's `lambda.Function` builds its managed-policy list and then passes it
 * only into the role it creates itself, so a caller-supplied role gets
 * `AWSLambdaBasicExecutionRole` and `AWSLambdaVPCAccessExecutionRole`
 * SILENTLY DISCARDED. This Lambda is VPC-attached, so a role missing the
 * latter cannot create ENIs and the function cannot start - while synthesizing
 * and deploying perfectly clean. Every assertion below reads the synthesized
 * template rather than the construct's own objects, since the property is
 * about what CloudFormation receives.
 *
 * NOT covered here, by agreement with the adopter who filed the request: that
 * no reference actually crosses the account boundary in their app. That is an
 * assertion about THEIR stacks (their guard checks for forbidden intrinsics);
 * these tests prove the role works once passed.
 */
const PASSED_ROLE_NAME = 'canopy-cms-passed-role'

function synthWithPassedRole(): { template: Template; roleLogicalId: string } {
  const app = newTestApp()
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  })
  // A NAMED role, matching the shape the prop exists to serve: the adopter
  // names it so both stacks can compute arn:aws:iam::<account>:role/<name>
  // from literals.
  const role = new iam.Role(stack, 'CmsRole', {
    roleName: PASSED_ROLE_NAME,
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  })
  new CanopyCmsService(stack, 'Cms', {
    cmsDockerImage: lambda.DockerImageCode.fromEcr(
      ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
    ),
    githubOwner: 'acme',
    githubRepo: 'site',
    lambdaRole: role,
    assetBucket: new s3.Bucket(stack, 'AssetBucket'),
  })

  const template = Template.fromStack(stack)
  const roles = template.findResources('AWS::IAM::Role', {
    Properties: Match.objectLike({ RoleName: PASSED_ROLE_NAME }),
  })
  const ids = Object.keys(roles)
  expect(ids).toHaveLength(1)
  return { template, roleLogicalId: ids[0] }
}

/** Every AWS::IAM::Policy in the template attached to the given role. */
function policyActionsForRole(template: Template, roleLogicalId: string): string {
  const policies = template.findResources('AWS::IAM::Policy')
  return Object.values(policies)
    .filter((policy) => JSON.stringify(policy.Properties.Roles).includes(roleLogicalId))
    .map((policy) => JSON.stringify(policy.Properties.PolicyDocument))
    .join('\n')
}

describe('CanopyCmsService: lambdaRole', () => {
  it('re-attaches the VPC-ENI and basic-execution managed policies CDK discards for a passed role', () => {
    const { template, roleLogicalId } = synthWithPassedRole()

    const role = template.findResources('AWS::IAM::Role')[roleLogicalId]
    const attached = JSON.stringify(role.Properties.ManagedPolicyArns)

    // Without the construct's compensation this property is absent entirely
    // (measured), so both of these fail rather than merely narrowing.
    expect(attached).toContain('service-role/AWSLambdaVPCAccessExecutionRole')
    expect(attached).toContain('service-role/AWSLambdaBasicExecutionRole')
  })

  it('points the CMS Lambda at the passed role rather than creating its own', () => {
    const { template, roleLogicalId } = synthWithPassedRole()

    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: Match.objectLike({ PackageType: 'Image' }),
    })
    const roleRefs = Object.values(fns).map((fn) => JSON.stringify(fn.Properties.Role))
    expect(roleRefs).toHaveLength(1)
    expect(roleRefs[0]).toContain(roleLogicalId)

    // And no CDK-created execution role is left behind alongside it.
    const roleNames = Object.values(template.findResources('AWS::IAM::Role')).map(
      (r) => (r.Properties as { RoleName?: string }).RoleName,
    )
    expect(roleNames).toContain(PASSED_ROLE_NAME)
  })

  it('still applies the EFS, log-group and asset-bucket grants to the passed role', () => {
    const { template, roleLogicalId } = synthWithPassedRole()
    const document = policyActionsForRole(template, roleLogicalId)

    // EFS access-point statements: applied via addToPrincipalPolicy, which a
    // passed role DOES receive - asserted rather than assumed.
    expect(document).toContain('elasticfilesystem:ClientMount')
    expect(document).toContain('elasticfilesystem:ClientWrite')
    // cmsLogGroup.grantWrite - the grant that actually enables logging to the
    // custom-named group (the basic-execution managed policy does not).
    expect(document).toContain('logs:PutLogEvents')
    // The props.assetBucket block, which grants via the function's
    // grantPrincipal (= the passed role).
    expect(document).toContain('asset-staging/*')
    expect(document).toContain('asset-originals/*')
  })

  it('leaves the default path alone: with no lambdaRole, CDK creates a role carrying both managed policies', () => {
    const template = synth()

    const roles = Object.values(template.findResources('AWS::IAM::Role'))
    const withBoth = roles.filter((role) => {
      const attached = JSON.stringify(role.Properties.ManagedPolicyArns)
      return (
        attached.includes('service-role/AWSLambdaVPCAccessExecutionRole') &&
        attached.includes('service-role/AWSLambdaBasicExecutionRole')
      )
    })
    expect(withBoth).toHaveLength(1)
  })
})
