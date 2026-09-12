# `examples/aws-deployment/` has drifted from the scaffold templates it mirrors, and nothing compares the two

**Status: open.** Found 2026-09-12 while wiring the secret JSON-field props (PR A2 of the
adopter-request-#45/#46 plan), which had to edit both copies by hand.

## Problem

Four files exist in two copies: the scaffold templates under
`packages/canopycms/src/cli/template-files/` and the checked-in example under
`examples/aws-deployment/`. They teach the same wiring to two different audiences — the
generator's output, and the thing a human reads on GitHub before running the generator.

**Nothing compares them.** `scaffold-synth.test.ts` runs the real CLI, so it exercises the
templates only; it never reads `examples/`. The one existing cross-copy check is the
media-block suite in `asset-support.test.ts`, added precisely because a fix landed in the
template while the example went on teaching a dead API — and it covers only that block.

At least one real difference is live right now:

| Template | Example | Effect |
| --- | --- | --- |
| `cms-stack.ts.template:107` sets `NEXT_PUBLIC_CANOPY_MODE: 'prod'` in the image build args | absent | An adopter who copies the example ships an editor bundle built with the **dev** browser mode — dev auth rather than Clerk, and the dev feature flags |

That one matters: `scaffold-synth.test.ts` has a dedicated test ("deploys a prod-mode CMS:
CANOPY_MODE on the Lambda, NEXT_PUBLIC_CANOPY_MODE in the image build") asserting exactly
this value, so the generated path is pinned and the example is the only way to get it wrong.
The server half (`CANOPY_MODE`) is set by `CanopyCmsService` either way, so the deployment
comes up and the failure is confined to what the editor bundle believes — which is the kind
that is found by a person, late.

Comment text also differs in places (the example is a slightly older render). That is
cosmetic on its own, but it is the same drift with a lower cost, and it makes a diff of the
two files noisy enough that the substantive difference above hid in it.

## Shape of the fix

Decide first **whether the example should be generated rather than maintained**. If
`examples/aws-deployment/` were produced by running `canopycms init-deploy aws` into a
fixture directory (with the placeholders resolved) and checked in, the drift class
disappears rather than being tested for. That is the strictly better outcome if the
placeholder substitution is total; check `{{STACK_NAME}}`, `{{GITHUB_OWNER}}`,
`{{GITHUB_REPO}}`, `{{ADD_DEV}}`, `{{LOCKFILE}}` and `{{DEFAULT_BRANCH}}` before assuming it.

If the example must stay hand-maintained, add a **whole-file** comparison (template with
placeholders substituted vs the example) as a test, rather than another per-feature textual
check. Two such checks now exist — the media block, and the JSON-field wiring added in the
PR that found this — and each only covers the feature whose author happened to think of it.
That pattern does not converge.

Either way, fix the `NEXT_PUBLIC_CANOPY_MODE` difference itself, which is a live defect for
anyone who copied the example.

## Related

- [worker-secret-json-field-cdk-props.md](resolved/worker-secret-json-field-cdk-props.md) —
  the task that ran into this; its PR added the third per-feature drift check.
