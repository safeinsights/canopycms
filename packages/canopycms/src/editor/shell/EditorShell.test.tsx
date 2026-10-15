import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { createPortal } from 'react-dom'
import { Modal } from '@mantine/core'
import { afterEach, describe, expect, it } from 'vitest'

import { EditorShell } from './EditorShell'
import { CanopyCMSProvider } from '../theme'

const foreignRoots: HTMLElement[] = []

/** A root another library creates with the DOM API, as MDXEditor does for its popups. */
const addForeignRoot = (): HTMLElement => {
  const root = document.createElement('div')
  root.innerHTML = '<button>Foreign popup</button>'
  document.body.appendChild(root)
  foreignRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of foreignRoots.splice(0)) root.remove()
})

const Shell = ({ overlays }: { overlays?: React.ReactNode }) => (
  <CanopyCMSProvider>
    <EditorShell
      topBar={<button>Top bar</button>}
      banner={<div>Banner</div>}
      main={<button>Main</button>}
      rail={<button>Rail</button>}
      overlays={overlays}
    />
  </CanopyCMSProvider>
)

/** A Next.js root layout: header and footer straight in `<body>`, the page in between. */
const AppRouterHost = ({ children }: { children: React.ReactNode }) => (
  <>
    {createPortal(<header data-testid="host-header">Site header</header>, document.body)}
    <main data-testid="host-main">{children}</main>
    {createPortal(<footer data-testid="host-footer">Site footer</footer>, document.body)}
  </>
)

const shell = () => document.querySelector('[data-canopy-shell]') as HTMLElement

describe('EditorShell', () => {
  it('renders every region into a portal in <body>, leaving only an anchor in place', async () => {
    const { container } = render(<Shell />)

    await waitFor(() => expect(shell()).not.toBeNull())
    expect(shell().parentElement?.parentElement).toBe(document.body)
    for (const area of ['topbar', 'banner', 'panel', 'main', 'rail', 'overlays']) {
      expect(shell().querySelector(`[data-canopy-region="${area}"]`)).not.toBeNull()
    }
    expect(container.contains(shell())).toBe(false)
    expect(container.querySelector('[data-canopy-shell-anchor]')).not.toBeNull()
  })

  it('hides the host root and makes it inert, but not portals or roots other libraries made', async () => {
    const foreign = addForeignRoot()
    const { container, unmount } = render(<Shell />)
    await waitFor(() => expect(shell()).not.toBeNull())

    expect(container.hasAttribute('inert')).toBe(true)
    expect(container.style.visibility).toBe('hidden')
    expect(shell().closest('[inert]')).toBeNull()
    expect(foreign.hasAttribute('inert')).toBe(false)
    for (const portal of document.querySelectorAll('[data-portal]')) {
      expect(portal.hasAttribute('inert')).toBe(false)
    }

    unmount()
    expect(container.hasAttribute('inert')).toBe(false)
    expect(container.style.visibility).toBe('')
  })

  it('also hides the chrome a root layout renders straight into <body>', async () => {
    const foreign = addForeignRoot()
    const { unmount } = render(
      <AppRouterHost>
        <Shell />
      </AppRouterHost>,
    )
    await waitFor(() => expect(shell()).not.toBeNull())

    expect(screen.getByTestId('host-header').hasAttribute('inert')).toBe(true)
    expect(screen.getByTestId('host-header').style.visibility).toBe('hidden')
    expect(screen.getByTestId('host-footer').hasAttribute('inert')).toBe(true)
    expect(screen.getByTestId('host-main').closest('[inert]')).not.toBeNull()
    expect(foreign.hasAttribute('inert')).toBe(false)
    expect(shell().closest('[inert]')).toBeNull()

    unmount()
    expect(document.querySelector('[inert]')).toBeNull()
  })

  it('restores what the host had set itself on unmount', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    host.setAttribute('inert', '')
    host.style.visibility = 'collapse'

    const { unmount } = render(<Shell />, { container: host })
    await waitFor(() => expect(shell()).not.toBeNull())
    unmount()
    expect(host.hasAttribute('inert')).toBe(true)
    expect(host.style.visibility).toBe('collapse')
    host.remove()
  })

  it('locks the page scroll while mounted', async () => {
    const { unmount } = render(<Shell />)
    await waitFor(() => expect(document.body.hasAttribute('data-scroll-locked')).toBe(true))
    unmount()
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false)
  })

  it('keeps a modal opened from the shell focusable', async () => {
    render(
      <Shell
        overlays={
          <Modal opened onClose={() => {}} title="Dialog">
            <button>Inside the dialog</button>
          </Modal>
        }
      />,
    )

    const inside = await screen.findByRole('button', { name: 'Inside the dialog' })
    expect(inside.closest('[inert]')).toBeNull()
    inside.focus()
    expect(document.activeElement).toBe(inside)
  })

  it('keeps the host hidden until the last of two shells unmounts', async () => {
    const Two = ({ first }: { first: boolean }) => (
      <>
        {first && <Shell />}
        <Shell />
      </>
    )
    const { container, rerender, unmount } = render(<Two first />)
    await waitFor(() => expect(document.querySelectorAll('[data-canopy-shell]')).toHaveLength(2))

    rerender(<Two first={false} />)
    expect(document.querySelectorAll('[data-canopy-shell]')).toHaveLength(1)
    expect(container.hasAttribute('inert')).toBe(true)
    expect(container.style.visibility).toBe('hidden')

    unmount()
    expect(container.hasAttribute('inert')).toBe(false)
    expect(container.style.visibility).toBe('')
  })

  it('leaves out the landmarks of regions given no content', async () => {
    render(
      <CanopyCMSProvider>
        <EditorShell main={<p>Main</p>} />
      </CanopyCMSProvider>,
    )
    await waitFor(() => expect(shell()).not.toBeNull())
    expect(shell().querySelector('header')).toBeNull()
    expect(shell().querySelector('aside')).toBeNull()
    expect(screen.getByRole('main').textContent).toBe('Main')
  })
})
