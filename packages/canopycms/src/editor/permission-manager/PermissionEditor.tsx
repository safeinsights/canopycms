'use client'

/**
 * Permission editor panel for a selected tree node.
 * Handles permission CRUD with tabs for each level.
 */

import React from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Tabs,
  Text,
  Tooltip,
} from '@mantine/core'
import { IconSearch, IconX, IconUserOff } from '@tabler/icons-react'
import type {
  TreeNode,
  PermissionLevel,
  PermissionTarget,
  GroupSelectItem,
  UserSearchResult,
} from './types'
import { PERMISSION_LEVELS, LEVEL_CONFIG } from './constants'
import { GroupSelector } from './GroupSelector'
import { UserSelector } from './UserSelector'
import { UserBadge } from '../components/UserBadge'

export interface PermissionEditorProps {
  node: TreeNode
  activeLevel: PermissionLevel
  onSetActiveLevel: (level: PermissionLevel) => void
  canEdit: boolean
  groups: GroupSelectItem[]
  /** Whether this node is selected (used for search panel visibility) */
  isSelected: boolean
  // User search
  userSearchResults: UserSearchResult[]
  isSearchingUsers: boolean
  showUserSearch: boolean
  userSearchQuery: string
  userSearchError: string | null
  onSearchUsers: (query: string) => void
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  onToggleUserSearch: (show: boolean) => void
  onAddUser: (path: string, level: PermissionLevel, userId: string) => void
  onRemoveUser: (path: string, level: PermissionLevel, userId: string) => void
  // Group search
  showGroupSearch: boolean
  groupSearchQuery: string
  filteredGroups: GroupSelectItem[]
  onSearchGroups: (query: string) => void
  onToggleGroupSearch: (show: boolean) => void
  onAddGroup: (path: string, level: PermissionLevel, groupId: string) => void
  onRemoveGroup: (path: string, level: PermissionLevel, groupId: string) => void
}

