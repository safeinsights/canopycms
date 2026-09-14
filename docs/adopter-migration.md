# Adopter Migration Guide

What changed in CanopyCMS, what you must do to adopt it, and **what you can now delete**.

## How to use this document

Work top-down through the entries for every version between your current pin and your target. Each
entry has the same three parts:

- **What changed** — the package-side change.
- **To adopt** — what you do in your repo.
- **Now deletable** — the kind of local code the change supersedes. **This part is the point.** An
  upgrade that adds the new API without removing the code it replaces leaves two implementations to
  drift apart, which is the failure mode most of these changes exist to end.

Where an entry names what a hand-rolled version's bug looked like, that is usually the fastest way
to recognise the code in your own repo.

Entries are grouped by the release that carries them, and sit under **Unreleased** until they ship.

## Picking a target version

Resolve your target when you plan the upgrade, with `npm view canopycms version` — do not copy a
version number out of this document. `main` auto-publishes a patch on every push, so the number
moves.

If you are several releases behind, read every entry between your pin and your target, not just the
newest: the deletable-code lists compound, and a later entry sometimes supersedes an earlier one's
workaround entirely.

---

## Unreleased

_Entries land here as changes merge._

**Promoting them is a manual step, and it is easy to miss.** `main` auto-publishes a patch on every
push, so an entry written here is usually released within hours while this heading still says
"Unreleased". When you next touch this file, check `npm view canopycms version` and move anything
already published down into `## Released` under its version heading, demoting each entry from `###`
to `####`.

### A worker credential can be one field of a JSON secret

**What changed.** The EC2 worker's Secrets Manager reads can pull a single field out of a secret
whose value is a JSON document. Two env vars, read by the worker entrypoint:

| Env var                                    | Reads a field from                  |
| ------------------------------------------ | ----------------------------------- |
| `CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD` | `CANOPYCMS_GITHUB_TOKEN_SECRET_ARN` |
| `CLERK_SECRET_KEY_SECRET_JSON_FIELD`       | `CLERK_SECRET_KEY_SECRET_ARN`       |

**Nothing changes if you do not set them** — the secret's whole string value stays the credential,
byte for byte. With a field configured, every off-path fails fast naming the ARN, the field asked
for and the keys present, and no secret value appears in those messages. A secret whose value parses
as a JSON _object_ with no field configured now logs a loud warning instead of silently using the
whole document as the credential, which failed only later, at Clerk or at git.

**To adopt.** Nothing, unless one of those two secrets holds a JSON document. If one does, set the
matching `CanopyCmsService` prop to the key you want:

| Prop                            | Sets                                       | Names a field in          |
| ------------------------------- | ------------------------------------------ | ------------------------- |
| `githubTokenSecretJsonField`    | `CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD` | `githubTokenSecretArn`    |
| `clerkSecretKeySecretJsonField` | `CLERK_SECRET_KEY_SECRET_JSON_FIELD`       | `clerkSecretKeySecretArn` |

