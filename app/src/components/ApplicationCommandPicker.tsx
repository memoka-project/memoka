import { useMemo, useState, type ReactNode } from "react";
import {
  APPLICATION_COMMANDS,
  applicationCommandArgumentHelp,
  applicationCommandArgumentIsComplete,
  filterApplicationCommands,
  parseApplicationCommand,
  type ApplicationCommandDefinition,
} from "../core/application-command";
import { rankPickerItems } from "../core/picker-recents";
import {
  normalizeWorkspaceSearchText,
  workspaceSearchMatchRanges,
  workspaceSearchTerms,
} from "../core/workspace-search";
import { SearchPane } from "./SearchPane";
import { usePickerRecents } from "./picker-recents-state";
import { useCommandHistory } from "./command-history-state";

export interface ApplicationCommandPickerSession {
  readonly restoreFocus: () => void;
}

export type ApplicationCommandPickerSelection =
  | {
      readonly kind: "line";
      readonly value: string;
      readonly lineNumber: number;
    }
  | {
      readonly kind: "execute";
      readonly value: string;
      readonly command: ApplicationCommandDefinition;
      readonly argument: string | null;
    }
  | { readonly kind: "transfer"; readonly value: string };

interface CommandItem {
  readonly kind: "command" | "history";
  readonly id: string;
  readonly value: string;
  readonly command: ApplicationCommandDefinition | null;
  readonly inputArgument: boolean;
}

function exactInputCommand(query: string): ApplicationCommandDefinition | null {
  const name = query
    .trimStart()
    .replace(/^:/u, "")
    .split(/\s/u, 1)[0]
    ?.toLocaleLowerCase();
  if (!name) return null;
  return (
    APPLICATION_COMMANDS.find(
      (command) => command.name === name || command.aliases.includes(name),
    ) ?? null
  );
}

function inputArgument(query: string): string | null {
  const source = query.trimStart().replace(/^:/u, "");
  const match = /^\S+\s+(.+)$/u.exec(source);
  return match?.[1]?.trim() || null;
}

function completedCommandValue(
  query: string,
  command: ApplicationCommandDefinition,
): string {
  const argument = inputArgument(query);
  return `${command.name}${argument ? ` ${argument}` : command.argument === "optional" ? " " : ""}`;
}

function itemCommandValue(item: CommandItem): string {
  if (item.kind === "history" || item.inputArgument) return item.value;
  return `${item.command!.name}${item.command!.argument === "optional" ? " " : ""}`;
}

