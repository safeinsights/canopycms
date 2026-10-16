---
adopters: BOTH
summary: >-
  RESOLVED 2026-10-08, branch `fix/unauthenticated-status`, base `int-202610-b` — adopter request #60. `unauthenticatedStatus: 401 | 419` (default 401) sets the HTTP status of the handler's two unauthenticated responses; the body keeps `status: 401`, and the client now fires `onUnauthorized` on HTTP 401 OR a handler body (`isApiResponseBody`) saying 401, so sign-out detection survives 419 while a proxy's 403 still does not trigger it. 419, not 403: a CloudFront custom error response can match 403 (S3-behind-OAC sites commonly map it to an error page) and would replace the body, but cannot match 401 or 419. Declined: holding API calls until the auth provider settles — the gate trusts only the server by design, and the status switch covers mid-session expiry too, which gating would not
---
# Unauthenticated API requests can only be answered with a bare 401

## Priority: P3 [BOTH]

**RESOLVED 2026-10-08** on `fix/unauthenticated-status` (adopter request #60), as suggested below:
`unauthenticatedStatus: 401 | 419`, with the client also firing `onUnauthorized` on a handler
body saying `status: 401`. Exempting the editor routes does not prevent the eviction; the switch
does.

## The gap

`http/handler.ts` answers an API request it cannot authenticate with `401` and no
`WWW-Authenticate` header (both the failed-auth and the anonymous-user branches). On a tier that
also sits behind HTTP Basic auth, a browser that gets that 401 drops its cached Basic credential,
and the next request that needs it waits on a fresh Basic prompt. Measured on an adopter tier: a
401 at +4.3 s, then the next gated request stalled 74.5 s on the dialog.

The supported answer is to keep the editor's routes out of the Basic gate
(docs/deploying-to-aws.md, "No HTTP Basic auth on editor routes"). This task is the optional
switch for adopters who cannot.

## Constraint

The editor detects sign-out from the status code alone: `api/client.ts` calls `onUnauthorized`
only when `response.status === 401`, and that is what shows the sign-in overlay. A config switch
that answers 403 instead would leave a signed-out editor failing every request with no sign-in
prompt. Any switch must change the client too, for example by recognising the body's
`status: 401` (the handler already sends `{ ok: false, status: 401, ... }`) whatever the HTTP
status, and it must not use `WWW-Authenticate: Basic`, which opens the dialog it is avoiding.

## Suggested shape

A `CanopyConfig` option for the HTTP status of unauthenticated API responses, default 401,
alongside a client check on the body's `status` field. Test both the handler's two 401 sites and
the client's `onUnauthorized` under the alternate status.
