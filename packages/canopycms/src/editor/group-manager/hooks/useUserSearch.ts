/**
 * Hook for user search functionality
 */

import { useState, useEffect, useCallback } from 'react'
import type { UserSearchResult } from '../types'

export interface UseUserSearchOptions {
  onSearchUsers?: (query: string, limit?: number) => Promise<UserSearchResult[]>
}

export interface UseUserSearchResult {
  searchQuery: string
  searchResults: UserSearchResult[]
  isSearching: boolean
  searchError: string | null
  activeGroupId: string | null
  setSearchQuery: (query: string) => void
  showSearch: (groupId: string) => void
  hideSearch: () => void
  clearSearch: () => void
}

export function useUserSearch({ onSearchUsers }: UseUserSearchOptions): UseUserSearchResult {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)

  // Debounced user search
  useEffect(() => {
    if (!activeGroupId || !searchQuery.trim()) return

    const timer = setTimeout(() => {
      if (onSearchUsers) {
        setIsSearching(true)
        setSearchError(null)
        onSearchUsers(searchQuery, 10)
          .then((results) => {
            setSearchResults(results)
            setSearchError(null)
          })
          .catch((err) => {
            console.error('User search failed:', err)
            setSearchError('Failed to search users. Please try again.')
            setSearchResults([])
          })
          .finally(() => setIsSearching(false))
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [searchQuery, onSearchUsers, activeGroupId])

  const showSearch = useCallback((groupId: string) => {
    setActiveGroupId(groupId)
  }, [])

  const hideSearch = useCallback(() => {
    setActiveGroupId(null)
    setSearchQuery('')
    setSearchResults([])
    setSearchError(null)
  }, [])

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchResults([])
    setSearchError(null)
  }, [])

  return {
    searchQuery,
    searchResults,
    isSearching,
    searchError,
    activeGroupId,
    setSearchQuery,
    showSearch,
    hideSearch,
    clearSearch,
  }
}
