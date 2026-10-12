---
priority: P3
adopters: BOTH
summary: >-
  `useSystemHealth` (`editor/admin/useSystemHealth.tsx`) refreshes status, tasks and branch health every 30 s with no guard against overlap. The branch-health scan runs under the API client's 180 s `long` deadline, so on a slow workspace each tick can start another scan while earlier ones are still running, and the shared `error` string flickers between the three fetches. Skip a tick while the previous refresh is in flight, and give each fetch its own error.
---

# System Health polls can overlap a slow branch-health scan

## What is known

- The poll is a `setInterval(refresh, 30_000)` while the panel is open; `refresh` is
  `Promise.all` over `admin.status`, `admin.listTasks` and `admin.branchHealth`.
- `admin.branchHealth` is declared `clientTimeout: 'long'` (180 s) in
  `api/admin-branch-health.ts`, longer than the poll interval.
- Each fetch writes the one `error` state, so whichever finished last wins.

## Done when

At most one refresh runs at a time, and each section shows its own failure.
