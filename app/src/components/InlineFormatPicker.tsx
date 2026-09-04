import { useMemo, useState, type ReactNode } from "react";
import {
  externalLinkErrorMessage,
  normalizeExternalLink,
} from "../core/external-links";
import {
  filterInlineFormatCatalog,
  type InlineFormatAction,
  type InlineFormatCatalogEntry,
} from "../core/inline-formats";
import { workspaceSearchMatchRanges } from "../core/workspace-search";
import type { InlineFormatResult } from "../vim/inline-format";
import { SearchPane } from "./SearchPane";

export interface InlineFormatPickerSession {
  readonly windowId: string;
  readonly selectedText: string;
  readonly existingHref: string | null;
  readonly apply: (action: InlineFormatAction) => InlineFormatResult;
  readonly restoreFocus: () => void;
}

interface LinkSubmission {
  readonly id: "link-submit";
  readonly href: string;
  readonly relative: boolean;
}

export function InlineFormatPicker({
  session,
  onClose,
  onMessage,
  focused = true,
}: {
  session: InlineFormatPickerSession;
  onClose: () => void;
  onMessage: (message: string) => void;
  focused?: boolean;
}) {
  const [phase, setPhase] = useState<"catalog" | "link">("catalog");
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState(session.existingHref ?? "");
  const [operationError, setOperationError] = useState<string | null>(null);
  const entries = useMemo(() => filterInlineFormatCatalog(query), [query]);
  const normalizedLink = useMemo(() => normalizeExternalLink(url), [url]);
  const linkItems: readonly LinkSubmission[] = normalizedLink.valid
    ? [
        {
          id: "link-submit",
          href: normalizedLink.href,
          relative: normalizedLink.kind === "relative",
        },
      ]
    : [];

  const finish = (result: InlineFormatResult, label: string): void => {
    if (result.changed || result.reason === "no-op") {
      onClose();
      queueMicrotask(session.restoreFocus);
      onMessage(
        result.changed
          ? `selection.format · ${label}`
          : `selection.format · ${label} · 変更なし`,
      );
      return;
    }
    setOperationError(inlineFormatFailureMessage(result));
  };

  const acceptFormat = (entry: InlineFormatCatalogEntry): void => {
    setOperationError(null);
    if (entry.id === "link") {
      setPhase("link");
      return;
    }
    finish(
      session.apply(
        entry.id === "clear"
          ? { kind: "clear" }
          : { kind: "apply", format: entry.id },
      ),
      entry.name,
    );
  };

  if (phase === "link") {
    const validationError =
      url.length > 0 && !normalizedLink.valid
        ? externalLinkErrorMessage(normalizedLink)
        : null;
    return (
      <SearchPane
        key="inline-format-link"
        ariaLabel="外部リンクURLを設定"
        inputAriaLabel="外部リンクURL"
        focusSurface="inline-format-picker"
        query={url}
        onQueryChange={(value) => {
          setUrl(value);
          setOperationError(null);
        }}
        items={linkItems}
        itemId={(item) => item.id}
        renderItem={(item) => (
          <span className="inline-format-picker__link-row">
            <strong>{item.href}</strong>
            <span>{item.relative ? "相対URL" : "外部URL"}</span>
          </span>
        )}
        renderPreview={(item) => (
          <div className="workspace-search-preview-pane inline-format-picker__preview">
            {item && (
              <div className="inline-format-picker__preview-content">
                <a href={item.href} onClick={(event) => event.preventDefault()}>
                  {previewText(session.selectedText)}
                </a>
                {item.relative && (
                  <p>相対URLは保存できますが、現在はgxで開けません。</p>
                )}
              </div>
            )}
          </div>
        )}
        prompt="URL›"
        countLabel={normalizedLink.valid ? "1 link" : "0 links"}
        onAccept={(item) =>
          finish(session.apply({ kind: "link", href: item.href }), "リンク")
        }
        onClose={onClose}
        restoreFocus={session.restoreFocus}
        error={operationError ?? validationError}
        empty={
          <p className="workspace-search-empty">
            URLを入力すると確定候補が表示されます
          </p>
        }
        focused={focused}
        className="inline-format-picker"
        dataAttributes={{
          "data-search-target": "inline-format-link",
          "data-window-id": session.windowId,
        }}
        idPrefix="inline-format-link-picker"
      />
    );
  }

  return (
    <SearchPane
      key="inline-format-catalog"
      ariaLabel="文字装飾を選択"
      inputAriaLabel="文字装飾を検索"
      focusSurface="inline-format-picker"
      query={query}
      onQueryChange={(value) => {
        setQuery(value);
        setOperationError(null);
      }}
      items={entries}
      itemId={(entry) => entry.id}
      renderItem={(entry, currentQuery) => (
        <span className="inline-format-picker__row">
          <HighlightedFormatName value={entry.name} query={currentQuery} />
          <span>{entry.description}</span>
        </span>
      )}
      renderPreview={(entry) => (
        <div className="workspace-search-preview-pane inline-format-picker__preview">
          {entry && (
            <div className="inline-format-picker__preview-content">
              <strong>{entry.name}</strong>
              <p>{entry.description}</p>
              <p className="inline-format-picker__example">
                {formatExample(entry.id, previewText(session.selectedText))}
              </p>
            </div>
          )}
        </div>
      )}
      prompt="m›"
      countLabel={`${entries.length} styles`}
      onAccept={acceptFormat}
      onClose={onClose}
      restoreFocus={session.restoreFocus}
      error={operationError}
      empty={<p className="workspace-search-empty">一致する装飾がありません</p>}
      focused={focused}
      className="inline-format-picker"
      dataAttributes={{
        "data-search-target": "inline-format",
        "data-window-id": session.windowId,
      }}
      idPrefix="inline-format-picker"
    />
  );
}

function previewText(value: string): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  return normalized.slice(0, 80) || "選択したテキスト";
}

function formatExample(
  id: InlineFormatCatalogEntry["id"],
  value: string,
): ReactNode {
  switch (id) {
    case "italic":
      return <em>{value}</em>;
    case "bold":
      return <strong>{value}</strong>;
    case "strike":
      return <s>{value}</s>;
    case "code":
      return <code>{value}</code>;
    case "highlight":
      return <mark data-memoka-highlight="true">{value}</mark>;
    case "link":
      return <a>{value}</a>;
    case "clear":
      return value;
  }
}

function HighlightedFormatName({
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

function inlineFormatFailureMessage(
  result: Extract<InlineFormatResult, { changed: false }>,
): string {
  switch (result.reason) {
    case "missing":
      return "Editorを利用できません";
    case "stale":
      return "選択範囲が変更されました";
    case "empty":
      return "装飾できる文字が選択されていません";
    case "unsupported-block":
      return "Sectionタイトル、Code、Source、Imageには文字装飾を適用できません";
    case "link-multiple-blocks":
      return "外部リンクは1つのテキストブロック内で選択してください";
    case "link-internal-atom":
      return "内部リンクを含む範囲へ外部リンクを設定できません";
    case "invalid-link":
      return "安全でないURLは設定できません";
    case "no-op":
      return "変更はありません";
  }
}
