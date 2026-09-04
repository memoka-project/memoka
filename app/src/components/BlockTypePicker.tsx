import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  filterBlockTypeCatalog,
  type BlockTransformOptions,
  type BlockTransformTarget,
  type BlockTypeCatalogEntry,
  type TableDimensions,
} from "../core/block-types";
import {
  filterMarkdownAlertTypeCatalog,
  markdownAlertLabel,
  type MarkdownAlert,
  type MarkdownAlertTypeCatalogEntry,
} from "../core/markdown-alert";
import { workspaceSearchMatchRanges } from "../core/workspace-search";
import type { BlockTransformResult } from "../vim/block-transform";
import { SearchPane } from "./SearchPane";

export interface BlockTypePickerSession {
  readonly windowId: string;
  readonly blockId: string;
  readonly transform: (
    target: BlockTransformTarget,
    options?: BlockTransformOptions,
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
  const [phase, setPhase] = useState<"catalog" | "table-size" | "alert-type">(
    "catalog",
  );
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
    if (entry.id === "table") {
      setPhase("table-size");
      return;
    }
    if (entry.id === "alert") {
      setPhase("alert-type");
      return;
    }
    completeTransform(entry, session.transform(entry.id));
  };

  const completeTransform = (
    entry: BlockTypeCatalogEntry,
    result: BlockTransformResult | null,
  ): void => {
    onClose();
    queueMicrotask(session.restoreFocus);
    if (result?.changed) {
      onMessage(`block.transform · ${entry.name}`);
      return;
    }
    onMessage(blockTransformFailureMessage(result));
  };

  if (phase === "table-size") {
    const tableEntry = entries.find((entry) => entry.id === "table") ?? {
      id: "table" as const,
      name: "Table",
      aliases: [],
      description: "行数と列数を選んで表を作成します。",
      example: "",
    };
    return (
      <TableSizePicker
        windowId={session.windowId}
        blockId={session.blockId}
        focused={focused}
        onAccept={(dimensions) =>
          completeTransform(
            tableEntry,
            session.transform("table", { tableDimensions: dimensions }),
          )
        }
        onClose={() => {
          onClose();
          queueMicrotask(session.restoreFocus);
        }}
      />
    );
  }

