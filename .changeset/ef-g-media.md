---
'canopycms': minor
'canopycms-cdk': minor
---

### Removing a file from the media library hides it, and an admin can restore it — **behaviour change**

<!-- migration
area: Assets
action: Own bucket policy: grant asset-hidden
row: Library removal hides the file; grant the asset-hidden/ prefix
-->

**What changed.** "Remove from library" no longer deletes the file's metadata, so every image
size and crop keeps working wherever the file is used, including `materialize-assets`. It writes
a marker under the new `asset-hidden/` prefix instead. Admins can turn on "Show removed files" in
the media library and restore a file, and uploading the same file again restores it too. The
`assets.delete` API call is replaced by `assets.hide` and `assets.restore`.

**To adopt.** `AssetSupport.grantUploadAccess()` and `CanopyCmsService`'s `assetBucket` grant
the new prefix, and no longer grant delete on `asset-meta/`. If you write the CMS role's bucket
policy yourself, grant it `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on
`asset-hidden/*`, and drop `s3:DeleteObject` on `asset-meta/*`.
