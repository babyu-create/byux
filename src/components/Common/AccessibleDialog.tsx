import {
  useEffect,
  useRef,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface AccessibleDialogProps {
  children: ReactNode;
  backdropClassName: string;
  dialogClassName: string;
  titleId: string;
  descriptionId?: string;
  onClose: () => void;
  /** Disable Escape/backdrop dismissal for non-interruptible work such as export. */
  dismissible?: boolean;
}

const FOCUSABLE =
  '[data-dialog-initial-focus], [autofocus], button:not([disabled]), ' +
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Portal-backed modal shared by every top-level dialog.
 *
 * Keeping the modal outside #root lets us make the editor inert while it is
 * open. Focus is moved inside, trapped with Tab, restored on close, and Escape
 * consistently dismisses dialogs that are safe to close.
 */
export function AccessibleDialog({
  children,
  backdropClassName,
  dialogClassName,
  titleId,
  descriptionId,
  onClose,
  dismissible = true,
}: AccessibleDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  }, [dismissible, onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById('root');
    const rootWasInert = appRoot?.hasAttribute('inert') ?? false;
    const previousAriaHidden = appRoot?.getAttribute('aria-hidden') ?? null;

    if (appRoot) {
      appRoot.setAttribute('inert', '');
      appRoot.setAttribute('aria-hidden', 'true');
    }

    const focusable = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => !element.hidden && element.getClientRects().length > 0,
      );

    const preferred = dialog.querySelector<HTMLElement>(
      '[data-dialog-initial-focus], [autofocus]',
    );
    const initial =
      preferred && !preferred.hidden && preferred.getClientRects().length > 0
        ? preferred
        : (focusable()[0] ?? dialog);
    initial.focus({ preventScroll: true });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissibleRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (appRoot) {
        if (!rootWasInert) appRoot.removeAttribute('inert');
        if (previousAriaHidden === null) appRoot.removeAttribute('aria-hidden');
        else appRoot.setAttribute('aria-hidden', previousAriaHidden);
      }
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (dismissible && event.button === 0 && event.target === event.currentTarget) onClose();
  };

  return createPortal(
    <div className={backdropClassName} onMouseDown={handleBackdropMouseDown}>
      <div
        ref={dialogRef}
        className={dialogClassName}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
