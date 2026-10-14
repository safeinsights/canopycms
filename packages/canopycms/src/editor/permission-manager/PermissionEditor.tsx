'use client'

import React, { useRef } from 'react'
import { ActionIcon, Badge, Button, Group, Paper, Stack, Tabs, Text, Tooltip } from '@mantine/core'
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
import { useFocusAfterRemove } from '../utils/focus-return'

export interface PermissionEditorProps {
  node: TreeNode
  activeLevel: PermissionLevel
  onSetActiveLevel: (level: PermissionLevel) => void
  canEdit: boolean
  groups: GroupSelectItem[]
  /** Whether this node is selected (used for search panel visibility) */
  isSelected: boolean
  userSearchResults: UserSearchResult[]
  isSearchingUsers: boolean
  showUserSearch: boolean
  userSearchQuery: string
  userSearchError: string | null
  onSearchUsers: (query: string) => void
  onGetUserMetadata: (userId: string) => Promise<UserSearchResult | null>
  onToggleUserSearch: (show: boolean) => void
  onAddUser: (path: string, level: PermissionLevel, userId: string) => void
  onRemoveUser: (path: string, level: PermissionLevel, userId: string) => void
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
  const { listRef, focusAfterRemove } = useFocusAfterRemove()
  const addGroupsRef = useRef<HTMLButtonElement>(null)
  const addUserRef = useRef<HTMLButtonElement>(null)

  const directPerm = node.directPermission
  const inheritedPerm = node.inheritedPermission

  const getTargetForLevel = (
    level: PermissionLevel,
    source: 'direct' | 'inherited',
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

        {/* keepMounted={false} ensures only the active panel is in the DOM */}
        <Tabs
          value={activeLevel}
          onChange={(v) => onSetActiveLevel(v as PermissionLevel)}
          keepMounted={false}
        >
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
                {inheritedTarget && (
                  <div style={{ marginBottom: 'var(--mantine-spacing-sm)' }}>
                    <Text size="xs" fw={500} mb={4} c="dimmed">
                      Inherited from parent
                    </Text>
                    <Group gap="xs">
                      {inheritedTarget.allowedGroups?.map((groupId) => {
                        const groupInfo = groups.find((g) => g.value === groupId)
                        return (
                          <Badge
                            key={`inherited-group-${groupId}`}
                            variant="outline"
                            color="gray"
                            size="xs"
                          >
                            {groupInfo?.label ?? groupId}
                          </Badge>
                        )
                      })}
                      {inheritedTarget.allowedUsers?.map((userId) => (
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
                          revealIdOnFallback
                        />
                      ))}
                    </Group>
                  </div>
                )}

                {canEdit ? (
                  <div>
                    <Text size="xs" fw={500} mb={4}>
                      {LEVEL_CONFIG[level].label} access
                    </Text>

                    <Group gap="xs" mb="xs" ref={listRef}>
                      {(directTarget?.allowedGroups ?? []).map((groupId, groupIndex) => {
                        const groupInfo = groups.find((g) => g.value === groupId)
                        return (
                          <Badge
                            key={`group-${groupId}`}
                            variant="light"
                            color={LEVEL_CONFIG[level].color}
                            pr={3}
                            rightSection={
                              <Tooltip label={`Remove ${groupInfo?.label ?? groupId}`}>
                                <ActionIcon
                                  size="xs"
                                  color={LEVEL_CONFIG[level].color}
                                  radius="xl"
                                  variant="transparent"
                                  aria-label={`Remove ${groupInfo?.label ?? groupId}`}
                                  onClick={() => {
                                    onRemoveGroup(node.path, level, groupId)
                                    focusAfterRemove(groupIndex, addGroupsRef)
                                  }}
                                >
                                  <IconX
                                    size={12}
                                    stroke={2.5}
                                    style={{ color: 'var(--mantine-color-text)' }}
                                  />
                                </ActionIcon>
                              </Tooltip>
                            }
                          >
                            {groupInfo?.label ?? groupId}
                          </Badge>
                        )
                      })}

                      {(directTarget?.allowedUsers ?? []).map((userId, userIndex) => (
                        <UserBadge
                          key={`user-${userId}`}
                          userId={userId}
                          getUserMetadata={onGetUserMetadata}
                          variant="avatar-name"
                          size="xs"
                          badgeVariant="light"
                          color={userId === 'anonymous' ? 'orange' : LEVEL_CONFIG[level].color}
                          onRemove={() => {
                            onRemoveUser(node.path, level, userId)
                            focusAfterRemove(
                              (directTarget?.allowedGroups ?? []).length + userIndex,
                              addUserRef,
                            )
                          }}
                          showEmailTooltip={true}
                          revealIdOnFallback
                        />
                      ))}

                      {(!directTarget?.allowedGroups || directTarget.allowedGroups.length === 0) &&
                        (!directTarget?.allowedUsers || directTarget.allowedUsers.length === 0) && (
                          <Text size="xs" c="dimmed">
                            No groups or users assigned for {level}
                          </Text>
                        )}
                    </Group>

                    <Group gap="xs">
                      <Button
                        ref={addGroupsRef}
                        variant="subtle"
                        leftSection={<IconSearch size={14} />}
                        onClick={() => onToggleGroupSearch(!showGroupSearch)}
                      >
                        {showGroupSearch ? 'Cancel' : 'Add groups'}
                      </Button>

                      <Button
                        ref={addUserRef}
                        variant="subtle"
                        leftSection={<IconSearch size={14} />}
                        onClick={() => onToggleUserSearch(!showUserSearch)}
                      >
                        {showUserSearch ? 'Cancel' : 'Add user'}
                      </Button>

                      {!(directTarget?.allowedUsers ?? []).includes('anonymous') && (
                        <Tooltip label="Allow unauthenticated/public access">
                          <Button
                            variant="subtle"
                            color="orange"
                            leftSection={<IconUserOff size={14} />}
                            onClick={() => onAddUser(node.path, level, 'anonymous')}
                          >
                            Add anonymous
                          </Button>
                        </Tooltip>
                      )}
                    </Group>

                    {showGroupSearch && isSelected && activeLevel === level && (
                      <GroupSelector
                        searchQuery={groupSearchQuery}
                        onSearchChange={onSearchGroups}
                        filteredGroups={filteredGroups}
                        onSelectGroup={(groupId) => onAddGroup(node.path, level, groupId)}
                      />
                    )}

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
