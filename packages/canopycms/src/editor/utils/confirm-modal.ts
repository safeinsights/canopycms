import { modals } from '@mantine/modals'

type ConfirmModalProps = Parameters<typeof modals.openConfirmModal>[0]

/**
 * `modals.openConfirmModal` with `sm` actions: its own Buttons would otherwise take the theme's
 * compact `xs` default. A `size` the caller sets replaces it. The close button is named "Close",
 * since an icon-only button has no other accessible name; a caller's `aria-label` replaces it.
 */
export function openConfirm(props: ConfirmModalProps): string {
  return modals.openConfirmModal({
    ...props,
    confirmProps: Object.assign({ size: 'sm' }, props.confirmProps),
    cancelProps: Object.assign({ size: 'sm' }, props.cancelProps),
    closeButtonProps: Object.assign({ 'aria-label': 'Close' }, props.closeButtonProps),
  })
}
