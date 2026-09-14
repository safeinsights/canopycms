# [P3] canopycms-cdk: second comment-compression pass

**Status:** Open. Filed 2026-09-14, deferred from the comment-compression chip A3 in
[resolved/baseline-quality-202609.md](resolved/baseline-quality-202609.md).

After A3, `canopycms-cdk` has a comment/code ratio of 1.279 (2,179 code, 2,786 comment lines per
`node scripts/check-comment-budget.mjs --report`). The other packages are under 1.0. By
directory: `src/constructs` 1.386, `worker` 1.365, `test-support` 1.636, `canary/bin` 1.037.

The A3 reviewer estimated about 380 more comment lines can go with no rule lost, landing near
1.1. The densest candidates (line ranges come from that review, so re-locate them at HEAD):

- `worker/credential-refresh.ts` header (45 code, 124 comment lines)
- `src/constructs/lambda-execution-role.ts` 46-76 (15 code, 67 comment lines)
- `src/constructs/asset-support.ts` 24-90 (444 code, 870 comment lines)
- `src/constructs/cms-service.ts` prop docs (749 code, 824 comment lines)

Reaching 1.0 would cost the per-IAM-statement reasons. Those are security rules and stay.

Fix shape: the rewrite brief the epic used, at Opus tier because IAM, OAC and secrets comments
are security rules. State the present-tense rule plus the one non-obvious fact, use a pointer
instead of re-deriving a mechanism owned elsewhere, and drop history. Work in two commits,
deletion-only first, then compression. Prove the diff touches comments only with
`scripts/diff-comments-only.mjs`, keep a keyword ledger for every changed
`MUST|NEVER|ONLY|IAM|secret|token|permission` line, then ratchet with
`node scripts/check-comment-budget.mjs --write-baseline --margin=2`.
