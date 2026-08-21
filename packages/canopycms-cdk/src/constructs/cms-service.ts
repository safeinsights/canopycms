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
  aws_logs as logs,
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

/**
 * Synth-time mirror of `resolveDeploymentName`'s rule in the `canopycms`
 * package (packages/canopycms/src/operating-mode/deployment-name.ts).
 * Duplicated rather than imported: `canopycms-cdk` publishes with no runtime
 * dependency on `canopycms` (it is a devDependency, used only to bundle the
 * worker), so importing it here would break the published construct.
 *
 * Drift between the two copies is caught by a test, not by this comment:
 * cms-deploy.test.ts drives both this construct and the runtime predicate over
 * the shared fixture in
 * packages/canopycms/src/operating-mode/deployment-name-fixtures.ts and
 * requires them to agree. Add a case there when you change either copy.
 */
const isValidDeploymentName = (name: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
  !name.includes('..') &&
  !name.endsWith('.') &&
  !name.endsWith('.lock')

/**
 * The heredoc delimiter user-data uses to write the worker's `.env` (see the
 * `cat > … << 'ENVEOF'` block below).
 */
const ENV_HEREDOC_DELIMITER = 'ENVEOF'

/**
 * Guard every value interpolated into the worker's `.env` file.
 *
 * This is robustness, not a security boundary: the heredoc delimiter is
 * quoted, so the shell performs no expansion on the body, and these values
 * come from the adopter's own CDK code rather than from an attacker. What it
 * catches is a malformed value silently producing a broken instance — a value
 * carrying a newline injects an arbitrary extra line into the worker's
 * environment, and a value containing the delimiter ends the heredoc early, so
 * the rest of the value is executed as user-data shell commands. Both would
 * deploy clean and fail at boot, or worse, boot with a subtly wrong
 * environment.
 *
 * Applied to every entry in `envEntries` below by construction rather than by
 * remembering to call it — the previous version validated `deploymentName`
 * only, while giving a rationale that applied verbatim to the other three
 * interpolated values.
 *
 * Returns the value so it can be used inline.
 */
function assertEnvSafe(name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `CanopyCmsService: ${name} must not contain a newline (got ${JSON.stringify(value)}). ` +
        `It is written into the worker's .env file, where a newline injects an arbitrary ` +
        `extra environment line.`,
    )
  }
  if (value.includes(ENV_HEREDOC_DELIMITER)) {
    throw new Error(
      `CanopyCmsService: ${name} must not contain ${JSON.stringify(ENV_HEREDOC_DELIMITER)} ` +
        `(got ${JSON.stringify(value)}). It is written into the worker's .env file with a ` +
        `<< '${ENV_HEREDOC_DELIMITER}' heredoc, which that value would terminate early.`,
    )
  }
  return value
}

/**
 * Default CMS Lambda timeout.
 *
 * Shared with `CanopyCmsDistribution`, which uses it as its default origin
 * read timeout: CloudFront's own default is **30 seconds**, so leaving the
 * origin unset silently caps this Lambda at half its budget. Requests in the
 * gap are answered 504 at the edge while the invocation runs to completion
 * behind them — first-touch branch provisioning does a full `git clone` onto
 * EFS inside the request, so this is a real path, not a hypothetical one.
 *
 * One constant rather than two matching literals, so the pair cannot drift;
 * `cms-deploy.test.ts` asserts the emitted template keeps them equal.
 *
 * NOTE: CloudFront accepts an origin read timeout up to 60s without a quota
 * increase. A longer Lambda timeout needs an AWS quota increase before the
 * distribution can match it — `CanopyCmsDistribution` fails at synth rather
 * than deploying a configuration that would 504.
 */
export const DEFAULT_CMS_LAMBDA_TIMEOUT = Duration.seconds(60)

