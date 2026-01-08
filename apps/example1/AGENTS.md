# AGENTS – Example One

Purpose: Minimal Next.js demo that proves a host app can use Tailwind while integrating CanopyCMS. Public pages read JSON content via branch-aware helpers; the CanopyCMS editor runs separately via the catch-all API.

Working agreements:

- Use Tailwind for all example UI; avoid Mantine components in this app (CanopyCMS UI uses Mantine internally).
- Keep integration touchpoints between the example app and CanopyCMS to a minimum, e.g. `canopycms.config.ts`, the catch-all API route at `/api/canopycms/[...canopycms]`, and `createContentReader` for server-side content loads. The idea is that adopters of CanopyCMS only need to minimimally change a few files in their code to achieve the integration. If a new connection to Canopy is needed, get approval first.
- Content lives under `content/`; respect branch query parameters when previewing to stay in sync with the editor.
