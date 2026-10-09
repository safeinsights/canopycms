---
priority: P2
adopters: BOTH
summary: >-
  Five diverging ACL matchers that already disagree (one is client-side, so a shared matcher must be browser-safe); comment threads that ignore path ACLs (**Decided:** filter per entry with `createContentAccessChecker`, no new matcher; P1 the moment any read-deny path rule exists, and the marketing site runs group path rules); and Clerk `authorizedParties` optional in prod
---
# Five diverging ACL matchers, comment threads that ignore path ACLs, optional Clerk `authorizedParties`

## Priority: P2 [BOTH]

The comments slice becomes **P1** the moment any read-deny path rule exists. Path rules are real
(`createContentAccessChecker` enforces them on listing, tree and write paths), and the marketing
site already runs group path rules; check whether any of them denies `read`.

The theme: authorization is enforced inconsistently, or more narrowly than the permission model
promises.

## Slice 1: comments leak past path ACLs

`api/comments.ts` (`listCommentsHandler`, line 61) returns every thread on the branch, scoped by
branch only, so branch access discloses comment text on entries the user cannot read by path.

**Decided:** filter threads per entry with the existing content access checker
(`createContentAccessChecker`), inside this consolidation work. No new matcher.

## Slice 2: the matchers (five, not four)

Five separate implementations answer "does this user match `allowedUsers` / `allowedGroups`":

1. `authorization/path.ts` (lines 26-34)
2. `authorization/branch.ts` (line 57-89)
3. `api/branch.ts` (edit-target check, line 142-148)
4. `api/branch.ts` (branch-listing filter, line 527)
5. `editor/components/EditorHeader.tsx` (line 510), **client-side**

A shared matcher has to be importable from the browser bundle, so it cannot reach a `node:`
built-in or `pnpm lint:bundle` fails. Put it somewhere dependency-free (the `paths/branch-name.ts`
precedent) or let the client keep its own copy behind a shared test fixture.

They already disagree: the branch-listing filter ignores `managerOrAdminAllowed`, so a branch can
be hidden from listing while its access check applies different semantics. The fix is one shared
target-matcher so listing and enforcement cannot drift apart.

## Slice 3: Clerk `authorizedParties` stays optional in prod

`canopycms-auth-clerk/src/clerk-plugin.ts` (lines 124-134) reads `authorizedParties` from config or
`CLERK_AUTHORIZED_PARTIES` and applies it only when set. Nothing requires it in production, so a
deployment can run without the check that binds tokens to expected origins.

## Acceptance

- One shared target-matcher, browser-safe, used by all five sites (or four plus a
  shared-fixture-tested client copy).
- A test proving listing and access agree on a `managerOrAdminAllowed` branch.
- `listThreads` results are filtered by path permission through `createContentAccessChecker`.
- Clerk config requires `authorizedParties` in prod mode.

## Related

- [acl-defaults-and-dead-path-checker.md](resolved/acl-defaults-and-dead-path-checker.md): the
  scaffolded `'allow'` default is what keeps these latent on sites without path rules
- [list-permission-level.md](list-permission-level.md): a new "list" level would add a sixth
  matcher unless this lands first
- [listentries-acl-awareness.md](resolved/listentries-acl-awareness.md): the runtime `listEntries` /
  `buildContentTree` enforce path ACLs through `createContentAccessChecker`, which routes through
  matcher #1; those two callers migrate with the rest when the shared matcher lands
