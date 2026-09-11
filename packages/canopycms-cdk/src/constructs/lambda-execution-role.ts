import { aws_iam as iam } from 'aws-cdk-lib'

/**
 * The two AWS managed policies CDK's `lambda.Function` attaches to an
 * execution role IT creates, and silently DISCARDS when one is passed in.
 *
 * Verbatim from `aws-cdk-lib/aws-lambda/lib/function.js` (checked against
 * 2.265.0 here, and independently against 2.267.0 by the adopter who filed
 * this):
 *
 * ```js
 * managedPolicies.push(ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'))
 * props.vpc && managedPolicies.push(ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'))
 * this.role = props.role || new iam.Role(this, 'ServiceRole', { assumedBy: ..., managedPolicies })
 * ```
 *
 * The array is built unconditionally and then reaches ONLY the `||` fallback.
 * Pass a role and both entries are dropped with nothing logged. Confirmed on a
 * synthesized template, not inferred: a VPC-attached function given a bare role
 * emits an `AWS::IAM::Role` whose `ManagedPolicyArns` is absent entirely.
 *
 * For the VPC-attached CMS Lambda that is not a degradation, it is fatal and
 * invisible: without `AWSLambdaVPCAccessExecutionRole` the function cannot
 * create ENIs, so it cannot start at all - while synthesizing and deploying
 * perfectly clean and failing only at invoke, a long way from the cause. Which
 * is why every `role` prop in this package routes through here.
 *
 * NOT affected by passing a role, so deliberately not re-applied below (all
 * three verified in the same CDK source):
 *
 * - EFS access-point statements - `config.policies.forEach(p => this.role?.addToPrincipalPolicy(p))`.
 * - `initialPolicy` - `this.role.addToPrincipalPolicy(statement)` per statement.
 * - Every `grant*` call, because `this.grantPrincipal = this.role`. That covers
 *   `cmsLogGroup`/`transformLogGroup`'s `grantWrite` and all asset-bucket
 *   grants, which land on the passed role exactly as they would on a created
 *   one.
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
 * execution role. Call this for every caller-supplied role, alongside passing
 * that role to the function.
 *
 * The contract this maintains is deliberately the strong one: **passing a role
 * yields the same effective permissions as letting the construct create one.**
 * The weaker alternative - attach only what each function demonstrably still
 * needs - is a judgment call that goes stale silently. Concretely, neither
 * Lambda in this package strictly needs `AWSLambdaBasicExecutionRole` today:
 * both log to a custom-named group (`/canopycms/<stackName>/...`), that
 * policy's `logs:CreateLogStream`/`logs:PutLogEvents` are scoped to
 * `arn:aws:logs:*:*:log-group:/aws/lambda/*:*` and so grant nothing for such a
 * group, and an explicit `logGroup.grantWrite()` is what actually enables
 * their logging. Attaching it regardless costs one managed-policy ARN and
 * means the first change to either function's logging cannot quietly leave
 * passed-role deployments behind.
 *
 * WHY THE PARAMETER IS THE CONCRETE `iam.Role` AND NOT `iam.IRole`, which is
 * the type a CDK prop would normally take: `addManagedPolicy` does nothing
 * useful on an imported role, in two distinct ways, neither of which surfaces
 * an error.
 *
 * - `ImmutableRole.addManagedPolicy(_policy) {}` - an empty method body. This
 *   is what `Role.fromRoleArn` returns for a CROSS-ACCOUNT role, or for any
 *   role imported with `mutable: false`.
 * - `ImportedRole.addManagedPolicy` (the same-account, still-mutable case)
 *   attaches the policy only if it exposes `attachToRole`, which
 *   `ManagedPolicy.fromAwsManagedPolicyName` does not - so it takes the
 *   warning branch and emits nothing.
 *
 * Both confirmed on a synthesized template: no `AWS::IAM::Role` and no
 * `AWS::IAM::Policy` resource appears in either case. So typed `IRole`, this
 * function would silently no-op for every imported role and ship exactly the
 * cannot-start Lambda it exists to prevent. There is no runtime guard
 * available either - `ImmutableRole.addToPrincipalPolicy` returns
 * `statementAdded: true` while emitting nothing, so the one signal CDK offers
 * lies. Narrowing the type moves the failure to COMPILE time instead, which is
 * the earliest it can be caught; `attachTo(distribution:
 * cloudfront.Distribution)` in asset-support.ts narrows to a concrete class for
 * the same kind of reason.
 *
 * Residual, documented rather than guarded because of its rarity: a role
 * produced under `Role.customizeRoles` carries a precreated `ImportedRole` that
 * `addManagedPolicy` delegates to, landing on the warning branch above.
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
