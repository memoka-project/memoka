import { Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EditorNavigationDestination } from "../core/editor-navigation";
import { contentOffsetAtTextOffset } from "../core/stable-position";
import type { StableEditorPosition } from "../core/stable-position";
import type { CoreRuntime, TrashPurgePreview } from "../core/runtime";
import type { AttachmentRepository } from "../core/attachments";
import { SymbolText } from "./SymbolText";
import {
  normalizeWorkspaceSearchText,
  workspaceSearchMatchRanges,
  workspaceSearchTerms,
  type WorkspaceSearchResponse,
  type WorkspaceSearchResult,
  type WorkspaceSearchScope,
  type WorkspaceSearchTarget,
} from "../core/workspace-search";
import { workspaceMatchRanges } from "../core/workspace-search-matcher";
import { productEditorExtensions } from "../editor/extensions";
import { SearchPane } from "./SearchPane";
import { EventDateTime } from "./EventDateTime";
import { ModalDialog } from "./ModalDialog";

export interface WorkspaceSearchSession {
  readonly windowId: string;
  readonly scope: WorkspaceSearchScope;
  readonly target: WorkspaceSearchTarget;
  readonly origin: StableEditorPosition | null;
  readonly applyDestination: (
    destination: EditorNavigationDestination,
    detail: string,
  ) => string | null;
  readonly restoreFocus: () => void;
}

