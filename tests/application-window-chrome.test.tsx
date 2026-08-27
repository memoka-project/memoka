import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app/src/App";
import {
  ApplicationWindowControls,
  ApplicationWindowDragRegion,
} from "../app/src/components/ApplicationWindowChrome";
import type { DesktopWindowPort } from "../app/src/platform/desktop-window";

function createDesktopWindowFixture() {
  let maximized = false;
  let resizeListener: (() => void) | null = null;
  const unsubscribe = vi.fn();
  const port: DesktopWindowPort = {
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => {
      maximized = !maximized;
    }),
    close: vi.fn(async () => undefined),
    startDragging: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => maximized),
    subscribeToResize: vi.fn(async (listener: () => void) => {
      resizeListener = listener;
      return unsubscribe;
    }),
  };
  return {
    port,
    unsubscribe,
    setMaximized(value: boolean): void {
      maximized = value;
      resizeListener?.();
    },
  };
}

describe("custom application window chrome", () => {
  it("routes the three window controls without confusing the TabPage close", async () => {
    const fixture = createDesktopWindowFixture();
    const view = render(
      <App desktopWindow={fixture.port} showDebugLine={false} />,
    );

    await screen.findByRole("button", { name: "Memokaを最小化" });
    fireEvent.click(screen.getByRole("button", { name: "新しいTabPage" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(view.container.querySelector(".application-tab-index")).toBeNull();

    const tabClose = screen.getAllByRole("button", {
      name: /のTabPageを閉じる$/,
    })[0];
    fireEvent.click(tabClose);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    expect(fixture.port.close).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Memokaを最小化" }));
    await waitFor(() => expect(fixture.port.minimize).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Memokaを最大化" }));
    await screen.findByRole("button", { name: "Memokaを元に戻す" });
    expect(fixture.port.toggleMaximize).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Memokaを閉じる" }));
    await waitFor(() => expect(fixture.port.close).toHaveBeenCalledOnce());
    view.unmount();
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("tracks maximize changes reported by the native window", async () => {
    const fixture = createDesktopWindowFixture();
    render(
      <ApplicationWindowControls
        desktopWindow={fixture.port}
        onError={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "Memokaを最大化" });

    fixture.setMaximized(true);
    await screen.findByRole("button", { name: "Memokaを元に戻す" });
    fixture.setMaximized(false);
    await screen.findByRole("button", { name: "Memokaを最大化" });
  });

  it("starts dragging only for a primary single press and toggles on double click", async () => {
    const fixture = createDesktopWindowFixture();
    const onError = vi.fn();
    const view = render(
      <ApplicationWindowDragRegion
        desktopWindow={fixture.port}
        onError={onError}
      />,
    );
    const region = view.container.querySelector<HTMLElement>(
      ".application-window-drag-region",
    );
    if (!region) throw new Error("Drag region did not mount");

    fireEvent.mouseDown(region, { button: 2, detail: 1 });
    fireEvent.mouseDown(region, { button: 0, detail: 2 });
    expect(fixture.port.startDragging).not.toHaveBeenCalled();

    fireEvent.mouseDown(region, { button: 0, detail: 1 });
    fireEvent.doubleClick(region, { button: 0 });
    await waitFor(() =>
      expect(fixture.port.startDragging).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(fixture.port.toggleMaximize).toHaveBeenCalledOnce(),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports native failures and omits native controls in browser mode", async () => {
    const fixture = createDesktopWindowFixture();
    fixture.port.minimize = vi.fn(async () => {
      throw new Error("denied");
    });
    const onError = vi.fn();
    const controls = render(
      <ApplicationWindowControls
        desktopWindow={fixture.port}
        onError={onError}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Memokaを最小化" }),
    );
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "ウィンドウの最小化",
        expect.any(Error),
      ),
    );
    controls.unmount();

    const browser = render(
      <ApplicationWindowControls desktopWindow={null} onError={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Memokaを閉じる" })).toBeNull();
    expect(browser.container.childElementCount).toBe(0);
  });
});
