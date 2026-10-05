/**
 * Whether the API client ends request paths with `/`: on a `trailingSlash: true` Next host every
 * unslashed call draws a 308 first. `withCanopy` sets `CANOPY_API_TRAILING_SLASH` in Next's `env`
 * config, which Next substitutes for this literal member expression in server and browser bundles
 * (`getNextConfigEnv`, `next/dist/build/define-env.js:54`). The try/catch covers a host whose
 * bundler neither substitutes it nor shims `process` in the browser.
 */
export function readApiTrailingSlashEnv(): boolean {
  try {
    return process.env.CANOPY_API_TRAILING_SLASH === 'true'
  } catch {
    return false
  }
}
