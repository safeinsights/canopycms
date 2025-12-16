# CanopyCMS Monorepo

Monorepo for building CanopyCMS, a clean TypeScript/Next.js-first CMS with schema-enforced content, branch-aware editing, and Clerk-based authentication. The public site ships without the editor bundle; a separate editor app handles live preview and content authoring.

## Structure
- `packages/canopycms/` — core library (schemas, branch-aware content store, auth helpers, editor UI components).
- `packages/canopycms/adapters/` — storage/cache adapters (starting with S3 assets; cache optional).
- `packages/canopycms/examples/one/` — Next.js demo showing schema-driven forms and live preview of real pages (home and posts) with file-backed data.
- Client-only editor bits are exported from `canopycms/client` to avoid bundling server-side deps.
- `reference/` — read-only upstream material for inspiration.

## Development
- Install dependencies with `npm install`.
- Run scripts across workspaces: `npm run build --workspaces`, `npm run test --workspaces`, `npm run lint --workspaces`.
