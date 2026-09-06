import { useEffect, useRef, useState, type ReactNode } from "react";
import type { JSONContent } from "@tiptap/core";
import { SearchPane } from "./SearchPane";
import { EventDateTime } from "./EventDateTime";
import { formatDisplayDateTime } from "../core/display-datetime";
import {
  nativeErrorMessage,
  type BackupPort,
  type HistoricalResource,
  type HistoryGeneration,
} from "../core/history";
import type { SectionSnapshot } from "../core/section-model";

export interface HistorySession {
  readonly id: string | null;
  readonly restoreFocus: () => void;
}
export function HistoryPane({
  port,
  session,
  onClose,
}: {
  port: BackupPort;
  session: HistorySession;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly HistoryGeneration[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void port.history(session.id).then(
      (value) => {
        if (active) setItems(value.generations);
      },
      (cause) => {
        if (active) setError(nativeErrorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [port, session.id]);
  const shown = items.filter(
    (item) =>
      item.descriptor.captured_at.includes(query) ||
      formatDisplayDateTime(item.descriptor.captured_at).includes(query),
  );
  return (
    <SearchPane
      ariaLabel="履歴（読み取り専用）"
      inputAriaLabel="履歴日時を絞り込む"
      focusSurface="history"
      query={query}
      onQueryChange={setQuery}
      items={shown}
      itemId={(item) => item.descriptor.generation_id}
      renderItem={(item) => (
        <span>
          <EventDateTime value={item.descriptor.captured_at} />{" "}
          {item.descriptor.known_missing.length ? " · 添付欠損あり" : ""}
        </span>
      )}
      renderPreview={(item) =>
        item ? (
          <HistoryPreview
            key={item.descriptor.generation_id}
            port={port}
            generation={item.descriptor.generation_id}
            initialId={session.id}
            capturedAt={item.descriptor.captured_at}
          />
        ) : (
          <div className="workspace-search-preview-pane" />
        )
      }
      prompt="history›"
      countLabel={`${shown.length} 世代`}
      error={error}
      onClose={onClose}
      restoreFocus={session.restoreFocus}
    />
  );
}

function HistoryPreview({
  port,
  generation,
  initialId,
  capturedAt,
}: {
  port: BackupPort;
  generation: string;
  initialId: string | null;
  capturedAt: string;
}) {
  const previewRoot = useRef<HTMLDivElement>(null);
  const [id, setId] = useState(initialId);
  const [resource, setResource] = useState<HistoricalResource | null>(null);
  const [notes, setNotes] = useState<readonly { id: string; title: string }[]>(
    [],
  );
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (id)
      void port.read(id, generation).then(
        (value) => {
          if (active) {
            setResource(value);
            setError("");
          }
        },
        (cause) => {
          if (active) {
            setResource(null);
            setError(nativeErrorMessage(cause));
          }
        },
      );
    else
      void port.tree(generation).then(
        (value) => {
          if (active) setNotes(value);
        },
        (cause) => {
          if (active) setError(nativeErrorMessage(cause));
        },
      );
    return () => {
      active = false;
    };
  }, [generation, id, port]);
  const navigate = (targetId: string | null): void => {
    // The clicked link/button is removed while the next resource loads.
    // WebKit does not emit focusout for that removal, so the application's
    // blur recovery cannot recover focus from document.body. Transfer it
    // before changing the preview; delayed reads must not steal it later.
    previewRoot.current
      ?.closest(".search-pane")
      ?.querySelector<HTMLInputElement>('input[role="combobox"]')
      ?.focus({ preventScroll: true });
    setResource(null);
    setError("");
    setId(targetId);
  };
  const exportAttachment = (attachmentId: string): void => {
    const attachment = resource?.attachments.find(
      (item) => item.attachment_id === attachmentId,
    );
    void port
      .exportAttachment(
        attachmentId,
        generation,
        attachment?.filename ?? "attachment",
      )
      .catch((cause) => setError(nativeErrorMessage(cause)));
  };
  const block = (node: JSONContent, key: number): ReactNode => {
    const content = node.content?.map(block);
    const attrs = node.attrs ?? {};
    if (node.type === "text") {
      let value: ReactNode = node.text;
      for (const mark of node.marks ?? []) {
        if (mark.type === "bold") value = <strong>{value}</strong>;
        if (mark.type === "italic") value = <em>{value}</em>;
        if (mark.type === "strike") value = <s>{value}</s>;
        if (mark.type === "code") value = <code>{value}</code>;
        if (mark.type === "highlight") value = <mark>{value}</mark>;
        if (mark.type === "link")
          value = (
            <span
              className="memoka-external-link"
              title={String(mark.attrs?.href ?? "")}
            >
              {value}
            </span>
          );
      }
      return <span key={key}>{value}</span>;
    }
    if (node.type === "internalSectionLink") {
      const target = resource?.references.find(
        (item) => item.id === attrs.targetSectionId,
      );
      return (
        <button
          key={key}
          className="internal-section-link"
          disabled={!target?.resolved}
          onClick={() => navigate(String(attrs.targetSectionId))}
        >
          {target?.title || "リンク先不明"}
        </button>
      );
    }
    switch (node.type) {
      case "paragraph":
        return <p key={key}>{content}</p>;
      case "hardBreak":
        return <br key={key} />;
      case "horizontalRule":
        return <hr key={key} />;
      case "bulletList":
        return <ul key={key}>{content}</ul>;
      case "orderedList":
        return (
          <ol key={key} start={Number(attrs.start ?? 1)}>
            {content}
          </ol>
        );
      case "listItem":
        return <li key={key}>{content}</li>;
      case "codeBlock":
      case "sourceBlock":
        return (
          <pre key={key}>
            <code>{content}</code>
          </pre>
        );
      case "blockquote":
        return (
          <blockquote key={key} data-alert-type={attrs.alertType}>
            {attrs.alertType && <p>{attrs.alertTitle || attrs.alertType}</p>}
            {content}
          </blockquote>
        );
      case "table":
        return (
          <div key={key} className="tableWrapper">
            <table className="memoka-table">
              <tbody>{content}</tbody>
            </table>
          </div>
        );
      case "tableRow":
        return <tr key={key}>{content}</tr>;
      case "tableHeader":
        return (
          <th
            key={key}
            colSpan={Number(attrs.colspan ?? 1)}
            rowSpan={Number(attrs.rowspan ?? 1)}
          >
            {content}
          </th>
        );
      case "tableCell":
        return (
          <td
            key={key}
            colSpan={Number(attrs.colspan ?? 1)}
            rowSpan={Number(attrs.rowspan ?? 1)}
          >
            {content}
          </td>
        );
      case "image":
        return (
          <figure key={key}>
            <img
              loading="lazy"
              src={port.imageUrl(String(attrs.attachmentId), generation)}
              alt={String(attrs.alt ?? "履歴の画像")}
              style={{
                maxWidth: "100%",
                width: `${Number(attrs.width ?? 100)}%`,
              }}
            />
            <button
              onClick={() => exportAttachment(String(attrs.attachmentId))}
            >
              画像を取得
            </button>
          </figure>
        );
      case "attachment":
        return (
          <button
            key={key}
            onClick={() => exportAttachment(String(attrs.attachmentId))}
          >
            {resource?.attachments.find(
              (item) => item.attachment_id === attrs.attachmentId,
            )?.filename ||
              attrs.label ||
              "添付を取得"}
          </button>
        );
      default:
        return <span key={key}>{content}</span>;
    }
  };
  const section = (value: SectionSnapshot, depth: number): ReactNode => (
    <section
      key={value.sectionId}
      className="memoka-section"
      data-memoka-markup-heading={depth + 1}
    >
      <header className="memoka-section-header">{value.title}</header>
      <div className="memoka-section-body">
        {(value.body as JSONContent[]).map(block)}
      </div>
      <div className="memoka-section-children">
        {value.children.map((child) => section(child, depth + 1))}
      </div>
    </section>
  );
  return (
    <div ref={previewRoot} className="workspace-search-preview-pane">
      <div className="workspace-search-preview-root">
        <p>
          読み取り専用 · <EventDateTime value={capturedAt} />
        </p>
        {id && (
          <button onClick={() => navigate(null)}>この世代のノート一覧</button>
        )}
        {error && <p role="alert">{error}</p>}
        {resource ? (
          <div className="workspace-search-preview-document">
            {section(resource.section, resource.depth)}
          </div>
        ) : id ? (
          <p>読み込み中…</p>
        ) : (
          notes.map((note) => (
            <p key={note.id}>
              <button onClick={() => navigate(note.id)}>
                {note.title || "新しいノート"}
              </button>
            </p>
          ))
        )}
      </div>
    </div>
  );
}
