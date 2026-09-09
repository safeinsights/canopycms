# [P1] No way to compute the Lambda role ARNs without a construct reference

Adopter request #42, filed 2026-09-09 by the website adopter. **A blocker for
their W5-2 topology**, though not a hard block — they have a coarser fallback.
Awaiting a shape decision from JP before implementation.

## The property asked for

An adopter must be able to compute, **at synth time and from a different
stack**, the ARN of the IAM principal that `AssetSupport`'s transform Lambda
and `CanopyCmsService`'s CMS Lambda run as — **without holding a reference to
the construct**.

Stated as a property rather than a mechanism deliberately (their #39 fix
sketch was not buildable as worded).

## Why the reference is the thing that cannot be held

Their asset bucket is in a build account, shared across per-environment
accounts; the compute is per tier, in the tier account. A cross-account S3
grant needs an identity half (tier stack) and a **resource-policy half written
in the bucket's stack**, which needs the principal ARN as a plain string.

They measured what CDK actually emits across an account boundary:
`Fn::GetStackOutput` — a CDK-CLI-only intrinsic — plus a publishing role,
resolved at deploy time by assuming that role and calling DescribeStacks. So
the coupling is invisible to CloudFormation and unusable by any deploy path
that is not `cdk deploy`. Their first guard against it was **found vacuous by
mutation-testing**: green in both cross-account configurations. A same-account
circular dependency at least fails synth; this does not.

Both constructs expose their functions (`transformFunction`, `lambdaFunction`),
so the roles are readable — but only through the reference.

## Alternatives already eliminated

- **`AssetSupport` in the bucket account, tier distribution using an OAC'd
  Function URL origin.** `lambda.FunctionUrl` has no static import (no
  `fromFunctionUrlAttributes`) and `FunctionUrlOrigin.withOriginAccessControl`
  needs a real `IFunctionUrl`. Needs the forbidden reference.
- **One shared asset distribution in the build account.** Cleanest arrows, and
  rejected on a stronger argument: the transform Lambda ships *inside*
  `canopycms-cdk`, so its version is set by `cdk deploy`, not by the promoted
  artifact. One shared Lambda flips every tier's asset pipeline at once,
  losing the graduated dev→staging→production rollout that build-once-promote
  exists to provide.

## THE FOOTGUN, which decides the shape

Neither session raised this; it was found reading CDK's `Function`:

```js
managedPolicies.push(AWSLambdaBasicExecutionRole)
props.vpc && managedPolicies.push(AWSLambdaVPCAccessExecutionRole)
this.role = props.role || new iam.Role(this, 'ServiceRole', { managedPolicies })
```

Those managed policies are attached **only to the role CDK creates**. Pass a
role and they are **silently discarded**. EFS access-point statements and
`initialPolicy` ARE still applied to a passed role; basic-execution and VPC-ENI
are not.

Consequence per Lambda:

| Lambda | VPC? | A passed role needs |
| --- | --- | --- |
| `AssetSupport` transform | no | basic execution (logs) |
| `CanopyCmsService` CMS | **yes** + EFS | basic execution **and** VPC ENI |

So an adopter passing a bare role to `CanopyCmsService` gets a Lambda that
cannot create ENIs and therefore **cannot start** — and it synthesizes and
deploys clean, failing only at invoke. Exactly the deploy-clean/fail-later class
the other guards in this package exist to convert into synth errors.

**Any `role` prop must therefore attach what CDK drops**, or it ships a worse
footgun than the gap it closes.

## Shapes

1. **`role?: iam.IRole`** on both (`transformRole` on `AssetSupportProps`,
   fitting its four `transform*` passthroughs; `lambdaRole` on
   `CanopyCmsServiceProps`, matching its `lambdaFunction` exposure). A forward
   to CDK's `FunctionProps.role`, plus the compensating managed policies above.
   Most flexible: the adopter can create the role wherever they like, name it
   deterministically, or pass `Role.fromRoleArn` for other topologies — and
   they own the named-role replacement trap rather than inheriting it.
2. **`roleName?: string`** on both. Less invasive, keeps the construct in
   control of what it attaches, and satisfies the property equally since only
   derivability is needed. Costs: forces a **named** IAM role, so the adopter's
   stack needs `CAPABILITY_NAMED_IAM`; and a customer-named role cannot be
   replaced in place without a rename — the adopter flagged this themselves.

**Recommendation: (1), with the compensating policies.** It is the standard CDK
idiom, strictly more flexible, and puts the naming decision where its
consequences land.

## Answered while investigating

**Does the EC2 worker's instance role need asset-bucket access? No.** Asset
grants go only to `lambdaFunction` (`cms-service.ts:757-766`); the worker role
gets log-group write, worker-asset read, secrets and SSM. So there is no third
principal — their instinct was right.

## Scope

Not bespoke. Any adopter whose asset bucket is in a different account from the
CMS compute hits this, which is the normal shape once assets are shared across
per-environment accounts.

## Their fallback while this waits

`grantAssetAccess` scoped to the tier **account** rather than a role — coarser
(any principal in that account could touch the asset prefixes), but bounded,
reversible and precedented by their existing `grantCloudFrontRead`. They would
take the narrow version later.
