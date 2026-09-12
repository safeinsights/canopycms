# The worker's JSON-secret-field env vars have no CDK props, so a `CanopyCmsService` adopter cannot set them

**Status: open.** Opened 2026-09-12 alongside PR #320, which shipped the worker half of
adopter request #46. This is the CDK half ("PR A2" of that plan).

## Problem

`packages/canopycms-cdk/worker/index.ts` now reads two env vars:

| Env var | Names a field inside the secret at |
| --- | --- |
| `CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD` | `CANOPYCMS_GITHUB_TOKEN_SECRET_ARN` |
| `CLERK_SECRET_KEY_SECRET_JSON_FIELD` | `CLERK_SECRET_KEY_SECRET_ARN` |

Nothing stamps them. `CanopyCmsService` builds the worker's `.env` from a **closed** list of
`envEntries` in `src/constructs/cms-service.ts` with no passthrough — `props.environment`
reaches the Lambda only. So the feature is inert for anyone deploying through the construct,
which is every documented adopter.

The visible symptom is worse than "nothing happens". An adopter whose secret holds a JSON
document now gets a loud warning **on every worker boot** naming the env var to set, and
there is no supported way to act on it: user-data rewrites `/opt/canopy-worker/.env` on every
instance launch and the ASG replaces instances on every `cdk deploy`, so a hand-edited `.env`
does not survive. A warning that cannot be acted on is a worse state than the silence it
replaced, and it is the state the repo is in until this lands.

## Why it was not done in PR #320

Deliberate split, so the worker half could be reviewed against real tests before the CDK
surface was widened. #320 says so in its body and in `docs/adopter-migration.md`. The cost is
this window, which is why this file exists rather than a line in a commit message.

## Shape of the fix

Two optional string props (`githubTokenSecretJsonField`, `clerkSecretKeySecretJsonField`) and
two `envEntries`. Reuse, do not re-implement:

- **`envEntries`, never `addCommands`** — values added by the other route silently skip
  `assertEnvSafe` (`cms-service.ts`), which is the guard that rejects newlines and quoting
  hazards in a generated `.env`.
- **`workerUserDataBlobs`** (`cms-deploy.test.ts`) for presence **and absence** assertions —
  the `settingsBranch` suite is the model for absence. Pair every `not.toContain` with a
  positive assertion; against a blob helper they pass vacuously if the blob shape changes.
- Add each new prop to the **`fields` array** of the parameterized heredoc suite in
  `cms-deploy.test.ts`. It is built to be extended, and not extending it is precisely how a
  value skips `assertEnvSafe`.

**No IAM change.** A JSON field is not a grantable resource — the secret ARN already is, and
the grant already exists. Worth a comment saying so: the resource union in `cms-service.ts`
exists because someone previously assumed the opposite.

Two synth-time guards, both closing silent failures:

1. A JSON-field prop **without** its ARN must throw. Otherwise the field is stamped, the ARN
   is not, `refreshAuthCache` becomes `undefined`, and the auth cache silently never
   refreshes.
2. A secret ARN matching `/:secret:.*-[A-Za-z0-9]{6}:/` must throw, naming the new prop. An
   adopter trying the ECS `:KEY::` convention otherwise gets either CDK's cryptic suffix error
   or an unmatchable IAM `Resource` and a 5-second systemd restart loop.

Then the templates, `examples/aws-deployment/`, the `deploying-to-aws.md` tables, and
`docs/adopter-migration.md`. Copy the example-drift idiom in `asset-support.test.ts`, which
reads `examples/aws-deployment/…/cms-stack.ts` off disk, rather than trusting review to keep
four copies of the wiring in step.

## Related

- PR #320 — the worker half, and the `getSecret` matrix these props feed.
- [adopter-request-log-intake.md](adopter-request-log-intake.md) — where request #46 came
  from, and where its disposition gets recorded.
