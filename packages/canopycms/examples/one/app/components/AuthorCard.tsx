import React from 'react'
import type { AuthorContent } from '../schemas'

export interface AuthorCardProps {
  author: AuthorContent | null
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

  return <p className="text-sm text-slate-700">By {author.name}</p>
}
