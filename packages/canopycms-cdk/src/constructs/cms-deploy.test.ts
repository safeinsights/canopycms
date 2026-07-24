import { describe, it, expect } from 'vitest'
import { App, Stack } from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { RetentionDays } from 'aws-cdk-lib/aws-logs'
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
    expect(all).toContain('yum install -y git unzip')
    expect(all).toContain('{\\"type\\":\\"module\\"}')
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
    expect(all).toContain('yum install -y amazon-cloudwatch-agent')
    expect(all).toContain('/var/log/canopy-worker/worker.log')
    expect(all).toContain('\\"log_stream_name\\": \\"{instance_id}\\"')
    expect(all).toContain('amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s')
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
      // after worker start under set -euo pipefail — the yum install is the
      // first (and most failure-prone: network + repo) command of that block,
      // so pin it explicitly, not just the final ctl call.
      const yumIdx = blob.indexOf('yum install -y amazon-cloudwatch-agent')
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
