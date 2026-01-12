import { Avatar, Badge, Tooltip, Group, Text, Skeleton, ActionIcon } from '@mantine/core'
import { IconUserOff, IconX } from '@tabler/icons-react'
import type { UserSearchResult } from '../../auth/types'
import type { CanopyUserId } from '../../types'
import { useUserMetadata } from '../hooks/useUserMetadata'

export interface UserBadgeProps {
  /** User ID to display */
  userId: CanopyUserId

  /** Function to fetch user metadata by ID */
  getUserMetadata: (userId: string) => Promise<UserSearchResult | null>

  /** Display mode */
  variant?: 'avatar-only' | 'avatar-name' | 'full'

  /** Show email tooltip on hover (default: true) */
  showEmailTooltip?: boolean

  /** Optional removal button */
  onRemove?: (userId: CanopyUserId) => void

  /** Color theme (for Badge wrapper) */
  color?: string

  /** Size (affects avatar and text size) */
  size?: 'xs' | 'sm' | 'md' | 'lg'

  /** Badge variant (when using Badge wrapper) */
  badgeVariant?: 'filled' | 'light' | 'outline'

  /** Always show Badge wrapper (even without onRemove) */
  showBadge?: boolean

  /** Loading state override */
  loading?: boolean

  /** Cached user data to avoid fetching (e.g., from search results) */
  cachedUser?: UserSearchResult
}

export const UserBadge: React.FC<UserBadgeProps> = ({
  userId,
  getUserMetadata,
  variant = 'avatar-name',
  showEmailTooltip = true,
  onRemove,
  color,
  size = 'sm',
  badgeVariant = 'filled',
  showBadge = false,
  loading: loadingOverride,
  cachedUser,
}) => {
  const { userMetadata, isLoading, error } = useUserMetadata(userId, getUserMetadata, cachedUser)

  const loading = loadingOverride ?? isLoading

  // Avatar size mapping
  const avatarSize = {
    xs: 16,
    sm: 20,
    md: 24,
    lg: 32,
  }[size]

  // Text size mapping
  const textSize = {
    xs: 'xs',
    sm: 'sm',
    md: 'sm',
    lg: 'md',
  }[size] as 'xs' | 'sm' | 'md'

  // Loading state
  if (loading) {
    return (
      <Group gap={4}>
        <Skeleton circle height={avatarSize} width={avatarSize} />
        {variant !== 'avatar-only' && <Skeleton height={12} width={60} />}
      </Group>
    )
  }

  // Error or missing user - fallback to userId
  if (error || !userMetadata) {
    const content = (
      <Group gap={4}>
        <Avatar size={avatarSize} color="gray" />
        {variant !== 'avatar-only' && (
          <Text size={textSize} c="dimmed">
            {userId}
          </Text>
        )}
      </Group>
    )

    return showEmailTooltip ? (
      <Tooltip label={error ? 'Error loading user' : 'User not found'}>{content}</Tooltip>
    ) : (
      content
    )
  }

  // Generate initials from name
  const getInitials = (name: string): string => {
    const parts = name.trim().split(/\s+/)
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
  }

  // Render avatar
  const renderAvatar = () => {
    // Special case: anonymous user
    if (userId === 'anonymous') {
      return (
        <Avatar size={avatarSize} color="orange">
          <IconUserOff size={avatarSize * 0.6} />
        </Avatar>
      )
    }

    // When inside Badge wrapper with filled/light variant, use white background for visibility
    // For outline badges or no badge, use the passed color
    let avatarColor = color || 'blue'
    let avatarStyles: React.CSSProperties = {}

    if (onRemove || showBadge) {
      if (badgeVariant === 'filled') {
        // Filled badges: white background with dark text for maximum contrast
        avatarStyles = {
          backgroundColor: 'white',
          color: 'var(--mantine-color-dark-6)',
        }
      } else if (badgeVariant === 'light') {
        // Light badges: use dark avatar for contrast
        avatarColor = 'dark'
      }
      // outline badges: keep the passed color
    }

    return (
      <Avatar
        src={userMetadata.avatarUrl}
        size={avatarSize}
        color={avatarColor}
        style={avatarStyles}
      >
        {!userMetadata.avatarUrl && getInitials(userMetadata.name)}
      </Avatar>
    )
  }

  // Render content based on variant
  const renderContent = () => {
    const avatar = renderAvatar()

    switch (variant) {
      case 'avatar-only':
        return avatar

      case 'full':
        return (
          <Group gap={4}>
            {avatar}
            <div>
              <Text size={textSize} fw={500}>
                {userMetadata.name}
              </Text>
              <Text size="xs" c="dimmed">
                {userMetadata.email}
              </Text>
            </div>
          </Group>
        )

      case 'avatar-name':
      default:
        return (
          <Group gap={4}>
            {avatar}
            <Text size={textSize} fw={500}>
              {userId === 'anonymous' ? 'Anonymous (Public)' : userMetadata.name}
            </Text>
          </Group>
        )
    }
  }

  const content = renderContent()

  // If onRemove or showBadge, wrap the content in a Badge
  if (onRemove || showBadge) {
    const badgeContent = (
      <Badge
        variant={badgeVariant}
        color={color}
        pr={onRemove ? 3 : 8}
        pl={4}
        rightSection={
          onRemove ? (
            <ActionIcon
              size="xs"
              radius="xl"
              variant="transparent"
              onClick={() => onRemove(userId)}
              aria-label="Remove user"
              style={{ color: 'white' }}
            >
              <IconX size={12} stroke={2.5} />
            </ActionIcon>
          ) : undefined
        }
        styles={{
          label: {
            textTransform: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          },
        }}
      >
        {content}
      </Badge>
    )

    return showEmailTooltip && variant !== 'full' ? (
      <Tooltip label={userMetadata.email}>{badgeContent}</Tooltip>
    ) : (
      badgeContent
    )
  }

  // No badge wrapper - just wrap with tooltip if needed
  return showEmailTooltip && variant !== 'full' ? (
    <Tooltip label={userMetadata.email}>{content}</Tooltip>
  ) : (
    content
  )
}
