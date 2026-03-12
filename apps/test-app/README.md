# CanopyCMS Test App

A Next.js application using the real CanopyCMS editor, dedicated to Playwright E2E testing.

## Purpose

This app provides a stable, controlled environment for E2E tests using the actual CanopyCMS editor. Unlike `example-one`, which may change frequently for development purposes, this app:

- **Stability**: Changes to example apps won't break E2E tests
- **Real Editor**: Uses the actual `CanopyEditorPage` component from canopycms/client
- **Determinism**: Controlled test data and predictable state
- **Isolation**: Runs on port 5174 to avoid conflicts with dev workflows

## Features

This is a minimal Next.js 14 app with:

- CanopyCMS editor at `/edit`
- Clerk authentication (test mode)
- Simple schema (posts collection + home entry with maxItems: 1)
- All CanopyCMS features available for testing

## Running the App

```bash
# Development server on port 5174
npm run dev -w test-app

# Build for production
npm run build -w test-app

# Type check
npm run typecheck -w test-app
```

## Running E2E Tests

Playwright automatically starts this app before running tests:

```bash
# Run E2E tests (auto-starts test-app)
npm run test:e2e

# Run with UI mode
npm run test:e2e:ui

# Debug mode
npm run test:e2e:debug
```

## Schema

The test app has a simple schema for testing:

- **Posts Collection**: Title, author, date, tags, body (MDX)
- **Home Entry** (maxItems: 1): Title, tagline, featured posts array

## Authentication

Uses Clerk in test mode. The `.env.local` file contains placeholder keys. For real testing, you'll need to:

1. Create a Clerk account
2. Add your Clerk keys to `.env.local`
3. Configure test users in Clerk dashboard

## Architecture

- Next.js 14 (App Router)
- CanopyCMS editor via `CanopyEditorPage(config)`
- Clerk authentication
- API routes at `/api/canopycms`
- Tailwind CSS for styling
