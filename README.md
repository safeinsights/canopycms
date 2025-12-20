# CanopyCMS Monorepo

Monorepo for building CanopyCMS, a clean TypeScript/Next.js-first CMS with schema-enforced content, branch-aware editing, and Clerk-based authentication. The public site ships without the editor bundle; a separate editor app handles live preview and content authoring.

## Structure

- `packages/canopycms/` — core library (schemas, branch-aware content store, auth helpers, editor UI components).
- `packages/canopycms/adapters/` — storage/cache adapters (starting with S3 assets; cache optional).
- `packages/canopycms/examples/one/` — Next.js demo showing schema-driven forms and live preview of real pages (home and posts) with file-backed data.
- Client-only editor bits are exported from `canopycms/client` to avoid bundling server-side deps.
- `reference/` — read-only upstream material for inspiration.

## Comments System

CanopyCMS includes a field-based comment system for collaborative content editing and review workflows.

### Comment Scopes

Comments can be attached at three levels:

- **Field Comments**: Attached to specific form fields (e.g., `title`, `blocks[0].description`)
- **Entry Comments**: General feedback on an entire entry/page
- **Branch Comments**: Discussion about a branch (visible in BranchManager)

### Inline UI

Comments appear inline beneath form fields using a horizontal carousel UI:

- **Always Visible**: Every field shows a comment section, even with 0 threads
- **Thread Navigation**: Multiple threads navigate with `← 2/5 →` counter and arrow buttons
- **Collapsed by Default**: First line visible, click to expand full thread
- **Peekaboo Preview**: Shows sliver of next thread to indicate more exist
- **Quick Access**: "+ New" button always visible for adding comments

### Error Handling

Both ThreadCarousel and InlineCommentThread components include comprehensive error handling:

- Network failures when adding replies or creating threads
- Resolution failures with user-friendly error messages
- Dismissible error alerts with retry capability

### Preview Integration

Click any element in the live preview to:

1. Scroll to the corresponding form field
2. Auto-expand the inline comment carousel
3. See existing feedback or add new comments

### Storage

Comments are stored locally in `.canopycms/comments.json` and are not committed to git.

### Permissions

Thread resolution is allowed for:

- The thread author (person who created the first comment)
- Users with reviewer role
- Users with admin role

## Development

- Install dependencies with `npm install`.
- Run scripts across workspaces: `npm run build --workspaces`, `npm run test --workspaces`, `npm run lint --workspaces`.
