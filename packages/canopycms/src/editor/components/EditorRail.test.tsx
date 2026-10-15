import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, cleanup, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Menu } from '@mantine/core'
import { EditorRail, SettingsMenu, type EditorRailProps } from './EditorRail'
import { CanopyCMSProvider } from '../theme'
import { CANOPYCMS_VERSION } from '../../version'

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CanopyCMSProvider>{children}</CanopyCMSProvider>
)

const defaultProps = (): EditorRailProps => ({
  siteTitle: 'example site',
  onHomeOpen: vi.fn(),
  contentPanelOpen: false,
  contentPanelId: 'content-panel',
  onContentToggle: vi.fn(),
  onQuickOpen: vi.fn(),
  quickOpenShortcut: '⌘P',
  branchesOpen: false,
  onBranchesOpen: vi.fn(),
  onCommentsOpen: vi.fn(),
  commentsOpen: false,
  unresolvedCommentCount: 0,
  mediaLibraryOpen: false,
  onMediaLibraryOpen: vi.fn(),
  onPermissionManagerOpen: vi.fn(),
  onGroupManagerOpen: vi.fn(),
  onSystemHealthOpen: vi.fn(),
  onLogoutClick: vi.fn(),
})

const renderRail = (props: Partial<EditorRailProps> = {}) => {
  const all = { ...defaultProps(), ...props }
  render(<EditorRail {...all} />, { wrapper: Wrapper })
  return all
}

const toolbarButtons = () =>
  Array.from(screen.getByRole('toolbar').querySelectorAll<HTMLElement>('[data-rail-item]'))

afterEach(() => {
  cleanup()
})

describe('EditorRail - buttons', () => {
  it('names every activity, from the monogram down, and calls its action', async () => {
    const props = renderRail()

    expect(toolbarButtons().map((button) => button.getAttribute('aria-label'))).toEqual([
      'example site',
      'Content',
      'Search entries (⌘P)',
      'Branches',
      'Comments',
      'Media library',
      'Settings',
    ])
    expect(screen.getByTestId('rail-home-button').textContent).toBe('E')

    await userEvent.click(screen.getByTestId('rail-home-button'))
    await userEvent.click(screen.getByTestId('content-panel-toggle'))
    await userEvent.click(screen.getByTestId('rail-search-button'))
    await userEvent.click(screen.getByTestId('rail-branches-button'))
    await userEvent.click(screen.getByTestId('comments-button'))
    await userEvent.click(screen.getByTestId('media-library-button'))
    for (const action of [
      props.onHomeOpen,
      props.onContentToggle,
      props.onQuickOpen,
      props.onBranchesOpen,
      props.onCommentsOpen,
      props.onMediaLibraryOpen,
    ]) {
      expect(action).toHaveBeenCalledTimes(1)
    }
  })

  it('says whether the content panel is open, and which element it is', () => {
    renderRail({ contentPanelOpen: true })
    const toggle = screen.getByTestId('content-panel-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-controls')).toBe('content-panel')

    cleanup()
    renderRail({ contentPanelOpen: false })
    expect(screen.getByTestId('content-panel-toggle').getAttribute('aria-expanded')).toBe('false')
  })

  it('offers no Comments button without a way to open comments', () => {
    renderRail({ onCommentsOpen: undefined })
    expect(screen.queryByTestId('comments-button')).toBeNull()
  })

  it('shows the tooltip of a rail button on keyboard focus', async () => {
    renderRail()
    act(() => screen.getByTestId('rail-branches-button').focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe('Branches')
  })
})

describe('EditorRail - keyboard', () => {
  it('is one Tab stop, moved by the arrow keys, Home and End, then the account controls', async () => {
    renderRail()
    const buttons = toolbarButtons()
    expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([buttons[0]])

    await userEvent.tab()
    expect(document.activeElement).toBe(buttons[0])
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(buttons[1])
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(document.activeElement).toBe(buttons[buttons.length - 1])
    await userEvent.keyboard('{Home}')
    expect(document.activeElement).toBe(buttons[0])
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe(buttons[buttons.length - 1])

    // The last button focused keeps the Tab stop.
    expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([buttons[buttons.length - 1]])
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sign out' }))
  })

  it('moves the Tab stop to the first button when the one holding it goes', () => {
    const props = defaultProps()
    const { rerender } = render(<EditorRail {...props} />, { wrapper: Wrapper })
    act(() => screen.getByTestId('comments-button').focus())
    expect(screen.getByTestId('comments-button').tabIndex).toBe(0)

    rerender(<EditorRail {...props} onCommentsOpen={undefined} />)
    expect(toolbarButtons().filter((button) => button.tabIndex === 0)).toEqual([
      screen.getByTestId('rail-home-button'),
    ])
  })
})

