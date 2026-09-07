import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

const CONTROL_SELECTOR =
  "input,button,select,textarea,a[href],summary,[tabindex]";

function controls(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)].filter(
    (element) => {
      if (
        element.tabIndex < 0 ||
        element.matches(":disabled") ||
        element.closest("[hidden],[inert]")
      )
        return false;
      let parent = element.parentElement;
      while (parent && parent !== dialog) {
        if (
          parent instanceof HTMLDetailsElement &&
          !parent.open &&
          !parent.querySelector("summary")?.contains(element)
        )
          return false;
        parent = parent.parentElement;
      }
      return true;
    },
  );
}

function revealControl(dialog: HTMLElement, control: HTMLElement): void {
  if (control === dialog || dialog.clientHeight === 0) return;
  let ancestor = control.parentElement;
  while (ancestor && ancestor !== dialog) {
    if (ancestor.hasAttribute("data-modal-scroll")) {
      const panel = ancestor.getBoundingClientRect(),
        rect = control.getBoundingClientRect();
      if (rect.top < panel.top + 8)
        ancestor.scrollTop += rect.top - panel.top - 8;
      else if (rect.bottom > panel.bottom - 8)
        ancestor.scrollTop += rect.bottom - panel.bottom + 8;
      if (rect.left < panel.left + 8)
        ancestor.scrollLeft += rect.left - panel.left - 8;
      else if (rect.right > panel.right - 8)
        ancestor.scrollLeft += rect.right - panel.right + 8;
    }
    ancestor = ancestor.parentElement;
  }
  const panel = dialog.getBoundingClientRect();
  const rect = control.getBoundingClientRect();
  const top = panel.top + dialog.clientTop + 8;
  const bottom = panel.top + dialog.clientTop + dialog.clientHeight - 8;
  if (rect.top < top) dialog.scrollTop += rect.top - top;
  else if (rect.bottom > bottom) dialog.scrollTop += rect.bottom - bottom;
}

export function ModalDialog({
  ariaLabel,
  focusSurface,
  children,
  className = "",
  compact = false,
  busy = false,
  initialFocus = "dialog",
  dialogRef,
  onClose,
  onKeyDown,
}: {
  ariaLabel: string;
  focusSurface: string;
  children: ReactNode;
  className?: string;
  compact?: boolean;
  busy?: boolean;
  initialFocus?: "dialog" | "first-control";
  dialogRef?: RefObject<HTMLDivElement | null>;
  onClose?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const root = dialogRef ?? ownRef;

  useLayoutEffect(() => {
    const dialog = root.current;
    if (!dialog) return;
    let lastFocused: HTMLElement | null = null;
    const keepFocusInside = (event: FocusEvent): void => {
      if (
        event.target instanceof HTMLElement &&
        dialog.contains(event.target)
      ) {
        lastFocused = event.target;
        revealControl(dialog, event.target);
        return;
      }
      // A background Editor may remount or recover focus while work is in
      // progress. Do not let that change the application's active Window.
      event.stopPropagation();
      const target =
        lastFocused?.isConnected &&
        !lastFocused.matches(":disabled") &&
        !lastFocused.closest("[hidden],[inert]")
          ? lastFocused
          : dialog;
      target.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", keepFocusInside, true);
    const first = initialFocus === "first-control" ? controls(dialog)[0] : null;
    (first ?? dialog).focus({ preventScroll: true });
    return () => document.removeEventListener("focusin", keepFocusInside, true);
  }, [initialFocus, root]);

  useLayoutEffect(() => {
    const dialog = root.current;
    // WebKit does not always send focusout when a focused button disappears
    // or becomes disabled between progress stages. Retain a keyboard target.
    if (
      dialog &&
      (!dialog.contains(document.activeElement) ||
        document.activeElement?.matches(":disabled") ||
        document.activeElement?.closest("[hidden],[inert]"))
    ) {
      dialog.focus({ preventScroll: true });
    }
  });

  return (
    <div
      className="application-modal-overlay"
      data-memoka-focus-surface={focusSurface}
      onMouseDown={(event) => {
        // Backdrop clicks neither dismiss the dialog nor blur its controls.
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <div
        ref={root}
        className={`application-modal-dialog focus-surface focus-surface--focused${compact ? " application-modal-dialog--compact" : ""}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Tab") {
            event.preventDefault();
            const available = controls(event.currentTarget);
            const index = available.indexOf(
              document.activeElement as HTMLElement,
            );
            const next =
              index < 0
                ? event.shiftKey
                  ? available.length - 1
                  : 0
                : (index + (event.shiftKey ? -1 : 1) + available.length) %
                  available.length;
            // WebKit may leave focused number inputs below an overflow panel.
            // Scroll this panel explicitly, never the background editor.
            const target = available[next] ?? event.currentTarget;
            target.focus({ preventScroll: true });
            revealControl(event.currentTarget, target);
          } else if (
            event.key === "Escape" ||
            (event.ctrlKey && event.key.toLowerCase() === "c")
          ) {
            event.preventDefault();
            onClose?.();
          } else {
            onKeyDown?.(event);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
