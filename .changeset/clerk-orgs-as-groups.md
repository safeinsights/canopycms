---
'canopycms-cdk': minor
'canopycms-auth-clerk': minor
'canopycms': minor
---

### Clerk organizations-as-groups is a deployment setting, and survives a Clerk instance without Organizations — **behaviour change**

<!-- migration
area: Auth
action: Optional
row: clerkOrganizationsAsGroups prop; 403 keeps users
-->

**What changed.** `CanopyCmsService` takes `clerkOrganizationsAsGroups` (default `true`, unchanged), which the worker honours; in a deployment it, not the plugin's `useOrganizationsAsGroups`, decides the groups. A 403 from Clerk's Organizations API now writes users with no groups and logs a warning, instead of failing the whole refresh. Memberships are fetched instance-wide rather than per user. The scaffolds write `false` explicitly: `useOrganizationsAsGroups` in `canopycms init`'s `canopy.ts`, and `clerkOrganizationsAsGroups` in `canopycms init-deploy aws`'s CDK stack.

**To adopt.** On a Clerk instance without Organizations, set `clerkOrganizationsAsGroups: false` on `CanopyCmsService` and `useOrganizationsAsGroups: false` in `createClerkAuthPlugin`. See [Deploying to AWS](../docs/deploying-to-aws.md).
