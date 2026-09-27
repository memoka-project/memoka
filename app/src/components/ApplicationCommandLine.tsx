import { useEffect, useRef, useState } from "react";
import {
  parseApplicationCommand,
  type ApplicationCommandId,
} from "../core/application-command";
import {
  commandLineKeySequence,
  commandLineKeymap,
} from "../core/command-line-keymap";
import {
  navigateCommandHistory,
  type CommandHistoryBrowse,
} from "../core/command-history";
import { useCommandHistory } from "./command-history-state";

export interface ApplicationCommandLineSession {
  readonly restoreFocus: () => void;
  readonly initialValue?: string;
}

export function ApplicationCommandLine({
  session,
  onExecute,
  onGoToLine,
  onClose,
  focused = true,
}: {
  session: ApplicationCommandLineSession;
  onExecute: (
    command: ApplicationCommandId,
    message: string,
    argument: string | null,
  ) => void;
  onGoToLine: (lineNumber: number) => void;
  onClose: () => void;
  focused?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(session.initialValue ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const browse = useRef<CommandHistoryBrowse | null>(null);
  const { entries, record } = useCommandHistory();

  useEffect(() => {
    const target = input.current;
    target?.focus();
    if (target)
      target.setSelectionRange(target.value.length, target.value.length);
  }, []);

  const close = (): void => {
    onClose();
    queueMicrotask(session.restoreFocus);
  };

  const execute = (): void => {
    if (busy) return;
    const parsed = parseApplicationCommand(value);
    if (parsed.kind === "empty") {
      close();
      return;
    }
    const saved = record(value);
    if (parsed.kind === "error") {
      setError(parsed.message);
      return;
    }
    if (parsed.kind === "line") {
      onGoToLine(parsed.lineNumber);
      return;
    }
    if (parsed.command.id === "application.quit") {
      setBusy(true);
      void saved.then(() =>
        onExecute(
          parsed.command.id,
          `:${parsed.command.name}`,
          parsed.argument,
        ),
      );
      return;
    }
    onExecute(parsed.command.id, `:${parsed.command.name}`, parsed.argument);
  };

  return (
    <div
      className={`application-commandline application-commandline--active focus-surface${focused ? " focus-surface--focused" : ""}`}
      data-memoka-focus-surface="command-line"
    >
      <span className="commandline-prompt">:</span>
      <input
        ref={input}
        value={value}
        maxLength={4096}
        readOnly={busy}
        aria-label="Memoka Command"
        autoComplete="off"
        spellCheck="false"
        onChange={(event) => {
          setValue(event.currentTarget.value);
          setError(null);
          browse.current = null;
        }}
        onKeyDown={(event) => {
          if (busy) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (event.nativeEvent.isComposing) return;
          const sequence = commandLineKeySequence(event);
          if (!sequence) return;
          const command = commandLineKeymap.resolve(
            "command-line.insert",
            sequence,
          );
          if (!command) return;
          event.preventDefault();
          event.stopPropagation();
          if (command === "command-line.close") close();
          else if (command === "command-line.execute") execute();
          else if (command.startsWith("command-line.history_")) {
            const previous = browse.current;
            const next = navigateCommandHistory(
              entries,
              value,
              event.currentTarget.selectionStart ?? value.length,
              event.currentTarget.selectionEnd ?? value.length,
              previous,
              command.includes("older") ? "older" : "newer",
              command.endsWith("prefix"),
            );
            browse.current = next.browse;
            setValue(next.value);
            setError(null);
            queueMicrotask(() => {
              const field = input.current;
              if (!field) return;
              if (previous && next.browse === null) {
                field.setSelectionRange(
                  previous.draftSelectionStart,
                  previous.draftSelectionEnd,
                );
              } else {
                field.setSelectionRange(next.value.length, next.value.length);
              }
            });
          }
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
