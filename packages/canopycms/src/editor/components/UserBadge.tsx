import { useState } from 'react'
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
import { personName } from '../../auth/person-name'

export interface UserBadgeProps {
  userId: CanopyUserId

  getUserMetadata: (userId: string) => Promise<UserSearchResult | null>

  variant?: 'avatar-only' | 'avatar-name' | 'full'

  /** Show email tooltip on hover (default: true) */
  showEmailTooltip?: boolean

  onRemove?: (userId: CanopyUserId) => void

  /** Color theme (for Badge wrapper) */
  color?: string

  /** Size (affects avatar and text size) */
  size?: 'xs' | 'sm' | 'md' | 'lg'

  /** Badge variant (when using Badge wrapper) */
  badgeVariant?: 'filled' | 'light' | 'outline'

  /** Always show Badge wrapper (even without onRemove) */
  showBadge?: boolean

  loading?: boolean

  /** Cached user data to avoid fetching (e.g., from search results) */
  cachedUser?: UserSearchResult

  /** Admin-only surfaces: a person with no name to show has their id in the tooltip, remove label and hidden text. */
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
  // The badge's tooltip stays shut while the pointer or focus is on the X and its own tooltip.
  const [onRemoveButton, setOnRemoveButton] = useState(false)

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
                onMouseEnter={() => setOnRemoveButton(true)}
                onMouseLeave={() => setOnRemoveButton(false)}
                onFocus={() => setOnRemoveButton(true)}
                onBlur={() => setOnRemoveButton(false)}
                aria-label={`Remove ${personLabel}`}
                style={{ color: nameColor ?? 'var(--mantine-color-white)' }}
              >
                <IconX size={12} stroke={2.5} />
              </ActionIcon>
            </Tooltip>
          ) : undefined
        }
        styles={{
          label: {
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
      <Tooltip label={tooltip} disabled={!tooltip || onRemoveButton}>
        {wrapped}
      </Tooltip>
    ) : (
      wrapped
    )
  }

  const record = error ? null : userMetadata
  const displayName = record ? personName(userId, record.name) : undefined

  if (!record || displayName === undefined) {
    // The id shows only where `revealIdOnFallback` is set (admin surfaces); the People rule treats
    // an id as an internal name. A record with no usable name still offers its avatar and email.
    const unavailable = error ? "Couldn't load this name" : 'Name unavailable'
    const described = revealIdOnFallback ? `${unavailable} · ${userId}` : unavailable
    const emailDetail = showEmailTooltip && variant !== 'full' ? (record?.email ?? '') : ''
    const describedWithEmail = emailDetail ? `${described}, ${emailDetail}` : described
    // A filled badge keeps its white text; dimmed would not contrast with its fill.
    const fallbackColor = inBadge && badgeVariant === 'filled' ? undefined : 'dimmed'
    const unavailableText = (
      <Text size={textSize} c={fallbackColor} fs="italic">
        {unavailable}
      </Text>
    )
    const hiddenDetail = `${revealIdOnFallback ? ` · ${userId}` : ''}${emailDetail ? `, ${emailDetail}` : ''}`
    return wrap(
      <Group gap={4}>
        <Avatar src={record?.avatarUrl} alt="" size={avatarSize} color="gray" aria-hidden />
        {variant === 'avatar-only' ? (
          <VisuallyHidden component="span">{describedWithEmail}</VisuallyHidden>
        ) : (
          <>
            {variant === 'full' && record?.email ? (
              <div>
                {unavailableText}
                <Text size="xs" c="dimmed">
                  {record.email}
                </Text>
              </div>
            ) : (
              unavailableText
            )}
            {hiddenDetail && <VisuallyHidden component="span">{hiddenDetail}</VisuallyHidden>}
          </>
        )}
      </Group>,
      variant === 'avatar-only'
        ? describedWithEmail
        : [revealIdOnFallback ? described : '', emailDetail].filter(Boolean).join(', '),
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
        <Avatar size={avatarSize} color="orange" aria-hidden>
          <IconUserOff size={avatarSize * 0.6} />
        </Avatar>
      )
    }
    if (isSystemUserId(userId)) {
      return (
        <Avatar size={avatarSize} color="gray" aria-hidden>
          <IconRobot size={avatarSize * 0.6} />
        </Avatar>
      )
    }

    let avatarColor = color || 'blue'
    let avatarStyles: React.CSSProperties = {}

    if (inBadge) {
      if (badgeVariant === 'filled') {
        avatarStyles = {
          backgroundColor: 'var(--mantine-color-body)',
          color: 'var(--mantine-color-text)',
        }
      } else if (badgeVariant === 'light') {
        avatarColor = 'dark'
      }
    }

    return (
      <Avatar
        src={record.avatarUrl}
        // The name is text beside it (hidden when alone), so initials stay out of the tree.
        alt=""
        aria-hidden
        size={avatarSize}
        color={avatarColor}
        style={avatarStyles}
      >
        {!record.avatarUrl && getInitials(displayName)}
      </Avatar>
    )
  }

  // The tooltip's email, read after the name by a screen reader, with no tab stop.
  const detail =
    showEmailTooltip && variant !== 'full' && userId !== 'anonymous' ? record.email : ''
  const detailText = detail ? (
    <VisuallyHidden component="span">{`, ${detail}`}</VisuallyHidden>
  ) : null

  const personLabel = userId === 'anonymous' ? 'Anonymous (Public)' : displayName

  const renderContent = () => {
    const avatar = renderAvatar()

    switch (variant) {
      case 'avatar-only':
        return (
          <Group gap={0}>
            {avatar}
            <VisuallyHidden component="span">{personLabel}</VisuallyHidden>
            {detailText}
          </Group>
        )

      case 'full':
        return (
          <Group gap={4}>
            {avatar}
            <div>
              <Text size={textSize} fw={500}>
                {displayName}
              </Text>
              <Text size="xs" c="dimmed">
                {record.email}
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
              {personLabel}
            </Text>
            {detailText}
          </Group>
        )
    }
  }

  // Alone, the avatar shows no name, so its tooltip gives it before the email.
  const tooltip =
    variant === 'full'
      ? ''
      : variant === 'avatar-only'
        ? [personLabel, detail].filter(Boolean).join(', ')
        : record.email
  return wrap(renderContent(), tooltip, personLabel)
}
