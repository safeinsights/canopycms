---
priority: P2
summary: >-
  New 2026-10-11. `listTasks` and `dequeueTask` sort with `createdAt.localeCompare(...)`, but
  `parseTaskJson` accepts a task file with only `id` and `action`, so one such file among two or
  more pending tasks makes the worker's claim and every listing throw. Validate `createdAt` (and
  `payload`) in `parseTaskJson`
---

# One malformed task file makes `listTasks` and `dequeueTask` throw

## Priority: P2

Found 2026-10-11 in review of adopter request 110's stale-mirror check, which lists the pending
and processing queues once per sync cycle (`worker/stale-mirror.ts`, `readEditorWork`).

## Problem

`task-queue/task-queue.ts`'s `parseTaskJson` keeps any JSON object whose `id` and `action` are
strings. `listTasks` and `dequeueTask` then sort the parsed tasks with
`a.createdAt.localeCompare(b.createdAt)`.
A file without a string `createdAt` (hand-written, truncated by a crash, or written by an older
or foreign tool) throws a TypeError from the comparator whenever the directory holds two or more
tasks. Every caller of that listing fails:

- the worker's stale-mirror check keeps every head as `unchecked` and warns once per head;
- `enqueueGitHubPush` (history-rewrite.ts) cannot dedupe, so it fails to queue the push;
- the admin task listing errors;
- `dequeueTask` throws, so the worker claims no task at all while the file sits in `pending/`.

## Fix

Make `parseTaskJson` reject a task whose `createdAt` is not a string and whose `payload` is not an
object, so the file is treated like any other unparseable task (moved to `corrupt/` where the
callers already do that). Then drop the payload guard in `readEditorWork` if it becomes redundant.
Add `listTasks` and `dequeueTask` tests with a file missing `createdAt` beside a valid one.
