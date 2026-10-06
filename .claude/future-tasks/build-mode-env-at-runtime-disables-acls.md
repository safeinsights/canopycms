# A runtime `CANOPY_BUILD_MODE=true` turns off every request's ACLs

## Priority: P3 [BOTH]

Filed 2026-10-05, from the review of the PR that 404s anonymous requests to `createPreviewPage`.
Pre-existing and needs a misconfiguration to trigger it. Not measured on a deployment.

## The gap

`isBuildMode()` (`packages/canopycms/src/build-mode.ts`) is true whenever
`CANOPY_BUILD_MODE === 'true'`, with no check that a build is actually running. `getUser()` in
`packages/canopycms/src/context.ts` then resolves every request to `STATIC_DEPLOY_USER` (an
authenticated Admins user) and skips ACL enforcement. So if an operator sets the variable in the
server's runtime environment, not just the builder stage, every request-time read, including the
preview route, shows any branch to anyone. The generated `Dockerfile.cms` sets it only in the
builder stage, so the default template is safe.

## Options

- Have the server refuse to start, or log loudly, when `CANOPY_BUILD_MODE=true` is set in a
  process that is serving requests (for example, from the catch-all handler's first request).
- As defense in depth, have `createPreviewPage` also 404 for `STATIC_DEPLOY_USER`. It is only
  ever legitimate at build time, and the preview route is request-time only.
