import { useEffect, useRef, useState } from "react";
import type { CoreRuntime } from "../core/runtime";
import type { EditorNavigationDestination } from "../core/editor-navigation";
import {
  noteSearchStatusMessage,
  type NoteSearchOrigin,
} from "../core/note-search";
import {
  commandLineKeySequence,
  commandLineKeymap,
} from "../core/command-line-keymap";

export interface ApplicationNoteSearchSession {
  readonly windowId: string;
  readonly origin: NoteSearchOrigin;
  readonly applyDestination: (
    destination: EditorNavigationDestination,
    detail: string,
  ) => string | null;
  readonly requestInputMethodDeactivation: () => void;
  readonly restoreFocus: () => void;
  readonly focusResult?: () => void;
}

export function ApplicationNoteSearch({
  runtime,
  session,
  onClose,
  onMessage,
  focused = true,
}: {
  runtime: CoreRuntime;
  session: ApplicationNoteSearchSession;
  onClose: () => void;
  onMessage: (message: string) => void;
  focused?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => input.current?.focus(), []);

  const close = (): void => {
    session.requestInputMethodDeactivation();
    onClose();
    queueMicrotask(session.restoreFocus);
  };

  const execute = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const navigation = await runtime.searchNote(
        session.windowId,
        session.origin,
        value,
      );
      if (!navigation.handled) {
        setError(noteSearchError(navigation.detail, navigation.query ?? value));
        return;
      }
      if (
        navigation.destination &&
        !session.applyDestination(navigation.destination, navigation.detail)
      ) {
        setError("一致位置を現在のEditorへ反映できませんでした");
        return;
      }
      const message = noteSearchStatusMessage(navigation);
      if (message) onMessage(message);
      session.requestInputMethodDeactivation();
      onClose();
      requestAnimationFrame(session.focusResult ?? session.restoreFocus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`application-commandline application-commandline--active focus-surface${focused ? " focus-surface--focused" : ""}`}
      data-memoka-focus-surface="note-search"
    >
      <span className="commandline-prompt">/</span>
      <input
        ref={input}
        value={value}
        aria-label="ノート内を検索"
        autoComplete="off"
        spellCheck="false"
        readOnly={busy}
        aria-busy={busy}
        onChange={(event) => {
          setValue(event.currentTarget.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          const sequence = commandLineKeySequence(event);
          if (!sequence) return;
          const command = commandLineKeymap.resolve(
            "command-line.insert",
            sequence,
          );
          if (!command) return;
          event.preventDefault();
          if (command === "command-line.close") close();
          else void execute();
        }}
      />
      {error && (
        <span className="commandline-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function noteSearchError(detail: string, query: string): string {
  if (detail === "search:note:no-pattern") {
    return "前回の検索パターンがありません";
  }
  if (detail.startsWith("search:note:not-found:")) {
    return `パターンが見つかりません: ${query}`;
  }
  return detail;
}
