import { useEffect, useRef, useState } from "react";
import {
  parseApplicationCommand,
  type ApplicationCommandId,
} from "../core/application-command";
import {
  commandLineKeySequence,
  commandLineKeymap,
} from "../core/command-line-keymap";

export interface ApplicationCommandLineSession {
  readonly restoreFocus: () => void;
}

export function ApplicationCommandLine({
  session,
  onExecute,
  onClose,
  focused = true,
}: {
  session: ApplicationCommandLineSession;
  onExecute: (
    command: ApplicationCommandId,
    message: string,
    argument: string | null,
  ) => void;
  onClose: () => void;
  focused?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => input.current?.focus(), []);

  const close = (): void => {
    onClose();
    queueMicrotask(session.restoreFocus);
  };

  const execute = (): void => {
    const parsed = parseApplicationCommand(value);
    if (parsed.kind === "empty") {
      close();
      return;
    }
    if (parsed.kind === "error") {
      setError(parsed.message);
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
        aria-label="Memoka Command"
        autoComplete="off"
        spellCheck="false"
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
          else execute();
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
