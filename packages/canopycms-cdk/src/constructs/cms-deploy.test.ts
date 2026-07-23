import { describe, it, expect } from 'vitest'
import { App, Stack } from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'
import {
  aws_ecr as ecr,
  aws_lambda as lambda,
  aws_route53 as route53,
  aws_certificatemanager as acm,
  aws_s3 as s3,
} from 'aws-cdk-lib'
import { CanopyCmsService } from './cms-service'
import type { CanopyCmsServiceProps } from './cms-service'
import { CanopyCmsDistribution } from './cms-distribution'

/**
 * Synthesizes a stack with the CMS service (and optionally the distribution) so
 * the emitted CloudFormation template can be asserted against. Guards the
 * Cluster B deploy blockers: Lambda↔EFS egress (DEP-C1) and the CloudFront-only
 * Function URL (DEP-H2).
 */
function synth(withDistribution = false, overrides: Partial<CanopyCmsServiceProps> = {}): Template {
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

    // The no-cache policy (all TTLs 0) is the one that carries the cache
    // key's cookie/query-string behavior for API/editor routes.
    const noCachePolicy = configs.find((config) => config.MinTTL === 0 && config.MaxTTL === 0)
    expect(noCachePolicy).toBeDefined()
    expect(
      noCachePolicy?.ParametersInCacheKeyAndForwardedToOrigin.CookiesConfig.CookieBehavior,
    ).toBe('all')
    expect(
      noCachePolicy?.ParametersInCacheKeyAndForwardedToOrigin.QueryStringsConfig
        .QueryStringBehavior,
    ).toBe('all')
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
    const launchConfigs = template.findResources('AWS::AutoScaling::LaunchConfiguration')
    const userDataBlobs = Object.values(launchConfigs).map((lc) =>
      JSON.stringify((lc.Properties as { UserData?: unknown }).UserData),
    )
    expect(userDataBlobs.some((blob) => blob.includes('/mnt/efs/workspace'))).toBe(true)
  })
})

describe('CanopyCmsService B7: git dubious-ownership workaround', () => {
  it('sets GIT_CONFIG_* env vars so git treats the EFS-owned (uid 1000) repo as safe', () => {
    const template = synth()
    template.hasResourceProperties(
      'AWS::Lambda::Function',
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'safe.directory',
            GIT_CONFIG_VALUE_0: '*',
          }),
        }),
      }),
    )
  })
})

describe('CanopyCmsService B8: worker region resolution', () => {
  it('writes an AWS_REGION line into the worker UserData env file', () => {
    const template = synth()
    const launchConfigs = template.findResources('AWS::AutoScaling::LaunchConfiguration')
    const userDataBlobs = Object.values(launchConfigs).map((lc) =>
      JSON.stringify((lc.Properties as { UserData?: unknown }).UserData),
    )
    expect(userDataBlobs.some((blob) => /AWS_REGION=/.test(blob))).toBe(true)
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
