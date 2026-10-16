import { assetUrl, type AssetRef } from 'canopycms'

/** A server component: its src is computed on the server, never in the browser. */
export function HeroThumb({ hero }: { hero: AssetRef }) {
  return <img data-testid="hero-thumb" src={assetUrl(hero, { width: 200 })} alt="" width={64} />
}
