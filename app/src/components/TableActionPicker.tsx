import { useMemo, useState, type ReactNode } from "react";
import {
  filterTableActionCatalog,
  type TableActionCatalogEntry,
  type TableActionId,
} from "../core/table-actions";
import { workspaceSearchMatchRanges } from "../core/workspace-search";
import type {
  TableActionResult,
  TableActionSelection,
} from "../vim/table-editing";
import { SearchPane } from "./SearchPane";

export interface TableActionPickerSession {
  readonly windowId: string;
  readonly selection: TableActionSelection;
  readonly apply: (action: TableActionId) => TableActionResult;
  readonly restoreFocus: () => void;
}

export function TableActionPicker({
  session,
  onClose,
  onMessage,
  focused = true,
}: {
  session: TableActionPickerSession;
  onClose: () => void;
  onMessage: (message: string) => void;
  focused?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const entries = useMemo(() => filterTableActionCatalog(query), [query]);
  const { selection } = session;
  const scope = `${selection.rowTo - selection.rowFrom + 1}行 × ${
    selection.columnTo - selection.columnFrom + 1
  }列`;

  const accept = (entry: TableActionCatalogEntry): void => {
    const result = session.apply(entry.id);
    if (result.changed || result.reason === "boundary") {
      onClose();
      queueMicrotask(session.restoreFocus);
      onMessage(
        result.changed
          ? `table.action · ${entry.name}`
          : `table.action · ${entry.name} · 境界`,
      );
      return;
    }
    setError(tableActionFailureMessage(result));
  };

  return (
    <SearchPane
      ariaLabel="Table操作を選択"
      inputAriaLabel="Table操作を検索"
      focusSurface="table-action-picker"
      query={query}
      onQueryChange={(value) => {
        setQuery(value);
        setError(null);
      }}
      items={entries}
      itemId={(entry) => entry.id}
      renderItem={(entry, currentQuery) => (
        <span className="table-action-picker__row">
          <HighlightedActionName value={entry.name} query={currentQuery} />
          <span>{entry.description}</span>
        </span>
      )}
      renderPreview={(entry) => (
        <div className="workspace-search-preview-pane table-action-picker__preview">
          {entry && (
            <div className="table-action-picker__preview-content">
              <strong>{entry.name}</strong>
              <p>{entry.description}</p>
              <p>対象: {scope}</p>
            </div>
          )}
        </div>
      )}
      prompt="table›"
      countLabel={`${entries.length} actions`}
      onAccept={accept}
      onClose={onClose}
      restoreFocus={session.restoreFocus}
      error={error}
      empty={<p className="workspace-search-empty">一致する操作がありません</p>}
      focused={focused}
      className="table-action-picker"
      dataAttributes={{
        "data-search-target": "table-action",
        "data-window-id": session.windowId,
      }}
      idPrefix="table-action-picker"
    />
  );
}

function HighlightedActionName({
  value,
  query,
}: {
  value: string;
  query: string;
}) {
  const ranges = workspaceSearchMatchRanges(value, query);
  if (ranges.length === 0) return <strong>{value}</strong>;
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
  return <strong>{parts}</strong>;
}

function tableActionFailureMessage(result: TableActionResult): string {
  switch (result.reason) {
    case "missing":
      return "対象のTableが変更または削除されました";
    case "unsupported":
      return "結合セルを含むTableにはこの操作を適用できません";
    case "boundary":
      return "これ以上移動できません";
    case "changed":
      return "Table操作を完了できませんでした";
  }
}
