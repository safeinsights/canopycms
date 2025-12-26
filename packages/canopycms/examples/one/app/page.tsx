import React from 'react'

import type { HomeContent } from './schemas'
import HomeView from './components/HomeView'
import { createContentReader } from 'canopycms/server'
import configBundle from '../canopycms.config'

const contentReader = createContentReader({ config: configBundle.server })

const Page = async ({ searchParams }: { searchParams?: { branch?: string } }) => {
  const { data } = await contentReader.read<HomeContent>({
    entryPath: 'content/home',
    branch: searchParams?.branch,
  })
  return <HomeView data={data} />
}

export default Page
