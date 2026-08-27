import { getCurrentWindow } from "@tauri-apps/api/window";

export interface DesktopWindowPort {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  startDragging(): Promise<void>;
  isMaximized(): Promise<boolean>;
  subscribeToResize(listener: () => void): Promise<() => void>;
  subscribeToCloseRequested?(
    listener: () => void | Promise<void>,
  ): Promise<() => void>;
  forceClose?(): Promise<void>;
}

class TauriDesktopWindowPort implements DesktopWindowPort {
  private readonly window = getCurrentWindow();

  minimize(): Promise<void> {
    return this.window.minimize();
  }

  toggleMaximize(): Promise<void> {
    return this.window.toggleMaximize();
  }

  close(): Promise<void> {
    return this.window.close();
  }

  startDragging(): Promise<void> {
    return this.window.startDragging();
  }

  isMaximized(): Promise<boolean> {
    return this.window.isMaximized();
  }

  subscribeToResize(listener: () => void): Promise<() => void> {
    return this.window.onResized(listener);
  }

  subscribeToCloseRequested(
    listener: () => void | Promise<void>,
  ): Promise<() => void> {
    return this.window.onCloseRequested((event) => {
      event.preventDefault();
      void listener();
    });
  }

  forceClose(): Promise<void> {
    return this.window.destroy();
  }
}

export function createDefaultDesktopWindowPort(): DesktopWindowPort | null {
  if (
    typeof window === "undefined" ||
    !("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))
  ) {
    return null;
  }
  return new TauriDesktopWindowPort();
}
