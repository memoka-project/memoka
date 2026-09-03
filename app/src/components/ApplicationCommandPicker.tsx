import { useMemo, useState, type ReactNode } from "react";
import {
  filterApplicationCommands,
  type ApplicationCommandDefinition,
} from "../core/application-command";
import { workspaceSearchMatchRanges } from "../core/workspace-search";
import { SearchPane } from "./SearchPane";

export interface ApplicationCommandPickerSession {
  readonly restoreFocus: () => void;
}

export function ApplicationCommandPicker({
  session,
  onSelect,
  onClose,
  focused = true,
}: {
  session: ApplicationCommandPickerSession;
  onSelect: (command: ApplicationCommandDefinition) => void;
  onClose: () => void;
  focused?: boolean;
}) {
  const [query, setQuery] = useState("");
  const commands = useMemo(() => filterApplicationCommands(query), [query]);

  return (
    <SearchPane
      ariaLabel="Memoka Commandを選択"
      inputAriaLabel="Memoka Commandを検索"
      focusSurface="command-picker"
      query={query}
      onQueryChange={setQuery}
      items={commands}
      itemId={(command) => command.id}
      renderItem={(command, currentQuery) => (
        <span className="command-picker__row">
          <strong>
            :
            <HighlightedCommandText value={command.name} query={currentQuery} />
          </strong>
          <span>{command.description}</span>
        </span>
      )}
      renderPreview={(command) => (
        <div className="workspace-search-preview-pane command-picker__preview">
          {command && (
            <div className="command-picker__preview-content">
              <strong>
                :{command.name}
                {command.argument === "optional" ? " [argument]" : ""}
              </strong>
              <p>{command.description}</p>
              {command.aliases.length > 0 && (
                <p>Aliases: {command.aliases.join(", ")}</p>
              )}
            </div>
          )}
        </div>
      )}
      prompt="cmd›"
      countLabel={`${commands.length} commands`}
      onAccept={onSelect}
      onClose={onClose}
      restoreFocus={session.restoreFocus}
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
