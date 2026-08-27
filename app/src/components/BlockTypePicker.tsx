import { useMemo, useState, type ReactNode } from "react";
import {
  filterBlockTypeCatalog,
  type BlockTransformTarget,
  type BlockTypeCatalogEntry,
} from "../core/block-types";
import { workspaceSearchMatchRanges } from "../core/workspace-search";
import type { BlockTransformResult } from "../vim/block-transform";
import { SearchPane } from "./SearchPane";

export interface BlockTypePickerSession {
  readonly windowId: string;
  readonly blockId: string;
  readonly transform: (
    target: BlockTransformTarget,
  ) => BlockTransformResult | null;
  readonly attach?: () => void;
  readonly restoreFocus: () => void;
}

export function BlockTypePicker({
  session,
  onClose,
  onMessage,
  focused = true,
}: {
  session: BlockTypePickerSession;
  onClose: () => void;
  onMessage: (message: string) => void;
  focused?: boolean;
}) {
  const [query, setQuery] = useState("");
  const entries = useMemo(() => filterBlockTypeCatalog(query), [query]);

  const accept = (entry: BlockTypeCatalogEntry): void => {
    if (entry.id === "attachment") {
      onClose();
      if (session.attach) {
        session.attach();
      } else {
        queueMicrotask(session.restoreFocus);
        onMessage("attachment.insert · 添付ファイル機能を利用できません");
      }
      return;
    }
    const result = session.transform(entry.id);
    onClose();
    queueMicrotask(session.restoreFocus);
    if (result?.changed) {
      onMessage(`block.transform · ${entry.name}`);
      return;
    }
    onMessage(blockTransformFailureMessage(result));
  };

  return (
    <SearchPane
      ariaLabel="ブロックタイプを選択"
      inputAriaLabel="ブロックタイプを検索"
      focusSurface="block-type-picker"
      query={query}
      onQueryChange={setQuery}
      items={entries}
      itemId={(entry) => entry.id}
      renderItem={(entry, currentQuery) => (
        <span className="block-type-picker__row">
          <HighlightedBlockTypeName value={entry.name} query={currentQuery} />
          <span className="block-type-picker__description">
            {entry.description}
          </span>
        </span>
      )}
      renderPreview={(entry) => (
        <div className="workspace-search-preview-pane block-type-picker__preview">
          {entry && (
            <div className="block-type-picker__preview-content">
              <strong>{entry.name}</strong>
              <p>{entry.description}</p>
              <pre>{entry.example}</pre>
            </div>
          )}
        </div>
      )}
      prompt="/›"
      countLabel={`${entries.length} types`}
      onAccept={accept}
      onClose={onClose}
      restoreFocus={session.restoreFocus}
      empty={<p className="workspace-search-empty">一致する種類がありません</p>}
      focused={focused}
      className="block-type-picker"
      dataAttributes={{
        "data-search-target": "block-type",
        "data-window-id": session.windowId,
        "data-block-id": session.blockId,
      }}
      idPrefix="block-type-picker"
    />
  );
}

function HighlightedBlockTypeName({
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

function blockTransformFailureMessage(
  result: BlockTransformResult | null,
): string {
  if (!result) return "block.transform · Editorを利用できません";
  if (result.changed) return "block.transform · changed";
  switch (result.reason) {
    case "stale-slash":
    case "missing":
      return "block.transform · 対象ブロックが変更されました";
    case "not-direct-body":
      return "block.transform · Section直下のブロックのみ変更できます";
    case "unsafe-inline-content":
      return "block.transform · 書式または内部リンクを含む本文は変換できません";
    case "unsupported":
      return "block.transform · このブロック間の変換には未対応です";
    case "no-op":
      return "block.transform · 変更はありません";
  }
}
