import React from 'react'
import type { PostContent } from '../schemas'

export interface AuthorCardProps {
  author: PostContent['author']
  isLoading?: boolean
}

export const AuthorCard: React.FC<AuthorCardProps> = ({ author, isLoading }) => {
  // Handle loading state (reference is being resolved)
  if (isLoading) {
    return <p className="text-sm text-slate-500">Loading author...</p>
  }

  if (!author) {
    return null
  }

  // An author entry the reader may not read arrives as its title and URL only.
  if (author.unavailable) {
    return <p className="text-sm text-slate-700">By {author.title}</p>
  }

  return <p className="text-sm text-slate-700">By {author.name}</p>
}
