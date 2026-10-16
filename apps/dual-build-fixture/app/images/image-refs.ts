import type { AssetRef } from 'canopycms'

// Stored refs as an image field holds them. Only the URL shapes matter: the collector parses
// build output and never reads an asset store, so these hashes name no real asset.

/** An editor crop at full float precision; assetUrl rounds it to the canonical spelling. */
export const PHOTO: AssetRef = {
  src: '/assets/t/orig/0123456789abcdef0123456789abcdef/photo.jpg',
  crop: { x: 0.123456, y: 0.1, w: 0.5, h: 0.333333 },
}

export const BANNER: AssetRef = {
  src: '/assets/t/orig/fedcba9876543210fedcba9876543210/banner.png',
}

export const LOGO: AssetRef = { src: '/assets/00112233445566778899aabbccddeeff/logo.svg' }

/**
 * Refs the page hands to a client component. Their props are serialized into the RSC payload,
 * so the stored `src` appears in the build output as well as every URL the component emits.
 */
export const CLIENT_REFS: readonly AssetRef[] = [BANNER]

/** An absolute origin in front of `/assets`, which the collector must strip. */
export const CDN_ORIGIN = 'https://cdn.example.com'
