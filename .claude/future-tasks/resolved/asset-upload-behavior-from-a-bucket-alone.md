# The upload behaviour could not be built without also building a transform Lambda

**Status: RESOLVED 2026-09-11**, branch `feat/asset-upload-behavior-free-function`, base
`int-202609-a`. Filed and resolved in the same session, from an adopter request raised against
`0.0.66-int.86`.

Shipped as `assetUploadBehavior(scope, { bucket, ...options })`, exported from
`packages/canopycms-cdk/src/index.ts` alongside `AssetSupport`.
`AssetSupport.uploadBehavior()` now delegates to the same module-local builder, so there is one
implementation.

## The argument for doing it, which is our own

[asset-support-upload-behavior.md](asset-support-upload-behavior.md) rejected option 2 (one
shared assets distribution) because "one assets distribution means one `AssetSupport`, and
`AssetSupport` creates the transform Lambda" — a shared Lambda would couple every environment's
asset pipeline to a package bump. It recommended option 3 instead: a distribution dedicated to
the upload route.

As shipped, **option 3 carried the same coupling**. `uploadBehavior()` was an instance method and
the constructor builds the transform Lambda unconditionally, so an adopter following the
recommendation had to instantiate a second `AssetSupport` beside the bucket purely to reach the
method. The coupling that disqualified option 2 was present in the implementation of the option
recommended in its place. That is an API defect, not a feature request, and it is why this was
accepted as asked rather than negotiated.

## The requester's stated cost was wrong, and the correction is worth keeping

The request argued that the real cost was **bucket-policy contamination**: that a second
`AssetSupport` in the stack owning the bucket would have CDK write the never-invoked transform
Lambda's grants (`GetObject*` on `asset-originals/*` and `asset-meta/*`, `PutObject` on
`assets/*`) straight into a deliberately tight bucket policy.

**Measured against a synthesized template: it does not.** An owned `s3.Bucket` plus an
`AssetSupport` in the same stack and account emits **zero** `AWS::S3::BucketPolicy` resources.
All three grants land on the transform function's own execution role, as
`AWS::IAM::Policy` statements on `…TransformFunctionServiceRoleDefaultPolicy`. This is CDK's
`Grant.addToPrincipalOrResource` behaviour: it writes the resource half only when the grantee
cannot take an identity policy or sits in another account. A same-account Lambda with a
CDK-managed mutable role takes the identity half and nothing else.

So the discarded footprint is **self-contained**: the role is created and destroyed with the
throwaway construct, and deleting it leaves no statement behind on the shared bucket. The real
costs are the inert Lambda, log group, Function URL and role, plus a second `AssetSupport` in a
stack that has no asset pipeline — which is an inexplicable thing to read six months later, and
reason enough on its own. The request would have been accepted on the API-defect argument
regardless; recorded here because the cost claim was the load-bearing part of the request and
an adopter may still believe it.

## Shape: a free function, not a construct and not a `transform: false` prop

- **Not `transform: false` on `AssetSupportProps`.** The requester argued against their own
  smaller-looking option and was right: it would make `transformFunction`,
  `transformFunctionUrl` and `transformLogGroup` optional on the public class, and produce an
  instance on which `assetBehaviors()` and `attachTo()` cannot work — `/assets/t/*` is an
  `OriginGroup` whose 403/404 failover **is** that Lambda. A mode in which half a construct's
  methods are illegal is worse than a second entry point.
- **Not an `AssetUploadRoute` construct**, despite the package's published surface being
  construct classes and types only (this is its first exported free function; the in-package
  idiom already allows the shape — `attachLambdaExecutionPolicies` is a free function that is
  simply not exported). A construct whose entire product is a plain `BehaviorOptions` owns no
  resource the caller addresses, exposes no ARN, and has one member. That is a function. It
  would also have nested the three children a level deeper and renamed every logical ID.
- **`scope` is a parameter**, because the builder creates a CloudFront Function and two
  policies. `uploadBehavior()` passes `this`, which is what keeps the three child ids
  (`AssetUploadRewriteFunction`, `AssetUploadOriginRequestPolicy`,
  `AssetUploadResponseHeadersPolicy`) exactly where they were.

## The gap in the request as written, which was the substantive addition

Extracting only `buildUploadBehavior` would have **silently dropped two guards**. Both
`allowedOrigins` checks lived in `AssetSupport`'s constructor, not in the builder:

- an empty `allowedOrigins` is refused rather than falling back to the wildcard
- a leftmost-subdomain pattern is refused, because the response-headers policy accepts
  CloudFront's pattern grammar while the edge preflight responder compares exactly

Each was added by a review round for a failure that deploys clean and fails silently in a
browser. They now live in `validateUploadBehaviorOptions(options, label)`, called from the
constructor at the same point as before (so the class still throws at construction, and the
tests pinning *when* it throws pass untouched) and from `assetUploadBehavior` on entry. The
dot-in-bucket-name guard was already inside the builder and moved for free; `label` is what
keeps each path's message naming the property the caller actually wrote.

## No attach guard on the free-function path, deliberately

`AssetSupport`'s `node.addValidation` fires only when `editorOrigins.length === 0 && !props.bucket`
— standalone mode, where opting into `uploadBehavior` is what satisfied the "something must
supply ACAO" guard, so opting in and stopping leaves a bucket with neither route nor CORS rule.
A free-function caller always brings their own bucket and never passes through that guard, so
there is no invariant left to protect and a discarded return value is a visibly unfinished call.
Pinned as a passing case, so a future "add the guard here too" is a deliberate change rather
than an accident.

## Verification

**The emitted template is byte-for-byte identical** for the existing path. Both versions of the
file were synthesized against the same stack (`AssetSupport` + a one-route distribution) and the
two `Template.toJSON()` dumps diffed clean — so no existing deployment sees a resource
replacement. This is the check that mattered most and is worth repeating for any future
extraction out of a construct: passing assertions do not prove an unchanged template.

All 59 pre-existing `asset-support.test.ts` tests pass unmodified; 16 added, 326 across the
package. **13 source mutations verified**, each red on its intended test and green elsewhere —
including two that initially proved nothing (a `customHeaders: {}` edit that does not affect
OAC at all, and a mutation whose shell quoting silently failed to apply). Both were re-run
properly. A mutation that does not fail is only evidence once you have confirmed it actually
changed the source.

Edge-function tests continue to load the emitted `FunctionCode` into `node:vm` and run it,
per the instrument change recorded in
[asset-support-upload-behavior.md](asset-support-upload-behavior.md).

## Related

- [asset-support-upload-behavior.md](asset-support-upload-behavior.md) — the topology this
  makes constructible, and the measurements behind it.
- [adopter-migration-unreleased-is-stale.md](../adopter-migration-unreleased-is-stale.md) —
  found while filing this; `docs/adopter-migration.md`'s Unreleased section covers three
  shipped releases.
