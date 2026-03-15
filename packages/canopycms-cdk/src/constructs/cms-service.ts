import * as path from 'node:path'
import { Construct } from 'constructs'
import {
  Duration,
  RemovalPolicy,
  aws_ec2 as ec2,
  aws_efs as efs,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_autoscaling as autoscaling,
  aws_s3_assets as s3assets,
} from 'aws-cdk-lib'

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

    // Lambda → EFS
    efsSg.addIngressRule(lambdaSg, ec2.Port.tcp(2049), 'Lambda NFS access')

    this.lambdaFunction = new lambda.DockerImageFunction(this, 'CmsFunction', {
      code: props.cmsDockerImage,
      memorySize: props.memorySize ?? 2048,
      timeout: props.timeout ?? Duration.seconds(60),
      reservedConcurrentExecutions: props.reservedConcurrency ?? 10,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      filesystem: lambda.FileSystem.fromEfsAccessPoint(accessPoint, '/mnt/efs'),
      environment: {
        CANOPYCMS_WORKSPACE_ROOT: '/mnt/efs/workspace',
        CANOPY_AUTH_CACHE_PATH: '/mnt/efs/workspace/.cache',
        ...props.environment,
      },
    })

    // Function URL for CloudFront origin
    this.functionUrl = this.lambdaFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    })

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
      '# Install dependencies',
      'yum install -y git',
      'curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -',
      'yum install -y nodejs',
      '',
      '# Mount EFS',
      'yum install -y amazon-efs-utils',
      'mkdir -p /mnt/efs',
      `mount -t efs ${this.fileSystem.fileSystemId}:/ /mnt/efs`,
      '',
      '# Download worker from CDK S3 Asset',
      `aws s3 cp s3://${workerAsset.s3BucketName}/${workerAsset.s3ObjectKey} /tmp/canopy-worker.zip`,
      'mkdir -p /opt/canopy-worker',
      'cd /opt/canopy-worker',
      'unzip -o /tmp/canopy-worker.zip',
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

    // Auto Scaling Group
    this.workerAsg = new autoscaling.AutoScalingGroup(this, 'WorkerAsg', {
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      role: workerRole,
      securityGroup: workerSg,
      minCapacity: 1,
      maxCapacity: 1,
      userData,
      spotPrice: props.spotMaxPrice ?? '0.0042', // On-demand rate for t4g.nano
      healthCheck: autoscaling.HealthCheck.ec2({
        grace: Duration.minutes(5),
      }),
    })
  }
}
