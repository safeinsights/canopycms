'use client'

/**
 * Tree visualization component for permission management.
 * Renders the content tree with permission badges and handles selection.
 */

import React from 'react'
import { ActionIcon, Collapse } from '@mantine/core'
import { IconChevronRight, IconChevronDown, IconFolder, IconFile } from '@tabler/icons-react'
import type {
  TreeNode,
  PermissionLevel,
  PermissionTarget,
  GroupSelectItem,
  UserSearchResult,
} from './types'
import { PERMISSION_LEVELS } from './constants'
import { PermissionLevelBadge } from './PermissionLevelBadge'
import { PermissionEditor } from './PermissionEditor'

export interface PermissionTreeProps {
  node: TreeNode
  expandedNodes: Set<string>
  selectedNode: string | null
  canEdit: boolean
  groups: GroupSelectItem[]
  activeLevel: PermissionLevel
  // User search props
  userSearchResults: UserSearchResult[]
  isSearchingUsers: boolean
  showUserSearch: boolean
  userSearchQuery: string
  userSearchError: string | null
  // Group search props
  showGroupSearch: boolean
  groupSearchQuery: string
  filteredGroups: GroupSelectItem[]
  // Callbacks
  onToggle: (path: string) => void
  onSelect: (path: string | null) => void
  onSetActiveLevel: (level: PermissionLevel) => void
  onUpdatePermission: (
    path: string,
    level: PermissionLevel,
    updates: Partial<PermissionTarget>,
  ) => void
  onSearchUsers: (query: string) => void
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  onToggleUserSearch: (show: boolean) => void
  onAddUser: (path: string, level: PermissionLevel, userId: string) => void
  onRemoveUser: (path: string, level: PermissionLevel, userId: string) => void
  onSearchGroups: (query: string) => void
  onToggleGroupSearch: (show: boolean) => void
  onAddGroup: (path: string, level: PermissionLevel, groupId: string) => void
  onRemoveGroup: (path: string, level: PermissionLevel, groupId: string) => void
}

export const PermissionTree: React.FC<PermissionTreeProps> = ({
  node,
  expandedNodes,
  selectedNode,
  canEdit,
  groups,
  activeLevel,
  userSearchResults,
  isSearchingUsers,
  showUserSearch,
  userSearchQuery,
  userSearchError,
  showGroupSearch,
  groupSearchQuery,
  filteredGroups,
  onToggle,
  onSelect,
  onSetActiveLevel,
  onUpdatePermission,
  onSearchUsers,
  onGetUserMetadata,
  onToggleUserSearch,
  onAddUser,
  onRemoveUser,
  onSearchGroups,
  onToggleGroupSearch,
  onAddGroup,
  onRemoveGroup,
}) => {
  const isExpanded = expandedNodes.has(node.path)
  const isSelected = selectedNode === node.path
  const hasChildren = node.children.length > 0

  const handleClick = () => {
    if (node.type === 'folder') {
      onToggle(node.path)
    }
    onSelect(node.path === selectedNode ? null : node.path)
  }

  const directPerm = node.directPermission
  const inheritedPerm = node.inheritedPermission

  // Get permission target for a level (from direct or inherited)
  const getTargetForLevel = (
    level: PermissionLevel,
    source: 'direct' | 'inherited',
  ): PermissionTarget | undefined => {
    const perm = source === 'direct' ? directPerm : inheritedPerm
    return perm?.[level]
  }

  return (
    <div>
      {/* Tree node row */}
      <div
        style={{
          display: 'flex',
          gap: 'var(--mantine-spacing-xs)',
          padding: '4px var(--mantine-spacing-xs)',
          cursor: 'pointer',
          backgroundColor: isSelected ? 'var(--mantine-color-blue-light)' : 'transparent',
          borderRadius: 'var(--mantine-radius-sm)',
        }}
        onClick={handleClick}
      >
        {/* Tree controls and icon - fixed width container */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--mantine-spacing-xs)',
            flexShrink: 0,
          }}
        >
          {node.type === 'folder' && hasChildren && (
            <ActionIcon size="xs" variant="transparent" color="gray">
              {isExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            </ActionIcon>
          )}
          {(node.type === 'file' || (node.type === 'folder' && !hasChildren)) && (
            <div style={{ width: 18 }} />
          )}
          {node.type === 'folder' ? <IconFolder size={16} /> : <IconFile size={16} />}
          <span style={{ fontSize: '14px', whiteSpace: 'nowrap' }}>{node.name}</span>
        </div>

        {/* Show permission level badges */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            flexWrap: 'wrap',
            alignItems: 'center',
            minWidth: 0,
          }}
        >
          {PERMISSION_LEVELS.map((level) => (
            <PermissionLevelBadge
              key={level}
              level={level}
              target={getTargetForLevel(level, 'direct')}
              inherited={getTargetForLevel(level, 'inherited')}
            />
          ))}
        </div>
      </div>

      {/* Expanded permission editor - use Collapse for animation, content stays in DOM for test accessibility */}
      <Collapse in={isSelected}>
        <PermissionEditor
          node={node}
          activeLevel={activeLevel}
          onSetActiveLevel={onSetActiveLevel}
          canEdit={canEdit}
          groups={groups}
          userSearchResults={userSearchResults}
          isSearchingUsers={isSearchingUsers}
          showUserSearch={showUserSearch}
          userSearchQuery={userSearchQuery}
          userSearchError={userSearchError}
          onSearchUsers={onSearchUsers}
          onGetUserMetadata={onGetUserMetadata}
          onToggleUserSearch={onToggleUserSearch}
          onAddUser={onAddUser}
          onRemoveUser={onRemoveUser}
          showGroupSearch={showGroupSearch}
          groupSearchQuery={groupSearchQuery}
          filteredGroups={filteredGroups}
          onSearchGroups={onSearchGroups}
          onToggleGroupSearch={onToggleGroupSearch}
          onAddGroup={onAddGroup}
          onRemoveGroup={onRemoveGroup}
          isSelected={isSelected}
        />
      </Collapse>

      {/* Children */}
      {node.type === 'folder' && hasChildren && (
        <Collapse in={isExpanded}>
          <div style={{ paddingLeft: 16 }}>
            {node.children.map((child) => (
              <PermissionTree
                key={child.path}
                node={child}
                expandedNodes={expandedNodes}
                selectedNode={selectedNode}
                canEdit={canEdit}
                groups={groups}
                activeLevel={activeLevel}
                userSearchResults={userSearchResults}
                isSearchingUsers={isSearchingUsers}
                showUserSearch={showUserSearch}
                userSearchQuery={userSearchQuery}
                userSearchError={userSearchError}
                showGroupSearch={showGroupSearch}
                groupSearchQuery={groupSearchQuery}
                filteredGroups={filteredGroups}
                onToggle={onToggle}
                onSelect={onSelect}
                onSetActiveLevel={onSetActiveLevel}
                onUpdatePermission={onUpdatePermission}
                onSearchUsers={onSearchUsers}
                onGetUserMetadata={onGetUserMetadata}
                onToggleUserSearch={onToggleUserSearch}
                onAddUser={onAddUser}
                onRemoveUser={onRemoveUser}
                onSearchGroups={onSearchGroups}
                onToggleGroupSearch={onToggleGroupSearch}
                onAddGroup={onAddGroup}
                onRemoveGroup={onRemoveGroup}
              />
            ))}
          </div>
        </Collapse>
      )}
    </div>
  )
}
