import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Construct } from 'constructs'
import {
  Duration,
  RemovalPolicy,
  Stack,
  aws_ec2 as ec2,
  aws_efs as efs,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_autoscaling as autoscaling,
  aws_s3_assets as s3assets,
} from 'aws-cdk-lib'
import type { IBucket } from 'aws-cdk-lib/aws-s3'

// This package (`canopycms-cdk`) is `"type": "module"`, so its compiled
// output is real ESM - `__dirname` is not a global there. Found while
// fixing this construct's B1 deploy blocker below: the worker asset path a
// few lines down threw `__dirname is not defined` under a real ESM runtime
// (e.g. `tsx`) - masked in this file's own tests only because Vitest's
// SSR/CJS-interop transform shims `__dirname` automatically. Same fix as
// ../../lambda/asset-transform/build.mjs and ./asset-support.ts.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface CanopyCmsServiceProps {
  /** Docker image for the CMS Lambda function */
  cmsDockerImage: lambda.DockerImageCode

  /** Optional: use an existing VPC instead of creating one */
  vpc?: ec2.IVpc

  /** Lambda memory in MB (default: 2048) */
  memorySize?: number

  /** Lambda timeout (default: 60 seconds) */
  timeout?: Duration

  /** Lambda reserved concurrency cap (default: 10) */
  reservedConcurrency?: number

  /**
   * Lambda architecture (default: `Architecture.X86_64`, Lambda's own
   * default). MUST match the platform the Docker image was built for - e.g.
   * an image built for `Platform.LINUX_ARM64` requires
   * `Architecture.ARM_64` here, or the function fails at invoke time with
   * an exec format error.
   */
  architecture?: lambda.Architecture

  /** EC2 spot max price (default: on-demand rate for t4g.nano) */
  spotMaxPrice?: string

  /** Secrets Manager ARNs the worker needs to read (GitHub token, Clerk key) */
  secretsArns?: string[]

  /** Environment variables for the Lambda function */
  environment?: Record<string, string>

  /** EFS removal policy (default: RETAIN) */
  efsRemovalPolicy?: RemovalPolicy

  /** GitHub owner for worker git operations (e.g., 'safeinsights') */
  githubOwner: string

  /** GitHub repo name for worker git operations (e.g., 'docs-site') */
  githubRepo: string

  /** Secrets Manager ARN for the GitHub bot token */
  githubTokenSecretArn?: string

  /** Secrets Manager ARN for the Clerk secret key */
  clerkSecretKeySecretArn?: string

  /** Base branch name (default: 'main') */
  baseBranch?: string

  /**
   * The asset bucket (from `AssetSupport`, or any bucket following its
   * prefix layout) the CMS Lambda's role should be granted access to. When
   * provided, grants the exact prefix-scoped put/get/delete permissions
   * `S3AssetStore` calls for (packages/canopycms/src/assets/store-s3.ts) -
   * mirrors `AssetSupport.grantUploadAccess()` rather than depending on that
   * construct directly, so `canopycms-cdk`'s two constructs stay decoupled.
   */
  assetBucket?: IBucket
}

/**
 * Core CDK construct for CanopyCMS deployment.
 *
 * Creates:
 * - VPC (2 AZs, public + private subnets, NO NAT)
 * - EFS filesystem with access point at /workspace
 * - Lambda function (Docker image, EFS mount, private subnet, no internet)
 * - Lambda Function URL (for CloudFront origin)
 * - EC2 Worker (t4g.nano spot in ASG, public subnet, EFS mount, systemd)
 * - Security groups (least-privilege)
 * - IAM roles (Lambda: EFS only; EC2: EFS + Secrets Manager)
 */
export class CanopyCmsService extends Construct {
  /** Lambda Function URL — use as CloudFront origin */
  public readonly functionUrl: lambda.FunctionUrl

  /** The EFS filesystem */
  public readonly fileSystem: efs.FileSystem

  /** The VPC */
  public readonly vpc: ec2.IVpc

  /** The Lambda function */
  public readonly lambdaFunction: lambda.Function

  /** The EC2 worker Auto Scaling Group */
  public readonly workerAsg: autoscaling.AutoScalingGroup

