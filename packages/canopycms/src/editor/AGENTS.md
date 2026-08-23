# `editor/` — React editor UI

The largest subsystem in the package: **176 files** (109 excluding tests and stories),
~20,900 LOC, roughly 29% of `packages/canopycms/src`.

Created 2026-08-23. Until then this directory's entire entry in the root `AGENTS.md` was
five words — "React editor components and hooks" — while `static/` (841 LOC) had 976.
Documentation depth had become inversely proportional to subsystem size, because the root
file recorded where bugs had hurt rather than where code lives.

As everywhere else in this package, **the code comment at the point of a rule is
authoritative**. This file is the map.

## Layout

| Path                                      | What lives there                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Editor.tsx`                              | The composition root (1,512 lines). See below.                                                                                                     |
| `hooks/`                                  | 17 hooks — the real logic. Start here, not in the components. Has its own [README.md](hooks/README.md) covering the SWR data-loading architecture. |
| `fields/`                                 | 17 field components, one per schema field type, plus `entry-link/`.                                                                                |
| `components/`                             | Presentational pieces used by `Editor.tsx` (header, sidebar, modals).                                                                              |
| `context/`                                | `ApiClientContext`, `AssetContext`, `EditorStateContext`, `SWRProvider`.                                                                           |
| `schema-editor/`                          | The admin schema-editing UI (collections, entry types, ordering).                                                                                  |
| `permission-manager/`, `group-manager/`   | Admin surfaces, each with its own `hooks/`.                                                                                                        |
| `comments/`, `media/`, `admin/`, `utils/` | Review threads, asset library, system health, local helpers.                                                                                       |

## `Editor.tsx` is a composition root, not a god component

It is 1,512 lines, but the hard work is already done: **12 custom hooks were extracted
into `hooks/` (17 files, each with its own test)**, and what remains is 26 `useState`
calls, a 24-prop interface, and a ~490-line JSX return. The JSX is the only real bulk.

Do not read its size as an invitation to split it before reading `hooks/` — the logic you
are probably looking for is already out of it.

## Client-bundle boundary

This whole directory is browser-reachable via `canopycms/client`, so:

- **56 files carry `'use client'`.** A new component using hooks needs it.
- **Nothing here may reach a `node:` built-in**, directly or transitively.
  `pnpm lint:bundle` (dependency-cruiser) fails the build on it, so this is a check
  rather than a convention.
- The classic trap is importing a path helper from the `paths` barrel or
  `paths/branch.ts` instead of the dependency-free `paths/branch-name.ts`; both of the
  former pull `node:fs` into the browser bundle. `components/EntryCreateModal.tsx`
  carries a comment at the import explaining exactly this.

## Styling

CanopyCMS's editor UI uses **Mantine**. Host apps and the example app use whatever they
like (example1 uses Tailwind). Per `CLAUDE.md`, do not mix Mantine styling into host-app
or example-app styling, and do not leak editor CSS outward.

## Preview bridge

`preview-bridge.tsx` is the `postMessage` contract between the editor and a host app's
preview iframe: draft updates, click-to-focus, and highlight. It is exported from
`canopycms/client` and is one of the few pieces here that an _adopter's public pages_
import (via `useCanopyPreview`), so treat its message names and payload shapes as a
public contract. `isTrustedEditorMessage`/`resolveMessageOrigin` are the origin checks —
do not weaken them.

## Data loading: SWR for three resources, hand-rolled for the rest

`hooks/README.md` documents the deliberate scope: branches, entries+schema, and comments
are SWR-backed; the remaining ten data-loading hooks hand-roll
`useState(loading)` + `useState(error)` + `useEffect`. That split is a real decision, not
an oversight, but it does mean "the pattern" is not uniform — read the README before
adding a hook so you match the right half.

## Known state, recorded so it is not rediscovered

- `PermissionManager.tsx` and `GroupManager.tsx` are **re-export shims** whose own
  comments say they exist "for backward compatibility", pointing at
  `permission-manager/` and `group-manager/`. `CLAUDE.md` says this is new code needing
  no legacy compat, and all their importers are internal — see
  [editor-compat-shims.md](../../../../.claude/future-tasks/editor-compat-shims.md).
- `permission-manager/` has 11 source files and **no tests in the directory**; it is
  covered only indirectly through `PermissionManager.test.tsx`.
