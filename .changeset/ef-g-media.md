---
'canopycms': minor
'canopycms-cdk': minor
---

### Removing a file from the media library hides it, and an admin can restore it — **breaking (assets.delete, AssetStore) / behaviour change; template first**

<!-- migration
area: Assets
action: Template first
row: Library removal hides the file; deploy grants before the image
-->

**What changed.** "Remove from library" no longer deletes the file's metadata, so every image
size and crop keeps working wherever the file is used, including `materialize-assets`. It writes
a marker under the new `asset-hidden/` prefix instead. Admins can turn on "Show removed files" in
the media library and restore a file, and uploading the same file again restores it too.

**To adopt.**

- `assets.delete` and `DELETE /assets` are removed (`DELETE /assets` answers 410); use
  `assets.hide` / `POST /assets/hide` and `assets.restore` / `POST /assets/restore`.
- A custom `AssetStore` drops `deleteMeta` and must implement `hideAsset` and `unhideAsset`; a
  custom `AssetPrefixes` must set `hidden`.
- `AssetSupport.grantUploadAccess()` and `CanopyCmsService`'s `assetBucket` grant `s3:PutObject`
  and `s3:DeleteObject` on `asset-hidden/*` and no longer grant delete on `asset-meta/*`. If you
  write the CMS role's bucket policy yourself, do the same (no `s3:GetObject` is needed), and if
  it scopes `s3:ListBucket` by prefix, include `asset-hidden/`.
- Deploy those grants before CI rolls this release's CMS image: the stack template, built with
  this release's `canopycms-cdk`, and your own bucket policy if you write one. On the old grants, removing a file is denied, and a policy that
  scopes `s3:ListBucket` by prefix without `asset-hidden/` fails every media library page.
- Files removed before this release lost their metadata. Uploading the same bytes again recreates
  it, recorded under the re-uploader's name.
