import { useMemo, useState, type ReactNode } from "react";
import {
  codeLanguageLabel,
  filterCodeBlockActionCatalog,
  filterCodeLanguageCatalog,
  type CodeBlockActionCatalogEntry,
  type CodeLanguageCatalogEntry,
} from "../core/code-blocks";
import type { CodeActionPickerRequest } from "../editor/tiptap-adapter";
import { workspaceSearchMatchRanges } from "../core/workspace-search";
import { SearchPane } from "./SearchPane";

export interface CodeActionPickerSession extends CodeActionPickerRequest {
  readonly windowId: string;
  readonly restoreFocus: () => void;
}

export function CodeActionPicker({
  session,
  onClose,
  onMessage,
  focused = true,
}: {
  session: CodeActionPickerSession;
  onClose: () => void;
  onMessage: (message: string) => void;
  focused?: boolean;
}) {
  const [phase, setPhase] = useState<"actions" | "languages">("actions");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const actions = useMemo(() => filterCodeBlockActionCatalog(query), [query]);
  const languages = useMemo(() => filterCodeLanguageCatalog(query), [query]);

  const closeAndRestore = (): void => {
    onClose();
    queueMicrotask(session.restoreFocus);
  };

  const acceptAction = (entry: CodeBlockActionCatalogEntry): void => {
    if (entry.id === "language") {
      setPhase("languages");
      setQuery("");
      setError(null);
      return;
    }
    closeAndRestore();
    void session.copy().then((result) => {
      if (result === "missing") onMessage("code.copy · 対象がありません");
    });
  };

  const acceptLanguage = (entry: CodeLanguageCatalogEntry): void => {
    const result = session.setLanguage(entry.id);
    if (result.changed || result.reason === "no-op") {
      closeAndRestore();
      onMessage(
        result.changed
          ? `code.language · ${entry.name}`
          : `code.language · ${entry.name} · 変更なし`,
      );
      return;
    }
    setError(
      result.reason === "missing"
        ? "対象のCode Blockが変更または削除されました"
        : "この言語は選択できません",
    );
  };

  if (phase === "languages") {
    return (
      <SearchPane
        ariaLabel="Code Blockの言語を選択"
        inputAriaLabel="Code Blockの言語を検索"
        focusSurface="code-action-picker"
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          setError(null);
        }}
        items={languages}
        itemId={(entry) => entry.id ?? "plain-text"}
        renderItem={(entry, currentQuery) => (
          <PickerRow
            name={entry.name}
            description={entry.id ?? "言語指定なし"}
            query={currentQuery}
          />
        )}
        renderPreview={(entry) => (
          <PickerPreview
            name={entry?.name ?? "言語設定"}
            description={
              entry
                ? `${entry.id ?? "言語指定なし"}としてCode Blockを表示します。`
                : "構文ハイライトに使う言語を選択します。"
            }
            current={`現在: ${codeLanguageLabel(session.selection.language)}`}
          />
        )}
        prompt="language›"
        countLabel={`${languages.length} languages`}
        onAccept={acceptLanguage}
        onClose={closeAndRestore}
        restoreFocus={() => {}}
        error={error}
        empty={
          <p className="workspace-search-empty">一致する言語がありません</p>
        }
        focused={focused}
        className="code-action-picker"
        dataAttributes={{
          "data-search-target": "code-language",
          "data-window-id": session.windowId,
          "data-block-id": session.selection.blockId,
        }}
        idPrefix="code-language-picker"
      />
    );
  }

  return (
    <SearchPane
      ariaLabel="Code Block操作を選択"
      inputAriaLabel="Code Block操作を検索"
      focusSurface="code-action-picker"
      query={query}
      onQueryChange={(value) => {
        setQuery(value);
        setError(null);
      }}
      items={actions}
      itemId={(entry) => entry.id}
      renderItem={(entry, currentQuery) => (
        <PickerRow
          name={entry.name}
          description={entry.description}
          query={currentQuery}
        />
      )}
      renderPreview={(entry) => (
        <PickerPreview
          name={entry?.name ?? "Code Block操作"}
          description={entry?.description ?? "操作を選択します。"}
          current={`言語: ${codeLanguageLabel(session.selection.language)}`}
        />
      )}
      prompt="code›"
      countLabel={`${actions.length} actions`}
      onAccept={acceptAction}
      onClose={closeAndRestore}
      restoreFocus={() => {}}
      error={error}
      empty={<p className="workspace-search-empty">一致する操作がありません</p>}
      focused={focused}
      className="code-action-picker"
      dataAttributes={{
        "data-search-target": "code-action",
        "data-window-id": session.windowId,
        "data-block-id": session.selection.blockId,
      }}
      idPrefix="code-action-picker"
    />
  );
}

function PickerRow({
  name,
  description,
  query,
}: {
  name: string;
  description: string;
  query: string;
}) {
  return (
    <span className="code-action-picker__row">
      <HighlightedName value={name} query={query} />
      <span>{description}</span>
    </span>
  );
}

function PickerPreview({
  name,
  description,
  current,
}: {
  name: string;
  description: string;
  current: string;
}) {
  return (
    <div className="workspace-search-preview-pane code-action-picker__preview">
      <div className="code-action-picker__preview-content">
        <strong>{name}</strong>
        <p>{description}</p>
        <p>{current}</p>
      </div>
    </div>
  );
}

function HighlightedName({ value, query }: { value: string; query: string }) {
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
