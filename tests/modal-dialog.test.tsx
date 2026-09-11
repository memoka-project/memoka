import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApplicationShutdownProgress } from "../app/src/components/ApplicationShutdownProgress";
import { ApplicationUpdatePrompt } from "../app/src/components/ApplicationUpdatePrompt";
import { ModalDialog } from "../app/src/components/ModalDialog";
import type { ApplicationDepartureProgress } from "../app/src/core/application-departure";

describe("shared floating modal dialogs", () => {
  it.each([
    "quit",
    "switch-workspace",
    "update",
    "update-confirmation",
  ] as const)(
    "keeps the %s dialog in the viewport overlay, not the command-line row",
    (kind) => {
      const style = document.createElement("style");
      style.textContent = readFileSync(
        resolve(process.cwd(), "app/src/styles.css"),
        "utf8",
      );
      document.head.append(style);
      try {
        if (kind === "update-confirmation") {
          render(
            <ApplicationUpdatePrompt
              release={{
                currentVersion: "0.1.8",
                version: "0.2.0",
                date: null,
                notes: "更新内容\n次の行",
                canSelfUpdate: true,
                bundleType: "appimage",
              }}
              progress={null}
              error={null}
              onConfirm={vi.fn()}
              onClose={vi.fn()}
            />,
          );
        } else {
          render(
            <ApplicationShutdownProgress
              progress={{ kind, stage: "backup", backup: null }}
              onRetry={vi.fn()}
              onCancel={vi.fn()}
              onSkip={vi.fn()}
            />,
          );
        }
        const dialog = screen.getByRole("dialog");
        const overlay = dialog.parentElement!;
        expect(overlay.classList.contains("application-modal-overlay")).toBe(
          true,
        );
        expect(overlay.classList.contains("focus-surface")).toBe(false);
        expect(getComputedStyle(overlay).position).toBe("fixed");
        expect(getComputedStyle(overlay).inset).toBe("0");
        expect(getComputedStyle(overlay).placeItems).toBe("center");
        expect(getComputedStyle(dialog).overflow).toBe("auto");
        expect(getComputedStyle(dialog).maxHeight).toBe("100%");
        expect(dialog.classList.contains("application-commandline")).toBe(
          false,
        );
        expect(dialog.getAttribute("aria-modal")).toBe("true");
        expect(document.activeElement).toBe(dialog);
      } finally {
        style.remove();
      }
    },
  );

  it("cycles from the panel to the first or last control and recovers after progress removes them", () => {
    const close = vi.fn();
    const view = render(
      <ModalDialog ariaLabel="処理" focusSurface="test" onClose={close}>
        <button>一つ目</button>
        <button>最後</button>
      </ModalDialog>,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "一つ目" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "最後" }),
    );
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "最後" }),
    );
    view.rerender(
      <ModalDialog ariaLabel="処理" focusSurface="test" busy>
        <p>中断を待っています</p>
      </ModalDialog>,
    );
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });

  it("reveals controls by scrolling only the panel, including WebKit number inputs", () => {
    render(
      <ModalDialog ariaLabel="処理" focusSurface="test">
        <input type="number" aria-label="先頭" />
        <input type="number" aria-label="末尾" />
      </ModalDialog>,
    );
    const dialog = screen.getByRole("dialog");
    const first = screen.getByRole("spinbutton", { name: "先頭" });
    const last = screen.getByRole("spinbutton", { name: "末尾" });
    Object.defineProperty(dialog, "clientHeight", { value: 200 });
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 20, 400, 200),
    );
    vi.spyOn(first, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 28 - dialog.scrollTop, 100, 36),
    );
    vi.spyOn(last, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 320 - dialog.scrollTop, 100, 36),
    );
    const pageScroll = document.documentElement.scrollTop;
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(dialog.scrollTop).toBe(144);
    fireEvent.keyDown(last, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(first);
    expect(dialog.scrollTop).toBe(0);
    expect(document.documentElement.scrollTop).toBe(pageScroll);
  });

  it("keeps Ctrl-C inside text controls for selection copy instead of closing", () => {
    const close = vi.fn();
    render(
      <ModalDialog ariaLabel="処理" focusSurface="test" onClose={close}>
        <input aria-label="通常入力" />
        <textarea aria-label="読み取り専用コード" readOnly value="code" />
      </ModalDialog>,
    );
    fireEvent.keyDown(screen.getByLabelText("通常入力"), {
      key: "c",
      ctrlKey: true,
    });
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("読み取り専用コード"), {
      key: "c",
      ctrlKey: true,
    });
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "c",
      ctrlKey: true,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["saving", "closing", "stopping", "cancelling", "resuming"] as const)(
    "does not cancel the protected %s stage or pass keys through to the editor",
    (stage) => {
      const cancel = vi.fn();
      const backgroundKey = vi.fn();
      render(
        <div onKeyDown={backgroundKey}>
          <button>背後</button>
          <ApplicationShutdownProgress
            progress={{ kind: "quit", stage, backup: null }}
            onRetry={vi.fn()}
            onCancel={cancel}
            onSkip={vi.fn()}
          />
        </div>,
      );
      const dialog = screen.getByRole("dialog");
      screen.getByRole("button", { name: "背後" }).focus();
      expect(document.activeElement).toBe(dialog);
      for (const key of [
        { key: "Escape" },
        { key: "c", ctrlKey: true },
        { key: "Tab" },
        { key: "j" },
      ]) {
        fireEvent.keyDown(dialog, key);
      }
      expect(document.activeElement).toBe(dialog);
      expect(backgroundKey).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    },
  );

  it("keeps backup cancellation, retry and explicit skip separate, including failures", () => {
    const retry = vi.fn();
    const cancel = vi.fn();
    const skip = vi.fn();
    const props = { onRetry: retry, onCancel: cancel, onSkip: skip };
    const progress: ApplicationDepartureProgress = {
      kind: "switch-workspace",
      stage: "backup-error",
      backup: null,
      error: "保存先がオフライン",
    };
    const view = render(
      <ApplicationShutdownProgress {...props} progress={progress} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(screen.getByRole("alert").textContent).toBe("保存先がオフライン");
    fireEvent.keyDown(dialog, { key: "Escape", isComposing: true });
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "c", ctrlKey: true });
    expect(cancel).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(skip).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: /バックアップを中断して切り替え/ }),
    );
    expect(skip).toHaveBeenCalledOnce();
    view.rerender(
      <ApplicationShutdownProgress
        {...props}
        progress={{ ...progress, stage: "saving-error" }}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /バックアップを中断/ }),
    ).toBeNull();
  });

  it("explains deferred quit backup and never offers to bypass child cleanup", () => {
    const props = { onRetry: vi.fn(), onCancel: vi.fn(), onSkip: vi.fn() };
    const view = render(
      <ApplicationShutdownProgress
        {...props}
        progress={{ kind: "quit", stage: "stopping", backup: null }}
      />,
    );
    expect(screen.getByRole("dialog").textContent).toContain(
      "バックアップの完了は待たず",
    );
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(
      <ApplicationShutdownProgress
        {...props}
        progress={{
          kind: "quit",
          stage: "stopping-error",
          backup: null,
          error: "cleanup failed",
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "再試行" })).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /バックアップを中断して終了/ }),
    ).toBeNull();
  });
});
