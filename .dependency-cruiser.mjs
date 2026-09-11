/**
 * Bundle-boundary guard for the browser-facing entry points.
 *
 * The editor ships to browsers through `canopycms/client` and
 * `canopycms-next/client`. Anything reachable from those entries — however many
 * hops away — must stay free of node built-ins, or an adopter's production
 * `next build` fails with "Module not found: Can't resolve 'fs'". `next dev`
 * tolerates the violation, so nothing flags it while authoring; this config
 * makes the reachability itself a lint error (`pnpm lint:bundle`).
 *
 * `tsPreCompilationDeps` is left off on purpose: we want the graph the bundler
 * sees, so `import type` edges (erased at compile time) are not followed.
 *
 * Scope: our own modules. `node_modules` is not followed, so a server-only npm
 * package pulled into the client graph is not detected here — the e2e
 * production `next build` stays the backstop for that.
 */

/** The browser-facing entry points. Cruise these, and only rule on these. */
const CLIENT_ENTRIES = '^packages/canopycms(-next)?/src/client\\.tsx?$'

/** Our own first-party sources (i.e. not resolved npm packages). */
const OWN_SRC = '^packages/[^/]+/src/'

/**
 * Node built-ins, `node:`-prefixed (our convention) or bare. Bare names are
 * fully anchored and spelled out — including the `/`-suffixed forms — so npm
 * packages that merely share a name are not flagged; their own modules appear
 * in the graph under `node_modules/...`. Spelled out rather than matched with
 * an optional-suffix group because dependency-cruiser rejects rule regexes its
 * safe-regex check considers ReDoS-prone.
 */
const NODE_BUILTIN =
  '^node:|^(assert|assert/strict|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|dns/promises|domain|events|fs|fs/promises|http|http2|https|inspector|module|net|os|path|path/posix|path/win32|perf_hooks|process|punycode|querystring|readline|readline/promises|repl|stream|stream/consumers|stream/promises|stream/web|string_decoder|sys|timers|timers/promises|tls|trace_events|tty|url|util|util/types|v8|vm|wasi|worker_threads|zlib)$'

export default {
  forbidden: [
    {
      name: 'client-bundle-no-node-builtins',
      severity: 'error',
      comment:
        'A module reachable from a client entry imports a node built-in. Browser bundles cannot resolve node:*. Import the dependency-free sibling instead (paths/branch-name, not paths/branch or the paths barrel; assets/asset-prefixes, not assets/keys; assets/transform-directives, not assets/transform), or make the import type-only.',
      from: { path: CLIENT_ENTRIES },
      to: { path: NODE_BUILTIN, reachable: true },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A runtime import cycle. Under ESM, module-init order becomes load-order dependent and the symptom (an undefined binding at first use) points nowhere near the cause. Break the edge: hoist the shared piece into a third module, or pass the collaborator in. Note `tsPreCompilationDeps` is off, so `import type` edges are erased and can never trip this — only value imports do.',
      from: { path: OWN_SRC },
      to: { circular: true },
    },
    {
      name: 'no-unresolvable-local-imports',
      severity: 'error',
      comment:
        "A relative import did not resolve. Everything behind it is invisible to the client-bundle rule above, so this would quietly blind the guard rather than just being a broken import — fix the specifier (or this config's resolver options).",
      from: { path: OWN_SRC },
      to: { couldNotResolve: true, path: '^[.]' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'browser', 'default'],
      mainFields: ['browser', 'module', 'main'],
    },
  },
}
