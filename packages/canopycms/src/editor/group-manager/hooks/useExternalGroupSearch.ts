/**
 * Hook for external group search functionality
 */

import { useState, useEffect } from 'react'
import type { ExternalGroup } from '../types'

export interface UseExternalGroupSearchOptions {
  onSearchExternalGroups?: (query: string) => Promise<ExternalGroup[]>
}

export interface UseExternalGroupSearchResult {
  searchQuery: string
  searchResults: ExternalGroup[]
  isSearching: boolean
  searchError: string | null
  setSearchQuery: (query: string) => void
}

export function useExternalGroupSearch({
  onSearchExternalGroups,
}: UseExternalGroupSearchOptions): UseExternalGroupSearchResult {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ExternalGroup[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  // Debounced external group search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([])
      return
    }

    const timer = setTimeout(() => {
      if (onSearchExternalGroups) {
        setIsSearching(true)
        setSearchError(null)
        onSearchExternalGroups(searchQuery)
          .then((results) => {
            setSearchResults(results)
            setSearchError(null)
          })
          .catch((err) => {
            console.error('External group search failed:', err)
            setSearchError('Failed to search external groups. Please try again.')
            setSearchResults([])
          })
          .finally(() => setIsSearching(false))
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [searchQuery, onSearchExternalGroups])

  return {
    searchQuery,
    searchResults,
    isSearching,
    searchError,
    setSearchQuery,
  }
}
