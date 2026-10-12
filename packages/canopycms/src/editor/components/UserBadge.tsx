import {
  Avatar,
  Badge,
  Tooltip,
  Group,
  Text,
  Skeleton,
  ActionIcon,
  VisuallyHidden,
} from '@mantine/core'
import { IconRobot, IconUserOff, IconX } from '@tabler/icons-react'
import type { UserSearchResult } from '../../auth/types'
import type { CanopyUserId } from '../../types'
import { useUserMetadata } from '../hooks/useUserMetadata'
import { isSystemUserId } from '../../system-users'

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

  /** Admin-only surfaces: an unresolved person's id joins the tooltip, remove label and hidden text. */
  revealIdOnFallback?: boolean
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
  revealIdOnFallback = false,
}) => {
  const { userMetadata, isLoading, error } = useUserMetadata(userId, getUserMetadata, cachedUser)

  const loading = loadingOverride ?? isLoading

  const avatarSize = {
    xs: 16,
    sm: 20,
    md: 24,
    lg: 32,
  }[size]

  const textSize = {
    xs: 'xs',
    sm: 'sm',
    md: 'sm',
    lg: 'md',
  }[size] as 'xs' | 'sm' | 'md'

  if (loading) {
    return (
      <Group gap={4}>
        <Skeleton circle height={avatarSize} width={avatarSize} />
        {variant !== 'avatar-only' && <Skeleton height={12} width={60} />}
      </Group>
    )
  }

  const inBadge = !!onRemove || showBadge
  // A light or outline badge tints its label with the badge colour, too faint for a name.
  const nameColor = inBadge && badgeVariant !== 'filled' ? 'var(--mantine-color-text)' : undefined

  const wrap = (content: React.ReactNode, tooltip: string, personLabel: string) => {
    const wrapped = inBadge ? (
      <Badge
        variant={badgeVariant}
        color={color}
        pr={onRemove ? 3 : 8}
        pl={4}
        rightSection={
          onRemove ? (
            <Tooltip label={`Remove ${personLabel}`} position="bottom">
              <ActionIcon
                size="xs"
                radius="xl"
                variant="transparent"
                onClick={() => onRemove(userId)}
                aria-label={`Remove ${personLabel}`}
                style={{ color: 'var(--mantine-color-white)' }}
              >
                <IconX size={12} stroke={2.5} />
              </ActionIcon>
            </Tooltip>
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
    ) : (
      content
    )
    return showEmailTooltip ? (
      <Tooltip label={tooltip} disabled={!tooltip}>
        {wrapped}
      </Tooltip>
    ) : (
      wrapped
    )
  }

  if (error || !userMetadata) {
    // The id only on an admin surface (`revealIdOnFallback`): it is an internal name.
    const unavailable = error ? "Couldn't load this name" : 'Name unavailable'
    const described = revealIdOnFallback ? `${unavailable} · ${userId}` : unavailable
    // A filled badge keeps its white text; dimmed would not contrast with its fill.
    const fallbackColor = inBadge && badgeVariant === 'filled' ? undefined : 'dimmed'
    return wrap(
      <Group gap={4}>
        <Avatar
          size={avatarSize}
          color="gray"
          aria-hidden={variant !== 'avatar-only' || undefined}
        />
        {variant === 'avatar-only' ? (
          <VisuallyHidden component="span">{described}</VisuallyHidden>
        ) : (
          <>
            <Text size={textSize} c={fallbackColor} fs="italic">
              {unavailable}
            </Text>
            {revealIdOnFallback && (
              <VisuallyHidden component="span">{` · ${userId}`}</VisuallyHidden>
            )}
          </>
        )}
      </Group>,
      variant === 'avatar-only' || revealIdOnFallback ? described : '',
      described,
    )
  }

  const getInitials = (name: string): string => {
    const parts = name.trim().split(/\s+/)
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
  }

  const renderAvatar = () => {
    if (userId === 'anonymous') {
      return (
        <Avatar size={avatarSize} color="orange">
          <IconUserOff size={avatarSize * 0.6} />
        </Avatar>
      )
    }
    if (isSystemUserId(userId)) {
      return (
        <Avatar size={avatarSize} color="gray">
          <IconRobot size={avatarSize * 0.6} />
        </Avatar>
      )
    }

    let avatarColor = color || 'blue'
    let avatarStyles: React.CSSProperties = {}

    if (inBadge) {
      if (badgeVariant === 'filled') {
        // Filled badges: white background with dark text for maximum contrast
        avatarStyles = {
          backgroundColor: 'var(--mantine-color-white)',
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
        // Beside the name it repeats it, so it is hidden from screen readers.
        alt={variant === 'avatar-only' ? userMetadata.name : ''}
        aria-hidden={variant !== 'avatar-only' || undefined}
        size={avatarSize}
        color={avatarColor}
        style={avatarStyles}
      >
        {!userMetadata.avatarUrl && getInitials(userMetadata.name)}
      </Avatar>
    )
  }

  // The tooltip's email, read after the name by a screen reader, with no tab stop.
  const detail =
    showEmailTooltip && variant !== 'full' && userId !== 'anonymous' ? userMetadata.email : ''
  const detailText = detail ? (
    <VisuallyHidden component="span">{`, ${detail}`}</VisuallyHidden>
  ) : null

  const renderContent = () => {
    const avatar = renderAvatar()

    switch (variant) {
      case 'avatar-only':
        return detailText ? (
          <Group gap={0}>
            {avatar}
            {detailText}
          </Group>
        ) : (
          avatar
        )

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
            <Text size={textSize} fw={500} c={nameColor}>
              {userId === 'anonymous' ? 'Anonymous (Public)' : userMetadata.name}
            </Text>
            {detailText}
          </Group>
        )
    }
  }

  return wrap(
    renderContent(),
    variant === 'full' ? '' : userMetadata.email,
    userId === 'anonymous' ? 'Anonymous (Public)' : userMetadata.name,
  )
}
