import { HeroThumb } from '../HeroThumb'
import { heroRef, type HomeData } from '../hero-ref'
import { readByUrlPath } from '../lib/canopy'

// A server-rendered page that is not a preview, so its asset URLs stay public.
export const dynamic = 'force-dynamic'

export default async function HeroPage() {
  const home = await readByUrlPath<HomeData>('/home', { branch: 'main' })
  const hero = heroRef(home?.data.heroImage)
  return hero ? <HeroThumb hero={hero} /> : null
}
