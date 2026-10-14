---
'canopycms': minor
---

### AI content can withhold or redirect a link to an entry with no page

<!-- migration
area: AI
action: Optional
row: referenceLink decides where AI-export entry links point
-->

**What changed.** The AI export linked every exported reference target to its page URL, even
when the site gives that entry no page. A new `AIContentConfig.referenceLink(target, { body,
defaultUrl })` decides where links to an exported entry point. The decision covers both reference
fields and body `entry:` links, so the two kinds of link always agree. Return a URL to link there
instead. Return `false` when the target has no page: its title then renders as plain text, with
no page link and no markdown-version link, and an inline `entry:` link becomes its text. Return
`undefined` to keep the default. `body` is the target's stored MD/MDX body and never reaches the
export. The callback runs once per target per run, may be async, and never sees a target the
export leaves out. A throw or any other return is logged and treated as `false`.

**To adopt.** If your site's routes, sitemap or bylines decide that some entries have no page,
apply the same rule here, for example `referenceLink: (target, { body }) =>
!body?.trim() ? false : undefined` in `defineAIContentConfig` from `canopycms/ai`. See
[AI Content Configuration](../README.md#ai-content-configuration).

**Now deletable.** A `fieldTransforms` entry that re-renders a reference field only to drop or
change its link.
