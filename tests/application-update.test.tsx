import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app/src/App";
import { ApplicationUpdatePrompt } from "../app/src/components/ApplicationUpdatePrompt";
import {
  MemoryApplicationDiagnosticsPort,
  type ApplicationDiagnosticsInfo,
} from "../app/src/platform/application-diagnostics";
import {
  isStablePublicVersion,
  MemoryApplicationUpdatePort,
  type ApplicationRelease,
} from "../app/src/platform/application-update";
import type { PortableMirrorPort } from "../app/src/core/portable-mirror";

const RELEASE: ApplicationRelease = {
  currentVersion: "0.1.0",
  version: "0.2.0",
  date: "2026-08-27T00:00:00Z",
  notes: "安全な更新",
  canSelfUpdate: true,
  bundleType: "appimage",
};

const DIAGNOSTICS: ApplicationDiagnosticsInfo = {
  applicationVersion: "0.1.0",
  tauriVersion: "test",
  operatingSystem: "linux",
  architecture: "x86_64",
  bundleType: "appimage",
  logDirectory: "memory://logs",
  updaterConfigured: true,
};

describe("Memoka application update", () => {
  it("accepts only stable public release versions", () => {
    expect(isStablePublicVersion("0.1.0")).toBe(true);
    expect(isStablePublicVersion("0.2.0-beta.1")).toBe(false);
    expect(isStablePublicVersion("0.2.0+rebuilt")).toBe(false);
    expect(isStablePublicVersion("latest")).toBe(false);
  });

  it("requires explicit confirmation and exposes bounded progress", () => {
    let confirmations = 0;
    let closes = 0;
    const view = render(
      <ApplicationUpdatePrompt
        release={RELEASE}
        progress={null}
        error={null}
        onConfirm={() => {
          confirmations += 1;
        }}
        onClose={() => {
          closes += 1;
        }}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Memokaを更新" });
    expect(dialog.textContent).toContain("v0.2.0へ更新しますか");
    expect(dialog.textContent).toContain("安全な更新");
    fireEvent.keyDown(dialog, { key: "Enter" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(confirmations).toBe(1);
    expect(closes).toBe(1);
    view.rerender(
      <ApplicationUpdatePrompt
        release={RELEASE}
        progress={{
          phase: "downloading",
          downloadedBytes: 5,
          contentLength: 10,
        }}
        error={null}
        onConfirm={() => {
          confirmations += 1;
        }}
        onClose={() => {
          closes += 1;
        }}
      />,
    );
    expect(dialog.textContent).toContain("50%");
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(closes).toBe(1);
  });

  it("checks after startup but installs only after :update confirmation", async () => {
    const update = new MemoryApplicationUpdatePort(RELEASE);
    const diagnostics = new MemoryApplicationDiagnosticsPort();
    const view = render(
      <App
        applicationUpdate={update}
        diagnostics={diagnostics}
        startupUpdateDelayMs={0}
      />,
    );
    await screen.findByRole("tree", { name: "ノートツリー" });
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Memoka v0.2.0を利用できます · :update",
      ),
    );
    expect(update.installCount).toBe(0);

    const editor = await waitFor(() => {
      const element =
        view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!element) throw new Error("Editor did not mount");
      return element;
    });
    editor.focus();
    fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(editor, {
      key: ":",
      code: "Semicolon",
      shiftKey: true,
    });
    const command = screen.getByRole("textbox", { name: "Memoka Command" });
    fireEvent.change(command, { target: { value: "update" } });
    fireEvent.keyDown(command, { key: "Enter" });

    const confirmation = await screen.findByRole("dialog", {
      name: "Memokaを更新",
    });
    expect(update.installCount).toBe(0);
    fireEvent.keyDown(confirmation, { key: "Enter" });
    await waitFor(() => expect(update.installCount).toBe(1));
    await waitFor(() => expect(update.relaunchCount).toBe(1));
    expect(diagnostics.events).toContain("update-install-started");
    view.unmount();
  });

  it("opens the release page instead of replacing a deb installation", async () => {
    const release = { ...RELEASE, canSelfUpdate: false, bundleType: "deb" };
    const update = new MemoryApplicationUpdatePort(release);
    const diagnostics = new MemoryApplicationDiagnosticsPort();
    const view = render(
      <App
        applicationUpdate={update}
        diagnostics={diagnostics}
        startupUpdateDelayMs={0}
      />,
    );
    await screen.findByRole("tree", { name: "ノートツリー" });
    const editor = await waitFor(() => {
      const element =
        view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!element) throw new Error("Editor did not mount");
      return element;
    });
    editor.focus();
    fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(editor, {
      key: ":",
      code: "Semicolon",
      shiftKey: true,
    });
    const command = screen.getByRole("textbox", { name: "Memoka Command" });
    fireEvent.change(command, { target: { value: "update" } });
    fireEvent.keyDown(command, { key: "Enter" });
    const confirmation = await screen.findByRole("dialog", {
      name: "Memokaを更新",
    });
    expect(confirmation.textContent).toContain("配布ページ");
    fireEvent.keyDown(confirmation, { key: "Enter" });
    await waitFor(() => expect(update.releasePageCount).toBe(1));
    expect(update.installCount).toBe(0);
    view.unmount();
  });

  it("does not contact the endpoint when the updater key is absent", async () => {
    const update = new MemoryApplicationUpdatePort(RELEASE);
    const diagnostics = new MemoryApplicationDiagnosticsPort({
      ...DIAGNOSTICS,
      updaterConfigured: false,
    });
    const view = render(
      <App
        applicationUpdate={update}
        diagnostics={diagnostics}
        startupUpdateDelayMs={0}
      />,
    );
    await screen.findByRole("tree", { name: "ノートツリー" });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(update.checkCount).toBe(0);
    view.unmount();
  });

  it("keeps the current version when the portable mirror flush fails", async () => {
    const update = new MemoryApplicationUpdatePort(RELEASE);
    const diagnostics = new MemoryApplicationDiagnosticsPort(DIAGNOSTICS);
    const failingMirror: PortableMirrorPort = {
      listAttachments: async () => {
        throw new Error("injected mirror failure");
      },
      publish: async () => undefined,
    };
    const view = render(
      <App
        applicationUpdate={update}
        diagnostics={diagnostics}
        portableMirror={failingMirror}
        startupUpdateDelayMs={0}
      />,
    );
    await screen.findByRole("tree", { name: "ノートツリー" });
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Memoka v0.2.0を利用できます · :update",
      ),
    );
    const editor = await waitFor(() => {
      const element =
        view.container.querySelector<HTMLElement>(".memoka-editor");
      if (!element) throw new Error("Editor did not mount");
      return element;
    });
    editor.focus();
    fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(editor, {
      key: ":",
      code: "Semicolon",
      shiftKey: true,
    });
    const command = screen.getByRole("textbox", { name: "Memoka Command" });
    fireEvent.change(command, { target: { value: "update" } });
    fireEvent.keyDown(command, { key: "Enter" });
    const confirmation = await screen.findByRole("dialog", {
      name: "Memokaを更新",
    });
    fireEvent.keyDown(confirmation, { key: "Enter" });
    await screen.findByText(
      /更新を適用できませんでした。現在のバージョンを継続します/u,
    );
    expect(update.installCount).toBe(0);
    expect(update.relaunchCount).toBe(0);
    expect(diagnostics.events).toContain("update-install-failed");
    view.unmount();
  });
});
