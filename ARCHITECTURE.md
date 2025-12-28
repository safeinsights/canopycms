# CanopyCMS Architecture

This document explains how CanopyCMS works at a systems level. For usage instructions, see [README.md](README.md). For contributor workflows, see [DEVELOPING.md](DEVELOPING.md).

## What is CanopyCMS?

CanopyCMS is a schema-driven, branch-aware content management system for git-backed, statically-generated websites. It provides an editing interface on top of a git-backed content store, enabling non-technical users to edit website content without touching Git directly.

Key characteristics:
- **Editing interface**: Schema-driven forms, block-based page building, live preview
- **Git as source of truth**: All content lives as files in git, enabling version history, rollback, and familiar workflows
- **Branch-based editing**: Each editing session works on its own branch, enabling review workflows
- **Schema-driven**: Content structure is defined by a schema, ensuring type safety and validation
- **File system based**: No external databases or caching servers—designed for deployment with an attached file system
- **Framework-agnostic core**: The core library works with any framework; adapters provide integration

## Package Architecture

CanopyCMS is organized as a monorepo with separate packages for extensibility:

- **canopycms** (core): The main library containing content store, branch management, permissions, editor UI, and API handlers. This package is framework-agnostic.

- **canopycms-next**: Next.js adapter that converts Next.js route handlers to work with the core API.

- **canopycms-auth-clerk**: Authentication plugin using Clerk.

This separation keeps the core framework-agnostic while allowing adopters to use only the adapters they need. Authentication and framework integration are deliberately abstracted so new providers can be added without modifying core code.

## Storage Architecture

CanopyCMS is entirely file system based. There are no external databases, no Redis/Valkey caching servers, and no separate worker processes by default. This simplifies deployment and operations.

**What gets stored:**
- **Content**: MD/MDX/JSON files in the content directory (committed to git)
- **Branch metadata**: `.canopycms/branch.json` per workspace (state, PR references)
- **Branch registry**: `.canopycms/branches.json` (inventory of all branches)
- **Comments**: `.canopycms/comments.json` per branch (NOT committed to git)
- **Groups**: `.canopycms/groups.json` (internal group definitions, committed)
- **Permissions**: `.canopycms/permissions.json` (path-based permissions, committed)

**Deployment model**: CanopyCMS is designed to be deployed to a server or serverless function with an attached file system shared by all server processes. On AWS, this could mean Lambda + EFS.

## Core Mental Model

Content in CanopyCMS flows through a predictable lifecycle:

```
Git Repository (source of truth)
        ↓
   Create/Open Branch (isolated workspace)
        ↓
   Edit Content (changes stay in branch)
        ↓
   Submit for Review (requests publication)
        ↓
   Review & Approve (on GitHub)
        ↓
   Merge PR (outside CanopyCMS)
        ↓
   Deploy Updated Site (outside CanopyCMS)
```

The key insight is that editors never interact with git or GitHub directly. CanopyCMS abstracts away the git operations, PR creation, and branch management. When an editor hits "Publish Branch", they are *requesting to publish*—the actual merge and deployment happen separately (typically through GitHub and CI/CD).

## Branch-Based Editing

When a user opens a branch, CanopyCMS either opens an existing workspace or creates a new one:

1. **Workspace resolution**: If a clone already exists for the branch, it's used. Otherwise, a new git clone is created (in production modes).
2. **Isolation**: Each branch has its own working directory with independent files
3. **Parallel editing**: Multiple users can work on different branches simultaneously without interference

Branches have a lifecycle with three states:
- **editing**: Active work in progress
- **submitted**: Sent for review, awaiting merge
- **archived**: Merged and preserved for audit

Users can work on main branch too—there's nothing preventing it. The branch model provides isolation for team collaboration but doesn't mandate it.

## Operating Modes

CanopyCMS supports three operating modes to fit different environments:

### local-simple
Direct file editing in the current checkout. No git cloning occurs. Best for solo development where the developer manages their own branch via git commands.

### local-prod-sim
Simulates production behavior locally. Creates per-branch clones in `.canopycms/branches/` and maintains a local git remote at `.canopycms/remote.git`. Use this for testing the full branch workflow without deploying.

### prod
Full production deployment. Branch workspaces live on persistent storage (e.g., EFS on AWS). Integrates with GitHub for PR creation and management. Designed for team collaboration with proper review workflows.

## The Permission Model

Access control uses three layers that all must pass:

### Layer 1: Branch Access
Per-branch ACLs control who can access a branch. Branches can be restricted to specific users or groups. Admins and reviewers always have access.

### Layer 2: Path Permissions
Glob patterns (e.g., `content/posts/**`) restrict who can edit specific content paths. First matching rule wins. Only admins bypass path rules.

### Layer 3: Content Access
Combines branch and path checks into a single decision. Returns detailed denial reasons for debugging.

**Reserved groups** provide consistent roles:
- **admins**: Full access to all operations
- **reviewers**: Can review branches, request changes, approve PRs

**Where permissions are stored:**
- Groups and path permissions are stored in `.canopycms/groups.json` and `.canopycms/permissions.json`
- These files ARE committed to git, providing version history and PR-reviewable changes
- Branch ACLs are stored in each branch's metadata file

## Content Workflow

