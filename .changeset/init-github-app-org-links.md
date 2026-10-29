---
'canopycms': patch
---

### Fix the App links `init-github-app create` prints for an organisation

<!-- migration
area: Ops
action: None
row: init-github-app create links work for organisation-owned Apps
-->

**What changed.** For an organisation-owned repository, `canopycms init-github-app create` printed App settings and install links under `github.com/settings/apps/…`, which 404 for an organisation's App. It now prints the `github.com/organizations/<owner>/settings/apps/…` form; user-owned repositories are unchanged. The command's output is also laid out for scanning, with bold headings, a permissions list, green ticks for progress and red crosses for failures, and is plain text on a stream that is piped (unless `FORCE_COLOR` turns colour on) or when `NO_COLOR` is set.
