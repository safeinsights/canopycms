/**
 * Hook for managing groups and user search state
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import type { UserSearchResult, GroupMetadata, GroupSelectItem } from '../types'

export interface UseGroupsAndUsersOptions {
  onListGroups?: () => Promise<GroupMetadata[]>
  onSearchUsers?: (query: string, limit?: number) => Promise<UserSearchResult[]>
  canEdit: boolean
}

export interface UseGroupsAndUsersResult {
  // Groups
  groups: GroupMetadata[]
  groupSelectData: GroupSelectItem[]
  filteredGroups: GroupSelectItem[]
  isLoadingGroups: boolean
  groupLoadError: string | null
  groupSearchQuery: string
  showGroupSearch: boolean
  setGroupSearchQuery: (query: string) => void
  setShowGroupSearch: (show: boolean) => void
  clearGroupLoadError: () => void

  // Users
  userSearchResults: UserSearchResult[]
  isSearchingUsers: boolean
  userSearchQuery: string
  showUserSearch: boolean
  userSearchError: string | null
  setUserSearchQuery: (query: string) => void
  toggleUserSearch: (show: boolean) => void
}

export function useGroupsAndUsers({
  onListGroups,
  onSearchUsers,
  canEdit,
}: UseGroupsAndUsersOptions): UseGroupsAndUsersResult {
  // Groups state
  const [groups, setGroups] = useState<GroupMetadata[]>([])
  const [isLoadingGroups, setIsLoadingGroups] = useState(false)
  const [groupLoadError, setGroupLoadError] = useState<string | null>(null)
  const [groupSearchQuery, setGroupSearchQuery] = useState('')
  const [showGroupSearch, setShowGroupSearch] = useState(false)

  // User search state
  const [userSearchResults, setUserSearchResults] = useState<UserSearchResult[]>([])
  const [isSearchingUsers, setIsSearchingUsers] = useState(false)
  const [userSearchQuery, setUserSearchQuery] = useState('')
  const [showUserSearch, setShowUserSearch] = useState(false)
  const [userSearchError, setUserSearchError] = useState<string | null>(null)

  // Load groups on mount
  useEffect(() => {
    if (onListGroups && canEdit) {
      setIsLoadingGroups(true)
      onListGroups()
        .then((loadedGroups) => {
          setGroups(loadedGroups)
          setGroupLoadError(null)
        })
        .catch((err) => {
          console.error('Failed to load groups:', err)
          setGroupLoadError('Failed to load groups. Group selection may be unavailable.')
        })
        .finally(() => setIsLoadingGroups(false))
    }
  }, [onListGroups, canEdit])

  // Transform groups to select data format
  const groupSelectData = useMemo(
    () =>
      groups.map((g) => ({
        value: g.id,
        label: g.name,
      })),
    [groups]
  )

  // Filter groups based on search query
  const filteredGroups = useMemo(() => {
    const query = groupSearchQuery.toLowerCase().trim()
    if (!query) return groupSelectData

    return groupSelectData.filter(
      (g) => g.label.toLowerCase().includes(query) || g.value.toLowerCase().includes(query)
    )
  }, [groupSearchQuery, groupSelectData])

  // Debounced user search
  useEffect(() => {
    if (!showUserSearch || !userSearchQuery.trim()) return

    const timer = setTimeout(() => {
      if (onSearchUsers) {
        setIsSearchingUsers(true)
        setUserSearchError(null)
        onSearchUsers(userSearchQuery, 10)
          .then((results) => {
            setUserSearchResults(results)
            setUserSearchError(null)
          })
          .catch((err) => {
            console.error('User search failed:', err)
            setUserSearchError('Failed to search users. Please try again.')
            setUserSearchResults([])
          })
          .finally(() => setIsSearchingUsers(false))
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [userSearchQuery, onSearchUsers, showUserSearch])

  const toggleUserSearch = useCallback((show: boolean) => {
    setShowUserSearch(show)
    if (!show) {
      setUserSearchQuery('')
      setUserSearchResults([])
      setUserSearchError(null)
    }
  }, [])

  const clearGroupLoadError = useCallback(() => {
    setGroupLoadError(null)
  }, [])

  return {
    // Groups
    groups,
    groupSelectData,
    filteredGroups,
    isLoadingGroups,
    groupLoadError,
    groupSearchQuery,
    showGroupSearch,
    setGroupSearchQuery,
    setShowGroupSearch,
    clearGroupLoadError,

    // Users
    userSearchResults,
    isSearchingUsers,
    userSearchQuery,
    showUserSearch,
    userSearchError,
    setUserSearchQuery,
    toggleUserSearch,
  }
}
