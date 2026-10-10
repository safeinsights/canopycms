# `editor/` — React editor UI

The largest subsystem in the package, by a wide margin.

As everywhere else in this package, **the code comment at the point of a rule is
authoritative**. This file is the map.

## Layout

| Path                                      | What lives there                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Editor.tsx`                              | The composition root. See below.                                                                                                                   |
| `hooks/`                                  | 17 hooks — the real logic. Start here, not in the components. Has its own [README.md](hooks/README.md) covering the SWR data-loading architecture. |
| `fields/`                                 | Field components per schema type, plus `FieldLabel` and `entry-link/`.                                                                             |
| `components/`                             | Presentational pieces used by `Editor.tsx` (header, sidebar, modals).                                                                              |
| `EditorAuthGate.tsx`                      | Signed-out and mode-mismatch handling, decided from the API's answers. See below.                                                                  |
| `context/`                                | `ApiClientContext`, `AssetContext`, `EditorStateContext`, `SWRProvider`, `EditorIdentityContext`.                                                  |
| `schema-editor/`                          | The admin schema-editing UI (collections, entry types, ordering).                                                                                  |
| `permission-manager/`, `group-manager/`   | Admin surfaces, each with its own `hooks/`.                                                                                                        |
| `comments/`, `media/`, `admin/`, `utils/` | Review threads, asset library, system health, local helpers.                                                                                       |

## `Editor.tsx` is a composition root, not a god component

Its size is mostly JSX: the logic has been extracted into `hooks/`, each hook with its own
test. Do not split it before reading `hooks/`; what you are looking for is probably there.

## Signed-out users

`EditorAuthGate` trusts the API's answers, a 401 or an `EDITOR_MODE_MISMATCH` 412; its header comment
holds the rules.
Two traps outside it:

- A 401 after mount overlays the editor. Never remount it for the same identity; that loses unsaved edits.
- Only a client the `ApiClientProvider` builds reports every 401. An injected `client` is
  seen only through the gate's `whoami`.

## Client-bundle boundary

This whole directory is browser-reachable via `canopycms/client`, so:

- A new component using hooks needs `'use client'`.
- **Nothing here may reach a `node:` built-in**, directly or transitively.
  `pnpm lint:bundle` (dependency-cruiser) fails the build on it, so this is a check
  rather than a convention.
- Import path helpers from the dependency-free `paths/branch-name.ts`, never from the `paths` barrel or `paths/branch.ts`; both pull `node:fs` into the browser bundle.
- `components/EntryCreateModal.tsx` carries the comment at that import.

## Styling

CanopyCMS's editor UI uses **Mantine**. Host apps and the example app use whatever they
like (example1 uses Tailwind). Per `CLAUDE.md`, do not mix Mantine styling into host-app
or example-app styling, and do not leak editor CSS outward.

## Preview bridge

`preview-bridge.tsx` is the `postMessage` contract between the editor and a host app's
preview iframe (draft updates, click-to-focus, highlight) plus the host-page hooks;
`PreviewFrame.tsx` is the editor's side. _Adopters' public pages_ import the bridge via
`canopycms/preview`, so its message names and payload shapes are a public contract. `isTrustedEditorMessage`/`resolveMessageOrigin` are the origin checks —
do not weaken them. `preview-asset-base.ts` holds `assetUrl`'s preview prefix; see its header.

## Data loading: SWR for three resources, hand-rolled for the rest

`hooks/README.md` documents the deliberate scope: branches, entries+schema, and comments
are SWR-backed; the remaining ten data-loading hooks hand-roll
`useState(loading)` + `useState(error)` + `useEffect`. That split is a real decision, not
an oversight, but it does mean "the pattern" is not uniform — read the README before
adding a hook so you match the right half.

## Known state, recorded so it is not rediscovered

- `PermissionManager.tsx` and `GroupManager.tsx` are re-export shims over `permission-manager/` and `group-manager/`; removing them is tracked in [editor-compat-shims.md](../../../../.claude/future-tasks/editor-compat-shims.md).
- `permission-manager/` has 11 source files and **no tests in the directory**; it is
  covered only indirectly through `PermissionManager.test.tsx`.
