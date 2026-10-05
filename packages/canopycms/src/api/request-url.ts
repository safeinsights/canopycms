/**
 * Whether the API client ends request paths with `/`, matching a Next host built with
 * `trailingSlash: true`. Next answers an unslashed `/api/canopycms/branches` there with a 308 to
 * `/api/canopycms/branches/`, so every call would otherwise cost a second round trip (and a
 * second serverless invocation).
 *
 * `withCanopy` sets `CANOPY_API_TRAILING_SLASH` in Next's `env` config, which Next substitutes
 * for this literal member expression in both the server and browser bundles. The try/catch
 * covers a host whose bundler neither substitutes it nor shims `process` in the browser.
 */
export function readApiTrailingSlashEnv(): boolean {
  try {
    return process.env.CANOPY_API_TRAILING_SLASH === 'true'
  } catch {
    return false
  }
}
