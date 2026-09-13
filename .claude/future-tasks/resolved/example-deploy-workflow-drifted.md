# `examples/aws-deployment/deploy-cms.yml` has drifted from its template

**Duplicate of [example-aws-deployment-drift-from-template.md](../example-aws-deployment-drift-from-template.md), merged during the base merge (#341).**

**Priority:** P2
**Found:** 2026-09-12, while wiring the GitHub App props (PR B3 of adopter request #45)

## What

`examples/aws-deployment/deploy-cms.yml` is supposed to be the placeholder-substituted
twin of `packages/canopycms/src/cli/template-files/deploy-cms.yml.template`. Diffing the
two (ignoring `{{PLACEHOLDER}}` substitutions) shows the example is several changes behind:

- **Missing `paths:` triggers** — the template fires on `next.config.*`, `middleware.ts`
  and `public/**`; the example does not. The template's own comment explains why those were
  added: an edit to one of them shipped days later piggybacked on an unrelated content
  change, so the breakage was attributed to the wrong commit.
- **Shorter dependency check** — the template checks
  `tsx aws-cdk-lib constructs canopycms canopycms-cdk aws-cdk`; the example checks
  `tsx aws-cdk-lib constructs canopycms-cdk`. The template's comment says `canopycms` and
  `aws-cdk` are checked deliberately (peer dependency; and `npx cdk` silently fetching a
  floating version when absent).
- **Stale install strings** in the header and the error message.

## Why it matters

The example is the copy an adopter reads and copies from, and
`cms-deploy.test.ts`'s "the scaffold template and the example stay in step" describe exists
precisely because it rots unnoticed — but that guard is a list of specific lines, so it
catches only the drift someone remembered to add a line for. Everything above slipped past it.

## Options

1. **Generate the example from the template** at test time (or check it in via a script),
   substituting the placeholders, and assert equality. That is what the pin test is
   approximating by hand, and it would have caught every item above. Placeholder values for
   the example are already known (`CanopyCms`, `main`, `npm ci`, `package-lock.json`,
   `npm install --save-dev`). `examples/aws-deployment/infrastructure/bin/app.ts` is already
   byte-identical to its template modulo three placeholder lines, so this is viable for at
   least two of the three pairs.
2. Just re-sync the file by hand now, leaving the same gap open for next time.

(1) is the one worth doing; (2) alone repeats the history this file records.

## Note

`infrastructure/lib/cms-stack.ts` also carries one unrelated comment-only drift (the
`uploadBehavior` CORS paragraph is a shorter, older wording than the template's).