/** CloudFront's maximum origin read timeout without a service-quota increase. */
export const MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT = Duration.seconds(60)

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

  /**
   * Environment variables for the Lambda function.
   *
   * Two keys are not free-form here, because the construct configures the
   * worker from the same values and the two halves must agree:
   * `CANOPYCMS_DEPLOYMENT_NAME` is folded into `deploymentName` (validated,
   * and mirrored into the worker's `.env`), and `CANOPY_MODE` accepts only
   * `'prod'`. Everything else is passed through untouched.
   */
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
   * Deployment name (default: 'prod'). Namespaces the settings branch
   * (`canopycms-settings-{deploymentName}`) so this stack's CMS Lambda/worker
   * don't fight another CanopyCMS deployment over the same orphan settings
   * branch. Stamped into the Lambda's `CANOPYCMS_DEPLOYMENT_NAME` environment
   * variable and the worker's `.env`; both resolve it through
   * `resolveDeploymentName` (packages/canopycms/src/operating-mode/deployment-name.ts),
   * which lets this env value win over any `deploymentName` baked into the
   * shared repo's `canopycms.config.ts` — the point of this prop.
   *
   * `environment.CANOPYCMS_DEPLOYMENT_NAME` still overrides this prop, but it
   * is now folded in at synth: the winner is validated by the same rule and
   * written to BOTH halves, so the Lambda and the worker can never resolve
   * different settings branches.
   *
   * Two `CanopyCmsService` stacks pointed at the SAME GitHub repo MUST set
   * distinct values here, or both resolve to `canopycms-settings-prod` and
   * fight over the same branch (permissions/groups changes reviewed on one PR
   * clobber the other). Changing this value later, on a stack that already
   * has a populated settings workspace, is refused at boot (see
   * settings-workspace.ts's rename guard) rather than silently reset — plan
   * the value up front for any stack that shares a repo.
   */
  deploymentName?: string

  /**
   * The asset bucket (from `AssetSupport`, or any bucket following its
   * prefix layout) the CMS Lambda's role should be granted access to. When
   * provided, grants the exact prefix-scoped put/get/delete permissions
   * `S3AssetStore` calls for (packages/canopycms/src/assets/store-s3.ts) -
   * mirrors `AssetSupport.grantUploadAccess()` rather than depending on that
   * construct directly, so `canopycms-cdk`'s two constructs stay decoupled.
   */
  assetBucket?: IBucket

  /**
   * Retention for the EC2 worker's CloudWatch log group (default: three
   * months).
   */
  workerLogRetention?: logs.RetentionDays

  /**
   * Name for the worker's CloudWatch log group (default:
   * `/canopycms/<stackName>/worker`). Override to follow an org naming
   * convention, or when instantiating this construct twice in one stack (the
   * default name would collide).
   */
  workerLogGroupName?: string

  /**
   * Retention for the CMS Lambda's CloudWatch log group (default: three
   * months / 90 days).
   */
  cmsLogRetention?: logs.RetentionDays

  /**
   * Name for the CMS Lambda's CloudWatch log group (default:
   * `/canopycms/<stackName>/cms`). Deliberately NOT
   * `/aws/lambda/<function-name>` - see the constructor's `cmsLogGroup`
   * comment for why a CDK-managed group must avoid that exact name once the
   * function has ever been deployed without one (CloudFormation's
   * `CreateLogGroup` call fails "already exists" against a group Lambda
   * itself auto-created outside CloudFormation). Override to follow an org
   * naming convention, or when instantiating this construct twice in one
   * stack (the default name would collide).
   */
  cmsLogGroupName?: string
}

