---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED 2026-10-10, branch `fix/staged-acl-changes-unsaved-guard`, base `int-202610-b` (adopter request 107). Manage Groups and Manage Permissions keep batch save, and both now render through one shared `editor/components/StagedChangesDrawer.tsx`: while dirty the drawer title carries an "Unsaved changes" badge, the Discard/Save bar is sticky at the bottom of the drawer's scroll area, closing (Escape, overlay, X) opens a Discard / Keep editing confirm, a `beforeunload` handler is registered only while dirty, and the panel is inert while a save is in flight. New or edited groups show an "Unsaved" row badge (`useGroupState.unsavedGroupIds`), and the group dialog's buttons read "Add" and "Apply". Escape inside the group dialog no longer closes the drawer. Covered by `StagedChangesDrawer.test.tsx` and e2e D6 in `permissions-groups.spec.ts`.
---

# Staged group and permission changes are easy to lose silently

## Status: RESOLVED 2026-10-10

## What an adopter saw

An admin opened Manage Groups, created a group, and saw it in the list, but nothing was sent:
the group was only staged. The "Save Groups" bar sat below the list, off-screen until the
panel was scrolled, so after a reload the group was gone. On an access-control surface, an
admin could walk away believing a removal had taken effect.

## Causes

- The Discard/Save bar rendered after the panel content inside the drawer's scroll area, so a
  long list pushed it out of view.
- Nothing marked the panel as dirty, and both managers ignored their `onClose` prop; the drawer
  in `Editor.tsx` closed without asking.
- Nothing under `editor/` registered a `beforeunload` handler.
- The group dialog's "Create" button suggested the group was created.

## Fix

The managers own their drawer now (`opened`/`onClose` props), so the component holding the
staged state decides whether closing may proceed. `StagedChangesDrawer` holds the badge,
sticky bar, close confirm and `beforeunload` guard for both. It also ignores close, and
disables the panel, while a save is in flight. Mantine listens for Escape on `window` in the
capture phase, so the drawer ignores Escape while its confirm or the group dialog is open.

Because the managers now stay mounted while closed, each is keyed by `useOpeningKey` so its
state lasts one opening, and PermissionManager loads groups only while open.
