import { aws_iam as iam } from 'aws-cdk-lib'

/**
 * The two AWS managed policies CDK's `lambda.Function` attaches to an
 * execution role IT creates, and silently DISCARDS when one is passed in.
 *
 * Verbatim from `aws-cdk-lib/aws-lambda/lib/function.js` (2.265.0, and the same
 * in 2.267.0):
 *
 * ```js
 * managedPolicies.push(ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'))
 * props.vpc && managedPolicies.push(ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'))
 * this.role = props.role || new iam.Role(this, 'ServiceRole', { assumedBy: ..., managedPolicies })
 * ```
 *
 * The array is built unconditionally and then reaches ONLY the `||` fallback, so
 * passing a role drops both entries with nothing logged - confirmed on a
 * synthesized template, where a VPC-attached function given a bare role emits an
 * `AWS::IAM::Role` with no `ManagedPolicyArns` at all. For the VPC-attached CMS
 * Lambda that is fatal and invisible: without `AWSLambdaVPCAccessExecutionRole`
 * the function cannot create ENIs and so cannot start, having synthesized and
 * deployed perfectly clean and failing only at invoke. Every `role` prop in this
 * package routes through here.
 *
 * NOT affected by passing a role, so deliberately not re-applied below (all
 * three verified in the same CDK source): EFS access-point statements and
 * `initialPolicy`, which go through `addToPrincipalPolicy`, and every `grant*`
 * call, because `this.grantPrincipal = this.role` - which covers
 * `cmsLogGroup`/`transformLogGroup`'s `grantWrite` and all asset-bucket grants.
 */
const BASIC_EXECUTION_POLICY = 'service-role/AWSLambdaBasicExecutionRole'
const VPC_ACCESS_POLICY = 'service-role/AWSLambdaVPCAccessExecutionRole'

export interface LambdaExecutionPolicyOptions {
  /**
   * Whether the function this role belongs to is VPC-attached (i.e. was given
   * a `vpc` prop). Mirrors the `props.vpc &&` condition in the CDK snippet
   * above rather than being decided here, so the two cannot drift.
   *
   * Required rather than defaulted: getting it wrong on a VPC function
   * produces a Lambda that cannot start, and a default would let a new call
   * site inherit the wrong answer by saying nothing.
   */
  readonly vpc: boolean
}

/**
 * Re-attach what CDK drops when a `lambda.Function` is handed a pre-built
 * execution role. Call this for EVERY caller-supplied role.
 *
 * The contract is the strong one: **passing a role yields the same effective
 * permissions as letting the construct create one.** Attaching only what each
 * function demonstrably still needs goes stale silently - neither Lambda here
 * strictly needs `AWSLambdaBasicExecutionRole` today, since both log to a
 * custom-named group its `/aws/lambda/*`-scoped statements do not cover and an
 * explicit `logGroup.grantWrite()` is what enables their logging. Attaching it
 * anyway costs one ARN and keeps a later logging change from quietly leaving
 * passed-role deployments behind.
 *
 * THE PARAMETER IS THE CONCRETE `iam.Role`, NOT `iam.IRole`, because
 * `addManagedPolicy` does nothing useful on an imported role, in two ways that
 * both emit nothing and neither of which errors: `ImmutableRole` (what
 * `Role.fromRoleArn` returns cross-account, or for any `mutable: false` import)
 * defines it as an empty method body, and `ImportedRole` (same-account, still
 * mutable) attaches only if the policy exposes `attachToRole`, which
 * `ManagedPolicy.fromAwsManagedPolicyName` does not, so it takes the warning
 * branch. Both confirmed on a synthesized template: no `AWS::IAM::Role` and no
 * `AWS::IAM::Policy` appears either way. Typed `IRole`, this function would
 * silently no-op for every imported role and ship exactly the cannot-start
 * Lambda it exists to prevent, and no runtime guard is available -
 * `ImmutableRole.addToPrincipalPolicy` reports `statementAdded: true` while
 * emitting nothing. Narrowing moves the failure to COMPILE time.
 *
 * Residual, documented rather than guarded: a role from `Role.customizeRoles`
 * carries a precreated `ImportedRole` and lands on that same warning branch.
 */
export function attachLambdaExecutionPolicies(
  role: iam.Role,
  options: LambdaExecutionPolicyOptions,
): void {
  role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(BASIC_EXECUTION_POLICY))

  if (options.vpc) {
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(VPC_ACCESS_POLICY))
  }
}
