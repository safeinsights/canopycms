# CanopyCMS Example One

Standalone Next.js demo app that uses the CanopyCMS editor UI with real content files (JSON under `content/`) to show schema-driven forms and preview working together. It renders with Tailwind to show that host apps do not need Mantine. This is intended for local exploration only.

## Run

```bash
cd packages/canopycms/examples/one
npm install
npm run dev   # Next.js dev server
```

Then open the printed local URL. Use the entry selector and reset buttons inside the UI to reload content.

## Notes

- Content loads via `createContentReader` from the active branch workspace (default `main`); the editor APIs live under the single catch-all route at `/api/canopycms/[...canopycms]`.
- Live preview still uses the preview bridge for draft updates; saved changes are read directly from disk.
- This example is not published; it exists to exercise the full editing flow locally.
