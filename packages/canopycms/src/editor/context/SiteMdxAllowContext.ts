'use client'

import { createContext, useContext } from 'react'

import type { MdxAllowlist } from '../../config'

/** The config's `mdxAllow`, which each field checked as MDX narrows by its own. */
export const SiteMdxAllowContext = createContext<MdxAllowlist | undefined>(undefined)

export function useSiteMdxAllow(): MdxAllowlist | undefined {
  return useContext(SiteMdxAllowContext)
}