/**
 * Core CDK construct for CanopyCMS deployment.
 *
 * Creates:
 * - VPC (2 AZs, public + private subnets, NO NAT)
 * - EFS filesystem with access point at /workspace
 * - Lambda function (Docker image, EFS mount, private subnet, no internet)
 * - Lambda Function URL (for CloudFront origin)
 * - EC2 Worker (t4g.nano spot in ASG, public subnet, EFS mount, systemd) -
 *   rolled on every deploy via the ASG's UpdatePolicy, so a changed worker
 *   bundle actually reaches the instance instead of sitting unused in a
 *   launch template until the next spot interruption (see the UpdatePolicy
 *   below)
 * - Dedicated CloudWatch log groups for the CMS Lambda and the worker's
 *   stdout/stderr (the worker's is shipped via the amazon-cloudwatch-agent -
 *   journald is not agent-readable), each with a custom name/retention/
 *   removal policy instead of the CloudFormation-implicit
 *   `/aws/lambda/<function-name>` group (infinite retention, survives
 *   `cdk destroy`)
 * - Security groups (least-privilege)
 * - IAM roles (Lambda: EFS + CloudWatch Logs write scoped to its own log
 *   group; EC2: EFS + Secrets Manager + CloudWatch Logs write, scoped to its
 *   own log group)
 */
export class CanopyCmsService extends Construct {
  /** Lambda Function URL — use as CloudFront origin */
  public readonly functionUrl: lambda.FunctionUrl

  /**
   * The CMS Lambda's resolved timeout — `props.timeout` or
   * {@link DEFAULT_CMS_LAMBDA_TIMEOUT}.
   *
   * Exposed so a distribution in front of this service can set its origin read
   * timeout to the SAME value. CloudFront's own default is 30s, which silently
   * caps a longer Lambda: every request landing in the gap is answered 504 at
   * the edge while the invocation runs to completion behind it (see
   * `CanopyCmsDistribution`'s `originReadTimeout`).
   */
  public readonly timeout: Duration

  /** The EFS filesystem */
  public readonly fileSystem: efs.FileSystem

  /** The VPC */
  public readonly vpc: ec2.IVpc

  /** The Lambda function */
  public readonly lambdaFunction: lambda.Function

  /** The CMS Lambda's CloudWatch log group (Lambda stdout/stderr) */
  public readonly cmsLogGroup: logs.LogGroup

  /** The EC2 worker Auto Scaling Group */
  public readonly workerAsg: autoscaling.AutoScalingGroup

  /** The EC2 worker's CloudWatch log group (worker stdout/stderr) */
  public readonly workerLogGroup: logs.LogGroup

