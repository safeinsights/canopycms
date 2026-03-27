# Contributing to CanopyCMS

## Prerequisites

- Node.js 22+ (see `.nvmrc`)
- pnpm (not npm, yarn, or bun)

## Getting Started

```bash
git clone https://github.com/safeinsights/canopycms.git
cd canopycms
pnpm install
pnpm typecheck
pnpm test
```

See [DEVELOPING.md](DEVELOPING.md) for detailed development patterns, testing practices, and architecture.
See [AGENTS.md](AGENTS.md) for project goals, code organization, and working agreements.

## Making Changes

1. Create a branch from `main`.
2. Make your changes. Follow existing code style and conventions.
3. Run `pnpm typecheck` and `pnpm test` to verify.
4. Run `pnpm test:e2e` locally before submitting. E2E tests are currently disabled in CI, so local verification is important.
5. Open a PR. CI must pass (typecheck + unit tests).

## Claude Code

This project uses [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with specialized agents in `.claude/agents/` for testing, type checking, code review, debugging, and documentation. These are optional but can speed up development.

## Project Structure

This is a pnpm workspaces monorepo:

- `packages/canopycms` — core CMS package
- `packages/canopycms-next` — Next.js adapter
- `packages/canopycms-auth-clerk` — Clerk auth provider
- `packages/canopycms-auth-dev` — dev auth provider (no external service needed)
- `packages/canopycms-cdk` — AWS CDK deployment constructs
- `apps/example1` — example app demonstrating CanopyCMS in use
- `apps/test-app` — E2E test harness
