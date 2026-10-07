# The public repo carries a sandbox AWS account id and an adopter's stack names

**Status:** Open. **Priority: P3.** Filed 2026-10-07, noticed while Phase 3 of
[image-materialization-epic.md](image-materialization-epic.md) edited the canary.

## State

This repository is public. A twelve-digit AWS account id is hardcoded as `CANARY_ACCOUNT` in
`packages/canopycms-cdk/canary/bin/canary.ts`, and appears again in two files under `resolved/`
(the CMS-service deployment test and the program-D stack rebuild records). The second of those
also names an adopter's own stacks. Both have been public since they landed, so removing them now
does not un-publish them; it stops new copies and keeps the tree to the rule that adopter names and
account ids stay out of it.

## Proposal

- Read the canary's account from the environment (`CDK_DEFAULT_ACCOUNT` or a `CANARY_ACCOUNT`
  variable) and refuse to synth without it, as `examples/aws-deployment/infrastructure/bin/app.ts`'s
  `required()` does for its own settings.
- Replace the id and the adopter stack names in the two resolved records with generic wording.
- Decide whether history needs rewriting. Probably not: an account id is an identifier, not a
  credential, but that call is JP's.