export function WorkspaceSearchPalette({
  runtime,
  session,
  onClose,
  focused = true,
  attachmentRepository,
}: {
  runtime: CoreRuntime;
  session: WorkspaceSearchSession;
  onClose: () => void;
  focused?: boolean;
  attachmentRepository?: AttachmentRepository;
}) {
  const [searchState, setSearchState] = useState<{
    query: string;
    response: WorkspaceSearchResponse;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingPurge, setPendingPurge] = useState<TrashPurgePreview | null>(
    null,
  );
  const requestSequence = useRef(0);
  const response = searchState?.query === query ? searchState.response : null;
  const results = response?.results ?? [];

  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebouncedQuery(query), 75);
    return () => globalThis.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    void runtime
      .searchWorkspace(
        debouncedQuery,
        session.scope,
        20,
        session.target,
        session.windowId,
      )
      .then(async (response) => {
        if (session.target !== "buffers" || !attachmentRepository) {
          return response;
        }
        const attachmentIds = runtime.imageBufferAttachmentIds();
        await attachmentRepository.resolve(attachmentIds);
        const attachments = attachmentIds.flatMap((attachmentId) => {
          const attachment = attachmentRepository.cached(attachmentId);
          return attachment ? [attachment] : [];
        });
        const terms = workspaceSearchTerms(debouncedQuery);
        const imageResults: WorkspaceSearchResult[] = attachments
          .filter((attachment) => {
            const value = normalizeWorkspaceSearchText(
              attachment.originalFilename,
            );
            return terms.every((term) => value.includes(term));
          })
          .map((attachment) => ({
            resultId: `image:${attachment.attachmentId}`,
            noteId: attachment.attachmentId,
            sectionId: attachment.attachmentId,
            title: attachment.originalFilename,
            parentPath: "/",
            updatedAt: attachment.createdAt,
            kind: "image",
            preview: "",
            lineText: "",
            blockId: null,
            logicalLineNumber: null,
            sectionLineNumber: null,
            lineIndex: 0,
            matchOffset: 0,
            lineMatchOffset: 0,
            query: debouncedQuery,
            attachmentId: attachment.attachmentId,
          }));
        return {
          ...response,
          results: [...response.results, ...imageResults]
            .sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            )
            .slice(0, 20),
        };
      })
      .then(
        (next) => {
          if (requestSequence.current === sequence) {
            setSearchState({ query: debouncedQuery, response: next });
          }
        },
        (cause: unknown) => {
          if (requestSequence.current === sequence) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        },
      );
  }, [
    attachmentRepository,
    runtime,
    session.scope,
    session.target,
    session.windowId,
    debouncedQuery,
    refreshVersion,
  ]);

  const openResult = async (result: WorkspaceSearchResult): Promise<void> => {
    if (busy || session.target === "trash" || result.kind === "group") return;
    setBusy(true);
    setError(null);
    const rankingContext = runtime.captureWorkspaceSearchRankingContext(
      session.windowId,
    );
    try {
      if (result.kind === "image" && result.attachmentId) {
        await runtime.openImage(
          session.windowId,
          result.attachmentId,
          session.origin,
        );
        onClose();
        return;
      }
      const navigation = await runtime.navigateWorkspaceSearchResult(
        session.windowId,
        session.origin,
        result,
      );
      if (!navigation.handled) {
        setError(navigation.detail);
        return;
      }
      if (
        navigation.destination &&
        !session.applyDestination(navigation.destination, navigation.detail)
      ) {
        setError("検索結果の位置を現在のEditorへ反映できませんでした");
        return;
      }
      if (session.target === "workspace") {
        const position = results.findIndex(
          (candidate) => candidate.resultId === result.resultId,
        );
        await runtime.learnWorkspaceSearchSelection(
          session.windowId,
          result,
          position > 0 ? results.slice(0, position) : [],
          rankingContext,
        );
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const restoreResult = async (
    result: WorkspaceSearchResult,
  ): Promise<void> => {
    if (busy || session.target !== "trash") return;
    setBusy(true);
    setError(null);
    try {
      if (result.namespaceEntryId)
        await runtime.restoreNamespaceEntry(result.namespaceEntryId);
      else await runtime.restoreNoteFromTrash(result.noteId);
      setSearchState(null);
      setRefreshVersion((version) => version + 1);
      focusTrashInput();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const focusTrashInput = (): void => {
    globalThis.setTimeout(
      () =>
        document
          .querySelector<HTMLInputElement>(
            '.workspace-search-overlay[data-search-target="trash"] input[role="combobox"]',
          )
          ?.focus(),
      0,
    );
  };

  const purgePreviewFor = (
    result: WorkspaceSearchResult,
  ): TrashPurgePreview | null => {
    const entryId =
      result.namespaceEntryId ??
      runtime.snapshot().notes.find((note) => note.noteId === result.noteId)
        ?.entryId;
    if (!entryId) return null;
    try {
      return runtime.previewTrashPurge(entryId);
    } catch {
      return null;
    }
  };

  const requestPurge = (result: WorkspaceSearchResult): void => {
    if (busy || session.target !== "trash") return;
    const preview = purgePreviewFor(result);
    if (!preview) {
      setError("Trashの対象が変わりました。検索結果を更新してください");
      return;
    }
    if (!preview.available) {
      setError(preview.reason ?? "この項目はTrashから削除できません");
      return;
    }
    setPendingPurge(preview);
  };

  const confirmPurge = async (): Promise<void> => {
    if (!pendingPurge || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runtime.purgeTrashOperation(pendingPurge);
      setPendingPurge(null);
      setSearchState(null);
      setRefreshVersion((version) => version + 1);
      focusTrashInput();
    } catch (cause) {
      setPendingPurge(null);
      setError(cause instanceof Error ? cause.message : String(cause));
      focusTrashInput();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SearchPane
        ariaLabel={workspaceSearchLabel(session.target, session.scope)}
        inputAriaLabel="ワークスペースを検索"
        focusSurface="workspace-search"
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          setError(null);
        }}
        items={results}
        itemId={(result) => result.resultId}
        renderItem={(result, currentQuery) => (
          <>
            <span className="workspace-search-row-heading">
              <span className="workspace-search-icon" aria-hidden="true">
                {result.kind === "image"
                  ? "📷"
                  : result.kind === "group"
                    ? "📁"
                    : "📄"}
              </span>
              {result.openStatus && (
                <span
                  className="workspace-search-open-indicator"
                  aria-label={
                    result.openStatus === "previous"
                      ? "直前に開いたノート"
                      : result.openStatus === "current"
                        ? "現在のノート"
                        : "開いているノート"
                  }
                >
                  {result.openStatus === "previous"
                    ? "↶"
                    : result.openStatus === "current"
                      ? "●"
                      : "○"}
                </span>
              )}
              {session.scope === "title" ? (
                <>
                  <span className="workspace-search-note-title">
                    <SymbolText
                      text={result.title}
                      highlights={
                        result.titleRanges ??
                        workspaceSearchMatchRanges(result.title, currentQuery)
                      }
                    />
                  </span>
                  <span className="workspace-search-title-hierarchy">
                    <HighlightedText
                      value={formatSearchHierarchy(result.parentPath)}
                      query={currentQuery}
                      ranges={result.pathRanges}
                    />
                  </span>
                </>
              ) : (
                <SearchResultPath result={result} query={currentQuery} />
              )}
            </span>
            <span className="workspace-search-timestamp">
              <EventDateTime value={result.updatedAt} />
            </span>
            {session.scope === "body" && (
              <span className="workspace-search-preview-text">
                <HighlightedText
                  value={result.preview}
                  query={currentQuery}
                  ranges={result.previewRanges}
                />
              </span>
            )}
          </>
        )}
        renderPreview={(result) =>
          result?.kind === "image" &&
          result.attachmentId &&
          attachmentRepository ? (
            <BufferImagePreview
              key={result.attachmentId}
              attachmentId={result.attachmentId}
              title={result.title}
              repository={attachmentRepository}
            />
          ) : result?.kind === "group" ? (
            <div className="workspace-search-preview-document">
              <p>
                <SymbolText text={result.title} />
              </p>
              <p>整理用グループです。rで同じ削除操作の項目を復元します。</p>
            </div>
          ) : result ? (
            <WorkspaceSearchPreview
              runtime={runtime}
              result={result}
              highlight={session.scope === "body"}
              includeDeleted={session.target === "trash"}
            />
          ) : null
        }
        renderPreviewActions={
          session.target === "trash"
            ? (result) => {
                if (!result) return null;
                const preview = purgePreviewFor(result);
                return (
                  <div className="trash-search-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void restoreResult(result)}
                    >
                      復元 (r)
                    </button>
                    <button
                      type="button"
                      className="sync-danger-button"
                      disabled={busy || !preview?.available}
                      title={preview?.reason}
                      onClick={() => requestPurge(result)}
                    >
                      Trashから削除 (Shift-d)
                    </button>
                  </div>
                );
              }
            : undefined
        }
        prompt={workspaceSearchPrompt(session.target, session.scope)}
        countLabel={response ? `${results.length} results` : "searching…"}
        onAccept={(result) => void openResult(result)}
        onRestore={(result) => void restoreResult(result)}
        onPurge={requestPurge}
        onClose={onClose}
        restoreFocus={session.restoreFocus}
        commandContext={
          session.target === "trash" ? "search.trash" : "search.insert"
        }
        busy={busy}
        error={error}
        empty={
          response &&
          !(session.scope === "body" && query.trim().length === 0) ? (
            <p className="workspace-search-empty">一致するノートがありません</p>
          ) : null
        }
        listFooter={
          response?.migemoUnavailable ||
          (response && response.failures.length > 0) ? (
            <div className="workspace-search-warning" role="status">
              {response.migemoUnavailable && (
                <p>
                  Migemo辞書を読み込めませんでした。通常の検索を使用します。
                </p>
              )}
              {response.failures.length > 0 && (
                <p>
                  {response.failures.length}
                  件のNoteDoc本文を読み込めませんでした。
                </p>
              )}
            </div>
          ) : null
        }
        focused={focused}
        dataAttributes={{
          "data-search-scope": session.scope,
          "data-search-target": session.target,
          "data-search-backend": response?.backend,
          "data-search-diagnostic": response?.warning ?? undefined,
        }}
        idPrefix="workspace-search"
      />
      {pendingPurge && (
        <ModalDialog
          ariaLabel="Trashから削除の確認"
          focusSurface="trash-purge-confirmation"
          busy={busy}
          initialFocus="first-control"
          onClose={() => {
            if (!busy) {
              setPendingPurge(null);
              focusTrashInput();
            }
          }}
        >
          <section data-modal-scroll>
            <h3>Trashから削除しますか？</h3>
            <p>
              「{pendingPurge.title}」を含むノート{pendingPurge.noteCount}
              件、グループ{pendingPurge.groupCount}
              件をTrashから取り除きます。通常の操作では復元できなくなります。
            </p>
            <p>
              <strong>本文データは物理的に消去されません。</strong>
              現在の保存データや過去のバックアップに残る場合があります。
            </p>
            <div className="application-modal-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setPendingPurge(null);
                  focusTrashInput();
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="sync-danger-button"
                disabled={busy}
                onClick={() => void confirmPurge()}
              >
                Trashから削除
              </button>
            </div>
          </section>
        </ModalDialog>
      )}
    </>
  );
}

function SearchResultPath({
  result,
  query,
}: {
  result: WorkspaceSearchResult;
  query: string;
}) {
  const hierarchy = result.parentPath
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
  return (
    <span className="workspace-search-result-path">
      <span className="workspace-search-note-title">
        <SymbolText
          text={result.title}
          highlights={workspaceSearchMatchRanges(
            result.title,
            result.kind === "title" ? query : "",
          )}
        />
      </span>
      {hierarchy && (
        <span className="workspace-search-hierarchy">/{hierarchy}</span>
      )}
      {result.logicalLineNumber !== null && (
        <span className="workspace-search-line-number">
          L{result.logicalLineNumber}
        </span>
      )}
    </span>
  );
}

function formatSearchHierarchy(parentPath: string): string {
  const hierarchy = parentPath
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
  return hierarchy ? `/${hierarchy}` : "/";
}

function HighlightedText({
  value,
  query,
  ranges: suppliedRanges,
}: {
  value: string;
  query: string;
  ranges?: readonly { from: number; to: number }[];
}) {
  const ranges = suppliedRanges ?? workspaceSearchMatchRanges(value, query);
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

function WorkspaceSearchPreview({
  runtime,
  result,
  highlight,
  includeDeleted,
}: {
  runtime: CoreRuntime;
  result: WorkspaceSearchResult | null;
  highlight: boolean;
  includeDeleted: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const releasePreview = useRef<(() => void) | null>(null);
  const loadedNoteId = useRef<string | null>(null);
  const generation = useRef(0);
  const [status, setStatus] = useState<{
    resultId: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    const element = root.current;
    return () => {
      generation.current += 1;
      editor.current?.destroy();
      editor.current = null;
      releasePreview.current?.();
      releasePreview.current = null;
      loadedNoteId.current = null;
      element?.replaceChildren();
    };
  }, []);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const element = root.current;
    if (!element) return;
    if (!result) {
      editor.current?.destroy();
      editor.current = null;
      releasePreview.current?.();
      releasePreview.current = null;
      loadedNoteId.current = null;
      element.replaceChildren();
      return;
    }
    let frame: number | null = null;
    let observer: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const timer = globalThis.setTimeout(() => {
      const publishResult = (): void => {
        if (currentGeneration !== generation.current || !editor.current) {
          return;
        }
        const preview = editor.current;
        const position = highlight
          ? previewBlockPosition(preview, result.blockId)
          : null;
        const transaction = preview.state.tr.setMeta(
          searchPreviewHighlightKey,
          {
            result,
            enabled: highlight,
          } satisfies SearchPreviewHighlightMeta,
        );
        // The viewport plugin renders offscreen BodyChunks as plain text. Put
        // the preview selection in the target block so its chunk is rendered
        // before locating the inline highlight in the DOM.
        if (position !== null) {
          transaction.setSelection(
            TextSelection.near(transaction.doc.resolve(position + 1)),
          );
        }
        preview.view.dispatch(transaction);
        setStatus({ resultId: result.resultId, message: "" });
        if (highlight) {
          const scroll = viewport.current;
          if (!preview || !scroll) return;
          const fallback = previewBlockElement(preview, result.blockId);
          let passes = 0;
          let retries = 0;
          const schedule = (): void => {
            if (frame === null) frame = window.requestAnimationFrame(attempt);
          };
          const attempt = (): void => {
            frame = null;
            if (currentGeneration !== generation.current) return;
            if (centerPreviewMatch(scroll, element, fallback)) {
              passes += 1;
              if (passes < 2) schedule();
              else {
                observer?.disconnect();
                resizeObserver?.disconnect();
              }
            } else if (++retries < 30) {
              schedule();
            }
          };
          observer = new MutationObserver(schedule);
          observer.observe(element, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class", "style"],
          });
          resizeObserver = new ResizeObserver(schedule);
          resizeObserver.observe(scroll);
          schedule();
        } else if (viewport.current) {
          viewport.current.scrollTop = 0;
        }
      };
      if (editor.current && loadedNoteId.current === result.noteId) {
        publishResult();
        return;
      }
      void runtime.loadNotePreview(result.noteId, { includeDeleted }).then(
        (preview) => {
          if (currentGeneration !== generation.current || !root.current) {
            preview.release();
            return;
          }
          editor.current?.destroy();
          releasePreview.current?.();
          root.current.replaceChildren();
          releasePreview.current = preview.release;
          loadedNoteId.current = result.noteId;
          editor.current = new Editor({
            element: root.current,
            editable: false,
            extensions: [
              ...productEditorExtensions(preview.document, {
                resolveInternalLinkTitle: (noteId) =>
                  runtime.resolveInternalLinkTitle(noteId),
                readOnly: true,
              }),
              searchPreviewHighlight(),
            ],
            editorProps: {
              attributes: {
                class: "workspace-search-preview-document",
                "aria-label": `${result.title}のプレビュー`,
              },
            },
          });
          publishResult();
        },
        (cause: unknown) => {
          if (currentGeneration === generation.current) {
            setStatus({
              resultId: result.resultId,
              message: cause instanceof Error ? cause.message : String(cause),
            });
          }
        },
      );
    }, 150);
    return () => {
      globalThis.clearTimeout(timer);
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      resizeObserver?.disconnect();
    };
  }, [highlight, includeDeleted, result, runtime]);

  const message = result
    ? status?.resultId === result.resultId
      ? status.message
      : "loading…"
    : "";

  return (
    <div className="workspace-search-preview-pane">
      <div
        ref={viewport}
        className={`workspace-search-preview-root${highlight ? " workspace-search-preview-root--centerable" : ""}`}
      >
        <div ref={root} />
        {message && (
          <p className="workspace-search-preview-message">{message}</p>
        )}
      </div>
    </div>
  );
}

function previewBlockElement(
  editor: Editor,
  blockId: string | null,
): HTMLElement | null {
  const position = previewBlockPosition(editor, blockId);
  if (position === null) return null;
  const node = editor.view.nodeDOM(position);
  return node instanceof HTMLElement
    ? node
    : node instanceof Text
      ? node.parentElement
      : null;
}

function previewBlockPosition(
  editor: Editor,
  blockId: string | null,
): number | null {
  if (!blockId) return null;
  let position: number | null = null;
  editor.state.doc.descendants((node, nodePosition) => {
    if (node.attrs.blockId !== blockId) return true;
    position = nodePosition;
    return false;
  });
  return position;
}

function centerPreviewMatch(
  viewport: HTMLElement,
  root: HTMLElement,
  fallback: HTMLElement | null,
): boolean {
  const match = root.querySelector<HTMLElement>(
    ".workspace-search-preview-match",
  );
  const target =
    match && match.getBoundingClientRect().height > 0 ? match : fallback;
  if (!target?.isConnected) return false;
  const viewportRect = viewport.getBoundingClientRect();
  const height = viewport.clientHeight || viewportRect.height;
  if (height <= 0) return false;
  viewport.style.setProperty(
    "--workspace-search-preview-padding",
    `${Math.max(22, height / 2 - 16)}px`,
  );
  const targetRect = target.getBoundingClientRect();
  if (targetRect.height <= 0) return false;
  viewport.scrollTop +=
    targetRect.top - viewportRect.top - height / 2 + targetRect.height / 2;
  return true;
}

function workspaceSearchLabel(
  target: WorkspaceSearchTarget,
  scope: WorkspaceSearchScope,
): string {
  if (target === "buffers") return "バッファ検索";
  if (target === "trash") return "ゴミ箱検索";
  return scope === "title" ? "ノート名検索" : "本文検索";
}

function BufferImagePreview({
  attachmentId,
  title,
  repository,
}: {
  attachmentId: string;
  title: string;
  repository: AttachmentRepository;
}) {
  const [failed, setFailed] = useState(false);
  const url = repository.previewUrl(attachmentId);
  if (!url || failed) {
    return <div className="workspace-search-preview-empty" />;
  }
  return (
    <div className="workspace-search-image-preview">
      <img
        src={url}
        alt={title}
        draggable={false}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function workspaceSearchPrompt(
  target: WorkspaceSearchTarget,
  scope: WorkspaceSearchScope,
): string {
  if (target === "buffers") return "b›";
  if (target === "trash") return "trash›";
  return scope === "title" ? "f›" : "s›";
}

interface SearchPreviewHighlightMeta {
  readonly result: WorkspaceSearchResult;
  readonly enabled: boolean;
}

function bodyHighlightRanges(
  text: string,
  result: WorkspaceSearchResult,
): readonly { from: number; to: number }[] {
  if (text === result.lineText && result.lineRanges) return result.lineRanges;
  const terms = workspaceSearchTerms(result.query).map((literal, index) => ({
    literal,
    migemoPattern: result.matchPatterns?.[index] ?? null,
  }));
  return workspaceMatchRanges(text, terms, "body");
}

const searchPreviewHighlightKey = new PluginKey<DecorationSet>(
  "memokaWorkspaceSearchPreviewHighlight",
);

function searchPreviewHighlight(): Extension {
  return Extension.create({
    name: "memokaWorkspaceSearchPreviewHighlight",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: searchPreviewHighlightKey,
          state: {
            init: () => DecorationSet.empty,
            apply: (transaction, previous) => {
              const meta = transaction.getMeta(searchPreviewHighlightKey) as
                SearchPreviewHighlightMeta | undefined;
              if (!meta)
                return previous.map(transaction.mapping, transaction.doc);
              return previewDecorations(
                transaction.doc,
                meta.result,
                meta.enabled,
              );
            },
          },
          props: {
            decorations: (state) => searchPreviewHighlightKey.getState(state),
          },
        }),
      ];
    },
  });
}