  constructor(scope: Construct, id: string, props: CanopyCmsServiceProps) {
    super(scope, id)

    // ========================================================================
    // VPC — 2 AZs, public + private subnets, NO NAT
    // ========================================================================

    this.vpc =
      props.vpc ??
      new ec2.Vpc(this, 'Vpc', {
        maxAzs: 2,
        natGateways: 0, // No NAT — Lambda has no internet access
        subnetConfiguration: [
          {
            name: 'Public',
            subnetType: ec2.SubnetType.PUBLIC,
            cidrMask: 24,
          },
          {
            name: 'Private',
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            cidrMask: 24,
          },
        ],
      })

    // Gateway VPC endpoint for S3 (free - no hourly/data charge, unlike an
    // interface endpoint). Without this the PRIVATE_ISOLATED subnet has NO
    // route to S3 at all (no NAT, no IGW) - the CMS Lambda's S3AssetStore
    // calls (presigned POST generation, finalize's originals/meta writes)
    // would hang/fail outright (adversarial finding B1). `addGatewayEndpoint`
    // is on `IVpc` itself, so this works whether `this.vpc` was created here
    // or supplied via `props.vpc`.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    })

    // ========================================================================
    // EFS — persistent filesystem for content, git repos, cache
    // ========================================================================

    const efsSg = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc: this.vpc,
      description: 'CanopyCMS EFS',
      allowAllOutbound: false,
    })

    this.fileSystem = new efs.FileSystem(this, 'FileSystem', {
      vpc: this.vpc,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      removalPolicy: props.efsRemovalPolicy ?? RemovalPolicy.RETAIN,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroup: efsSg,
    })

    const accessPoint = this.fileSystem.addAccessPoint('WorkspaceAP', {
      path: '/workspace',
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '755',
      },
      posixUser: {
        gid: '1000',
        uid: '1000',
      },
    })

    // ========================================================================
    // Lambda — CMS app, private subnet, no internet, EFS mount
    // ========================================================================

    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'CanopyCMS Lambda',
      allowAllOutbound: false, // No internet access
    })

    // Lambda ↔ EFS (ingress on EFS SG + egress on Lambda SG).
    // The Lambda SG is allowAllOutbound: false, so without the explicit egress
    // rule the NFS mount is blocked and every Lambda request fails to reach
    // /mnt/efs (DEP-C1). Mirrors the worker's ingress+egress pair below.
    efsSg.addIngressRule(lambdaSg, ec2.Port.tcp(2049), 'Lambda NFS access')
    lambdaSg.addEgressRule(efsSg, ec2.Port.tcp(2049), 'NFS to EFS')

    // Lambda -> S3 (via the gateway endpoint above), HTTPS only. The tight
    // option - `ec2.Peer.prefixList(<S3 managed prefix list id>)` - needs a
    // region-specific literal id (there is no CFN attribute exposing it off
    // `GatewayVpcEndpoint`, and `PrefixList.fromLookup` does a real AWS
    // context-provider lookup at synth time, which would make this
    // construct's synth require live AWS credentials - unacceptable for a
    // construct whose own unit tests synth with a fake account/region).
    // `anyIpv4()` on 443 is safe here specifically because the route table
    // for this PRIVATE_ISOLATED subnet has no route to 0.0.0.0/0 at all (no
    // NAT, no IGW) - only to the VPC CIDR and to configured endpoints'
    // prefix-list routes - so this rule cannot actually reach the general
    // internet; the route table, not the security group, is the real
    // boundary here. Narrow this to `Peer.prefixList(...)` if/when a
    // region-agnostic way to reference the S3 managed prefix list lands in
    // CDK, or if this VPC ever gains a NAT/IGW route.
    lambdaSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS to S3 (via gateway endpoint)',
    )

    this.lambdaFunction = new lambda.DockerImageFunction(this, 'CmsFunction', {
      code: props.cmsDockerImage,
      memorySize: props.memorySize ?? 2048,
      timeout: props.timeout ?? Duration.seconds(60),
      reservedConcurrentExecutions: props.reservedConcurrency ?? 10,
      architecture: props.architecture,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      filesystem: lambda.FileSystem.fromEfsAccessPoint(accessPoint, '/mnt/efs'),
      environment: {
        // INVARIANT (B1): the Lambda mounts EFS through the WorkspaceAP access
        // point above, which is already rooted at EFS:/workspace - so /mnt/efs
        // here IS EFS:/workspace. The EC2 worker instead mounts the filesystem
        // ROOT at /mnt/efs (see UserData below) and reaches the same directory
        // via /mnt/efs/workspace. Both paths must resolve to EFS:/workspace,
        // or the Lambda and worker silently operate on different directories.
        CANOPYCMS_WORKSPACE_ROOT: '/mnt/efs',
        CANOPY_AUTH_CACHE_PATH: '/mnt/efs/.cache',
        // B7 note: git >= 2.35.2 refuses repos owned by another uid (the
        // access point forces uid 1000; Lambda containers run as a different
        // user). Env-based GIT_CONFIG_* CANNOT fix this - simple-git
        // hard-blocks env config (deploy-proven 2026-07-24). The fix lives in
        // the image: Dockerfile.cms.template runs
        // `git config --system safe.directory '*'`.
        ...props.environment,
      },
    })

    // Function URL for CloudFront origin.
    // AWS_IAM (not NONE): the URL must only be reachable through CloudFront,
    // which signs origin requests via Origin Access Control (see
    // CanopyCmsDistribution). With NONE, anyone who learns the URL hits the CMS
    // directly, bypassing CloudFront (DEP-H2). Adopters wiring their own
    // CloudFront must configure an OAC and grant it lambda:InvokeFunctionUrl.
    this.functionUrl = this.lambdaFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    })

    // Asset bucket access (optional) - grants the CMS Lambda's role the same
    // prefix-scoped put/get/delete permissions `AssetSupport.grantUploadAccess()`
    // grants, without this construct depending on `AssetSupport` directly
    // (kept decoupled - a consumer wires both constructs together in their
    // own stack). Duplicated rather than shared because the two constructs
    // must stay independently usable (`AssetSupport` has no CMS-service
    // dependency either).
    if (props.assetBucket) {
      const prefixes = {
        staging: 'asset-staging',
        originals: 'asset-originals',
        meta: 'asset-meta',
        public: 'assets',
      }
      props.assetBucket.grantPut(this.lambdaFunction, `${prefixes.staging}/*`)
      props.assetBucket.grantRead(this.lambdaFunction, `${prefixes.staging}/*`)
      props.assetBucket.grantRead(this.lambdaFunction, `${prefixes.originals}/*`)
      props.assetBucket.grantRead(this.lambdaFunction, `${prefixes.meta}/*`)
      props.assetBucket.grantRead(this.lambdaFunction, `${prefixes.public}/*`)
      props.assetBucket.grantPut(this.lambdaFunction, `${prefixes.originals}/*`)
      props.assetBucket.grantPut(this.lambdaFunction, `${prefixes.meta}/*`)
      props.assetBucket.grantPut(this.lambdaFunction, `${prefixes.public}/*`)
      props.assetBucket.grantDelete(this.lambdaFunction, `${prefixes.staging}/*`)
      props.assetBucket.grantDelete(this.lambdaFunction, `${prefixes.meta}/*`)
    }

    // ========================================================================
    // EC2 Worker — t4g.nano spot, public subnet, internet, EFS mount
    // ========================================================================

    const workerSg = new ec2.SecurityGroup(this, 'WorkerSg', {
      vpc: this.vpc,
      description: 'CanopyCMS EC2 Worker',
      allowAllOutbound: false,
    })

    // Worker ↔ EFS (ingress on EFS SG + egress on Worker SG)
    efsSg.addIngressRule(workerSg, ec2.Port.tcp(2049), 'Worker NFS access')
    workerSg.addEgressRule(efsSg, ec2.Port.tcp(2049), 'NFS to EFS')

    // Worker → internet (HTTPS only)
    workerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS outbound')

    // Worker → DNS (needed for EFS DNS-based mount targets)
    workerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(53), 'DNS TCP')
    workerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53), 'DNS UDP')

    // Worker IAM role
    const workerRole = new iam.Role(this, 'WorkerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'CanopyCMS EC2 Worker role',
    })

    // Worker needs to read secrets
    if (props.secretsArns && props.secretsArns.length > 0) {
      workerRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: props.secretsArns,
        }),
      )
    }

    // Worker needs EFS access (handled via security group, but mount needs ec2:DescribeAvailabilityZones)
    workerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonElasticFileSystemClientReadWriteAccess'),
    )

    // Observation channel for a NAT-less deploy (SSM Session Manager / send-command);
    // worker SG already allows 443 egress.
    workerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    )

    // Worker S3 Asset — upload bundled worker code to CDK assets bucket
    // The worker is bundled with esbuild into a single JS file (npm run build:worker)
    const workerAsset = new s3assets.Asset(this, 'WorkerCode', {
      path: path.join(__dirname, '../../worker/dist'),
    })
    workerAsset.grantRead(workerRole)

    // Build worker .env file content from CDK props
    const envLines = [
      `CANOPYCMS_WORKSPACE_ROOT=/mnt/efs/workspace`,
      `CANOPYCMS_GITHUB_OWNER=${props.githubOwner}`,
      `CANOPYCMS_GITHUB_REPO=${props.githubRepo}`,
      `CANOPYCMS_BASE_BRANCH=${props.baseBranch ?? 'main'}`,
      // B8: the AWS SDK JS v3 cannot resolve a region from IMDS on its own -
      // without this the worker's bare `SecretsManagerClient({})` crash-loops
      // with "Region is missing".
      `AWS_REGION=${Stack.of(this).region}`,
    ]
    if (props.githubTokenSecretArn) {
      envLines.push(`CANOPYCMS_GITHUB_TOKEN_SECRET_ARN=${props.githubTokenSecretArn}`)
    }
    if (props.clerkSecretKeySecretArn) {
      envLines.push(`CLERK_SECRET_KEY_SECRET_ARN=${props.clerkSecretKeySecretArn}`)
    }
    const envFileContent = envLines.join('\n')

    // UserData script
    const userData = ec2.UserData.forLinux()
    userData.addCommands(
      '#!/bin/bash',
      'set -euo pipefail',
      '',
      '# Install dependencies (unzip is not guaranteed in the AL2023 AMI)',
      'yum install -y git unzip',
      'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -',
      'yum install -y nodejs',
      '',
      '# Mount EFS',
      'yum install -y amazon-efs-utils',
      'mkdir -p /mnt/efs',
      `mount -t efs ${this.fileSystem.fileSystemId}:/ /mnt/efs`,
      '# Persist the mount across instance reboots: user-data runs once per',
      '# instance, so without an fstab entry a plain reboot leaves /mnt/efs an',
      '# empty local dir and the worker would clone a divergent remote.git',
      '# onto the instance disk, invisible to the Lambda.',
      `echo '${this.fileSystem.fileSystemId}:/ /mnt/efs efs _netdev 0 0' >> /etc/fstab`,
      '',
      '# Download worker from CDK S3 Asset',
      `aws s3 cp s3://${workerAsset.s3BucketName}/${workerAsset.s3ObjectKey} /tmp/canopy-worker.zip`,
      'mkdir -p /opt/canopy-worker',
      'cd /opt/canopy-worker',
      'unzip -o /tmp/canopy-worker.zip',
      '# The worker bundle is ESM (esbuild --format=esm). Node 20 treats .js as',
      '# CommonJS without this marker and crash-loops on the import statement',
      '# (Node >=22.7 auto-detects and masks the bug locally).',
      `echo '{"type":"module"}' > /opt/canopy-worker/package.json`,
      '',
      '# Write environment file for systemd service',
      `cat > /opt/canopy-worker/.env << 'ENVEOF'`,
      envFileContent,
      'ENVEOF',
      '',
      '# Create systemd service',
      `cat > /etc/systemd/system/canopy-worker.service << 'SVCEOF'`,
      '[Unit]',
      'Description=CanopyCMS Worker Daemon',
      'After=network.target',
      '# Never run against an unmounted /mnt/efs (see the fstab note above).',
      'RequiresMountsFor=/mnt/efs',
      '',
      '[Service]',
      'Type=simple',
      'User=ec2-user',
      'WorkingDirectory=/opt/canopy-worker',
      'ExecStart=/usr/bin/node index.js',
      'Restart=always',
      'RestartSec=5',
      'TimeoutStartSec=300',
      'StandardOutput=journal',
      'StandardError=journal',
      'EnvironmentFile=/opt/canopy-worker/.env',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'SVCEOF',
      '',
      '# Set ownership for ec2-user',
      'chown -R ec2-user:ec2-user /opt/canopy-worker',
      '# Non-recursive: EFS access point enforces UID 1000 for Lambda.',
      '# Only set ownership on mount point and workspace dir to avoid',
      '# slow recursive chown on large filesystems during ASG replacements.',
      'chown ec2-user:ec2-user /mnt/efs',
      'mkdir -p /mnt/efs/workspace',
      'chown ec2-user:ec2-user /mnt/efs/workspace',
      '',
      '# Start worker',
      'systemctl daemon-reload',
      'systemctl enable canopy-worker',
      'systemctl start canopy-worker',
    )

    // Launch template (not the deprecated AutoScalingGroup instanceType/
    // machineImage/... shorthand): that shorthand synthesizes an
    // AWS::AutoScaling::LaunchConfiguration, which AWS accounts created after
    // ~mid-2023 cannot create at all — `cdk deploy` would hard-fail for any
    // fresh adopter account. An explicit LaunchTemplate synthesizes
    // AWS::EC2::LaunchTemplate instead, which every account can use.
    const launchTemplate = new ec2.LaunchTemplate(this, 'WorkerLaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      role: workerRole,
      securityGroup: workerSg,
      userData,
      spotOptions: {
        requestType: ec2.SpotRequestType.ONE_TIME, // required for ASG-managed spot
        maxPrice: parseFloat(props.spotMaxPrice ?? '0.0042'), // On-demand rate for t4g.nano
      },
    })

    // Auto Scaling Group
    this.workerAsg = new autoscaling.AutoScalingGroup(this, 'WorkerAsg', {
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate,
      minCapacity: 1,
      maxCapacity: 1,
      healthCheck: autoscaling.HealthCheck.ec2({
        grace: Duration.minutes(5),
      }),
    })

    // Boot ordering: the ASG can launch before EFS mount targets are
    // available; user-data runs with `set -euo pipefail`, so an early
    // `mount -t efs` failure kills the whole bootstrap and the
    // EC2-health-checked ASG never notices.
    this.workerAsg.node.addDependency(this.fileSystem.mountTargetsAvailable)
  }
}
