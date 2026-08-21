import { describe, it, expect } from 'vitest'
import { App, Duration, Stack } from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { RetentionDays } from 'aws-cdk-lib/aws-logs'
import {
  aws_ecr as ecr,
  aws_lambda as lambda,
  aws_route53 as route53,
  aws_certificatemanager as acm,
  aws_cloudfront_origins as origins,
  aws_s3 as s3,
} from 'aws-cdk-lib'
import { CanopyCmsService, DEFAULT_CMS_LAMBDA_TIMEOUT } from './cms-service'
import type { CanopyCmsServiceProps } from './cms-service'
import { CanopyCmsDistribution } from './cms-distribution'
// Test-only imports across the package boundary, deliberately: the construct
// itself must NOT import `canopycms` (this package publishes with no runtime
// dependency on it), but its SUITE can, which is what makes the duplicated
// deployment-name rule a red test on drift rather than a comment asking nicely.
// Both modules are dependency-free apart from canopycms's own logger shim.
import { isValidDeploymentName } from '../../../canopycms/src/operating-mode/deployment-name'
import {
  VALID_DEPLOYMENT_NAMES,
  INVALID_DEPLOYMENT_NAMES,
} from '../../../canopycms/src/operating-mode/deployment-name-fixtures'

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
  const app = new App()
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
    const app = new App()
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
    const app = new App()
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
    const app = new App()
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
    const app = new App()
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
    const app = new App()
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

describe('CanopyCmsService: Lambda architecture', () => {
  it('defaults to x86_64 (no explicit Architectures override) when architecture is omitted', () => {
    const template = synth()
    // Lambda's own default is x86_64; CDK renders that as no `Architectures`
    // property at all rather than an explicit 'x86_64' entry - assert
    // whichever of the two the template actually contains.
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: Match.objectLike({ PackageType: 'Image' }),
    })
    const architectures = Object.values(fns).map(
      (fn) => (fn.Properties as { Architectures?: string[] }).Architectures,
    )
    expect(architectures.length).toBeGreaterThan(0)
    for (const arch of architectures) {
      expect(arch === undefined || arch?.[0] === 'x86_64').toBe(true)
    }
  })

  it('sets Architectures to arm64 when architecture: Architecture.ARM_64 is passed', () => {
    const template = synth(false, { architecture: lambda.Architecture.ARM_64 })
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({ Architectures: ['arm64'] }),
    )
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
  // construct cannot import the runtime predicate -- `canopycms-cdk` publishes
  // with no runtime dependency on `canopycms` -- so this TEST imports it and
  // requires the two verdicts to match. The dangerous direction is a rule
  // tightened at runtime but not here: the stack would synth clean and then
  // crash-loop the Lambda at boot, which is what the synth guard exists to
  // prevent.
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
    ['deploymentName', (value) => ({ deploymentName: value })],
    ['githubTokenSecretArn', (value) => ({ githubTokenSecretArn: value })],
    ['clerkSecretKeySecretArn', (value) => ({ clerkSecretKeySecretArn: value })],
  ]

  for (const [field, build] of fields) {
    it(`rejects a newline in ${field}`, () => {
      expect(() => synth(false, build('acme\nCANOPYCMS_DEPLOYMENT_NAME=hijacked'))).toThrow(
        // deploymentName has its own (stricter) guard, which fires first.
        field === 'deploymentName' ? /invalid deploymentName/i : /must not contain a newline/i,
      )
    })

    it(`rejects an ENVEOF-bearing ${field}`, () => {
      expect(() => synth(false, build('acmeENVEOFrm'))).toThrow(/must not contain "ENVEOF"/i)
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