export const PermissionEditor: React.FC<PermissionEditorProps> = ({
  node,
  activeLevel,
  onSetActiveLevel,
  canEdit,
  groups,
  isSelected,
  userSearchResults,
  isSearchingUsers,
  showUserSearch,
  userSearchQuery,
  userSearchError,
  onSearchUsers,
  onGetUserMetadata,
  onToggleUserSearch,
  onAddUser,
  onRemoveUser,
  showGroupSearch,
  groupSearchQuery,
  filteredGroups,
  onSearchGroups,
  onToggleGroupSearch,
  onAddGroup,
  onRemoveGroup,
}) => {
  const directPerm = node.directPermission
  const inheritedPerm = node.inheritedPermission

  // Get permission target for a level (from direct or inherited)
  const getTargetForLevel = (
    level: PermissionLevel,
    source: 'direct' | 'inherited'
  ): PermissionTarget | undefined => {
    const perm = source === 'direct' ? directPerm : inheritedPerm
    return perm?.[level]
  }

  return (
    <Paper withBorder p="sm" ml={32} mt="xs" mb="xs">
      <Stack gap="sm">
        <Text size="xs" fw={500} c="dimmed">
          Path: {node.path}
          {node.type === 'folder' ? '/**' : ''}
        </Text>

        {/* Level tabs - keepMounted={false} ensures only active panel is in DOM */}
        <Tabs value={activeLevel} onChange={(v) => onSetActiveLevel(v as PermissionLevel)} keepMounted={false}>
          <Tabs.List>
            {PERMISSION_LEVELS.map((level) => (
              <Tabs.Tab key={level} value={level} leftSection={LEVEL_CONFIG[level].icon}>
                {LEVEL_CONFIG[level].label}
              </Tabs.Tab>
            ))}
          </Tabs.List>

          {PERMISSION_LEVELS.map((level) => {
            const directTarget = getTargetForLevel(level, 'direct')
            const inheritedTarget = getTargetForLevel(level, 'inherited')

            return (
              <Tabs.Panel key={level} value={level} pt="sm">
                {/* Inherited permissions display */}
                {inheritedTarget && (
                  <div style={{ marginBottom: 'var(--mantine-spacing-sm)' }}>
                    <Text size="xs" fw={500} mb={4} c="dimmed">
                      Inherited from parent
                    </Text>
                    <Group gap="xs">
                      {inheritedTarget.allowedGroups?.map((groupId) => {
                        const groupInfo = groups.find((g) => g.value === groupId)
                        return (
                          <Badge key={`inherited-group-${groupId}`} variant="outline" color="gray" size="xs">
                            {groupInfo?.label ?? groupId}
                          </Badge>
                        )
                      })}
                      {inheritedTarget.allowedUsers?.map((userId) =>
                        onGetUserMetadata ? (
                          <UserBadge
                            key={`inherited-user-${userId}`}
                            userId={userId}
                            getUserMetadata={onGetUserMetadata}
                            variant="avatar-name"
                            size="xs"
                            badgeVariant="outline"
                            color="gray"
                            showEmailTooltip={true}
                            showBadge={true}
                          />
                        ) : (
                          <Badge
                            key={`inherited-user-${userId}`}
                            variant="outline"
                            color={userId === 'anonymous' ? 'orange' : 'gray'}
                            size="xs"
                            leftSection={userId === 'anonymous' ? <IconUserOff size={10} /> : undefined}
                          >
                            {userId === 'anonymous' ? 'Anonymous (Public)' : userId}
                          </Badge>
                        )
                      )}
                    </Group>
                  </div>
                )}

                {canEdit ? (
                  <div>
                    <Text size="xs" fw={500} mb={4}>
                      {LEVEL_CONFIG[level].label} Access
                    </Text>

                    {/* Badges for groups and users */}
                    <Group gap="xs" mb="xs">
                      {(directTarget?.allowedGroups ?? []).map((groupId) => {
                        const groupInfo = groups.find((g) => g.value === groupId)
                        return (
                          <Badge
                            key={`group-${groupId}`}
                            variant="filled"
                            color={LEVEL_CONFIG[level].color}
                            pr={3}
                            rightSection={
                              <ActionIcon
                                size="xs"
                                color={LEVEL_CONFIG[level].color}
                                radius="xl"
                                variant="transparent"
                                onClick={() => onRemoveGroup(node.path, level, groupId)}
                              >
                                <IconX size={12} stroke={2.5} style={{ color: 'white' }} />
                              </ActionIcon>
                            }
                          >
                            {groupInfo?.label ?? groupId}
                          </Badge>
                        )
                      })}

                      {(directTarget?.allowedUsers ?? []).map((userId) =>
                        onGetUserMetadata ? (
                          <UserBadge
                            key={`user-${userId}`}
                            userId={userId}
                            getUserMetadata={onGetUserMetadata}
                            variant="avatar-name"
                            size="xs"
                            badgeVariant="filled"
                            color={userId === 'anonymous' ? 'orange' : LEVEL_CONFIG[level].color}
                            onRemove={() => onRemoveUser(node.path, level, userId)}
                            showEmailTooltip={true}
                          />
                        ) : (
                          <Badge
                            key={`user-${userId}`}
                            variant="filled"
                            color={userId === 'anonymous' ? 'orange' : LEVEL_CONFIG[level].color}
                            pr={3}
                            leftSection={userId === 'anonymous' ? <IconUserOff size={12} /> : undefined}
                            rightSection={
                              <ActionIcon
                                size="xs"
                                color={userId === 'anonymous' ? 'orange' : LEVEL_CONFIG[level].color}
                                radius="xl"
                                variant="transparent"
                                onClick={() => onRemoveUser(node.path, level, userId)}
                              >
                                <IconX size={12} stroke={2.5} style={{ color: 'white' }} />
                              </ActionIcon>
                            }
                          >
                            {userId === 'anonymous' ? 'Anonymous (Public)' : userId}
                          </Badge>
                        )
                      )}

                      {(!directTarget?.allowedGroups || directTarget.allowedGroups.length === 0) &&
                        (!directTarget?.allowedUsers || directTarget.allowedUsers.length === 0) && (
                          <Text size="xs" c="dimmed">
                            No groups or users assigned for {level}
                          </Text>
                        )}
                    </Group>

                    {/* Action buttons */}
                    <Group gap="xs">
                      <Button
                        size="xs"
                        variant="subtle"
                        leftSection={<IconSearch size={14} />}
                        onClick={() => onToggleGroupSearch(!showGroupSearch)}
                      >
                        {showGroupSearch ? 'Cancel' : 'Add Groups'}
                      </Button>

                      <Button
                        size="xs"
                        variant="subtle"
                        leftSection={<IconSearch size={14} />}
                        onClick={() => onToggleUserSearch(!showUserSearch)}
                      >
                        {showUserSearch ? 'Cancel' : 'Add User'}
                      </Button>

                      {/* Anonymous user button - only show if not already added */}
                      {!(directTarget?.allowedUsers ?? []).includes('anonymous') && (
                        <Tooltip label="Allow unauthenticated/public access">
                          <Button
                            size="xs"
                            variant="subtle"
                            color="orange"
                            leftSection={<IconUserOff size={14} />}
                            onClick={() => onAddUser(node.path, level, 'anonymous')}
                          >
                            Add Anonymous
                          </Button>
                        </Tooltip>
                      )}
                    </Group>

                    {/* Group search panel - only show when this node is selected and on active level */}
                    {showGroupSearch && isSelected && activeLevel === level && (
                      <GroupSelector
                        searchQuery={groupSearchQuery}
                        onSearchChange={onSearchGroups}
                        filteredGroups={filteredGroups}
                        onSelectGroup={(groupId) => onAddGroup(node.path, level, groupId)}
                      />
                    )}

                    {/* User search panel - only show when this node is selected and on active level */}
                    {showUserSearch && isSelected && activeLevel === level && (
                      <UserSelector
                        searchQuery={userSearchQuery}
                        onSearchChange={onSearchUsers}
                        searchResults={userSearchResults}
                        isSearching={isSearchingUsers}
                        searchError={userSearchError}
                        onSelectUser={(userId) => onAddUser(node.path, level, userId)}
                        onGetUserMetadata={onGetUserMetadata}
                      />
                    )}
                  </div>
                ) : (
                  <Text size="xs" c="dimmed">
                    {directTarget ? 'Read-only view' : 'No direct permissions set'}
                  </Text>
                )}
              </Tabs.Panel>
            )
          })}
        </Tabs>
      </Stack>
    </Paper>
  )
}
