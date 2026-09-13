# `examples/aws-deployment/` has drifted from the scaffold templates it mirrors, and nothing compares the two

**Status: open. Priority: P1.** Filed three times, independently, on 2026-09-12, and merged into
this file during the base merge of `int-202609-a` into `int-202609-cms-image` (#341). The other
two filings are kept as history:
[example-deploy-workflow-drifted.md](resolved/example-deploy-workflow-drifted.md) and
[examples-aws-deployment-drift.md](resolved/examples-aws-deployment-drift.md).

## How it was found

- While wiring the secret JSON-field props (PR A2 of the adopter-request-#45/#46 plan), which had
  to edit both copies by hand.
- While wiring the GitHub App props (PR B3 of adopter request #45), by diffing the example
  workflow against its template.
- By the round-1 review of PR #323 (the CMS image architecture fix), which touched only `runs-on`
  in the example workflow and the `platform`/build-arg lines in the example stack. Not a
  regression from that PR.

## Problem

`examples/aws-deployment/README.md` says these files are what `npx canopycms init-deploy aws`
scaffolds. Five files exist in two copies: the templates under
`packages/canopycms/src/cli/template-files/`, and the checked-in example, which is the copy a
human reads on GitHub before running the generator, and may copy from instead.

| Template                     | Example copy                      | State after the #341 merge                                                                 |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `cdk.json.template`          | `cdk.json`                        | identical                                                                                  |
| `cdk-tsconfig.json.template` | `infrastructure/tsconfig.json`    | identical                                                                                  |
| `cdk-app.ts.template`        | `infrastructure/bin/app.ts`       | differs only in its three placeholder lines (`{{STACK_NAME}}`, `{{GITHUB_OWNER}}`, `{{GITHUB_REPO}}`) |
| `cms-stack.ts.template`      | `infrastructure/lib/cms-stack.ts` | comment drift, below                                                                       |
| `deploy-cms.yml.template`    | `deploy-cms.yml`                  | several changes behind, below                                                              |

### `deploy-cms.yml` vs `deploy-cms.yml.template`

- **Missing `paths:` triggers.** The template fires on `next.config.*`, `middleware.ts` and
  `public/**`; the example does not. The template's own comment says why they were added: an edit
  to one of them shipped days later, piggybacked on an unrelated content change, so any breakage
  was attributed to the wrong commit.
- **Shorter dependency check.** The template checks
  `tsx aws-cdk-lib constructs canopycms canopycms-cdk aws-cdk`; the example checks
  `tsx aws-cdk-lib constructs canopycms-cdk`. The template's comment gives the reasons for the two
  extras: `canopycms-cdk` peer-depends on `canopycms`, and without `aws-cdk` in `node_modules`,
  `npx cdk` silently fetches whatever version is current that day.
- **Stale install strings.** The header's and the error message's install lines omit `canopycms`.

### `infrastructure/lib/cms-stack.ts` vs `cms-stack.ts.template`

- The commented media block's `editorOrigins` paragraph is an older, shorter wording that lacks the
  template's note about when to include `http://localhost:3000`.

### What guards the pair today

`scaffold-synth.test.ts` runs the real CLI, so it exercises the templates only and never reads
`examples/`. Every cross-copy check is a per-feature textual pin, covering only what its author
thought of:

- `asset-support.test.ts`, "cms-stack template: the media block names a real API": every
  `assetSupport.<member>` either copy of the stack references exists on `AssetSupport`, and both
  copies mention `editorOrigins`.
- `cms-deploy.test.ts`, "secret JSON-field wiring: the scaffold template and the example stay in
  step": a hand-maintained list of required lines per file pair, plus three checks over both
  copies: no ECS `:KEY::` ARN suffix, no repository secret or variable named `GITHUB_*`, and
  `NEXT_PUBLIC_CANOPY_MODE: 'prod'` in the stack.

None of them covers the drift listed above.

### The instance that makes this P1

One live difference was **fixed in PR #322**, with a test pinning both copies:
`cms-stack.ts.template` set `NEXT_PUBLIC_CANOPY_MODE: 'prod'` in the image build args and the
example did not. An adopter who copied the example shipped an editor bundle built with the **dev**
browser mode, which selects dev auth rather than Clerk. `CanopyCmsService` sets the server half
(`CANOPY_MODE`) either way, so the deployment came up and the failure was confined to what the
editor bundle believes — the kind found by a person, late. `scaffold-synth.test.ts` already pinned
that value on the generated path, so the example was the only way left to get it wrong.

The instance is closed; the class that produced it is what stays open here.

## Shape of the fix

Decide first **whether the example should be generated rather than maintained**:

1. **Generate it.** Render the templates for the npm case into `examples/aws-deployment/` with a
   script, and have CI fail when the checked-in copies differ. The drift class then disappears
   instead of being tested for. The substitution has to be total. The templates use seven
   placeholders, `{{STACK_NAME}}`, `{{GITHUB_OWNER}}`, `{{GITHUB_REPO}}`, `{{ADD_DEV}}`,
   `{{CI_INSTALL}}`, `{{LOCKFILE}}` and `{{DEFAULT_BRANCH}}`, and the example already resolves them
   as `CanopyCms`, `your-org`, `your-docs-site`, `npm install --save-dev`, `npm ci`,
   `package-lock.json` and `main`.
2. **Keep it hand-maintained, and compare whole files.** A test renders each template with those
   values and diffs the result against the example, replacing the per-feature pins. Adding another
   per-feature pin does not converge.
3. **Delete the copies.** Keep only the README, pointing at `init-deploy aws` output. This removes
   the drift surface, at the cost of an example readable on GitHub.

Re-syncing the files by hand, without (1) or (2), repeats the history this file records.

## Related

- [worker-secret-json-field-cdk-props.md](resolved/worker-secret-json-field-cdk-props.md) — the
  task that ran into this; its PR added the JSON-field drift check.
