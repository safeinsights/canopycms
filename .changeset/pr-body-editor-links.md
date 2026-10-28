---
'canopycms': patch
---

### Pull request bodies link back to the editor

<!-- migration
area: Branches
action: Optional
row: PR body links back to the editor
-->

**What changed.** The pull request a submit opens links to the branch in the editor, and each changed entry to that entry. A notice tells reviewers that comments on the pull request do not reach the editor, so the author will not see them. The links use the editor's URL from the submit, accepted only when its host is the one the request was addressed to (`X-Forwarded-Host`, else `Host`), which holds behind `canopycms-cdk`'s CloudFront distribution as it stands.

**To adopt.** Nothing, unless a proxy in front of the CMS sets neither header to the editor's public host: then set `editorUrl` in your Canopy config to the editor page's URL, e.g. `editorUrl: 'https://cms.example.org/edit'`. See [the config reference](../README.md#definecanopyconfig-options).