  constructor(scope: Construct, id: string, props: CanopyCmsServiceProps) {
    super(scope, id)

    // ------------------------------------------------------------------
    // Deployment name: ONE effective value, validated once, used by both halves
    // ------------------------------------------------------------------
    //
    // `props.environment` is spread into the Lambda's environment, so an
    // adopter can set CANOPYCMS_DEPLOYMENT_NAME there directly. That escape
    // hatch used to bypass both things that make this prop safe: the synth
    // guard below (an invalid value deployed clean and crash-looped the Lambda
    // at boot) and the worker, which kept reading `props.deploymentName` and so
    // resolved a DIFFERENT settings branch than the Lambda — exactly the split
    // that `pushSettingsBranches`'s [SYNC-M3] warning was added to detect.
    //
    // Kept rather than dropped (dropping is a breaking change for anyone
    // already setting it), but resolved to a single value here: whatever wins
    // is validated, and the same string is stamped on the Lambda AND written
    // into the worker's `.env` below. The two halves cannot disagree.
    const envDeploymentNameOverride = props.environment?.['CANOPYCMS_DEPLOYMENT_NAME']
    const deploymentName = envDeploymentNameOverride ?? props.deploymentName ?? 'prod'
    const deploymentNameSource =
      envDeploymentNameOverride !== undefined
        ? 'environment.CANOPYCMS_DEPLOYMENT_NAME'
        : 'deploymentName'

    // Fail at synth, not at boot. deploymentName is interpolated BOTH into a
    // git ref (`canopycms-settings-{deploymentName}`) and into a line of the
    // worker's `.env`, which user-data writes with a shell heredoc — a value
    // carrying a newline or quote would corrupt the worker's environment file
    // before any runtime validation could run. Mirrors the package-side rule
    // in operating-mode/deployment-name.ts (resolveDeploymentName); the
    // fixture-driven drift test named above keeps the two in step.
    if (!isValidDeploymentName(deploymentName)) {
      throw new Error(
        `CanopyCmsService: invalid deploymentName ${JSON.stringify(deploymentName)} ` +
          `(from ${deploymentNameSource}). ` +
          `It must start with a letter or digit, contain only letters, digits, '.', '_' or '-', ` +
          `and must not contain '..' or end with '.' or '.lock'.`,
      )
    }

    // ------------------------------------------------------------------
    // Operating mode
    // ------------------------------------------------------------------
    //
    // The adopter's `canopycms.config.ts` is shared by local dev, the image
    // build and this deployment, and it must say `dev` for the first two (a
    // prod-mode `next build` would try to open an EFS branch workspace that
    // cannot exist in an image builder). So the deployed mode is supplied
    // here, at run time: `resolveOperatingMode`
    // (packages/canopycms/src/operating-mode/mode-env.ts) reads CANOPY_MODE
    // and it wins over the config literal. Without it the Lambda runs dev
    // mode, resolves its workspace to `<cwd>/.canopy-dev`, and fails EROFS on
    // Lambda's read-only filesystem.
    //
    // Only 'prod' is accepted from `props.environment`: this construct deploys
    // the prod topology (EFS workspace, no internet, read-only container), and
    // 'dev' there cannot work — better a synth error than an EROFS crash-loop.
    // The browser half of `mode` cannot come from here at all; it is inlined
    // at image-build time from the NEXT_PUBLIC_CANOPY_MODE build arg (see
    // Dockerfile.cms.template and the generated cms-stack.ts).
    const envModeOverride = props.environment?.['CANOPY_MODE']
    if (envModeOverride !== undefined && envModeOverride !== 'prod') {
      throw new Error(
        `CanopyCmsService: invalid environment.CANOPY_MODE ${JSON.stringify(envModeOverride)}. ` +
          `This construct deploys the prod topology, so the only supported value is "prod" ` +
          `(dev mode resolves its workspace to <cwd>/.canopy-dev, which is read-only on Lambda). ` +
          `Omit it to get the default.`,
      )
    }

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

    // Dedicated CloudWatch log group for the CMS Lambda's stdout/stderr.
    // Custom name (NOT the CloudFormation-implicit `/aws/lambda/<function
    // name>`), for two reasons: (1) CDK does not manage that implicit group
    // at all - infinite retention, and `cdk destroy` leaves it behind (the
    // deploy-test teardown had to sweep it manually); (2) Lambda auto-creates
    // `/aws/lambda/<function name>` on first invoke, OUTSIDE CloudFormation -
    // once that has happened (e.g. this stack was already deployed before
    // this log group existed), a CDK `LogGroup` construct using that exact
    // name would fail its `CreateLogGroup` call with "already exists" and
    // block every future `cdk deploy`. Mirrors `workerLogGroup` below, which
    // predates this and already follows the same convention.
    this.cmsLogGroup = new logs.LogGroup(this, 'CmsFunctionLogs', {
      logGroupName: props.cmsLogGroupName ?? `/canopycms/${Stack.of(this).stackName}/cms`,
      retention: props.cmsLogRetention ?? logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    this.timeout = props.timeout ?? DEFAULT_CMS_LAMBDA_TIMEOUT

    this.lambdaFunction = new lambda.DockerImageFunction(this, 'CmsFunction', {
      code: props.cmsDockerImage,
      memorySize: props.memorySize ?? 2048,
      timeout: this.timeout,
      reservedConcurrentExecutions: props.reservedConcurrency ?? 10,
      architecture: props.architecture,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      filesystem: lambda.FileSystem.fromEfsAccessPoint(accessPoint, '/mnt/efs'),
      // Pass the pre-created group via `logGroup`, NOT `logRetention` (CDK
      // throws LogRetentionLogGroupConflict/ConflictingLogPolicyOptions if
      // both are set on the same function) - the removal policy lives on the
      // LogGroup construct above instead.
      logGroup: this.cmsLogGroup,
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
        // AFTER the spread, deliberately. Both values are already the
        // adopter's own choice (an `environment` override is folded into
        // `deploymentName` above and validated; CANOPY_MODE is restricted to
        // 'prod'), so nothing is being taken away here - what the placement
        // buys is that the Lambda and the worker's `.env` cannot end up
        // holding different strings, which is the failure mode that made this
        // an escape hatch worth fixing rather than a harmless one.
        CANOPYCMS_DEPLOYMENT_NAME: deploymentName,
        CANOPY_MODE: 'prod',
      },
    })

    // Explicit, scoped grant - NOT a reliance on the auto-created execution
    // role's AWSLambdaBasicExecutionRole managed policy (attached by CDK's
    // lambda.Function/DockerImageFunction regardless of `logGroup`, and
    // never adjusted for it - passing `logGroup` only points the function's
    // LoggingConfig at this group, it grants no IAM permissions). That
    // managed policy's logs:CreateLogStream/logs:PutLogEvents statement is
    // scoped to `arn:aws:logs:*:*:log-group:/aws/lambda/*:*` only (its
    // logs:CreateLogGroup statement is the sole one that's unrestricted) -
    // it grants nothing for a custom-named group like this one. Without this
    // grantWrite, the function would still create log streams to the void:
    // CloudWatch Logs delivery failures are never surfaced to the function's
    // own invocation, so logs would simply vanish with no error anywhere.
    this.cmsLogGroup.grantWrite(this.lambdaFunction)

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

    // Dedicated CloudWatch log group for the worker's stdout/stderr (shipped by
    // the CloudWatch agent in user-data below - the agent cannot read journald,
    // so the systemd unit is switched to file output further down).
    this.workerLogGroup = new logs.LogGroup(this, 'WorkerLogs', {
      logGroupName: props.workerLogGroupName ?? `/canopycms/${Stack.of(this).stackName}/worker`,
      retention: props.workerLogRetention ?? logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    })
    // CreateLogStream + PutLogEvents scoped to this group only (least privilege;
    // the group is pre-created by CFN so the agent never needs CreateLogGroup).
    this.workerLogGroup.grantWrite(workerRole)

    // Worker S3 Asset — upload bundled worker code to CDK assets bucket
    // The worker is bundled with esbuild into a single JS file (npm run build:worker)
    const workerAsset = new s3assets.Asset(this, 'WorkerCode', {
      path: path.join(__dirname, '../../worker/dist'),
    })
    workerAsset.grantRead(workerRole)

    // Build worker .env file content from CDK props.
    //
    // Name/value PAIRS rather than pre-formatted lines: every value then flows
    // through `assertEnvSafe` in the single `map` below, so a value added here
    // later is guarded whether or not whoever adds it remembers to.
    const envEntries: Array<[string, string]> = [
      ['CANOPYCMS_WORKSPACE_ROOT', '/mnt/efs/workspace'],
      ['CANOPYCMS_GITHUB_OWNER', props.githubOwner],
      ['CANOPYCMS_GITHUB_REPO', props.githubRepo],
      ['CANOPYCMS_BASE_BRANCH', props.baseBranch ?? 'main'],
      // The SAME string the Lambda's environment gets above, including an
      // `environment.CANOPYCMS_DEPLOYMENT_NAME` override - the two halves
      // resolve one settings branch (`canopycms-settings-<name>`) between them,
      // and disagreeing here is what [SYNC-M3] warns about at runtime.
      ['CANOPYCMS_DEPLOYMENT_NAME', deploymentName],
      // B8: the AWS SDK JS v3 cannot resolve a region from IMDS on its own -
      // without this the worker's bare `SecretsManagerClient({})` crash-loops
      // with "Region is missing".
      ['AWS_REGION', Stack.of(this).region],
    ]
    if (props.githubTokenSecretArn) {
      envEntries.push(['CANOPYCMS_GITHUB_TOKEN_SECRET_ARN', props.githubTokenSecretArn])
    }
    if (props.clerkSecretKeySecretArn) {
      envEntries.push(['CLERK_SECRET_KEY_SECRET_ARN', props.clerkSecretKeySecretArn])
    }
    const envFileContent = envEntries
      .map(([name, value]) => `${name}=${assertEnvSafe(name, value)}`)
      .join('\n')

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
      '# File output, not journal: the CloudWatch agent cannot read journald,',
      '# so it tails this file instead (see the agent config below).',
      '# CAUTION: /var/log/canopy-worker must exist BEFORE first start. systemd',
      '# opens append: targets before it creates LogsDirectory= dirs',
      '# (systemd#27591), so without the pre-created dir the exec fails with',
      '# 209/STDOUT and Restart=always crash-loops forever. User-data runs',
      '# mkdir before systemctl start; LogsDirectory= is kept for ownership.',
      'LogsDirectory=canopy-worker',
      'StandardOutput=append:/var/log/canopy-worker/worker.log',
      'StandardError=append:/var/log/canopy-worker/worker.log',
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
      '# Pre-create the worker log dir (crash-loop guard, MUST precede the',
      '# first systemctl start): systemd opens StandardOutput=append: files',
      '# BEFORE it creates LogsDirectory= dirs (systemd#27591), so on a fresh',
      '# instance the unit would fail exec with 209/STDOUT and crash-loop',
      '# forever without this. The unit keeps LogsDirectory= for ownership',
      '# management on subsequent starts.',
      'mkdir -p /var/log/canopy-worker',
      'chown ec2-user:ec2-user /var/log/canopy-worker',
      '',
      '# Start worker',
      'systemctl daemon-reload',
      'systemctl enable canopy-worker',
      'systemctl start canopy-worker',
      '',
      '# ---- CloudWatch log shipping ----',
      '# Placed AFTER worker start: with set -euo pipefail, a yum/agent failure',
      '# here must not prevent the worker from running (shipping is best-effort).',
      'yum install -y amazon-cloudwatch-agent logrotate',
      '',
      '# Bound on-disk growth; copytruncate keeps the fd the CW agent tails valid',
      '# (tiny copy->truncate loss window is acceptable for diagnostic logs).',
      `cat > /etc/logrotate.d/canopy-worker << 'ROTEOF'`,
      '/var/log/canopy-worker/worker.log {',
      '    size 10M',
      '    rotate 5',
      '    compress',
      '    copytruncate',
      '    missingok',
      '    notifempty',
      '}',
      'ROTEOF',
      '# The config above only fires when logrotate actually runs; AL2023',
      '# presets may leave logrotate.timer disabled, and without it the size',
      '# cap never triggers and worker.log grows until the nano disk fills.',
      '# --now is idempotent if the timer is already enabled/running.',
      'systemctl enable --now logrotate.timer',
      '',
      '# No retention_in_days here: CDK owns retention on the pre-created group.',
      `cat > /opt/aws/amazon-cloudwatch-agent/etc/canopy-worker-logs.json << 'CWEOF'`,
      '{',
      '  "logs": {',
      '    "logs_collected": {',
      '      "files": {',
      '        "collect_list": [',
      '          {',
      '            "file_path": "/var/log/canopy-worker/worker.log",',
      `            "log_group_name": "${this.workerLogGroup.logGroupName}",`,
      '            "log_stream_name": "{instance_id}",',
      // The worker prefixes every line with an ISO-8601 timestamp
      // (packages/canopycms/src/worker/log.ts). Parsing it here is what makes
      // CloudWatch show the time the WORKER emitted a line rather than the
      // time the agent shipped it - those diverge exactly when it matters
      // (agent hiccup, buffered burst, post-restart backlog).
      '            "timestamp_format": "%Y-%m-%dT%H:%M:%S.%f",',
      // The prefix ends in `Z`, so the parsed time is UTC. Without this the
      // agent would interpret it in the instance's local zone.
      '            "timezone": "UTC",',
      // "{timestamp_format}" reuses the pattern above as the multi-line start
      // marker: a line WITHOUT the timestamp prefix continues the previous
      // event instead of becoming its own. That is what keeps a stack trace as
      // one CloudWatch event, and why every writer to this file must go
      // through the worker log helpers.
      '            "multi_line_start_pattern": "{timestamp_format}"',
      '          }',
      '        ]',
      '      }',
      '    }',
      '  }',
      '}',
      'CWEOF',
      '# fetch-config -s starts AND systemctl-enables the agent (reboot-persistent).',
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/canopy-worker-logs.json',
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
      // Without an updatePolicy, CloudFormation's default behavior for an ASG
      // behind a changed launch template is to update the template resource
      // and do NOTHING else - the running instance keeps its old user-data
      // (and therefore the old worker code: the worker bundle is a CDK S3
      // asset whose hash is interpolated into user-data's `aws s3 cp
      // s3://...`) until a spot interruption or a manual terminate happens
      // to replace it. `cdk deploy` would then silently deploy everything
      // EXCEPT the worker. `rollingUpdate` makes CloudFormation actually
      // terminate-and-relaunch the instance on every deploy that changes the
      // launch template, so a worker code change actually reaches it.
      //
      // minInstancesInService: 0 is REQUIRED, not just accepted, because
      // minCapacity/maxCapacity are both 1: there is no way to keep an
      // instance "in service" out of a max of 1 while its replacement is
      // being created. The update is therefore terminate-then-relaunch, with
      // a short worker outage while the replacement boots (yum install
      // git/unzip/nodejs/efs-utils, mount EFS - realistically 2-4 minutes).
      // That outage is acceptable: the task queue and branch workspaces live
      // on EFS, not on the instance, so the new instance picks up exactly
      // where the old one left off; the Lambda's Save/Publish paths only
      // enqueue task files onto EFS and never talk to the worker directly,
      // so they are unaffected by the worker being briefly down. A task that
      // was actually mid-flight when the old instance was terminated is
      // handled by orphan recovery now running on every task-queue cycle,
      // not only at worker boot (see recoverOrphanedTasks's call site in
      // CmsWorker.processTaskQueue(), packages/canopycms/src/worker/cms-worker.ts).
      //
      // Deliberately NOT paired with a `signals`/cfn-signal setup (and
      // `waitOnResourceSignals` therefore defaults to false here, so this
      // rolling update does not wait on one): see the comment below.
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({ minInstancesInService: 0 }),
    })

