import { useEffect, useRef, type CSSProperties } from "react";

export interface PaneResizeGesture {
  preview: (delta: number) => number;
  commit: (value: number) => Promise<unknown>;
  cancel: () => void;
}

/** Preview only changes layout CSS. Persist once on release, never per pointer move. */
export function PaneResizeHandle({
  orientation,
  label,
  style,
  onStart,
  onError,
}: {
  orientation: "vertical" | "horizontal";
  label: string;
  style?: CSSProperties;
  onStart: () => PaneResizeGesture | null;
  onError: (error: unknown) => void;
}) {
  const cancelDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDrag.current?.(), []);
  return (
    <div
      className={`pane-resize-handle pane-resize-handle--${orientation}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      style={style}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        cancelDrag.current?.();
        const gesture = onStart();
        if (!gesture) return;
        const target = event.currentTarget;
        const pointerId = event.pointerId;
        const coordinate = (pointer: { clientX: number; clientY: number }) =>
          orientation === "vertical" ? pointer.clientX : pointer.clientY;
        const start = coordinate(event);
        let value: number | null = null;
        const oldCursor = document.documentElement.style.cursor;
        document.documentElement.style.cursor =
          orientation === "vertical" ? "col-resize" : "row-resize";
        document.documentElement.classList.add("pane-resizing");
        target.setPointerCapture?.(pointerId);
        const cleanup = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", cancel);
          window.removeEventListener("blur", cancel);
          window.removeEventListener("keydown", key, true);
          target.removeEventListener("lostpointercapture", cancel);
          if (target.hasPointerCapture?.(pointerId))
            target.releasePointerCapture(pointerId);
          document.documentElement.style.cursor = oldCursor;
          document.documentElement.classList.remove("pane-resizing");
          cancelDrag.current = null;
        };
        const cancel = () => {
          cleanup();
          gesture.cancel();
        };
        const move = (pointer: PointerEvent) => {
          if (pointer.pointerId !== pointerId) return;
          pointer.preventDefault();
          value = gesture.preview(coordinate(pointer) - start);
        };
        const up = (pointer: PointerEvent) => {
          if (pointer.pointerId !== pointerId) return;
          if (coordinate(pointer) !== start)
            value = gesture.preview(coordinate(pointer) - start);
          cleanup();
          if (value === null) {
            gesture.cancel();
            return;
          }
          void gesture.commit(value).catch((error: unknown) => {
            gesture.cancel();
            onError(error);
          });
        };
        const key = (keyboard: globalThis.KeyboardEvent) => {
          if (keyboard.key !== "Escape") return;
          keyboard.preventDefault();
          keyboard.stopPropagation();
          cancel();
        };
        cancelDrag.current = cancel;
        window.addEventListener("pointermove", move, { passive: false });
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("blur", cancel);
        window.addEventListener("keydown", key, true);
        target.addEventListener("lostpointercapture", cancel);
      }}
    />
  );
}