  if (phase === "alert-type") {
    const alertEntry = entries.find((entry) => entry.id === "alert") ?? {
      id: "alert" as const,
      name: "Alert",
      aliases: [],
      description: "typeを選んでAlertを作成します。",
      example: "",
    };
    return (
      <AlertTypePicker
        windowId={session.windowId}
        blockId={session.blockId}
        focused={focused}
        onAccept={(alert) =>
          completeTransform(alertEntry, session.transform("alert", { alert }))
        }
        onClose={() => {
          onClose();
          queueMicrotask(session.restoreFocus);
        }}
      />
    );
  }

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

function AlertTypePicker({
  windowId,
  blockId,
  focused,
  onAccept,
  onClose,
}: {
  windowId: string;
  blockId: string;
  focused: boolean;
  onAccept: (alert: MarkdownAlert) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const entries = useMemo(() => filterMarkdownAlertTypeCatalog(query), [query]);
  return (
    <SearchPane
      ariaLabel="Alert typeを選択"
      inputAriaLabel="Alert typeを検索"
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
      renderPreview={(entry) => <AlertTypePreview entry={entry} />}
      prompt="[!›"
      countLabel={`${entries.length} types`}
      onAccept={(entry) =>
        onAccept({ type: entry.id, title: null, fold: null })
      }
      onClose={onClose}
      restoreFocus={() => {}}
      empty={<p className="workspace-search-empty">一致するtypeがありません</p>}
      focused={focused}
      className="block-type-picker alert-type-picker"
      dataAttributes={{
        "data-search-target": "alert-type",
        "data-window-id": windowId,
        "data-block-id": blockId,
      }}
      idPrefix="alert-type-picker"
    />
  );
}

function AlertTypePreview({
  entry,
}: {
  entry: MarkdownAlertTypeCatalogEntry | null;
}) {
  return (
    <div className="workspace-search-preview-pane block-type-picker__preview">
      {entry && (
        <div className="block-type-picker__preview-content workspace-search-preview-document">
          <blockquote
            data-memoka-alert-type={entry.id}
            data-memoka-alert-label={markdownAlertLabel({
              alertType: entry.id,
            })}
          >
            <p>{entry.description}</p>
          </blockquote>
        </div>
      )}
    </div>
  );
}

const TABLE_SIZE_GRID_ROWS = 10;
const TABLE_SIZE_GRID_COLUMNS = 10;

function TableSizePicker({
  windowId,
  blockId,
  focused,
  onAccept,
  onClose,
}: {
  windowId: string;
  blockId: string;
  focused: boolean;
  onAccept: (dimensions: TableDimensions) => void;
  onClose: () => void;
}) {
  const picker = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<TableDimensions>({
    rows: 3,
    columns: 3,
  });

  useEffect(() => {
    const focusPicker = (): void => picker.current?.focus();
    focusPicker();
    queueMicrotask(focusPicker);
    const frame = window.requestAnimationFrame(focusPicker);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const move = (rowDelta: number, columnDelta: number): void => {
    setDimensions((current) => ({
      rows: Math.max(
        1,
        Math.min(TABLE_SIZE_GRID_ROWS, current.rows + rowDelta),
      ),
      columns: Math.max(
        1,
        Math.min(TABLE_SIZE_GRID_COLUMNS, current.columns + columnDelta),
      ),
    }));
  };

  return (
    <section
      className={`workspace-search-overlay table-size-picker focus-surface${focused ? " focus-surface--focused" : ""}`}
      aria-label="Tableの行数と列数を選択"
      data-memoka-focus-surface="block-type-picker"
      data-search-target="table-size"
      data-window-id={windowId}
      data-block-id={blockId}
    >
      <div className="table-size-picker__left">
        <div
          ref={picker}
          className="table-size-picker__keyboard-surface"
          role="grid"
          aria-label="Tableサイズ"
          aria-rowcount={TABLE_SIZE_GRID_ROWS}
          aria-colcount={TABLE_SIZE_GRID_COLUMNS}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const key = event.key.toLowerCase();
            if (key === "escape" || (event.ctrlKey && key === "c")) {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              onAccept(dimensions);
              return;
            }
            if (event.key === "Tab") {
              event.preventDefault();
              return;
            }
            const movement =
              key === "h" || event.key === "ArrowLeft"
                ? ([0, -1] as const)
                : key === "l" || event.key === "ArrowRight"
                  ? ([0, 1] as const)
                  : key === "k" || event.key === "ArrowUp"
                    ? ([-1, 0] as const)
                    : key === "j" || event.key === "ArrowDown"
                      ? ([1, 0] as const)
                      : null;
            if (!movement) return;
            event.preventDefault();
            move(movement[0], movement[1]);
          }}
        >
          <div className="table-size-picker__grid">
            {Array.from({ length: TABLE_SIZE_GRID_ROWS }, (_, rowIndex) =>
              Array.from(
                { length: TABLE_SIZE_GRID_COLUMNS },
                (_, columnIndex) => {
                  const rows = rowIndex + 1;
                  const columns = columnIndex + 1;
                  const active =
                    rows <= dimensions.rows && columns <= dimensions.columns;
                  const cursor =
                    rows === dimensions.rows && columns === dimensions.columns;
                  return (
                    <button
                      key={`${rows}:${columns}`}
                      type="button"
                      role="gridcell"
                      aria-label={`${columns}列×${rows}行`}
                      aria-selected={active}
                      tabIndex={-1}
                      className={`table-size-picker__cell${active ? " table-size-picker__cell--active" : ""}${cursor ? " table-size-picker__cell--cursor" : ""}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setDimensions({ rows, columns })}
                      onClick={() => onAccept({ rows, columns })}
                    />
                  );
                },
              ),
            )}
          </div>
          <strong className="table-size-picker__dimensions">
            {dimensions.columns}列 × {dimensions.rows}行
          </strong>
        </div>
        <div className="table-size-picker__guide">
          h/j/k/l または矢印で選択 · Enterで作成 · Escでキャンセル
        </div>
      </div>
      <div className="workspace-search-preview-pane table-size-picker__preview">
        <div>
          <strong>Table</strong>
          <p>選択範囲の右下Cellが、新しいTableの右下Cellになります。</p>
          <p>先頭行は見出し行です。</p>
        </div>
      </div>
    </section>
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