describe('EditorRail - comments count', () => {
  it('shows the unresolved count and names it on the button', () => {
    renderRail({ unresolvedCommentCount: 2 })
    expect(screen.getByTestId('comments-unresolved-count').textContent).toBe('2')
    expect(screen.getByRole('button', { name: 'Comments, 2 unresolved' })).toBeDefined()
    const count = screen.getByTestId('comments-unresolved-count').parentElement as HTMLElement
    expect(getComputedStyle(count).pointerEvents).toBe('none')
    expect(count.style.getPropertyValue('--indicator-color')).toBe('var(--canopy-count-bg)')
    expect(count.style.getPropertyValue('--indicator-text-color')).toBe('var(--mantine-color-text)')
  })

  it('shows no count at zero', () => {
    renderRail({ unresolvedCommentCount: 0 })
    expect(screen.queryByTestId('comments-unresolved-count')).toBeNull()
    expect(screen.getByRole('button', { name: 'Comments' })).toBeDefined()
  })
})

describe('EditorRail - Settings menu', () => {
  it('offers the admin items given, and no Media library: Media has its own button', async () => {
    renderRail()
    await userEvent.click(screen.getByTestId('settings-button'))
    await screen.findByText('Manage permissions')
    expect(screen.getByText('Manage groups')).toBeDefined()
    expect(screen.getByText('System health')).toBeDefined()
    expect(screen.queryByText('Media library')).toBeNull()
  })

  it('offers an editor only the version and About', async () => {
    renderRail({
      onPermissionManagerOpen: undefined,
      onGroupManagerOpen: undefined,
      onSystemHealthOpen: undefined,
    })
    await userEvent.click(screen.getByTestId('settings-button'))
    await screen.findByTestId('settings-menu-about')
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'About CanopyCMS (opens in a new tab)',
    ])
  })

  it('labels its menu by the Settings button', async () => {
    renderRail()
    const settings = screen.getByTestId('settings-button')
    await userEvent.click(settings)
    const menu = await screen.findByTestId('settings-menu')
    expect(settings.id).not.toBe('')
    expect(menu.getAttribute('aria-labelledby')).toBe(settings.id)
  })

  it('calls the item it offers', async () => {
    const props = renderRail()
    await userEvent.click(screen.getByTestId('settings-button'))
    await userEvent.click(await screen.findByText('System health'))
    expect(props.onSystemHealthOpen).toHaveBeenCalledTimes(1)
  })

  it('returns focus to the Settings button after an item acts and nothing takes focus', async () => {
    const props = renderRail()
    const settings = screen.getByTestId('settings-button')

    act(() => settings.focus())
    await userEvent.keyboard('{Enter}')
    const item = await screen.findByRole('menuitem', { name: 'Manage groups' })
    for (let i = 0; i < 6 && document.activeElement !== item; i++) {
      await userEvent.keyboard('{ArrowDown}')
    }
    await userEvent.keyboard('{Enter}')

    expect(props.onGroupManagerOpen).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(settings))
  })

  it('leaves the arrow keys to its open menu', async () => {
    renderRail()
    await userEvent.click(screen.getByTestId('settings-button'))
    await screen.findByRole('menuitem', { name: 'Manage permissions' })
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement?.closest('[data-testid="settings-menu"]')).not.toBeNull()
  })

  it('hides the Settings tooltip while its menu is open', async () => {
    renderRail()
    const settings = screen.getByTestId('settings-button')

    await userEvent.hover(settings)
    await screen.findByRole('tooltip')
    await userEvent.click(settings)

    await screen.findByText('Manage groups')
    // It fades out, so read its opacity rather than its presence.
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')
    expect(tooltip?.style.opacity ?? '0').toBe('0')
  })

  it('shows the version and links About to the project in a new tab, saying so', async () => {
    renderRail()
    await userEvent.click(screen.getByTestId('settings-button'))

    expect((await screen.findByTestId('settings-menu-version')).textContent).toBe(
      `CanopyCMS ${CANOPYCMS_VERSION}`,
    )
    const about = screen.getByRole('menuitem', { name: 'About CanopyCMS (opens in a new tab)' })
    expect(about.getAttribute('href')).toBe('https://github.com/safeinsights/canopycms')
    expect(about.getAttribute('target')).toBe('_blank')
    expect(about.getAttribute('rel')).toBe('noopener noreferrer')
  })
})

describe('SettingsMenu', () => {
  it('offers no Settings button when it has no items', () => {
    render(<SettingsMenu items={[]} />, { wrapper: Wrapper })
    expect(screen.queryByTestId('settings-button')).toBeNull()
  })

  it('offers the button when it has an item', () => {
    render(<SettingsMenu items={[<Menu.Item key="one">One</Menu.Item>]} />, { wrapper: Wrapper })
    expect(screen.getByTestId('settings-button')).toBeDefined()
  })
})

describe('EditorRail - account', () => {
  it("renders the adopter's account component in place of the default buttons", () => {
    renderRail({ AccountComponent: () => <button>Adopter account</button> })
    expect(screen.getByRole('button', { name: 'Adopter account' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
  })
})
