# CanopyCMS Example One

Standalone Next.js demo app that uses the CanopyCMS editor UI with real content files (JSON under `content/`) to show schema-driven forms and preview working together. It renders with Tailwind to show that host apps do not need Mantine. This is intended for local exploration only.

## Run

```bash
cd apps/example1
pnpm install
pnpm dev   # Next.js dev server
```

Then open the printed local URL (the editor lives at `/edit`). Use the entry selector and reset buttons inside the UI to reload content. To reset the local dev workspaces and simulated remote, run `pnpm reset-sim` (removes `.canopy-dev/`).

## Notes

- Content loads via `createContentReader` from the active branch workspace (in dev mode this follows your checked-out git branch); the editor APIs live under the single catch-all route at `/api/canopycms/[...canopycms]`.
- Live preview still uses the preview bridge for draft updates; saved changes are read directly from disk.
- This example is not published; it exists to exercise the full editing flow locally.