function previewDecorations(
  document: ProseMirrorNode,
  result: WorkspaceSearchResult,
  enabled: boolean,
): DecorationSet {
  if (!enabled || !result.blockId || !result.query) {
    return DecorationSet.empty;
  }
  const decorations: Decoration[] = [];
  let matches = 0;
  document.descendants((node, nodePosition) => {
    if (node.attrs.blockId !== result.blockId) return true;
    matches += 1;
    appendPreviewDecorations(decorations, node, nodePosition, result);
    return false;
  });
  // A repaired legacy duplicate may invalidate the disposable indexed
  // blockId. Navigation has a Section-line fallback; preview highlighting can
  // still safely fall back to the first matching logical line.
  if (matches !== 1 && decorations.length === 0) {
    document.descendants((node, nodePosition) => {
      if (!node.isTextblock) return true;
      if (bodyHighlightRanges(node.textContent, result).length < 1) {
        return true;
      }
      appendPreviewDecorations(decorations, node, nodePosition, {
        ...result,
        lineText: node.textContent,
        matchOffset: 0,
        lineMatchOffset: 0,
      });
      return false;
    });
  }
  return DecorationSet.create(document, decorations);
}

function appendPreviewDecorations(
  decorations: Decoration[],
  node: ProseMirrorNode,
  nodePosition: number,
  result: WorkspaceSearchResult,
): void {
  if (node.isTextblock) {
    const sourceOffset = result.matchOffset - result.lineMatchOffset;
    for (const range of bodyHighlightRanges(result.lineText, result)) {
      const from =
        nodePosition +
        1 +
        contentOffsetAtTextOffset(node, sourceOffset + range.from);
      const to =
        nodePosition +
        1 +
        contentOffsetAtTextOffset(node, sourceOffset + range.to);
      if (to > from) {
        decorations.push(
          Decoration.inline(from, to, {
            class: "workspace-search-preview-match",
          }),
        );
      }
    }
    return;
  }
  if (node.isAtom || node.isLeaf) {
    decorations.push(
      Decoration.node(nodePosition, nodePosition + node.nodeSize, {
        class: "workspace-search-preview-match",
      }),
    );
    return;
  }
  node.descendants((child, childOffset) => {
    if (!child.isTextblock) return true;
    const text = child.textBetween(0, child.content.size, "", "\n");
    for (const range of bodyHighlightRanges(text, result)) {
      const from =
        nodePosition +
        1 +
        childOffset +
        1 +
        contentOffsetAtTextOffset(child, range.from);
      const to =
        nodePosition +
        1 +
        childOffset +
        1 +
        contentOffsetAtTextOffset(child, range.to);
      if (to > from) {
        decorations.push(
          Decoration.inline(from, to, {
            class: "workspace-search-preview-match",
          }),
        );
      }
    }
    return true;
  });
}
