/**
 * Bundle-boundary guard for the browser-facing entry points.
 *
 * The editor ships to browsers through `canopycms/client` and
 * `canopycms-next/client`. Anything reachable from those entries — however many
 * hops away — must stay free of node built-ins, or an adopter's production
 * `next build` fails with "Module not found: Can't resolve 'fs'". `next dev`
 * tolerates the violation, so nothing flags it while authoring; this config
 * makes the reachability itself a lint error (`pnpm lint:bundle`). The other
 * rules run over the whole of src through `pnpm lint:cycles`.
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

/** Test code may reach across module boundaries; the three boundary rules below skip it. */
const TEST_FILES = '\\.test\\.tsx?$|/__test__/|\\.stories\\.tsx?$'

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
      name: 'core-no-github-app-auth',
      severity: 'error',
      comment:
        "`@octokit/auth-app` must not enter canopycms's own graph. github-service.ts is reachable from services.ts, so anything it imports lands in EVERY adopter's Next.js server bundle — including the majority who authenticate with a personal access token and will never register a GitHub App. The client-bundle rule above does not cover the server bundle, which is why this rule exists. A deployment that does use an App constructs the strategy in its own entrypoint and injects it through the structural `{ authStrategy, auth }` passthrough in github-service.ts; the dependency is declared by packages/canopycms-cdk/package.json. NOTE this rule is evaluated by `pnpm lint:cycles`, not `pnpm lint:bundle` -- lint:bundle cruises only the two client entries, which never reach github-service.ts.",
      from: { path: OWN_SRC },
      to: { path: '@octokit[/+]auth-app' },
    },
    {
      name: 'http-reaches-api-only-via-routes',
      severity: 'error',
      comment:
        'http/ value-imports from api/ only through api/routes.ts, the server-only aggregate of every route table. Type imports are erased (tsPreCompilationDeps is off), so http/handler.ts importing api/types stays legal. Evaluated by `pnpm lint:cycles`.',
      from: { path: '^packages/canopycms/src/http/', pathNot: TEST_FILES },
      to: {
        path: '^packages/canopycms/src/api/',
        pathNot: '^packages/canopycms/src/api/routes\\.ts$',
      },
    },
    {
      name: 'api-never-imports-worker',
      severity: 'error',
      comment:
        'api/ never imports worker/. The queue contract both sides share lives in task-queue/ (cms-task-queue.ts, task-queue-config.ts, worker-status.ts); import it from there. Evaluated by `pnpm lint:cycles`.',
      from: { path: '^packages/canopycms/src/api/', pathNot: TEST_FILES },
      to: { path: '^packages/canopycms/src/worker/' },
    },
    {
      name: 'editor-imports-api-only-client-index-constants',
      severity: 'error',
      comment:
        'editor/ value-imports from api/ only api/client.ts, api/index.ts and api/entries-constants.ts, the three modules that are client-safe by construction; every other api/ module reaches node built-ins. Type imports are erased and stay legal. Evaluated by `pnpm lint:cycles`.',
      from: { path: '^packages/canopycms/src/editor/', pathNot: TEST_FILES },
      to: {
        path: '^packages/canopycms/src/api/',
        pathNot: '^packages/canopycms/src/api/(client|index|entries-constants)\\.ts$',
      },
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