    // Why this PR does NOT add cfn-signal, despite the rolling update above
    // now making instance replacement routine instead of rare:
    //
    // 1. User-data runs under `set -euo pipefail`, and the CloudWatch-agent
    //    block is placed at the very end ON PURPOSE (see that block's own
    //    comment) so an agent failure there cannot kill the boot. A
    //    cfn-signal placed after it would then never run when that block
    //    fails, and CloudFormation would wait out its own timeout and
    //    fail/roll back the ENTIRE deploy - the opposite of the intent
    //    (agent shipping is best-effort; the worker itself must not be
    //    blocked by it).
    // 2. Even placed earlier (right after `systemctl start canopy-worker`),
    //    a signal there would prove almost nothing: the systemd unit is
    //    `Type=simple` with `Restart=always`, so `systemctl start` returns 0
    //    the instant the process execs, regardless of what happens next. A
    //    worker that immediately crash-loops (bad env, bad bundle) would
    //    still signal SUCCESS. A real readiness gate would have to poll
    //    `worker-status.json` or `systemctl is-active` in a loop before
    //    signaling - a bigger change than this PR should carry.
    //
    // recoverOrphanedTasks()'s per-cycle recovery (see above) is the
    // intentionally simpler fix for the actual problem (a stranded task
    // surviving an instance replacement) - it works regardless of WHY the
    // instance was replaced (rolling update, spot interruption, manual
    // terminate) and does not depend on the new instance ever proving
    // "ready" in the first place.

    // Boot ordering: the ASG can launch before EFS mount targets are
    // available; user-data runs with `set -euo pipefail`, so an early
    // `mount -t efs` failure kills the whole bootstrap and the
    // EC2-health-checked ASG never notices.
    this.workerAsg.node.addDependency(this.fileSystem.mountTargetsAvailable)
  }
}
