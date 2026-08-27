import { useCallback, useEffect, useState, type MouseEvent } from "react";
import type { DesktopWindowPort } from "../platform/desktop-window";

export type WindowControlErrorHandler = (
  action: string,
  error: unknown,
) => void;

export function ApplicationWindowDragRegion({
  desktopWindow,
  onError,
}: {
  desktopWindow: DesktopWindowPort | null;
  onError: WindowControlErrorHandler;
}) {
  const handleMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (!desktopWindow || event.button !== 0 || event.detail !== 1) return;
    void desktopWindow.startDragging().catch((error: unknown) => {
      onError("ウィンドウの移動", error);
    });
  };

  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (!desktopWindow || event.button !== 0) return;
    void desktopWindow.toggleMaximize().catch((error: unknown) => {
      onError("ウィンドウの最大化／復元", error);
    });
  };

  return (
    <div
      className="application-window-drag-region"
      aria-hidden="true"
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    />
  );
}

export function ApplicationWindowControls({
  desktopWindow,
  onError,
}: {
  desktopWindow: DesktopWindowPort | null;
  onError: WindowControlErrorHandler;
}) {
  const [maximized, setMaximized] = useState(false);

  const refreshMaximized = useCallback(async (): Promise<void> => {
    if (!desktopWindow) return;
    try {
      setMaximized(await desktopWindow.isMaximized());
    } catch (error) {
      onError("ウィンドウ状態の取得", error);
    }
  }, [desktopWindow, onError]);

  useEffect(() => {
    if (!desktopWindow) return;

    let active = true;
    let unsubscribe: (() => void) | null = null;
    const refresh = async (): Promise<void> => {
      if (!active) return;
      await refreshMaximized();
    };

    void refresh();
    void desktopWindow
      .subscribeToResize(() => void refresh())
      .then((nextUnsubscribe) => {
        if (active) unsubscribe = nextUnsubscribe;
        else nextUnsubscribe();
      })
      .catch((error: unknown) => {
        if (active) onError("ウィンドウ状態の監視", error);
      });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [desktopWindow, onError, refreshMaximized]);

  if (!desktopWindow) return null;

  const run = (
    action: string,
    operation: () => Promise<void>,
    after?: () => Promise<void>,
  ): void => {
    void operation()
      .then(after)
      .catch((error: unknown) => onError(action, error));
  };

  return (
    <div className="application-window-controls" aria-label="ウィンドウ操作">
      <button
        type="button"
        className="application-window-control application-window-control--minimize"
        aria-label="Memokaを最小化"
        title="最小化"
        onClick={() =>
          run("ウィンドウの最小化", () => desktopWindow.minimize())
        }
      >
        <span className="application-window-icon application-window-icon--minimize" />
      </button>
      <button
        type="button"
        className="application-window-control application-window-control--maximize"
        aria-label={maximized ? "Memokaを元に戻す" : "Memokaを最大化"}
        title={maximized ? "元に戻す" : "最大化"}
        onClick={() =>
          run(
            "ウィンドウの最大化／復元",
            () => desktopWindow.toggleMaximize(),
            refreshMaximized,
          )
        }
      >
        <span
          className={`application-window-icon ${
            maximized
              ? "application-window-icon--restore"
              : "application-window-icon--maximize"
          }`}
        />
      </button>
      <button
        type="button"
        className="application-window-control application-window-control--close"
        aria-label="Memokaを閉じる"
        title="閉じる"
        onClick={() =>
          run("アプリケーションの終了", () => desktopWindow.close())
        }
      >
        <span className="application-window-icon application-window-icon--close">
          ×
        </span>
      </button>
    </div>
  );
}
