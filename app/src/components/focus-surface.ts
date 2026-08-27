export function focusSurfaceFromPointer(
  target: EventTarget | null,
  focusTarget: HTMLElement | null,
): void {
  if (!(target instanceof HTMLElement) || !focusTarget) return;
  if (
    target.closest(
      "button, input, textarea, select, [contenteditable='true'], [role='option'][tabindex]",
    )
  ) {
    return;
  }
  focusTarget.focus({ preventScroll: true });
}
