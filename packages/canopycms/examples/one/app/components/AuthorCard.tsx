import React from 'react'
import type { AuthorContent } from '../schemas'

export interface AuthorCardProps {
  author: AuthorContent | null
  fallbackId?: string
}

export const AuthorCard: React.FC<AuthorCardProps> = ({ author, fallbackId }) => {
  if (!author) {
    return (
      <div className="flex items-start gap-3 rounded-lg bg-slate-50 p-3 border border-slate-200">
        <div className="flex-1">
          <p className="text-sm font-medium text-slate-500">Author not found</p>
          {fallbackId && <p className="text-xs text-slate-400 mt-1">Reference ID: {fallbackId}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-3 rounded-lg bg-slate-50 p-3 border border-slate-200">
      <div className="flex-1">
        <p className="text-sm font-medium text-slate-900">{author.name}</p>
        {/* Bio is available in data if needed, but showing just name for now */}
      </div>
    </div>
  )
}
