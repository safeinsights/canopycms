import React from 'react'
import type { HomeContent } from './schemas'
import HomeView from './components/HomeView'
import { getCanopy } from './lib/canopy'

const Page = async () => {
  const canopy = await getCanopy()

  const { data } = await canopy.read<HomeContent>({
    entryPath: 'content/home',
  })

  return <HomeView data={data} />
}

export default Page