### Creating and Editing
1. User opens or creates a branch
2. System opens existing workspace or creates new clone (in prod modes)
3. User makes edits through the editor UI
4. Each save writes directly to files in the branch workspace
5. Live preview shows changes immediately

### Submitting for Review
1. User clicks "Submit"
2. System commits all changes and pushes to remote
3. GitHub PR is created (if GitHub integration configured)
4. Branch status changes to "submitted"

**Important**: Clicking "Submit" requests publication—it does not actually publish. The content becomes live only after the PR is merged on GitHub and the site is rebuilt/deployed. This separation means CanopyCMS doesn't control the actual publication moment; that's handled by your CI/CD pipeline.

### Review Process
1. Reviewers see submitted branches and can add comments
2. Comments attach to specific fields, entries, or the whole branch
3. Reviewers can approve or request changes
4. Requesting changes returns branch to "editing" status

### Merging and Archiving
1. PR is merged on GitHub (outside CanopyCMS, by someone with merge permissions)
2. User clicks "Mark as Merged" in CanopyCMS
3. System verifies merge via GitHub API
4. Branch moves to "archived" status
5. Site rebuild/deploy happens via other processes (e.g. CI/CD)

## Comments & Collaboration

The comment system supports asynchronous review workflows.

**Three attachment levels:**
- **Field comments**: Attached to specific form fields (e.g., title, description)
- **Entry comments**: General feedback on an entire content entry
- **Branch comments**: Discussion about the overall branch/changeset

**Key characteristics:**
- Comments are stored per-branch in `.canopycms/comments.json`
- Comments are NOT committed to git—they're review artifacts, not content
- Thread resolution is controlled by the thread author, reviewers, or admins

## Editor Architecture

The editor provides a rich editing experience with schema-driven forms, block-based page building, and live preview.

**Bundle separation**: Public sites can be built without any editor code. The editor is exported from `canopycms/client` and can be imported only where needed. This means your production site visitors never download editor JavaScript.

**Integration options:**
- Embed editor in the same Next.js app (simpler setup)
- Run editor as a separate application (stricter separation)
- Public sites can optionally import and embed the editor, but they don't have to

**Server imports**: Adopting apps also import from `canopycms/server` for content reading and API setup.

**Live preview**: The editor can show a live preview of content changes. The preview is an iframe that loads your actual site pages, and the editor communicates with it via postMessage. When you edit a field, the preview updates immediately. Clicking on elements in the preview focuses the corresponding form field. This preview bridge enables real-time feedback without page reloads.

## Extensibility Points

### Authentication
Authentication is abstracted out and provided by separate packages. The core CanopyCMS package has no built-in auth provider—you must install an auth package.

Auth plugins implement the `AuthPlugin` interface, which provides:
- User identity extraction from requests
- Group membership lookup
- Session validation

This abstraction means you can use Clerk, Auth0, NextAuth, Supabase Auth, or a custom solution. See `canopycms-auth-clerk` as a reference implementation. Creating a new auth plugin involves implementing the interface and publishing it as a package.

### Framework Adapters
The core API handler is framework-agnostic. Framework adapters convert framework-specific request/response objects to the core `CanopyRequest`/`CanopyResponse` types.

See `canopycms-next` as a reference implementation. Creating an adapter for Express, Fastify, Hono, or other frameworks follows the same pattern.

## Key Design Decisions

### Why file system based (no external databases)?
Simplifies deployment and operations. Git already provides versioning, and the file system provides persistence. No need to sync state between a database and git. Works well with serverless + attached storage (Lambda + EFS).

### Why branch-per-workspace?
Each branch gets its own git clone to prevent conflicts. Editors can work simultaneously without stepping on each other. The workspace isolation also means a crash or bad edit on one branch can't affect others.

### Why aren't comments committed to git?
Comments are review artifacts, not content. They're ephemeral discussion about changes, not part of the final published content. Keeping them out of git prevents clutter and keeps the content repository clean.

### Why are groups and permissions committed to git?
Unlike comments, groups and permissions are configuration that should be version-controlled. Changes to who can edit what should be reviewable via PR, and you should be able to roll back permission changes if needed.

### Why three permission layers?
Defense in depth. Branch access controls who can see a branch. Path permissions control what content they can edit. Combining them provides flexible policies: you might let someone access a branch but restrict them to certain content paths within it.

### Why separate packages for auth and framework adapters?
Keeps the core framework-agnostic. Adopters only install what they need. Testing is simpler because the core doesn't depend on Next.js or Clerk. New frameworks and auth providers can be supported without modifying core code.

### Why do git operations in the request cycle (no worker)?
Simplicity. Git operations (clone, commit, push) happen synchronously during API requests rather than being queued to a separate worker process. This avoids the complexity of job queues, worker coordination, and eventual consistency. For most content editing use cases, git operations complete fast enough. If this becomes a bottleneck, a worker architecture could be added later.

### Why "Publish Branch" doesn't actually publish?
Separation of concerns. CanopyCMS handles content editing and PR creation. The actual publication (merging the PR and deploying the site) is handled by GitHub and your CI/CD pipeline. This makes the system more flexible—you can have any merge/deploy workflow you want, and CanopyCMS doesn't need credentials to actually push to production.
