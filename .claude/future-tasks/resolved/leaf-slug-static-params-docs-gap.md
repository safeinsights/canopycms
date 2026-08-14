# Leaf-slug static params (adopter request #12)

## RESOLVED (2026-08-14) — already fully shipped; request itself was stale

From adopter request #12 in `../website/docs/canopycms-requests.md`, triaged
during the go-live backlog re-baseline. Verdict: **zero work needed.**

`collectStaticParams(..., {shape: 'single'})` already does exactly what the
request asks for — `canopycms-next/src/static.ts:23,64-66`. It's documented
(`README.md:1420-1428`) and has reference usage in-repo
(`apps/example1/app/posts/[slug]/page.tsx:14-15`). It's also already available
to the requester: `website` pins `canopycms@^0.0.41`, and this shipped well
before that version.

This wasn't a package gap — it was a discoverability gap on the request side.
The request-writer didn't know the capability existed. Filed here as a record
so nobody re-implements it or re-opens the same request without checking
first; no follow-up work identified beyond what already exists.
