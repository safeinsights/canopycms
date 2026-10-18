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
  contentPanelOpen: false,
  contentPanelId: 'content-panel',
  onContentToggle: vi.fn(),
  onQuickOpen: vi.fn(),
  quickOpenShortcut: '⌘P',
  quickOpenKeys: 'Meta+P',
  branchesOpen: false,
  onBranchesOpen: vi.fn(),
  onCommentsOpen: vi.fn(),
  commentsOpen: false,
  unresolvedCommentCount: 0,
  mediaLibraryOpen: false,
  onMediaLibraryOpen: vi.fn(),
  layout: 'side',
  onLayoutChange: vi.fn(),
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
  it('names every activity, from Content down, and calls its action', async () => {
    const props = renderRail()

    expect(toolbarButtons().map((button) => button.getAttribute('aria-label'))).toEqual([
      'Content',
      'Open entry',
      'Branches',
      'Comments',
      'Media library',
      'Switch to stacked layout (now side by side)',
      'Settings',
    ])
    await userEvent.click(screen.getByTestId('content-panel-toggle'))
    await userEvent.click(screen.getByTestId('rail-search-button'))
    await userEvent.click(screen.getByTestId('rail-branches-button'))
    await userEvent.click(screen.getByTestId('comments-button'))
    await userEvent.click(screen.getByTestId('media-library-button'))
    for (const action of [
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

  it('shows a shortcut in the tooltip and in aria-keyshortcuts, not in the name', async () => {
    renderRail()
    const search = screen.getByTestId('rail-search-button')
    expect(search.getAttribute('aria-keyshortcuts')).toBe('Meta+P')
    act(() => search.focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe('Open entry (⌘P)')
  })

  it('fills the button of an open panel, so its state is not a tint alone', () => {
    renderRail({ contentPanelOpen: true })
    const toggle = screen.getByTestId('content-panel-toggle')
    expect(toggle.getAttribute('data-variant')).toBe('filled')
    // The theme's measured fill for white on the primary colour, not Mantine's.
    expect(toggle.style.getPropertyValue('--ai-bg')).toBe('var(--canopy-primary-fill)')
    expect(screen.getByTestId('rail-branches-button').getAttribute('data-variant')).toBe('subtle')
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

  it('scrolls only a rail too short for its buttons, so a full-height rail clips nothing', () => {
    const props = defaultProps()
    const { rerender } = render(<EditorRail {...props} />, { wrapper: Wrapper })
    const toolbar = screen.getByRole('toolbar')
    const contentHeight = (height: number) =>
      Object.defineProperty(toolbar, 'scrollHeight', { value: height, configurable: true })
    Object.defineProperty(toolbar, 'clientHeight', { value: 300, configurable: true })
    expect(toolbar.style.overflowY).toBe('')

    contentHeight(340)
    rerender(<EditorRail {...props} unresolvedCommentCount={1} />)
    expect(toolbar.style.overflowY).toBe('auto')
    expect(toolbar.style.overflowX).toBe('hidden')

    contentHeight(300)
    rerender(<EditorRail {...props} unresolvedCommentCount={2} />)
    expect(toolbar.style.overflowY).toBe('')
  })

  it('moves the Tab stop to the first button when the one holding it goes', () => {
    const props = defaultProps()
    const { rerender } = render(<EditorRail {...props} />, { wrapper: Wrapper })
    act(() => screen.getByTestId('comments-button').focus())
    expect(screen.getByTestId('comments-button').tabIndex).toBe(0)

    rerender(<EditorRail {...props} onCommentsOpen={undefined} />)
    expect(toolbarButtons().filter((button) => button.tabIndex === 0)).toEqual([
      screen.getByTestId('content-panel-toggle'),
    ])
  })
})

describe('EditorRail - layout', () => {
  const layoutButton = () => screen.getByTestId('rail-layout-button')
  const icon = () => layoutButton().querySelector('svg')?.getAttribute('class')
  const status = () => screen.getByTestId('rail-layout-status')

  it('names and shows the current layout, and switches to the other', async () => {
    const props = defaultProps()
    const { rerender } = render(<EditorRail {...props} />, { wrapper: Wrapper })
    expect(layoutButton().getAttribute('aria-label')).toBe(
      'Switch to stacked layout (now side by side)',
    )
    expect(icon()).toContain('tabler-icon-layout-columns')
    expect(status().getAttribute('role')).toBe('status')
    expect(status().textContent).toBe('')
    await userEvent.click(layoutButton())
    expect(props.onLayoutChange).toHaveBeenLastCalledWith('stacked')
    expect(status().textContent).toBe('Stacked layout')

    rerender(<EditorRail {...props} layout="stacked" />)
    expect(layoutButton().getAttribute('aria-label')).toBe(
      'Switch to side by side layout (now stacked)',
    )
    expect(icon()).toContain('tabler-icon-layout-rows')
    await userEvent.click(layoutButton())
    expect(props.onLayoutChange).toHaveBeenLastCalledWith('side')
    expect(status().textContent).toBe('Side by side layout')
  })

  it('sits in the bottom group, just above Settings', () => {
    renderRail()
    expect(toolbarButtons().slice(-2)).toEqual([
      layoutButton(),
      screen.getByTestId('settings-button'),
    ])
  })

  it('says why it is blocked while the preview is maximized, stays focusable and does nothing', async () => {
    const props = renderRail({ layoutBlocked: true })
    const button = layoutButton()
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.getAttribute('aria-label')).toBe('Switch to stacked layout (now side by side)')
    const reason = 'Restore the preview to change the layout.'
    expect(
      document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe(reason)

    await userEvent.click(button)
    expect(props.onLayoutChange).not.toHaveBeenCalled()
    expect(status().textContent).toBe('')

    act(() => screen.getByTestId('settings-button').focus())
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(button)
    expect((await screen.findByRole('tooltip')).textContent).toBe(reason)
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