export function ApplicationCommandPicker({
  session,
  onSelect,
  onClose,
  focused = true,
}: {
  session: ApplicationCommandPickerSession;
  onSelect: (selection: ApplicationCommandPickerSelection) => void;
  onClose: () => void;
  focused?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const { state: pickerRecents, record: recordPickerRecent } =
    usePickerRecents();
  const { entries: history, record: recordCommand } = useCommandHistory();
  const exact = exactInputCommand(query);
  const argument = exact ? inputArgument(query) : null;
  const items = useMemo(() => {
    const terms = workspaceSearchTerms(query);
    const seenNoArgumentCommands = new Set<string>();
    const historyItems: CommandItem[] = history
      .filter((value) => {
        const searchable = normalizeWorkspaceSearchText(value);
        return terms.every((term) => searchable.includes(term));
      })
      .map<CommandItem>((value) => {
        const parsed = parseApplicationCommand(value);
        return {
          kind: "history",
          id: `history:${value}`,
          value,
          command:
            parsed.kind === "command"
              ? parsed.command
              : exactInputCommand(value),
          inputArgument: false,
        };
      })
      .filter((item) => {
        const parsed = parseApplicationCommand(item.value);
        if (parsed.kind !== "command" || parsed.argument !== null) return true;
        if (seenNoArgumentCommands.has(parsed.command.id)) return false;
        seenNoArgumentCommands.add(parsed.command.id);
        return true;
      });
    const mergedIds = new Set(
      historyItems
        .filter((item) => {
          const parsed = parseApplicationCommand(item.value);
          return parsed.kind === "command" && parsed.argument === null;
        })
        .map((item) => item.command!.id),
    );
    const matches = exact ? [exact] : filterApplicationCommands(query);
    const catalog = rankPickerItems(
      matches.filter(
        (command) => !mergedIds.has(command.id) || argument !== null,
      ),
      "command",
      pickerRecents,
      (command) => command.id,
    ).map<CommandItem>((command) => ({
      kind: "command",
      id: `command:${command.id}`,
      value:
        argument !== null && exact?.id === command.id
          ? completedCommandValue(query, command).trimEnd()
          : command.name,
      command,
      inputArgument: argument !== null && exact?.id === command.id,
    }));
    if (argument !== null && exact) return [...catalog, ...historyItems];
    return [...historyItems, ...catalog];
  }, [query, history, exact, argument, pickerRecents]);

  const accept = (item: CommandItem): void => {
    if (busy) return;
    const value = itemCommandValue(item);
    const parsed = parseApplicationCommand(value);
    if (parsed.kind === "line") {
      void recordCommand(value);
      onSelect({ kind: "line", value, lineNumber: parsed.lineNumber });
      return;
    }
    if (
      parsed.kind === "command" &&
      applicationCommandArgumentIsComplete(parsed.command, parsed.argument)
    ) {
      const saved = recordCommand(value);
      const perform = (): void => {
        recordPickerRecent("command", parsed.command.id);
        onSelect({
          kind: "execute",
          value,
          command: parsed.command,
          argument: parsed.argument,
        });
      };
      if (parsed.command.id === "application.quit") {
        setBusy(true);
        void saved.then(perform);
      } else {
        perform();
      }
      return;
    }
    if (item.command) recordPickerRecent("command", item.command.id);
    onSelect({ kind: "transfer", value });
  };

  return (
    <SearchPane
      ariaLabel="Memoka Commandを選択"
      inputAriaLabel="Memoka Commandを検索"
      focusSurface="command-picker"
      commandContext="search.command"
      query={query}
      onQueryChange={setQuery}
      items={items}
      itemId={(item) => item.id}
      renderItem={(item, currentQuery) => (
        <span className="command-picker__row">
          <strong>
            :<HighlightedCommandText value={item.value} query={currentQuery} />
          </strong>
          <span>
            {item.kind === "history" ? "履歴 · " : ""}
            {item.command?.description ??
              (parseApplicationCommand(item.value).kind === "line"
                ? "指定した論理行へ移動する"
                : "未対応のCommand")}
          </span>
        </span>
      )}
      renderPreview={(item) => {
        const command = item?.command;
        const help = command ? applicationCommandArgumentHelp(command) : null;
        const parsed = item
          ? parseApplicationCommand(itemCommandValue(item))
          : null;
        const description = help
          ? help.description
          : command
            ? `${command.description}。`
            : parsed?.kind === "line"
              ? "現在のNoteの指定した論理行へ移動します。"
              : "未対応のCommandです。Command-lineで編集できます。";
        const complete =
          parsed?.kind === "line" ||
          (parsed?.kind === "command" &&
            applicationCommandArgumentIsComplete(
              parsed.command,
              parsed.argument,
            ));
        return (
          <div className="workspace-search-preview-pane command-picker__preview">
            {item && (
              <div className="command-picker__preview-content">
                <strong>
                  :{command?.name ?? item.value}
                  {help ? ` ${help.syntax}` : ""}
                </strong>
                <p>{description}</p>
                {command && command.aliases.length > 0 && (
                  <p>Aliases: {command.aliases.join(", ")}</p>
                )}
                <p>{complete ? "Enterで実行" : "EnterでCommand-lineへ転記"}</p>
              </div>
            )}
          </div>
        );
      }}
      prompt="cmd›"
      countLabel={`${items.length} commands`}
      onAccept={accept}
      onComplete={(item) =>
        setQuery(
          item.kind === "history"
            ? item.value
            : exact && item.command?.id === exact.id
              ? completedCommandValue(query, item.command)
              : `${item.command!.name}${item.command!.argument === "optional" ? " " : ""}`,
        )
      }
      onClose={onClose}
      restoreFocus={session.restoreFocus}
      busy={busy}
      closeDisabled={busy}
      empty={
        <p className="workspace-search-empty">一致するCommandがありません</p>
      }
      focused={focused}
      className="command-picker"
      dataAttributes={{ "data-search-target": "command" }}
      idPrefix="command-picker"
    />
  );
}

function HighlightedCommandText({
  value,
  query,
}: {
  value: string;
  query: string;
}) {
  const ranges = workspaceSearchMatchRanges(value, query);
  if (ranges.length === 0) return value;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.from > cursor) parts.push(value.slice(cursor, range.from));
    parts.push(
      <mark className="workspace-search-match" key={`${range.from}:${index}`}>
        {value.slice(range.from, range.to)}
      </mark>,
    );
    cursor = range.to;
  });
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts;
}
