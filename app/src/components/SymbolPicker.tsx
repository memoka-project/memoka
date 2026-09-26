import { useEffect, useMemo, useState } from "react";
import {
  filterSymbols,
  loadSymbolCatalog,
  type SymbolEntry,
  type SymbolFilter,
} from "../core/symbols";
import { SearchPane } from "./SearchPane";
import { SymbolIcon } from "./SymbolText";
import { usePickerRecents } from "./picker-recents-state";

export interface SymbolPickerSession {
  readonly windowId: string;
  readonly apply: (value: string) => boolean;
  readonly restoreFocus: () => void;
}
const filters: readonly SymbolFilter[] = ["All", "Emoji", "Lucide"];
export function SymbolPicker({
  session,
  onClose,
}: {
  session: SymbolPickerSession;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SymbolFilter>("All");
  const [catalog, setCatalog] = useState<readonly SymbolEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { record } = usePickerRecents();
  useEffect(() => {
    let active = true;
    void loadSymbolCatalog()
      .then((entries) => {
        if (active) setCatalog(entries);
      })
      .catch(() => {
        if (active) setError("候補を読み込めませんでした");
      });
    return () => {
      active = false;
    };
  }, []);
  const matches = useMemo(
    () => filterSymbols(catalog, query, filter),
    [catalog, query, filter],
  );
  const glyph = (item: SymbolEntry) =>
    item.type === "Emoji" ? item.value : <SymbolIcon name={item.name} />;
  return (
    <div
      onKeyDownCapture={(event) => {
        if (
          event.nativeEvent.isComposing ||
          !event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        const next = filters[Number(event.key) - 1];
        if (next) {
          event.preventDefault();
          event.stopPropagation();
          setFilter(next);
        }
      }}
    >
      <SearchPane
        ariaLabel="絵文字・アイコンを選択"
        inputAriaLabel="絵文字・アイコンを検索"
        focusSurface="symbol-picker"
        query={query}
        onQueryChange={setQuery}
        items={matches}
        itemId={(item) => item.id}
        recentKind="symbol"
        maxItems={200}
        renderItem={(item) => (
          <span className="symbol-picker__row">
            <span>{glyph(item)}</span>
            <span>{item.name}</span>
            <small>{item.type}</small>
          </span>
        )}
        renderPreview={(item) => (
          <div className="workspace-search-preview-pane inline-format-picker__preview">
            {item && (
              <div>
                <div className="symbol-picker__preview">{glyph(item)}</div>
                <p>{item.name}</p>
                <code>{item.value}</code>
              </div>
            )}
          </div>
        )}
        prompt="Symbol›"
        countLabel={`${matches.length} symbols${matches.length > 200 ? " · 先頭200件（検索で絞り込み）" : ""}`}
        listFooter={
          <div className="symbol-picker__filters">
            {filters.map((value, index) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setFilter(value)}
              >
                {value} · Ctrl-{index + 1}
              </button>
            ))}
          </div>
        }
        onAccept={(item) => {
          if (!session.apply(item.value)) {
            setError(
              "入力元が変更されたため挿入できません。Escで閉じて開き直してください",
            );
            return;
          }
          record("symbol", item.id);
          onClose();
          queueMicrotask(session.restoreFocus);
        }}
        onClose={onClose}
        restoreFocus={session.restoreFocus}
        error={error}
        empty={
          <p className="workspace-search-empty">
            {catalog.length ? "一致する候補がありません" : "読み込み中…"}
          </p>
        }
        idPrefix="symbol-picker"
        dataAttributes={{ "data-window-id": session.windowId }}
      />
    </div>
  );
}