Through the scaffolded stack they are wired to optional env vars filled from the repository
_variables_ `CANOPY_GITHUB_TOKEN_SECRET_JSON_FIELD` and `CLERK_SECRET_KEY_SECRET_JSON_FIELD` —
variables, because they carry a key's name, not its value ([why the
prefix](deploying-to-aws.md#repository-secrets-and-variables)). If you scaffolded earlier, add the
props to `infrastructure/bin/app.ts` and `infrastructure/lib/cms-stack.ts`, or re-run the generator
and diff.

Two mistakes now fail at `cdk synth` rather than restart-looping the worker: a `…JsonField` prop
without its `…SecretArn` prop, and an ARN carrying the ECS `:KEY::` suffix. Neither check changes
the worker's IAM policy — a field is a key inside a secret's value, not a grantable resource.

**Two forms that deliberately do NOT work.** The ECS/CloudFormation suffix form
(`arn:…:secret:my-secret-AbCdEf:CLERK_SECRET_KEY::`), which `GetSecretValue` takes as part of the
`SecretId` — refused at synth, including in `secretsArns`, where a suffixed ARN matches nothing. And
CDK's `secretValueFromJson`, which resolves the **plaintext** into the CloudFormation template and
would end the "the `.env` carries the ARN, never the value" posture
[deploying-to-aws.md](deploying-to-aws.md) describes.

**This solves one of the three Clerk keys.** Only `CLERK_SECRET_KEY` is read through Secrets
Manager; `CLERK_JWT_KEY` is a plain CDK prop and the publishable key is a Docker build arg, and
neither can point at an ARN, deliberately, since both are public material (see [Security
Model](deploying-to-aws.md#security-model)).

**Now deletable.** Any wrapper that fetches the secret itself, parses it, and re-exports one field
into the worker's environment before starting it — a `jq` step in user-data, or a wrapper entrypoint
around `canopy-worker`. If it also validated the field exists, the package now does that with a
better message.

### The worker can authenticate to GitHub as an App (the token still works, unchanged)

**What changed.** `CmsWorkerConfig` gained an optional `githubAppAuth`. Supply it _instead of_
`githubToken` to have the worker act as a GitHub App installation. Exactly one of the two: both is
rejected rather than resolved by precedence, since it would otherwise be undefined which identity a
push or a pull request acts as.

**Nothing about the token path changed.** `githubToken` is not deprecated and stays the documented
default; registering an App under an organisation takes an owner, which many adopters are not. The
token path also keeps working with `@octokit/auth-app` absent from your install entirely —
`canopycms` neither depends on it nor imports it.

**To adopt** — only if you want App auth, and only if you drive `CmsWorker` from your own
entrypoint. With `canopycms-cdk` you write none of this; see [the CDK entry
below](#the-cdk-worker-can-authenticate-as-a-github-app-45).

```ts
import { createAppAuth } from '@octokit/auth-app' // YOUR dependency, not canopycms's
import { CmsWorker, normalizeGitHubAppPrivateKey } from 'canopycms/worker/cms-worker'

// ONE instance: it holds the installation-token cache, so sharing it keeps the REST
// and git halves on the same hourly token.
const appAuth = createAppAuth({
  appId,
  installationId,
  privateKey: normalizeGitHubAppPrivateKey(rawPrivateKey),
})

new CmsWorker({
  ...rest,
  githubAppAuth: {
    mintInstallationToken: async () => (await appAuth({ type: 'installation' })).token,
    // A closure, not `authStrategy: createAppAuth` — that would have Octokit build a
    // SECOND instance with its own separate cache.
    octokitAuth: { authStrategy: () => appAuth, auth: {} },
  },
})
```

**Run your private key through `normalizeGitHubAppPrivateKey`.** It repairs a key mangled by
configuration — `\n` escapes, a base64-wrapped PEM, both orders — converts PKCS#1 to PKCS#8, and
throws where the key is configured rather than surfacing later as an opaque JWT signing failure.

**One caveat on the `authStrategy: () => appAuth` closure.** Octokit's REST calls mint through the
`request` Octokit passes the strategy, not one you gave `createAppAuth`, so if you configured
`createAppAuth({ request })` for a GitHub Enterprise host, set Octokit's own `baseUrl` too.

**Now deletable.** If you hand-rolled App auth around `CmsWorker`: your own PEM conversion; any code
that mints a token at boot and holds it (installation tokens last about an hour, and
`buildGitHubUrl` now resolves one per use); and any wrapper that catches and re-throws a mint
failure. That last one is worth hunting — re-throwing as a new `Error` drops the HTTP status the
task classifier reads to decide permanent-versus-retry, so a permanently bad key burns every
publish's whole retry budget instead of failing fast.

**`GitHubService` is unaffected** and remains static-token-only.

### The CDK worker can authenticate as a GitHub App (#45)

**What changed.** `CanopyCmsServiceProps` gained `githubAppId`, `githubAppInstallationId`,
`githubAppPrivateKeySecretArn` and `githubAppPrivateKeySecretJsonField`. Set the first three and the
EC2 worker entrypoint builds the App credential for you.

**To adopt** — only if you want App auth; existing stacks need no edit:

1. Register the App under your organisation, install it on the content repository with **Contents:
   read & write** and **Pull requests: read & write**, and store its PEM private key in Secrets
   Manager.
2. Set the three props and **remove `githubTokenSecretArn`** (with its JSON field). A partial set of
   the three is refused at synth, and so is an App alongside a token.
3. In the generated workflow, store them as `CANOPY_GITHUB_APP_ID`,
   `CANOPY_GITHUB_APP_INSTALLATION_ID` and `CANOPY_GITHUB_APP_PRIVATE_KEY_SECRET_ARN`. **The
   `CANOPY_` prefix is not cosmetic:** GitHub refuses to create an Actions secret _or variable_
   whose name starts with `GITHUB_`. The workflow maps each onto the unprefixed environment variable
   the CDK app reads.

Regenerating the workflow rather than hand-adding those mappings also brings in the
`ubuntu-24.04-arm` runner and the CDK type-check step — see [the CMS image
entry](#the-cms-image-builds-without-git-canopycmsservice-defaults-to-arm64-and-the-cdk-app-is-type-checked--breaking-deploy-for-a-stack-that-sets-platform-without-architecture).

The private key is **ARN-only**, and passing the key itself where the ARN belongs is refused at
synth ([why](deploying-to-aws.md#authenticating-as-a-github-app)). The ARN is unioned into the
worker's IAM policy automatically, so you do not repeat it in `secretsArns`, and it honours
`githubAppPrivateKeySecretJsonField`.

**Now deletable.** A hand-written entrypoint that existed only to get App auth onto an otherwise-CDK
deployment, and any user-data or wrapper step that fetched the PEM and re-exported it into the
worker's environment — a path that could not have worked for a multi-line key anyway.

See [deploying-to-aws.md](deploying-to-aws.md#authenticating-as-a-github-app) for the walkthrough.

### `canopycms init-github-app` registers that App for you

**What changed.** A new CLI command, `canopycms init-github-app <create|verify>`. `create` registers
the App from a manifest — so GitHub shows you the exact permission set before you click Create —
captures its private key over a loopback redirect, and hands the key to a destination you name.
`verify` reads an existing installation back and changes nothing.

**Nothing is required of you**; the entries above still work by hand.

**What it is for.** The permission set those entries describe in prose is now
`CANOPY_APP_PERMISSIONS` in `packages/canopycms/src/cli/init-github-app.ts`, held in step with the
code by a test over the worker's dispatch table. An App one permission short does not fail loudly —
`convert-to-draft`'s GraphQL failure carries no HTTP status, so a permission denial is classified as
transient and retried into `sync-failed`. `verify` finds that at setup time instead.

**Register one App per site, not one shared across repositories:** anyone holding an App's key can
mint a token for any of its installations
([why](../ARCHITECTURE.md#why-one-github-app-per-site-not-one-shared-across-an-organisation)).

**The key's destination is yours to choose.** Everything after `--` is run with the PEM on its
standard input — so it never touches disk and never appears in a process listing — and that
command's own output is shown to you, which is how you learn the ARN of a secret you just created.
`--key-out <path>` writes a `0600` file instead.

```bash
canopycms init-github-app create -- \
  aws secretsmanager create-secret --name canopycms/github-app-key --secret-string file:///dev/stdin
```

If that command fails, `create` asks for a **file path**, never a command, and refuses a first word
containing `=` ([details](deploying-to-aws.md#register-it-with-canopycms-init-github-app)).

**Two things it will not do**, both deliberate: edit an existing JSON secret document (a
read-modify-write against a shared credential can silently drop its other fields — create the secret
yourself and point the JSON-field var at it), and run without an interactive terminal, since it
waits twice for a human and hanging in CI would leave a live App whose only key dies with the job.

**Now deletable.** Any runbook step that said "download the .pem from the App's settings page and
upload it to the secret store" — the hop where a private key most often ends up in a downloads
folder or a clipboard.

### A rotated secret reaches the running worker, without an instance replacement

**What changed.** The worker read both of its Secrets Manager secrets once, at boot, and never
again, so rotating the GitHub token or the Clerk secret key had no effect until the instance was
replaced — silently in the Clerk case, since `refreshAuthCache()` logs and swallows its errors. The
worker now re-reads a secret when the operation using it fails. Timings, costs and the
store-before-revoke order are in [deploying-to-aws.md](deploying-to-aws.md#rotating-a-secret).

**To adopt.** Nothing. This is automatic for any deployment whose credentials come from
`*_SECRET_ARN`, which is every deployment the scaffold generates.

Two limits, both deliberate:

- A **GitHub App private key** is still read only at boot. Store the new key, replace the instance,
  and only then delete the old key on GitHub — the reverse order fails every publish about an hour
  later ([details](deploying-to-aws.md#rotating-a-secret)).
- A credential supplied as a **plain env var** (`CANOPYCMS_GITHUB_TOKEN`, `CLERK_SECRET_KEY`) is
  never re-read, since re-reading the ARN you overrode would swap your override back out.

**Now deletable.** Any runbook step or automation that rotates a secret and then runs `cdk deploy`
(or triggers an ASG instance refresh) purely to pick it up — unless it exists for a GitHub App
private key.

One consequence for anyone driving `CmsWorker` themselves: `CmsWorkerConfig` gains an optional
`refreshGitHubToken?: () => Promise<string | undefined>` — return the new token, or `undefined` for
"nothing to do"; unset, behaviour is exactly as before. Core calls it after a failed git sync or
task, at most once per `refreshGitHubTokenMinIntervalMs` (default `60000`; `0` disables it), a floor
that costs one publish when a call lands in the minute before a rotation. A call still unsettled
after `taskTimeoutMs` is abandoned. `packages/canopycms-cdk/worker/credential-refresh.ts` is the
worked example.

### `assetUploadBehavior()` builds the upload route from a bucket alone

**What changed.** `canopycms-cdk` now exports a free function beside `AssetSupport`:

```ts
import { assetUploadBehavior } from 'canopycms-cdk'

const uploads = new cloudfront.Distribution(this, 'AssetUploads', {
  defaultBehavior: assetUploadBehavior(this, { bucket: assetBucket }),
})
// media.uploadUrl = `https://${uploads.distributionDomainName}/`
```

It takes the same options as `AssetSupportProps.uploadBehavior` plus the `bucket`.
`AssetSupport.uploadBehavior()` is unchanged, both entry points route through one shared builder,
and the emitted template for existing callers is byte-for-byte identical. It exists because reaching
the upload behavior otherwise means instantiating a second `AssetSupport` next to the bucket — whose
constructor unconditionally builds a transform Lambda, log group, Function URL and execution role —
purely to call an instance method.

**To adopt.** Nothing, unless you want it. Reach for the free function when you have a bucket and no
other use for an `AssetSupport` in that stack; keep the method when you already have the construct.
Do not move an _existing_ deployment from the method to the function: the three CloudFront resources
would sit at a new construct path, get new logical IDs, and be replaced.

**Now deletable.** Any `AssetSupport` instantiated only to reach `uploadBehavior()`, with the
transform Lambda, log group, Function URL and execution role it drags in. Check what those grants
are attached to first: CDK puts them on that function's own execution role when function and bucket
share an account, so removing the construct usually removes the whole footprint and leaves no
bucket-policy statement behind.

### `media.uploadUrl` routes presigned uploads through your own CDN (#44)

**What changed.** One optional field on `mediaSchema`'s s3 branch:

```ts
media: {
  adapter: 's3',
  bucket: '…',
  region: '…',
  uploadUrl: '/asset-upload/', // absolute http(s) URL, or a site-relative path
}
```

It replaces the `url` that `beginUpload()` returns, leaving the presign's `fields` untouched. Unset,
nothing changes. See [README's Media Configuration](../README.md#media-configuration) for the
CloudFront behaviour it expects, and what is easy to get wrong when you wire the route by hand.

**Why.** A direct-to-S3 upload is cross-origin, so it needs a bucket CORS rule naming an exact
origin — one `AllowedOrigins` entry per environment forever, with no prefix scoping available.
Routing the upload through a distribution you already control makes it same-origin. The signature is
unaffected: a presigned POST's string-to-sign is the base64 policy alone, so the host never enters
it.

**To adopt.** Nothing, unless you want it. Set `uploadUrl` from an environment variable — a
site-relative value only works where that path routes to the bucket, so it 404s under `next dev`.

**Now deletable.** The bucket CORS rule naming your editor's origin, once uploads are same-origin.
With `canopycms-cdk`'s `AssetSupport` in standalone mode, `editorOrigins` becomes inert at the same
moment; it stays a required prop, since a cross-origin editor is still the default shape.

### `media.publicBaseUrl` accepts a site-relative path, and rejects non-http(s) schemes

**What changed.** `publicBaseUrl` was `z.string().url()`. It now accepts an absolute `http(s)` URL,
a protocol-relative `//host` URL, **or** a site-relative path such as `/preview-123`, so you can
state the asset mount point directly in every topology instead of relying on the deployment
`basePath` inference. That inference is kept, so nothing breaks on upgrade.

**To adopt.** Nothing required.

**Watch out — this is also a tightening.** `z.string().url()` accepted anything `new URL()` parses,
including `mailto:` and `javascript:`. Those now fail validation; a value of that shape never
worked, so this converts a silent misconfiguration into a startup error.

Four narrower shapes are also rejected, because the browser rewrites them so the stored value stops
describing what is requested: a literal space (use `%20`); a backslash anywhere (`/asset\upload/` is
sent as `/asset/upload/`); `.` or `..` segments in any spelling, percent-encoded included; and a
scheme with no `//` (`https:cdn.example.com`), which resolves as a relative reference.

### `media` config now rejects unknown keys

**What changed.** Each branch of `mediaSchema` is `.strict()`. `CanopyConfigSchema`'s own
`.strict()` does not recurse, so a misspelled key under `media` used to parse and be silently
dropped — your setting never took effect, with no diagnostic anywhere.

**To adopt.** If your config carries a key that was being ignored, validation now fails and names
it. Fix or remove the key.

### `AssetSupport` and `CanopyCmsService` take an execution role, so its ARN is derivable without a construct reference (#42)

**What changed.** Two new optional props; unset, nothing changes and CDK creates the role as before.

```ts
AssetSupportProps.transformRole?: iam.Role // the transform Lambda
CanopyCmsServiceProps.lambdaRole?: iam.Role // the CMS Lambda
```

**Why.** A cross-account asset bucket needs a resource-policy half written in the bucket's own
stack, and that half needs the Lambda's principal ARN as a **plain string**. Both constructs already
expose their functions, but only through a construct reference — and across an account boundary CDK
emits `Fn::GetStackOutput`, a CDK-CLI-only intrinsic invisible to CloudFormation and unusable by any
other deploy path. Create a deterministically **named** role instead and both stacks compute
`arn:aws:iam::<account>:role/<name>` from literals. See [Cross-account asset
bucket](deploying-to-aws.md#cross-account-asset-bucket).

**The footgun this closes.** `lambda.Function` attaches `AWSLambdaBasicExecutionRole` (plus
`AWSLambdaVPCAccessExecutionRole` when VPC-attached) only to the role it creates **itself**; pass
your own and both are **silently discarded**, with no warning and no synth error. For the
VPC-attached CMS Lambda that leaves a function that cannot create ENIs and therefore cannot start,
after deploying perfectly clean. The constructs now re-attach them
(`packages/canopycms-cdk/src/constructs/lambda-execution-role.ts`), so passing a role yields the
same effective permissions as letting the construct create one.

**To adopt.** Nothing required. If you need the ARN without a reference:

```ts
const roleName = `canopy-cms-${tier}` // derive it however you name things
const role = new iam.Role(this, 'CmsRole', {
  roleName,
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
})
new CanopyCmsService(this, 'Cms', { /* ... */ lambdaRole: role })

// In the bucket's stack, in the other account - no reference, just literals:
const principal = new iam.ArnPrincipal(`arn:aws:iam::${tierAccount}:role/${roleName}`)
```

**Two costs that are now yours, deliberately.** A named IAM role means the creating stack needs
`CAPABILITY_NAMED_IAM`, and a customer-named role cannot be replaced in place without a rename — so
plan the name up front for anything long-lived.

**The type is `iam.Role`, not `iam.IRole`,** because `addManagedPolicy` silently does nothing on an
_imported_ role — so the re-attachment above would vanish and you would be back to a Lambda that
cannot start. No runtime guard is possible, since `addToPrincipalPolicy` reports `statementAdded:
true` while emitting nothing, so the narrower type makes it a compile error. If you were going to
pass `Role.fromRoleArn`, create the role in the compute's stack and name it.

**Now deletable.** Any local workaround for the missing ARN: a hand-written
`Fn::GetStackOutput`-producing cross-stack reference, a `CfnOutput`-plus-manual-wiring step, or an
asset grant scoped to the whole compute **account** because the role could not be named. That last
one is worth hunting for — it works, so nothing will ever tell you it is broader than you wanted.

### `AssetSupport.attachTo()` takes behavior overrides (#41)

**What changed.** `attachTo(distribution)` gained an optional second parameter, merged into **both**
asset behaviors:

```ts
attachTo(distribution: cloudfront.Distribution, overrides?: Partial<cloudfront.AddBehaviorOptions>): void
```

`CanopyCmsDistribution` forwards them through a new `assetBehaviorOverrides?:
Partial<cloudfront.AddBehaviorOptions>` prop. Passing that prop without `assetSupport` throws at
`cdk synth`, since the override would have no behaviors to merge into and would vanish silently.

**Why.** Without it, `attachTo` was unusable by the adopters who most need its ordering guarantee
(see the entry below): a distribution running a viewer-request function on every behavior — tier
basic-auth, most commonly — needs the asset behaviors to carry the same `functionAssociations`, or
`/assets/*` is **anonymously readable on an authenticated tier**. Such an adopter had to fall back
to `assetBehaviors()` plus two hand-ordered `addBehavior` calls, the exact shape `attachTo` exists
to eliminate. `responseHeadersPolicy` is the same story for a shared security-headers policy.

**To adopt.** Nothing required. If you fell back to `assetBehaviors()` — or dropped the
`assetSupport` prop — _only_ because you needed per-behavior options, delete your hand-ordered
block:

```ts
new CanopyCmsDistribution(this, 'Dist', {
  ...yourExistingDistributionProps,
  assetSupport,
  assetBehaviorOverrides: {
    functionAssociations: [{ function: tierAuthFn, eventType: FunctionEventType.VIEWER_REQUEST }],
  },
})
// on a bespoke distribution, pass the same object as attachTo's second argument
```

Overrides apply to both behaviors, which keeps ordering the only thing the method decides. If you
genuinely need the two to differ you are still on `assetBehaviors()`, and should keep your own
assertion on the **synthesized** template's `CacheBehaviors` array index.

### `canopycms-auth-clerk` supports Clerk Core 3 (`@clerk/nextjs` 7.x, `@clerk/backend` 3.x)

**What changed.** The peer ranges widened to `@clerk/nextjs: ^6.0.0 || ^7.0.0` and `@clerk/backend:
^2.0.0 || ^3.0.0`, so you can stay on 6.x/2.x or move to 7.x/3.x. CanopyCMS's own devDependencies
and both example apps build against the new majors, so CI exercises them.

**To adopt.** Upgrading is optional. If you do, Core 3 forces exactly one change, and it is in your
own app: **`<ClerkProvider>` must go inside `<body>`**, not wrap `<html>`.

```tsx
<html lang="en">
  <body>
    <ClerkProvider>{children}</ClerkProvider>
  </body>
</html>
```

`apps/example1/app/layout.tsx` shows the corrected shape. For a **dual-build** adopter the provider
belongs in the editor subtree's layout instead (see [Dual Build
Support](deploying-to-aws.md#dual-build-support)), and a nested layout is already inside `<body>`,
so that arrangement is unaffected.

**What does NOT change, despite what Clerk's Core 3 guide implies.**

- `verifyToken` is **not** removed — the guide's "replaced by `verify()`" is about the machine-auth
  surface. Session-token `verifyToken` is still exported from `@clerk/backend@3.x` with a
  byte-identical option set, and **networkless PEM verification still works**, the property the
  no-internet Lambda deployment depends on. Verified by execution with no network available.
- `CLERK_ENCRYPTION_KEY`, required "when passing `secretKey`" to `clerkMiddleware`, does not apply
  to the middleware CanopyCMS scaffolds, which passes only `jwtKey`.
- `UserButton` lost its `afterSignOutUrl`/`signOutUrl` props, but `useClerkAuthConfig()` passes
  `UserButton` as a bare component reference, so the editor's account button is unaffected. If
  **you** render `AccountComponent` yourself with those props, move them to `ClerkProvider`'s
  `afterSignOutUrl` or a `SignOutButton`.
- `clerkMiddleware` still requires a non-empty `secretKey`, slightly more strictly than in 6.x. See
  [Security Model](deploying-to-aws.md#security-model) for what that means for a CMS Lambda
  documented as holding no secrets — an open question this upgrade neither resolves nor worsens.

**Node version.** The 7.x/3.x line requires **Node >= 20.9.0** (Clerk's own `engines`); all five
CanopyCMS packages declare `>= 22.12.0` regardless, being ESM-only.

### `CanopyCmsService` gains `settingsBranch`, and the generated stack derives `baseBranch`/`settingsBranch` from `canopycms.config.ts` (#39)

**What changed.** `CanopyCmsService` gained a `settingsBranch` prop, stamped into the worker's
`CANOPYCMS_SETTINGS_BRANCH` environment variable — previously read by the worker but stamped by
nothing. Both it and the existing `baseBranch` prop are now validated at `cdk synth` against git's
branch-name rules, so a value git would refuse fails synth instead of deploying a crash-looping
instance. This is a **looser** rule than `deploymentName` gets: a `/` is legal in a branch name,
whereas `deploymentName` is interpolated into `canopycms-settings-<name>` as one ref component.

`infrastructure/lib/cms-stack.ts`, as generated, now imports your `canopycms.config.ts` at synth
time and derives both props from it (`baseBranch: config.defaultBaseBranch`,
`settingsBranch: config.settingsBranch`), so they cannot drift from the shared config.

**Why.** Nothing derived `CANOPYCMS_BASE_BRANCH` from `config.defaultBaseBranch`, so a repo whose
default branch is not `main` got **no working worker at all**: `verifyBaseBranchExists` throws, the
worker exits 1, and systemd repeats that forever. `CANOPYCMS_SETTINGS_BRANCH` had the matching gap:
an adopter who set `config.settingsBranch` got a worker aimed at a different branch than the Lambda
writes to, with only a per-cycle warning.

**To adopt.** Regenerate `infrastructure/lib/cms-stack.ts`, or copy the import and the two new lines
by hand. **Do this now if your repo's default branch is not `main`, or if you set
`config.settingsBranch`** — both were silently wrong before. If you maintain your own stack, set the
two props on `CanopyCmsService` explicitly to match `canopycms.config.ts`; neither is inferred
outside the generated stack.

**Now deletable.** Any comment, runbook step or checklist item telling you to keep
`CANOPYCMS_BASE_BRANCH` (or a settings-branch override) in sync with `canopycms.config.ts` by hand.

### `AssetSupport.attachTo()` and `CanopyCmsDistribution`'s `assetSupport` prop make the CloudFront behavior-ordering footgun unrepresentable

**What changed.** `assetBehaviors()` returned `{ assets, assetsTransform }` with no path pattern
attached, and CloudFront matches patterns in the order given, stopping at the first match. Listing
`/assets/*` before `/assets/t/*` — which alphabetizing the two keys does — served every
not-yet-computed transform off the S3-only behavior and never failed over to the transform Lambda: a
silent, permanent 403 on any derivative not already computed, with no synth or deploy error.
Spreading the return value straight into `additionalBehaviors` type-checked and deployed too,
synthesizing behaviors matching the literal patterns `assets` and `assetsTransform`.

Two new APIs replace hand-wiring the order:

- `AssetSupport.attachTo(distribution)` — calls `addBehavior` for `/assets/t/*` then `/assets/*`, in
  that order, every time.
- `CanopyCmsDistribution`'s `assetSupport` prop — pass your instance and the construct calls
  `attachTo()` for you.

`CanopyCmsDistribution` also throws at synth, naming the cause, on three shapes: `/assets/*` listed
before `/assets/t/*`; the literal `assets`/`assetsTransform` keys from the spread mistake; and **the
`assetSupport` prop passed while `additionalBehaviors` still lists either asset pattern**. That
third one is the mistake to watch for while migrating — both routes are then active, each pattern is
attached twice, and CloudFront rejects duplicate patterns at deploy time. The ordering check cannot
catch it, because the block you are migrating away from normally has the order right.

The guard only covers callers going through `CanopyCmsDistribution`; a bespoke
`new cloudfront.Distribution(...)` should call `attachTo()` directly.

**This is additive and opt-in.** `assetBehaviors()` and its return shape are unchanged, and a stack
already listing the two behaviors in the correct order keeps working. The one thing you must not do
is _half_ the migration.

**To adopt.** Nothing is required. To adopt the safer API, replace a hand-written

```typescript
additionalBehaviors: {
  '/assets/t/*': assetSupport.assetBehaviors().assetsTransform,
  '/assets/*': assetSupport.assetBehaviors().assets,
},
```

with passing `assetSupport` straight to `CanopyCmsDistribution`:

```typescript
new CanopyCmsDistribution(this, 'CmsDist', {
  // ...your existing props...
  assetSupport,
})
```

**Now deletable.** The hand-written `additionalBehaviors` block above, and any comment reminding
yourself which order the two patterns have to be listed in.

### `CLERK_JWT_KEY` is a repository **variable**, not a secret (#37)

**What changed.** The generated `deploy-cms.yml` reads `CLERK_JWT_KEY` from
`${{ vars.CLERK_JWT_KEY }}` instead of
`${{ secrets.CLERK_JWT_KEY }}`, and the docs classify it as a repository variable throughout.

**Why.** It is Clerk's public JWKS PEM, retrievable from your instance's public JWKS endpoint and
used only to verify signatures. Calling it a secret is the reading that licenses an adopter to
conclude the CMS Lambda accepts secrets — and from there to put `CLERK_SECRET_KEY`, which is full
Clerk API access, in the Lambda's plaintext environment. The Lambda's posture is now stated once, in
prose, next to that table.

**To adopt.** If you regenerate `deploy-cms.yml` or copy the change in, **move `CLERK_JWT_KEY` from
repository secrets to repository variables** (Settings → Secrets and variables → Actions →
Variables). This fails loudly rather than silently: `infrastructure/bin/app.ts` reads it via
`required()`, so an unset value refuses the deploy at synth. Keeping it as a secret also works; the
reclassification is about not teaching that the Lambda handles secrets.

**Worth checking while you are here.** Confirm your `bin/app.ts` passes `CLERK_SECRET_KEY` to
`CanopyCmsService` as `clerkSecretKeySecretArn` — a Secrets Manager ARN read by the EC2 worker — and
**not** as an entry in the Lambda's `environment`. CanopyCMS's Lambda code never reads that value,
so passing it there gains nothing and makes a real secret readable by anyone holding
`lambda:GetFunctionConfiguration`. The exception is `clerkMiddleware`, if you keep it: it needs the
secret wherever it runs (see [Security Model](deploying-to-aws.md#security-model)).

### `basePath` deployments are supported, and `assetUrl`'s `baseUrl` is now safe for path prefixes (#24)

**What changed.** Three things, all pointing at the same failure — deploying under a Next.js
`basePath`, where Next auto-prefixes only its own `Image`/`Link`/`Script` and leaves every raw
string URL resolving at the origin root.

1. `assetUrl()` / `assetSrcSet()`'s `baseUrl` option is now a documented contract accepting a
   **same-origin path prefix** (`'/preview-123'`), not just an absolute origin. Two fixes made that
   safe to recommend: an already-absolute `src` is returned untouched rather than concatenated onto
   the prefix, and a prefix without a leading slash is normalized rather than producing a
   _document-relative_ URL that resolved differently on every page. There is deliberately **no** new
   `basePath` parameter — `baseUrl` is the one prefix concept for asset URLs.
2. A new top-level `basePath` config key makes the **editor** work under a `basePath`. Its API route
   base and preview pane were hardcoded to the origin root, so the editor loaded no API response at
   all on such a deployment.
3. `media.publicBaseUrl` is documented for what it actually is: the editor's own answer to "where is
   `/assets` mounted", editor-display-only.

**To adopt.** Nothing if you deploy at the origin root. If you deploy under a `basePath`, state it
in your Canopy config as well as `next.config` (CanopyCMS cannot read `next.config`):

```typescript
// canopycms.config.ts
basePath: process.env.NEXT_PUBLIC_BASE_PATH,
```

Then decide whether your **asset** space actually moved, which is a different question:

- Next serves `/assets` (local adapter, `next dev`, S3 with no distribution) → it moved. Pass your
  prefix: `assetUrl(image, { width: 960, baseUrl: BASE_PATH })`.
- Assets are on CloudFront via `AssetSupport` → it did **not** move; those behaviors are anchored at
  the distribution root. Pass no `baseUrl`.

Deriving `baseUrl` from `next.config`'s `basePath` unconditionally breaks the second case; the mount
table is under "Where `/assets` is mounted" in
[README's Media Configuration](../README.md#media-configuration).

Two traps worth checking for explicitly:

- **Do not pass a deployment `basePath` to `contentStaticParams({ basePath })`.** That option is a
  nested catch-all's route prefix and _filters_ entries by it — a deployment prefix matches nothing,
  emits zero static params, and still builds green.
- **Body images bypass `assetUrl()` entirely.** Images inserted into markdown or MDX bodies are
  stored as raw srcs and rendered by your own renderer, so under a `basePath` they need the `img`
  override the README shows. It is safe on every body image — off-site srcs and `data:` URIs come
  back byte-identical — but it DOES root a **page-relative** src onto the base you pass, so make
  those root-relative first.

**Now deletable.** Any hand-rolled prefixing wrapper around `assetUrl` — a module exporting a
re-bound `assetUrl`/`assetSrcSet` that injects a prefix read from an env var. The first-class option
handles the cases such a wrapper usually gets wrong: an off-site src, a prefix missing its leading
slash, and a prefix that is nothing but slashes. Also deletable: any local "strip trailing slashes
from a base URL" helper — `stripTrailingSlashes` is exported from `canopycms/server`.

### `select` fields now infer their own options — **breaking (type-level)**

**What changed.** `TypeFromEntrySchema` used to infer every `select` field as `string | number`. It
now infers the literal union of that field's own `options`:

```diff
- status: string | number
+ status: 'draft' | 'published'
```

The `number` half was never reachable — `SelectOption` carries `value: string` in both arms, the
editor's normalizer emits strings, and the validator rejects a non-string select value — so it was a
type-level fiction every adopter laundered back out by hand. Both option forms work, including one
array that mixes them: a bare string contributes itself, a `{ label, value }` option contributes its
**`value`**.

**To adopt.** Nothing, if your schema goes through `defineEntrySchema` (or is declared `as const`)
and your code already treats select values as strings.

Two things determine whether you get the narrow type:

- **The options must still be literals at the type level.** `defineEntrySchema` and `as const`
  preserve them; an array annotated as the runtime type (`const options: SelectOption[] = [...]`)
  has no literals left, so the field falls back to `string`. That fallback is deliberate.
- **A `select` with no `options`, or `options: []`, also falls back to `string`.** Both are schema
  mistakes, rejected by `ensureSelectFieldsHaveOptions` — which runs from
  `createEntrySchemaRegistry`, not `validateCanopyConfig`, so a schema you only ever feed to
  `TypeFromEntrySchema` gets no runtime rejection at all.

**`''` is deliberately not in the union**, even though the validator accepts an empty string as "not
filled in" for any field not explicitly `required: true`, so a select can hold `''` on disk. Like
the rest of `TypeFromEntrySchema`, this models the schema's declared shape rather than everything
the validator tolerates. If your content has cleared selects and you branch on that, compare before
the value reaches the typed surface, or add `''` to your schema's options.

_Broken (act on these):_

- **Comparing a select value against a string that is not one of its options** is now a "no overlap"
  compile error instead of silent dead code — usually a real bug, a renamed option or a comparison
  against a label. Fix the comparison; do not widen the type to silence it.
- **Assigning a plain `string` into a schema-derived select value** is now an error; the reverse is
  still fine. Derive the type from the schema instead of re-declaring it.
- **A custom field type using the property name `options` for something else** stops compiling,
  since `options` is now a reserved, typed key on the schema field shape. Rename the property.
- **Anything relying on the `number` half.** A `typeof value === 'number'` branch now narrows to
  `never`, correctly — and **silently**, since TypeScript reports nothing for an impossible `typeof`
  check. Grep for these rather than expecting the compiler to list them.

**Now deletable.** Any local shim that re-narrows a schema-derived select value back to the app's
own union — a helper or inline cast checking the value against a hand-maintained allowlist of the
same option strings, or asserting `as 'a' | 'b'`. That allowlist was a second copy of the schema's
`options`, free to drift. Also deletable: `typeof v === 'string'` guards that existed only to strip
the impossible `number`.

### `listEntries()` and `buildContentTree()` can now resolve `reference` fields (#16)

_This supersedes the caveat shipped in `0.0.63` under "Shared/referenced blocks", whose "Now
deletable" list said, correctly at the time, that there was nothing to delete._

**What changed.** Both batch listing surfaces take a `resolveReferences` option. Turn it on and
every `reference` field in the returned `data` resolves to the referenced entry — including
references nested inside `object` fields, inline `group`s and block templates, so a shared block
finally carries its snippet's content in a listing. Off (the default), they stay a bare id string or
`null`. `collectRoutableEntries` takes and forwards the same option; `collectStaticPaths` does not,
since it discards `data`.

**The default is `false`, and `read()`'s is `true`.** A resolved reference changes from
`'a1b2c3d4e5f6'` to `{ id, slug, collection, ...data }`, and a listing's `data` is your own generic
while `extract` receives an untyped record — so a flipped default would have changed the shape under
every existing call site with no compile error, turning an `/authors/${data.author}` template into
`/authors/[object Object]` at runtime.

**Cost.** An opted-in call adds one ContentId index scan plus one read per **distinct** referenced
entry, not per referencing entry: one per-call cache spans the whole batch, so a shared block
referenced from 40 pages is read once. Nothing is constructed or scanned when the option is off.

Two things to know before switching it on. Path ACLs are **not** applied to resolved targets,
matching `read()` exactly — the entries being listed are still ACL-filtered, and a filtered-out
entry is never resolved. And within one call an id resolves once and every occurrence shares that
answer, each getting its own copy. The admin entries API deliberately does not resolve: it is a
paginated table that never reads inside a reference.

**To adopt.**

```ts
// A search index that must see shared-block content:
const entries = await ctx.listEntries({ resolveReferences: true })

// Or through the static helper:
const routable = await collectRoutableEntries(await getCanopyForBuild(), {
  resolveReferences: true,
})
```

Leave it off for `generateStaticParams`, sitemaps, and anything else needing only paths, slugs or
`updatedAt`.

**Now deletable.**

- **A second `read()` pass bolted onto a `listEntries()`-derived surface.** The shape is a build
  script or route that lists entries, walks the results for id-shaped strings or empty block values,
  then issues a follow-up single-entry read per hit — usually with its own memo table. Pass the
  option; delete the second pass and the memo.
- **A surface deliberately rebuilt on `read()`/`readByUrlPath()` to dodge the gap** — a search index
  or feed that enumerates paths and reads each entry individually. It can go back to one listing
  call.
- **Nothing where the listing never touched a reference field.** Leaving the option off is the right
  answer there.

### Resolved references now carry `urlPath`, and can carry the target's body — **breaking (type-level)**

_Follows the `listEntries` entry above; together they close what a resolved reference is for._

**What changed.** A resolved reference used to be `{ id, slug, collection, ...frontmatter }`, which
served neither job it gets used for. Two additions:

- **`urlPath`, on every resolved reference, always.** The referenced entry's URL, following the same
  rule `listEntries` publishes as `item.urlPath` (an `index` entry collapses to its parent path).
  Both now come from one shared function, so a link built from a resolved reference reaches the
  entry the listing enumerates by construction.
- **`includeBody` on the reference field**, default `false`. When set, the resolved value also
  carries the target's body, under the _target_ entry type's own body field name (`isBody: true`,
  else `body`). Only meaningful for md/mdx targets.

```diff
  {
    name: 'snippet',
    type: 'reference',
    entryTypes: ['ctaSnippet'],
+   includeBody: true,     // this reference EMBEDS its target, so it wants the prose
  }
```

`includeBody` sits on the field, not the call, because a reference either embeds its target (a
shared call-to-action rendered inline — wants the prose) or links to it (an author byline — wants a
URL and a title, not the full body inlined into every page read). That is a property of your content
model, and a single `listEntries()` call routinely contains both kinds.

**The type-level break.** `TypeFromEntrySchema` now intersects the resolution metadata that was
always returned at runtime but missing from the type:

```diff
- author: { name: string; bio: string } | null
+ author: ({ name: string; bio: string } & ResolvedReferenceMeta) | null
+   // ResolvedReferenceMeta = { id: string; slug: string; collection: string; urlPath: string }
```

Reads keep compiling — this is a widening, and `ref.id` no longer needs a cast. What can break is an
exact-shape assignment: a variable annotated with the old literal object type, an `Exact<>`-style
helper, or a test asserting the inferred type equals a hand-written shape. Add
`& ResolvedReferenceMeta` (exported from `canopycms`) or widen the annotation.

**Two things to know.** If a field's `resolvedSchema` declares a body field but you have not set
`includeBody`, the inferred type promises that field while the runtime omits it; set `includeBody`,
or leave the body field out of the `resolvedSchema`, which is inference-only. And `includeBody:
true` carries the target's body into every referencing entry's resolved value — fine for a snippet,
think twice for a full article, which probably wanted a link.

`id`, `slug`, `collection` and `urlPath` are **reserved** on a resolved reference: the resolution
value wins over a target that models one of them as a real content field. That ordering is a fix,
since the write boundary recovers a reference's id from `value.id` — so a target with its own `id`
frontmatter field made a re-save silently repoint the reference. If a target of yours legitimately
carries one of those four names, read that entry directly to get it.

**A save no longer freezes a resolved reference into your content.** The editor reads a document
with references already resolved, so a plain open-and-save posted those objects back and the write
boundary persisted them verbatim; since resolution only re-resolves a bare string, that snapshot
survived every later read and save, severing the reference for good. Reference fields are now
collapsed back to their ID at the write boundary.

**If you have edited entries with reference fields through the editor on an earlier version, check
your content files**: a reference field holding an object rather than a 12-character ID string is a
severed reference, and replacing the object with its own `id` restores it. One case is not covered —
if the target was deleted, resolution yields `null`, a save persists that `null` over the ID, and
the ID is not recoverable from the file.

**To adopt.** Nothing is required — `urlPath` simply appears. Add `includeBody: true` to reference
fields whose target's prose you actually render or index.

**Now deletable.**

- **A contentId → URL index built by a second content pass.** The shape is a helper that walks
  `listEntries()` (or the content tree) again purely to map ids to URLs so referenced entries can be
  linked. Delete it; read `urlPath` off the resolved reference.
- **The `resolveReferences: false` escape hatch that index forced.** Pages that turned resolution
  off because paying for it _and_ a separate URL lookup was worse than hand-rolling both can turn it
  back on.
- **A follow-up `read()` of a referenced entry purely to get its body.** Set `includeBody: true` on
  the field instead.

### Editor saves no longer delete comments in content files

**What changed.** `ContentStore` used to write an entry by re-serialising a fresh plain object, and
comments are in neither the object nor that round trip — so the first CMS save of a hand-authored
entry silently deleted every comment in it, with no warning and no recovery outside git. `canopycms
sync` copies files byte-for-byte, so a dev team never saw this; an editorial team hit it on their
first save.

Writes now re-serialise onto the file's own parsed document, so a node whose value did not change
keeps its comments, its quoting and its block style. Both YAML entries and md/mdx frontmatter are
covered, and reordering a list carries each comment with the content it was written about. JSON is
unaffected. The payload stays authoritative about _content_: a key the editor removed is removed,
and comments are the only thing inherited from disk.

**To adopt.** Nothing. It applies to every save automatically.

**Now deletable.** Any convention your team adopted to work around it — moving explanatory notes out
of content files into a sidecar doc, or a rule that comment-bearing entries must never be opened in
the CMS.

### Saves and builds now report content keys the schema does not define (#29)

**What changed.** Entry validation walked the schema, so a content key with no schema counterpart
was reported nowhere: rename or reshape a field and there was no editor error, no 422 and no build
failure, while the old key persisted indefinitely. The only symptom was a component receiving
`undefined`.

Two non-fatal reports now exist:

- **On save**, unknown keys come back in the write response's `validationWarnings`, which the editor
  surfaces as "Saved with warnings". The save still succeeds.
- **During a production build**, `collectStaticPaths` / `collectRoutableEntries` print one warning
  naming the offending entries and their key paths — exact count, first 20 listed. The build still
  passes.

Both report paths (`hero.kicker`, `blocks[2].headline`), and neither fires for an entry type with no
schema at all or for a block item's `template` discriminator. Nothing is rejected or stripped, and
with the comment-preserving write above, an unknown key and its comments are still written back on
every save.

**To adopt.** Nothing to wire up. Expect the first build after upgrading to list keys you no longer
use — that list is the point. For each, add the field to the entry type's schema or delete the key.

**Now deletable.** Any hand-rolled script that diffs content keys against a schema to catch drift
after a rename, and any defensive `?? fallback` a component carries purely because nobody could tell
whether a field was still populated.

### An `index` entry no longer answers at a second URL, and a contested URL now fails the build — **breaking (routing)**

**What changed.** Two things, from one root cause in the URL → entry resolver.

`readByUrlPath` no longer resolves an index entry at its literal `.../index` URL. An index entry's
URL is its collection's path — what `listEntries` publishes as `item.urlPath`, what
`buildContentTree` uses, and what a resolved reference's `urlPath` carries. The resolver tried "last
segment is the slug" first, so the same entry also answered at a URL no other API ever emits.

```diff
  await readByUrlPath('/guides')        // the index entry — unchanged
- await readByUrlPath('/guides/index')  // ALSO the index entry
+ await readByUrlPath('/guides/index')  // null
```

The round-trip guarantee now excludes the `.../index` spelling in every case (`/x/Index` and
`/x/INDEX` return null too). Ordinary entries are unchanged. A collection literally _named_ `index`
is fixed rather than broken: `/docs/index` now resolves to that collection's own index entry instead
of being shadowed by its parent's. The remaining extra URLs an entry answered at are closed by
["`readByUrlPath` answers only where `listEntries`
publishes"](#readbyurlpath-answers-only-where-listentries-publishes--breaking-routing) below, which
supersedes this entry's original caveat; read the two together.

Separately, a **production build** (`isBuildMode()`, not `next dev`) now fails when two entries
compute the same `urlPath`, listing each contested URL and its claimants; before, one got the route
and the other silently had no page. The usual causes are an entry whose slug matches a sibling
collection that _also_ has an `index` entry, and two slugs differing only by case. An entry beside a
sibling collection with **no** index entry is untouched — a landing page plus a folder of children
is a legitimate shape.

**To adopt.** Mostly nothing; the resolver change removes URLs no API advertised. Three exceptions:

**If you route a collection through a single-segment `[slug]` route** — `shape: 'single'` static
params — that helper no longer emits the collection's **index** entry, which never had a param that
could address it. **This is the one case where a page can silently stop being generated**, so check
for it: move the index entry to the collection's own route (`app/posts/page.tsx`). Catch-all routes
are unaffected.

If you have a collection literally _named_ `index`, `/x/index` now resolves to a **different**
entry.

If a build starts failing on a contested URL, the error names every colliding entry; rename or
remove one of each pair. The build only fails where it enumerates through Canopy's own helpers —
`collectStaticPaths` / `collectRoutableEntries`, or the bound wrappers `createNextCanopyContext`
returns. A hand-rolled `generateStaticParams` over `listEntries` does not fail; call
`findDuplicateUrlPaths` yourself there. To check before upgrading:

```ts
import { findDuplicateUrlPaths } from 'canopycms/server'

const canopy = await getCanopyForBuild()
const duplicates = findDuplicateUrlPaths(await canopy.listEntries())
```

Scan `listEntries()`, not `collectRoutableEntries()` — the latter drops the `entryPath` that names
the offenders.

**Also changed, smaller.** The `path` field on a `read()` / `readByUrlPath()` result now collapses
an index slug and strips the content root from root-level entries, so it is a URL that actually
resolves. If you were working around either, stop.

**Now deletable.**

- **A route-level guard whose only job is to reject a `.../index` URL.** The shape is a check at the
  top of a `[slug]` route — usually on `entryType` — that exists because the collection's index
  entry resolved through a template meant for its children and rendered with every field undefined.
  That URL is now a 404 in every case spelling. Keep any `entryType` narrowing you rely on for real
  type safety.
- **A hand-rolled duplicate-URL integrity test.** The build now enforces it; if you want the
  assertion locally, call `findDuplicateUrlPaths` instead of re-implementing the scan.

### Sitemap `pathFor`, and modelling a page served at `/` as a root `index` entry

**What changed.** Two answers to one question — "the URL my app serves this entry at isn't the
entry's own `urlPath`" — in the order you should try them.

1. **Modelling, which needs no API at all.** An entry whose slug is `index` collapses onto its
   collection's path; at the content root that path is `/`. So a home page stored as
   `content/home.index.<id>.json` has `urlPath: '/'` already. This was always true, but the
   reference app in this repo modelled `home` as an ordinary root entry and papered over the
   mismatch in its own sitemap, so the workaround was what adopters had in front of them. It no
   longer does that.

2. **`generateContentSitemap` gained `pathFor`**, for cases where modelling is not available — a URL
   fixed by published history, or a route prefix that deliberately differs from the content layout:

   ```ts
   pathFor: (entry) =>
     entry.entryType === 'article' ? entry.urlPath.replace(/^\/articles\//, '/blog/') : null,
   ```

   It overrides the URL while keeping the entry **inside** the entry walk, so the `isNoindexEntry`
   gate, the `updatedAt` `lastModified` default and `priority` all still apply. `null` (or
   `undefined`) means **"keep the structural path", not "drop this entry"** — dropping is still
   `exclude`'s job. An empty string throws rather than silently resolving to `/`.

   `extraUrls` now means only what its name says: URLs with **no entry behind them**, like a feed.
   It inherits neither the `noindex` gate nor the `lastModified` default, which is why rerouting a
   real entry through it was always hand-managed.

**To adopt.** Nothing is required. If you do re-model a singleton you serve at a collection's own
path:

1. Rename the file so its slug segment is `index` (`git mv home.home.<id>.json
home.index.<id>.json`). Entry type and ID are unchanged, so references,
   `order` arrays and editor position all survive.
2. **Fix any read that addresses the entry by entry-type path.** This is the step that bites:
   `read({ entryPath: 'content/home' })` passes no `slug`, and a slugless read defaults the slug to
   the entry-type _name_, so it stops resolving once the slug is `index`. Passing `slug: 'index'`
   explicitly keeps that call working; prefer switching to `readByUrlPath('/')` and handling its
   `null` return. Skipping this yields a **green build with a 404 at `/`** — a static build
   prerenders the not-found boundary and reports success, so verify by reading the emitted HTML, not
   the exit code.
3. Drop the sitemap workaround below, and re-check the emitted `sitemap.xml`.
4. If the old URL was publicly indexed, add a redirect from it.

Modelling home at the root also made `readByUrlPath('/home')` return the home entry — and so did
_every_ entry-type name declared beside home. All of them now return `null`; see ["`readByUrlPath`
answers only where `listEntries`
publishes"](#readbyurlpath-answers-only-where-listentries-publishes--breaking-routing), and do not
write the filter.

**Now deletable.**

- **The `exclude` + `extraUrls` pair that re-adds a page's real URL by hand.** The shape is an
  exclusion by entry type or slug, paired with an `extraUrls` item putting the same page back at the
  URL the route actually serves — two lines that exist only because the entry's structural URL and
  its served URL disagree. Re-model the entry and both go; the page then carries a real
  `lastModified` instead of a hand-copied one.
- **Hand-derived `noindex` and `lastModified` beside an `extraUrls` entry** — a re-implementation of
  the SEO-flag read, or a date threaded in from elsewhere, written because an extra URL inherits
  neither. If the entry exists, `pathFor` gives you both back.
- **Nothing on the `pathFor` side if you were not already working around this.**

### The CMS now refuses to author a contested URL

_The write-boundary half of the previous entry._

**What changed.** Creating or renaming an entry, or renaming a collection, is refused when it would
give a second entry a URL another entry already holds. Previously only a production build caught
this, after the fact. Refused in two shapes, both leaving one of the pair unreachable: an entry
whose slug matches a sibling collection **that has an index entry**, and an index entry added to a
collection whose **parent** already holds an entry with that collection's name.

**Deliberately not refused:** an entry beside a same-named sibling collection that has _no_ index
entry. That is a landing page plus a folder of children, nothing is contested, and it keeps working.
The guard keys on the URL, never on the name.

It is also create/rename **only**. An ordinary save of an entry already in a contested pair still
succeeds — blocking it would trap you in an entry you could no longer fix. Pre-existing collisions,
from a merge or a retrofit, are the build guard's business.

**To adopt.** Nothing. Creating or renaming an entry into a contested URL returns **409** naming the
other entry and its path; renaming a _collection_ into one returns **400**, matching that endpoint's
existing refusals. Both messages say what to do about it rather than reporting a generic conflict.

**Now deletable.** Nothing — this closes a gap rather than replacing local code. If you added your
own editor-side check after hitting it, it is now redundant.

### A slug that cannot round-trip through a URL now fails the build, and the CMS refuses to create one — **breaking (build)**

**What changed.** Content file names are `{type}.{slug}.{id}.{ext}`, and the parse is anchored on
the type and the ID — so the `slug` segment could contain characters that are not valid in a URL
segment. A dot is the common one: `post.getting.started.guide.<id>.md` parses fine and lists with
`slug: 'getting.started.guide'`. But `readByUrlPath()` runs every candidate through a stricter rule
— lowercase letters, numbers and hyphens, starting with a letter or number — and skips anything that
fails it. Such an entry **built, got a `generateStaticParams` entry and a sitemap `<loc>`, and then
404'd on every actual visit.** Silently.

Two changes, both aimed at that:

- A **production build now fails** on it, listing every offending entry by path. This is the part
  most likely to turn a previously-green build red on upgrade: nothing about your content changed,
  but a page you did not know was broken is now loud.
- The **write API refuses to mint one** — a create with a non-conforming slug is rejected with
  `400`, and so is a rename to one, enforced in `ContentStore` itself so it holds for any client.
  Previously only `renameEntry`'s `newSlug` was checked.

It is **create/rename only**, deliberately. An entry that already has a non-conforming slug stays
readable, saveable and renameable — renaming it is the only way to clear the build failure, so
refusing to read or edit it would convert a red build into unreachable data. That is also why
enforcement is not in the path-resolution layer, which reads and writes share.

**To adopt.** Build once and read the failure list. For each entry it names, rename the file's
**slug segment** — the part between the type and the ID — to lowercase letters, numbers and hyphens
(`post.getting-started-guide.<id>.md`), leaving the type, the ID and the extension alone. Renaming
through the editor does the same thing. If the old URL was reachable in practice it was not
reachable through CanopyCMS, so there is no redirect to preserve — but check hand-written links to
it.

If you generate content with a script, slugify with the same rule before writing; `canopycms
migrate` already does. A script that writes files directly is not covered by the new refusal, which
is exactly the case the build guard exists for.

**Now deletable.** Any local build-time or CI check that walks content filenames looking for slugs
your routing could not serve, and any editor-side slug-format check in front of the create form.

### `readByUrlPath` answers only where `listEntries` publishes — **breaking (routing)**

**What changed.** `readByUrlPath` now resolves exactly the set of URLs enumeration advertises: for
every entry, `readByUrlPath(item.urlPath)` reaches it and nothing else does. Three shapes that used
to resolve now return `null`:

```diff
  await readByUrlPath('/blog/hello')          // the article — unchanged
- await readByUrlPath('/blog/article')        // ALSO the blog's index entry
- await readByUrlPath('/blog/article/hello')  // ALSO the article
+ await readByUrlPath('/blog/article')        // null
+ await readByUrlPath('/blog/article/hello')  // null
```

`article` there is an entry-type _name_. Both shapes came from one cause: an entry type is
registered in the schema at `<collectionPath>/<typeName>`, and a read against that path is delegated
to the parent collection — correct for `read({ entryPath })`, meaningless for a URL, whose non-slug
segments are collection names by construction. The first shape needed the collection to have an
index entry; **the second did not**, so it applied to every entry in every collection.

The third shape is an entry whose type token on disk is not one its collection declares — most often
an entry type renamed in the schema without renaming the files, so a page stayed live at a URL
enumeration had stopped publishing. **A collection that declares no entry types at all counts here
too**: it lists nothing, whatever sits in its directory. Neither case can arise from content the CMS
authored, so such content arrived by hand, by merge or by retrofit and was already missing from your
sitemap and static params. The fix is to rename the files to a declared type, or declare the type.
The entry stays fully editable, renameable and deletable throughout, deliberately — narrowing writes
too would make the mistake unfixable from the editor.

**Two things deliberately did not change.** `read({ entryPath: 'content/home' })` still addresses a
singleton structurally, defaulting the slug to the entry type's own name. And two _different_
entries claiming one `urlPath` is still a separate problem with its own guard.

**One gap remains, and is not fixed here.** A legacy untyped content file — `overview.json` rather
than `{type}.{slug}.{id}.{ext}` — is still readable by URL while invisible to `listEntries`,
`generateContentStaticParams` and the sitemap. Rename such files into the typed grammar to make them
real entries.

**To adopt.** Nothing, unless a route of yours depends on one of the URLs above. Two checks worth
doing once:

1. On a catch-all route, request `/<collection>/<entryTypeName>` and
   `/<collection>/<entryTypeName>/<some-slug>` for a few of your own type names and confirm a 404
   rather than a page you did not mean to publish. Under a full static export these were always CDN
   404s; under `next dev` or `output: 'standalone'` they were served.
2. If you renamed an entry type without renaming files on disk, those entries stop resolving. A
   build will not tell you — `listEntries()` will.

**Now deletable.**

- **Per-route `entryType` gates that exist only to reject a URL that should not have resolved** — a
  check at the top of a catch-all or `[slug]` route asserting the resolved entry is the type that
  route renders, added because the resolver handed back an entry from a different level and the
  template rendered with every field `undefined` while `if (!result) notFound()` stayed silent. Keep
  any `entryType` branch that genuinely dispatches between templates.
- **A catch-all filter that drops entry-type names before resolving** — a hard-coded list of
  segments to reject in front of `readByUrlPath`. It was never sufficient anyway: filtering the
  singleton's own name left every other type name declared beside it resolving.
- **A regression test asserting a specific phantom URL returns null.** The package now asserts the
  general invariant — enumerate, then probe every adjacent URL the resolver would attempt — over
  both its own fixtures and its reference app. Keep a local test only if it covers routing you own.

### Static exports are reproducible: `CANOPY_BUILD_ID` pins the build id, and the AI manifest stops baking a wall clock — **breaking (type-level)**

**What changed.** Two independent sources of build-to-build variance.

1. **`withCanopy(..., { staticBuild: true })` now honors `CANOPY_BUILD_ID` as Next.js's build id.**
   Next defaults `generateBuildId` to `nanoid()`, so two builds of one source tree land under
   different `out/_next/static/<id>/` directories. Unset, nothing changes; an explicit
   `generateBuildId` in your own config still wins. Deliberately ignored on non-static builds, where
   the dual-build flavors have different `pageExtensions` and therefore different chunk sets.
2. **`canopycms generate-ai-content` no longer writes an unconditional `new Date()` into
   `public/ai/manifest.json`.** It records `buildId` from `CANOPY_BUILD_ID`, and pins `generated` to
   `SOURCE_DATE_EPOCH` when that is set. Setting a build id and no `SOURCE_DATE_EPOCH` **omits
   `generated` entirely** — an artifact built once and promoted months later has a build clock that
   describes the runner, not the content. The runtime `/ai/*` route still uses a live clock, which
   is correct for a response generated on demand.

**Breaking, at the type level only:** `AIManifest.generated` is now `string | undefined`. If you
read that field in TypeScript you need a guard. It is still present at runtime for every build that
sets neither variable.

**To adopt.** Nothing is required. To make a static export reproducible, export `CANOPY_BUILD_ID`
for both the `next build` and the `generate-ai-content` step, and `SOURCE_DATE_EPOCH` too if you
want the manifest to keep a timestamp. The id must be 1-255 characters of `[A-Za-z0-9._-]` and not
`.` or `..`, because Next splices it into a path segment with no validation of its own; a value that
is set but unusable is ignored with a warning.

Two things to know before computing that id. A **commit SHA or commit date is not a substitute for a
tree hash**: a rebase or cherry-pick gives an identical tree a different commit object and date,
reintroducing the variance. And a hex id containing the letters `ad` is safe here — Next re-rolls
such ids only on its internal fallback path.

**Now deletable.** A per-site `generateBuildId: () => process.env.<YOUR_VAR> || null` line in
`next.config.ts` — **provided you also pass `{ staticBuild: true }`**. On a non-static build
`withCanopy` leaves `generateBuildId` alone by design, so deleting your line there un-pins the build
id silently; keep it. If you do pass `staticBuild: true`, delete the line and export
`CANOPY_BUILD_ID` instead — but check its operator first: written with `??` rather than `||`, an
empty-string environment variable survives, clears Next's `typeof buildId !== 'string'` guard, and
ships an **empty** build id. Also deletable: any post-build step that rewrites or strips the
manifest's `generated` field.

### The CMS image builds without git, `CanopyCmsService` defaults to arm64, and the CDK app is type-checked — **breaking (deploy), for a stack that sets `platform` without `architecture`**

**What changed.** Six changes to how the CMS editor image is built and deployed. They matter most if
you ran `canopycms init-deploy aws` before them, or copied `Dockerfile.cms.template` by hand.

1. **Build-time reads come from the working tree.** `next build` reads content from the build
   context, in either operating mode, and never touches git, a branch clone or `.canopy-dev`. The
   generated `Dockerfile.cms` builder stage no longer installs git or commits a snapshot repository,
   and sets `ENV CANOPY_BUILD_MODE=true` so anything else the build command runs reads the working
   tree too. The runner stage still installs git.
2. **The pnpm install sees `pnpm-workspace.yaml`.** The pnpm Dockerfile copies it before installing
   (`COPY package.json pnpm-lock.yaml pnpm-workspace.yam[l] ./`); pnpm 11 keeps its `allowBuilds`
   decisions there and fails the install without them.
3. **`init-deploy aws` keeps `infrastructure/` out of the app**, adding it to your `tsconfig.json`
   `exclude` (or asking you to) and to the generated `.dockerignore`, so `next build` no longer
   type-checks the CDK app.
4. **The CDK app is type-checked separately.** The generated workflow runs `tsc --noEmit -p
infrastructure` against a scaffolded `infrastructure/tsconfig.json`. `cdk.json` runs the app
   through tsx, which does not check types, so without that step a misspelled `CanopyCmsService`
   prop is dropped silently.
5. **`CanopyCmsService` defaults to `Architecture.ARM_64`** and always passes the resolved
   architecture to the function, which is what CDK derives a `fromImageAsset` image's build platform
   from. The generated workflow runs on `ubuntu-24.04-arm`, so that image builds natively.
6. **`withCanopy()` makes a Turbopack standalone server able to load sharp.** For any build except a
   static export it adds sharp's libvips to Next's file tracing, and on Next 16 and later it also
   sets `turbopack: {}` when your config has neither `turbopack` nor your own `webpack` and it can
   read your installed Next version. A webpack build still fails its image transforms (see
   [deploying-to-aws.md](deploying-to-aws.md#dual-build-support)).

**Breaking, for one stack shape.** A stack that sets `platform` on `fromImageAsset` and leaves
`architecture` unset got an x86_64 function; it now gets an arm64 one while the explicit `platform`
still decides the image, so `platform: Platform.LINUX_AMD64` builds an x86_64 image the arm64
function cannot run. A stack generated before this change sets both and still agrees. A stack
setting neither moves to arm64 on the next deploy, with an image built to match — natively on an
arm64 host, under QEMU emulation on an x86 one (see [Where the image is
built](deploying-to-aws.md#where-the-image-is-built)).

**To adopt.**

1. In your CDK stack, delete `platform` from `fromImageAsset` with its `Platform` import, and set
   `architecture` on `CanopyCmsService` only if you want x86_64. Read [Where the image is
   built](deploying-to-aws.md#where-the-image-is-built) before changing the architecture or the
   workflow's runner.
2. Re-run `canopycms init-deploy aws`. Without `--force` it asks before replacing each file you
   already have (`--non-interactive` skips them, `--force` replaces everything including a stack you
   have edited); either way it adds `infrastructure/tsconfig.json` and the `exclude` entry. For the
   `Dockerfile.cms`, `.dockerignore`, workflow and stack you keep, bring the rest across by hand:
   - the workflow's "Type-check the CDK app" step, before "Configure AWS credentials", and
     `tsconfig.json` in its `on.push.paths` (`examples/aws-deployment/deploy-cms.yml` has both,
     rendered for npm);
   - `runs-on: ubuntu-24.04-arm`, if yours still says `ubuntu-latest`;
   - an `infrastructure` line in `.dockerignore`;
   - with pnpm, `pnpm-workspace.yam[l]` in the Dockerfile's first `COPY`.

   A regenerated workflow and stack also carry the optional GitHub App wiring and the secret
   JSON-field variables, which change nothing while unset; see [the CDK GitHub App
   entry](#the-cdk-worker-can-authenticate-as-a-github-app-45) to use them.

3. An existing hand-copied `Dockerfile.cms` builds as before. Update it when convenient by deleting
   the builder's git install and snapshot commit and adding `ENV CANOPY_BUILD_MODE=true` before the
   build command.

**Now deletable.**

- In a hand-copied `Dockerfile.cms`, the builder's git install and snapshot commit, and any step
  that created or checked out your base branch there so the build could find it.
- In CI that runs `next build`, a step that attaches a detached HEAD or creates the base branch
  locally only so the build's content reads resolve.
- In your CDK stack, `platform` on `fromImageAsset` and its `Platform` import.
- If you use `withCanopy()`: a hand-written `outputFileTracingIncludes` entry for sharp's libvips
  (`withCanopy()` adds its own and keeps yours), and a `turbopack: {}` added only to get past Next
  16's error about `withCanopy()`'s `webpack` function — as long as `withCanopy()` can read your
  Next version, which it cannot under Yarn PnP.

---

<!--
Template for each entry — copy, don't improvise:

### <short title>

**What changed.** One or two sentences.

**To adopt.** Concrete steps, with the import path and the call shape.

**Now deletable.** Describe the PATTERN of local code this supersedes ("a hand-rolled
filename parser") so any adopter can recognise it in their own tree. Never name files,
paths, branches, hosts or identifiers from a specific adopter's repo: this package is
public and its adopters' repos generally are not. If nothing becomes deletable, say so
explicitly — that is a real and useful answer.
-->

---

## Released

### 0.0.63

Every entry below shipped in `0.0.63`. They were promoted from `## Unreleased` manually — see the
note under that heading for why a released feature can still be sitting there.

#### `required: false` now infers an optional property (#14) — **breaking (type-level)**

**What changed.** `TypeFromEntrySchema` used to emit every field as a _required_ property, adding `|
undefined` to the value type for `required: false` fields. It now emits them as genuinely _optional_
properties, at every level — top-level fields, fields inside `object` fields, and fields inside
block templates:

```diff
- { heading: string; subheading: string | undefined }
+ { heading: string; subheading?: string }
```

**Only an explicit `required: false` is affected.** A field that omits `required` still infers a
required property, unchanged and deliberate, now pinned by tests. This is type-only: no runtime, no
content-file format, no validator behaviour changes.

_Not broken:_ reading (`data.subheading` is still `string | undefined`), constructing literals
(strictly more permissive — this is the win), `keyof T`, `in`, spreads, `Object.entries`.

_Broken (act on these):_

- **Assigning a `TypeFromEntrySchema` value to a hand-written interface declaring the key as
  required-with-`undefined`** (`subheading: string | undefined`). Fix the interface to use
  `subheading?: string` — or delete it and derive from the schema.
- **`Required<T>`** now strips the `?` and yields `subheading: string`, where before it was a no-op.
  Audit any `Required<...>` applied to a schema-derived type.
- **`exactOptionalPropertyTypes: true` projects.** Under that flag, writing
  `x.subheading = undefined` or passing `{ subheading: undefined
}` becomes an error; omit the key instead. A plain `"strict": true` does not enable it.
- **`exactOptionalPropertyTypes: true` combined with `skipLibCheck: false`** fails to compile
  against the package at all, independent of the advice above: a pre-existing gap in a `reference`
  field's inferred type surfaces as a library-internal type error. `skipLibCheck: true` (the Next.js
  default) avoids it; there is no other workaround today.

**To adopt.** Bump the pin. No API change, no import to add.

**Now deletable.**

- **`undefined`-walls in schema-typed literals.** Any `: undefined,` line that exists only to
  satisfy a `required: false` field — delete the line, do not replace it. These cluster in route or
  page modules that construct a schema-typed object by hand. The follow-on benefit is the real
  point: adding a new `required: false` field no longer breaks every hand-written literal in the
  app, friction whose observed effect was to push a team toward hardcoding content into components
  rather than extending the schema.
- **Nothing, possibly.** `: undefined` inside ternaries, local fixtures or non-schema-derived types
  is unaffected, and two patterns that look affected are not: `NonNullable<Schema['field']>` still
  resolves identically, and `Required<...>` applied to a _local_ type is untouched.

#### Sitemap and SEO metadata helpers (#10, #10a)

**What changed.** The two static-export surfaces ship **together on purpose** (see the `noindex`
note below).

The surface is `collectRoutableEntries`, `extractSeoFields`, `isNoindexEntry` and the
`resolveSeoUrl` / `withTrailingSlash` / `isAbsoluteUrl` shapers from `canopycms/server`;
`defineSeoFieldGroup()` from `canopycms`; and `generateContentSitemap` plus `entryToMetadata` from
`canopycms-next`, both bound on `createNextCanopyContext`'s result so your route modules never
import the admin build context. See [README's Sitemap and SEO
Metadata](../README.md#sitemap-and-seo-metadata) for each signature.

Two shapes that are easy to get wrong: **an empty or whitespace-only SEO field counts as unset**, so
a fallback wins (CanopyCMS writes optional fields present-but-empty), and `defineSeoFieldGroup({
group: 'seo' })` nests the group under a key, which you must then pass to the read side as well.

**Four behaviors worth knowing before you wire it up.**

1. **Every routable entry type is in the sitemap by default** — no allow-list to maintain; omission
   requires an explicit `exclude` predicate or a `noindex` flag. A hand-rolled sitemap listing only
   the entry types someone remembered shipped advertising a fraction of a real site, with whole
   content types invisible to search engines and nothing warning.
2. **The mirror failure: a type with no route.** An entry type meant for embedding is
   schema-routable but has no page, so leaving it unexcluded advertises a URL that 404s. Ask whether
   a route actually serves that `urlPath` shape, not whether the schema allows it.
3. **`trailingSlash` is an explicit option, and is not inferred.** CanopyCMS cannot see your
   framework's routing config; pass `trailingSlash: true` to both helpers if your site serves them.
4. **`noindex` drives BOTH surfaces from one predicate** — `robots: { index: false }` and sitemap
   exclusion. That is why these ship in one change: derived separately, an entry stayed advertised
   in one surface while suppressed in the other. Enumeration is unaffected, so noindex entries still
   build and resolve for anyone holding the link.

**`lastModified` — read this before trusting it.** It defaults to the entry's `updatedAt`, which is
the file's **filesystem mtime**, not an editorial timestamp: a fresh CI clone dates every URL to the
clone. Pass a `lastModified` callback returning a real content date, or `undefined` to omit
`<lastmod>`. `robots.txt` stays out of scope — write `app/robots.ts` yourself and point its
`sitemap` field at your sitemap route.

**New way for a build to go red.** `generateContentSitemap` inherits `collectStaticPaths`'s
build-time schema-validity guard, so a schema-invalid entry now fails sitemap generation too —
including in an app with no `generateStaticParams` at all.

**To adopt.**

```ts
// app/lib/canopy.ts — bind the sitemap helper once
export const contentSitemap = async (options: GenerateContentSitemapOptions) => {
  const context = await canopyContextPromise
  return context.generateContentSitemap(options)
}

// app/sitemap.ts
export const dynamic = 'force-static' // required for output: 'export'
export default () =>
  contentSitemap({
    siteUrl: SITE_URL,
    trailingSlash: true, // match your framework's routing config
    exclude: (entry) => entry.entryType === 'author', // types with no page of their own
  })

// app/posts/[slug]/page.tsx — the type argument matters: without it `result.data`
// is `unknown` and `result?.data.title` fails to compile (TS18046).
const result = await readByUrlPath<PostContent>(`/posts/${slug}`)
return entryToMetadata(result?.data, {
  path: `/posts/${slug}`,
  siteUrl: SITE_URL,
  fallbackTitle: result?.data.title,
})
```

Add `defineSeoFieldGroup()` to any schema whose entries should carry SEO fields. If you already have
an ad-hoc SEO group using different field names, either rename the fields to the defaults or pass
`{ fields: { title: 'yourName' } }` to the read side — do not keep both.

**Now deletable.**

- **A hand-rolled sitemap enumerating a hardcoded list of entry types** — a module holding a
  `ROUTABLE_ENTRY_TYPES`-style array, looping it and mapping each type to a URL prefix. Replace it
  wholesale; keep only the deliberate exclusions, now expressed as an `exclude` predicate.
- **A hand-written entry-data to `Metadata` mapper**, and any per-route copy of "meta title else
  page title else site name". Scattered copies are how two routes disagree about which title wins.
- **A local `withTrailingSlash` / `absoluteUrl` pair.** Watch for one bug while deleting: a version
  that normalized the path _before_ checking whether it was absolute turned an off-site canonical
  into `<your-site>/https://other.org/page/`. The shipped `resolveSeoUrl` checks absolute first.
- **A build-time content walk that exists only to date sitemap URLs** — `collectRoutableEntries` now
  carries `updatedAt`, with the same mtime caveat.
- **Nothing, for `robots.txt`**, which stays hand-written deliberately.

#### Static-generation review follow-ups: siteUrl validation, one shared SEO field location, sitemap dedup

**What changed.** Five gaps in the helpers above, all closed:

1. **`generateContentSitemap`'s `siteUrl` is now validated.** A non-absolute value produced a
   `<loc>` with no scheme — invalid per the sitemap spec, and most search engines silently reject
   the **entire file**. It now throws, naming the value it received.
2. **`generateContentSitemap` and `entryToMetadata` can share ONE SEO field location.** Each took
   its own `seo`/`fields`/`group` option, so setting it on one call and forgetting the other left a
   `noindex` entry advertised in the sitemap while its own page said `robots: noindex`. Pass `seo`
   to `createNextCanopyContext` once and both bound helpers use it; a per-call override still wins.
3. **`withTrailingSlash` no longer appends the slash inside a query string or fragment.**
   `/blog?page=2` becomes `/blog/?page=2`.
4. **`generateContentSitemap` dedupes colliding URLs and warns.** Two entries resolving to the same
   `<loc>` used to appear twice; the first is kept, the rest dropped, with a warning naming the
   collision.
5. **A content file CanopyCMS cannot parse into an entry now fails a production build**, as a
   schema-invalid entry already did. Previously it was dropped from `listEntries` — and therefore
   from every surface built on it — with **zero build output** unless `CANOPYCMS_DEBUG=true`. The
   realistic trigger is a schema rename that left a stale file behind. `next dev` and the admin UI
   are unaffected.

**To adopt.** If you pass `seo`/`fields`/`group` identically to both helpers, move it to
`createNextCanopyContext({ seo })` and drop the per-call copies. Otherwise nothing changes — the
other behaviors only fire on inputs that were already wrong.

**Now deletable.** A local workaround that repeats the SEO field location on every call site to keep
the two surfaces in sync by hand.

#### The build guard now ignores files that were never entry-shaped

**What changed.** The content-entry build guard was too broad: it fired on _any_ file inside a
collection directory sharing a recognized content extension but failing to parse as
`{type}.{slug}.{id}.{ext}` — including a colocated sibling artifact read via an `entryTransforms`
`readSibling(...)` call and named `{contentId}.suffix.ext` per that convention. Dropping one of
those next to its entry used to red a production build for using a documented feature.

The guard now only fires on a file that structurally _could_ have parsed as an entry: 4 or more
dot-separated segments, OR exactly 3 whose first segment names a real entry type in that collection.
So a bare `README.md` and a `5NVkkrB1MJUv.profile.json` sibling both build clean, while a file that
still looks like an attempted entry — wrong type, invalid ID, genuinely 4+ segments, or a real entry
type name with no ID at all (`post.hello-world.md`, the likeliest real accident) — still fails with
an error naming the file. Dot-prefixed and underscore-prefixed filenames are always skipped, as
established "not an entry" conventions. The error message now also names the sibling-artifact
convention as one way to resolve it: keep sibling filenames to `id.suffix.ext`, three segments.

**To adopt.** Nothing required. If you moved a sibling artifact outside its collection directory, or
renamed it, to dodge the old guard, move it back — `readSibling` only ever looked inside the
collection directory next to the entry, so relocating it may have silently broken the
`entryTransforms` call that reads it.

**Now deletable.** Any workaround that relocated or renamed a colocated sibling artifact solely to
avoid tripping the build guard.

#### `canopycms init` scaffolds `defaultBranchAccess: 'deny'` and public read by default

**What changed.** The generated `canopycms.config.ts.template` used to write `defaultBranchAccess:
'allow'`, which no longer matched the package's fail-closed schema default — a freshly scaffolded
project ran with a WIDER access posture than the package itself considers safe. The template now
scaffolds `'deny'`.

Flipping the branch default alone would have made `canopycms init` then `npm run dev` 403 every
route for the developer running it, including the dev-auth default user, because `defaultPathAccess`
is a separate layer with its own fail-closed default and the template relied on the branch layer to
paper over it. So the template also scaffolds `defaultPathAccess: { read: 'allow' }` — public read,
edit and review still closed — the posture [README's "Public read on server
deployments"](../README.md#public-read-on-server-deployments) recommends and `apps/example1` already
uses. This is not a security walk-back: only `read` opens, only on the PATH layer, and an anonymous
request must still pass both layers.

**To adopt.** This only changes what NEW `canopycms init` runs write. Two cases to check in your own
`canopycms.config.ts`:

- You relied on the old scaffold's `defaultBranchAccess: 'allow'` and never overrode it: you were
  running wider-than-recommended branch access; consider tightening to `'deny'` (creators and the
  base branch still resolve, so this is rarely a functional lockout).
- You copied the scaffold, kept `defaultPathAccess: { read: 'allow' }`, and later deleted that line
  thinking it was an example: you have silently inherited the fully closed default on every level,
  including `read` — anonymous routes will 403 until you restore it.

**Now deletable.** Nothing — this only affects newly generated files.

#### `parseTypedFilename` exported from `canopycms/server` (#1)

**What changed.** `parseTypedFilename` — parses `{type}.{slug}.{id}.{ext}` into `{ type, slug, id }`
— existed but was never re-exported, so no adopter could import it. It is now exported from
`canopycms/server`, with a JSDoc block documenting the filename grammar in full.

Its `entryTypes` second argument is now **optional**. Omit it to parse the shape structurally
without validating `type` against a known list, which is what every hand-rolled copy actually does,
since none has an entry-types list in hand at the point it parses a filename. Behaviour is
byte-identical when the argument is supplied.

**To adopt.**

```ts
import { parseTypedFilename } from 'canopycms/server'

const parsed = parseTypedFilename('post.hello-world.vh2WdhwAFiSL.md')
// { type: 'post', slug: 'hello-world', id: 'vh2WdhwAFiSL' }
```

IDs are 12-character Base58, excluding the ambiguous characters `0 O I l`; `parseTypedFilename`
returns `null` for a filename whose ID segment fails that check even when the rest looks right.

**Now deletable.** Every hand-rolled copy of this parsing. Search your tree for `.split('.')` or
`lastIndexOf('.')` applied to a content filename — across two audited adopter repos there were four
copies and **they disagreed with each other**: different segment counts, and one lowercased the slug
while another did not. Two backed a link-integrity check, so the drift silently narrowed what that
check covered. Typical homes for a copy:

- A test or script validating content links or checking for slug collisions.
- A build-time module that walks the content root (which this change plus the `updatedAt` entry
  below usually delete entirely).
- A helper that recovers an entry's type or ID from a path — superseded more completely by the
  `meta.entryType` entry below, which removes the need to parse at all.
- Route-level `{type}.{slug}.{id}` hand-splits.

#### `defaultBuildPath` exported from `canopycms/server` (#2)

**What changed.** `buildContentTree`'s default URL path builder — strip the content root, collapse
an entry's `index` slug to its parent collection path, lowercase — was module-private, so extending
it rather than replacing it outright meant reimplementing it. It is now exported as
`defaultBuildPath`, and the `buildPath` option's JSDoc documents the default's exact behavior.

**To adopt.**

```ts
import { defaultBuildPath } from 'canopycms/server'

canopy.buildContentTree({
  buildPath: (logicalPath, kind) => {
    const base = defaultBuildPath(logicalPath, 'content', kind)
    return kind === 'entry' ? someTransform(base) : base
  },
})
```

`buildPath` still fully replaces the default when supplied — it is not automatically composed with
it.

**Now deletable.** Any verbatim reimplementation of the default path builder passed as a custom
`buildPath`. A real adopter had copied it exactly, which silently forks URL derivation the moment
the package default changes. Replace it with a call to `defaultBuildPath`, or drop the custom
`buildPath` entirely if you were not actually extending the default.

#### `read()` / `readByUrlPath()` return `meta.entryType` and `meta.entryId` (#3)

**What changed.** Both now include `entryType: string` and `entryId?: ContentId` on the returned
`meta`, alongside `meta.physicalPath`. Both were already resolved internally during path resolution
— this is plumbing, not new derivation. `entryId` is `undefined` only for legacy entry files that
predate embedded-ID filenames; `entryType` is always populated.

**Read this before branching routing logic on `entryType`.** "Always populated" does not mean
"always accurate": the entry type is read from the resolved file's own filename, not re-validated
against the collection's current schema on every read.

- **For a legacy file, `entryType` is a guess.** A legacy filename (`{slug}.{ext}`) carries no type,
  so `entryType` falls back to the collection's _default_ entry type. **`entryId === undefined` is
  the signal that this happened.**
- **It is usually, but not guaranteed to be, a key in the collection's `entries` config.** It can
  diverge if an entry type was renamed or removed after files using the old name were created, or if
  a file was hand-authored with a type token that was never real. Do not look it up in your schema's
  `entries` array without a fallback case.

**To adopt.**

```ts
const result = await canopy.readByUrlPath(urlPath)
if (!result) return notFound()
switch (result.meta.entryType) {
  case 'home':
    return <HomePage data={result.data} />
  default:
    return <DocView data={result.data} />
}
```

Purely additive — no change to either function's input side.

**Now deletable.**

- Any helper that recovers the entry type by parsing `meta.physicalPath`, typically a one-liner
  splitting the filename on `.` and taking the first segment. Likewise any re-derivation of the
  entry ID.
- Guard-and-delegate blocks in routes that exist only because the read result carried no entry type
  — the shape is a route that must re-check "is this actually the type I handle?" before rendering.
  Each collapses to a `switch` on `result.meta.entryType`, often letting several near-duplicate
  route files become one catch-all.

#### Build-context factory, title derivation, and a Markdown-to-plaintext primitive (#17)

**What changed.** A requested `extractSearchDocuments(registry, opts)` helper **is not being
built**: two real search-index derivations shared essentially nothing at that level, and a generic
extractor would have to guess which keys are prose — guessing wrong silently omits content from the
index. What genuinely was duplicated is the plumbing _around_ the derivation. Three primitives cover
it:

- **`createBuildCanopy(config, options)`**, from `canopycms/server`. A one-call factory for a
  **build/admin** Canopy context — `createCanopyServices` plus `createCanopyContext` plus a
  synthetic admin user, wired the way `getCanopyForBuild()` does it internally, minus the Next.js
  pieces. For standalone scripts running outside a Next.js request or build phase. **It bypasses all
  branch and path ACLs — do not use it in request-handling code.**
- **`resolveEntryTitle(data, options)`**, from `canopycms/server` and the root `canopycms` entry
  (type-only dependencies, so client-safe). Resolves a display title through the chain: a
  schema-marked `isTitle` field, then `data.title`/`data.name`, then an entry-type label, then a
  humanized slug, then `"Untitled"`.
- **`toPlainText(markdown)`**, from `canopycms/ai`. Converts MDX/Markdown body content to plain
  prose: strips frontmatter, JSX tags and expressions, and Markdown syntax; unwraps code fences and
  inline code to their bare content; keeps link and image text while dropping the URL. The reason it
  is worth shipping: **a paired custom component loses only its tags, never its contents.** A
  hand-rolled stripper that deletes `<Callout>...</Callout>` wholesale drops every word inside it
  from the search index, invisibly.

**To adopt.**

```ts
// A standalone script — index builder, content audit, codegen — run with tsx/node,
// never imported by Next.js.
import { createBuildCanopy, resolveEntryTitle } from 'canopycms/server'
import { toPlainText } from 'canopycms/ai'
import config from '../canopycms.config'
import { entrySchemaRegistry } from '../src/schemas'

const canopy = await createBuildCanopy(config.server, { entrySchemaRegistry })
const entries = await canopy.listEntries()

for (const entry of entries) {
  const title = resolveEntryTitle(entry.data, { schema: entry.schema })
  const body = typeof entry.data.body === 'string' ? toPlainText(entry.data.body) : ''
  // ...build your search document however your site actually needs it
}
```

Because the boot sequence is one function call over a plain config object, a script built this way
can be imported and exercised from a test, unlike a hand-rolled top-level-`await` boot block.

**Now deletable.**

- **The hand-rolled boot block.** Any standalone script that manually calls `createCanopyServices`
  plus `createCanopyContext` and builds its own synthetic admin user. Replace with one
  `createBuildCanopy` call.
- **A hand-rolled title-fallback chain** — any `data.title ?? data.name ?? humanize(slug)`-shaped
  helper, especially one that does not also check for a schema-marked title field.
- **A hand-rolled Markdown/MDX-to-plaintext stripper**, especially one that deletes a matched custom
  component's entire span rather than keeping the children's text. If your search results are
  missing content you can see in the source file, this is the pattern to look for.

#### `listEntries` carries `updatedAt` (#4)

**What changed.** `listCollectionEntries` already ran an unconditional `fs.stat` on every entry file
and set `updatedAt`; `listEntries` was discarding it. `ListEntriesItem.updatedAt?: string` (ISO 8601) is now populated on every result.

**Caveat — read before wiring this to `<lastmod>`.** `updatedAt` is the file's filesystem mtime,
**not** an editorial "last changed" timestamp. A fresh CI clone, or a fresh branch-clone checkout,
resets every file's mtime, so there it reflects when the branch was checked out. Treat it as
"changed since the last build" at best. Sourcing mtime from git commit history is a real gap this
does not close.

**To adopt.** No signature change — `entries[i].updatedAt` is populated wherever `listEntries` is
already called.

**Now deletable.** Any build-time module that walks the content root with `node:fs` to collect file
mtimes. One adopter had ~75 lines of directory walking plus a second copy of filename parsing for
exactly this; deleting such a module usually removes a duplicate filename parser too.

#### `BlockValueOf` / `BlockComponentRegistry` — exhaustive block → component types (#13)

**What changed.** Two new exported types make a block-field to React-component mapping exhaustive
**at compile time**. `Blocks` is a block field's own discriminated union, as already derived by
`TypeFromEntrySchema`; `BlockComponentRegistry` requires exactly one component per template name —
no more, no fewer, when the registry is written as an object literal (TypeScript's excess-property
check is literal-only; the missing-key direction holds regardless).

Deliberately shipped as types, not a `renderBlocks()` runtime helper: a helper would have to pick a
key strategy, an unknown-template policy, and how extra props reach each component, and any one of
those choices is wrong for someone.
[README's Block Component Registries](../README.md#block-component-registries) has the full recipe,
including the one contained type assertion the dispatch loop needs;
`apps/example1/app/components/PostView.tsx` uses the pattern end-to-end.

**To adopt.**

```ts
import type { BlockComponentRegistry } from 'canopycms'

type Blocks = Page['blocks'][number]

const blockRegistry: BlockComponentRegistry<Blocks> = {
  hero: ({ data }) => <HeroSection headline={data.headline} />,
  cta: ({ data }) => <CtaSection title={data.title} />,
  // Missing a key here, or a key that doesn't match a template name, is a compile error.
}
```

Purely additive — no existing API changes.

**Now deletable.**

- A `switch (block.template) { ... default: return null }` over block templates. That `default` case
  is exactly the failure mode this replaces: renaming or removing a template in the schema falls
  through it silently — green build, green tests, a page section that renders nothing.
- A hand-written test asserting "the schema's declared block templates match the handled set" in
  both directions. The registry catches that drift at compile time.

#### Reusable field fragments — documented, plus `defineFieldFragment()` (#15)

**What changed.** No new runtime behavior — this closes a documentation gap. Two patterns for
sharing a field cluster across schemas already worked and now have [a README
section](../README.md#reusable-field-fragments): spreading a `const`-inferred field array into
multiple schemas' `fields`, and nesting `defineInlineFieldGroup()` inside a block template (inline
groups are transparent at every layer — inference, storage, validation, reference resolution and the
editor). A new 3-line `defineFieldFragment()` identity helper sits beside `defineBlockTemplate`
purely for discoverability; a plain `const fields = [...] as const` spread works identically.

**To adopt.**

```ts
import { defineFieldFragment, defineEntrySchema } from 'canopycms'

const ctaFields = defineFieldFragment([
  { name: 'ctaLabel', type: 'string' },
  { name: 'ctaHref', type: 'string' },
])

const heroSchema = defineEntrySchema([{ name: 'headline', type: 'string' }, ...ctaFields])
const bannerSchema = defineEntrySchema([{ name: 'message', type: 'string' }, ...ctaFields])
```

For a per-use override — one schema needing a different `required` or `label` on one field — do not
spread that field; compose from the same underlying `const` field object and override just the key
that differs.

**Now deletable.** A field cluster spelled out identically across several schemas by hand. In one
audited real-world schema the same cluster was retyped eight times and a preview-object cluster
three times, and the copies had already drifted apart on a `select` field's option list, invisibly.
Collapse them into one fragment and spread it; for schemas needing one field to differ, override
just that field.

#### Shared/referenced blocks: documented recipe, plus a `listEntries` caveat (#16)

**What changed.** No new runtime behavior. A block template can already hold a `reference` field
pointing at another entry — so a shared content block is just a small entry type plus a one-field
block template, and `read()`/`readByUrlPath()` already resolve the reference before your code sees
it. This now has [a README recipe](../README.md#shared--referenced-blocks) with a worked example,
plus one shared reference wired into `apps/example1/app/schemas.ts`.

**The caveat:** `listEntries()` reads content files raw off disk and never resolves `reference`
fields, so a surface built from it — a search index, a sitemap, an AI-content export — sees a shared
block's reference as `null` or a bare id string. Superseded by ["`listEntries()` and
`buildContentTree()` can now resolve `reference`
fields"](#listentries-and-buildcontenttree-can-now-resolve-reference-fields-16), which adds the
option; act on that entry instead.

**To adopt.**

```ts
const ctaSnippetSchema = defineEntrySchema([
  { name: 'title', type: 'string' },
  { name: 'ctaText', type: 'string' },
])

const sharedCtaBlock = defineBlockTemplate({
  name: 'sharedCta',
  fields: [
    {
      name: 'snippet',
      type: 'reference',
      entryTypes: ['ctaSnippet'],
      resolvedSchema: ctaSnippetSchema,
    },
  ],
})
```

**Now deletable.** A hand-rolled second `read()` call scattered through page code to "unwrap" a
shared block's reference field — the resolution already happens inside `read()`/`readByUrlPath()`,
including inside block templates.

#### `checkPathAccess` removed from `CanopyServices`

**What changed.** The `CanopyServices` interface no longer exposes `checkPathAccess`. It was bound
at service-creation time with an empty rule set — path permissions are loaded from the settings
branch per request, not known that early — so any call through it always fell through to the default
path-access decision, never a real per-path rule. `checkContentAccess`, `checkBranchAccess` and
`createContentAccessChecker` are unaffected and remain on `CanopyServices`.

**To adopt.** Nothing, unless you called `context.services.checkPathAccess` directly. If you did, it
was never evaluating your actual rules — replace it with
`context.services.createContentAccessChecker(...)`, which resolves the real rule set once and
returns a synchronous per-path checker.

**Now deletable.** Nothing, since it never returned a real answer.

### 0.0.62 and earlier

Not retro-documented. Two things adopters upgrading from an older pin should know, because both bit
a real site:

- **`rich-text` was removed** (breaking). It was an undocumented alias for `markdown` and was used
  by no adopter, example or fixture. If you have a `type: 'rich-text'` field, change it to
  `type: 'markdown'`.
- **Content IDs are 12-character Base58** and exclude the ambiguous characters `0 O I l`. A
  hand-rolled ID containing one of those is silently ignored — the entry never loads and nothing
  warns. Use `generateId()` from `canopycms/server`; never hand-roll an ID.
