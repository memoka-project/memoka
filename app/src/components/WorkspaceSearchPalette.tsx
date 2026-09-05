import { Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EditorNavigationDestination } from "../core/editor-navigation";
import { contentOffsetAtTextOffset } from "../core/stable-position";
import type { StableEditorPosition } from "../core/stable-position";
import type { CoreRuntime } from "../core/runtime";
import type { AttachmentRepository } from "../core/attachments";
import {
  formatWorkspaceSearchAge,
  normalizeWorkspaceSearchText,
  workspaceSearchMatchRanges,
  workspaceSearchTerms,
  type WorkspaceSearchResponse,
  type WorkspaceSearchResult,
  type WorkspaceSearchScope,
  type WorkspaceSearchTarget,
} from "../core/workspace-search";
import { productEditorExtensions } from "../editor/extensions";
import { SearchPane } from "./SearchPane";

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
      .searchWorkspace(debouncedQuery, session.scope, 20, session.target)
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
    debouncedQuery,
    refreshVersion,
  ]);

  const openResult = async (result: WorkspaceSearchResult): Promise<void> => {
    if (busy || session.target === "trash") return;
    setBusy(true);
    setError(null);
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
      await runtime.restoreNoteFromTrash(result.noteId);
      setSearchState(null);
      setRefreshVersion((version) => version + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
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
            <span className="workspace-search-age">
              {formatWorkspaceSearchAge(result.updatedAt)}
            </span>
            <span className="workspace-search-icon" aria-hidden="true">
              {result.kind === "image" ? "📷" : "📄"}
            </span>
            {session.scope === "title" ? (
              <span className="workspace-search-note-title">
                <HighlightedText value={result.title} query={currentQuery} />
              </span>
            ) : (
              <SearchResultPath result={result} query={currentQuery} />
            )}
          </span>
          {session.scope === "title" && (
            <span className="workspace-search-title-hierarchy">
              <HighlightedText
                value={formatSearchHierarchy(result.parentPath)}
                query={currentQuery}
              />
            </span>
          )}
          {session.scope === "body" && (
            <span className="workspace-search-preview-text">
              <HighlightedText value={result.preview} query={currentQuery} />
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
        ) : result ? (
          <WorkspaceSearchPreview
            runtime={runtime}
            result={result}
            highlight={session.scope === "body"}
            includeDeleted={session.target === "trash"}
          />
        ) : null
      }
      prompt={workspaceSearchPrompt(session.target, session.scope)}
      countLabel={response ? `${results.length} results` : "searching…"}
      onAccept={(result) => void openResult(result)}
      onRestore={(result) => void restoreResult(result)}
      onClose={onClose}
      restoreFocus={session.restoreFocus}
      commandContext={
        session.target === "trash" ? "search.trash" : "search.insert"
      }
      busy={busy}
      error={error}
      empty={
        response && !(session.scope === "body" && query.trim().length === 0) ? (
          <p className="workspace-search-empty">一致するノートがありません</p>
        ) : null
      }
      listFooter={
        response && response.failures.length > 0 ? (
          <p className="workspace-search-warning" role="status">
            {response.failures.length}
            件のNoteDoc本文を読み込めませんでした。
          </p>
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
      {hierarchy && (
        <span className="workspace-search-hierarchy">{hierarchy}/</span>
      )}
      <span className="workspace-search-note-title">
        <HighlightedText
          value={result.title}
          query={result.kind === "title" ? query : ""}
        />
      </span>
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

function HighlightedText({ value, query }: { value: string; query: string }) {
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
    const timer = globalThis.setTimeout(() => {
      const publishResult = (): void => {
        if (currentGeneration !== generation.current || !editor.current) {
          return;
        }
        editor.current.view.dispatch(
          editor.current.state.tr.setMeta(searchPreviewHighlightKey, {
            result,
            enabled: highlight,
          } satisfies SearchPreviewHighlightMeta),
        );
        setStatus({ resultId: result.resultId, message: "" });
        if (highlight) {
          window.requestAnimationFrame(() => {
            if (currentGeneration !== generation.current) return;
            root.current
              ?.querySelector<HTMLElement>(".workspace-search-preview-match")
              ?.scrollIntoView?.({ block: "center", inline: "nearest" });
          });
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
  return scope === "title" ? "f›" : "g›";
}

interface SearchPreviewHighlightMeta {
  readonly result: WorkspaceSearchResult;
  readonly enabled: boolean;
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
      if (
        workspaceSearchMatchRanges(node.textContent, result.query).length < 1
      ) {
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
    for (const range of workspaceSearchMatchRanges(
      result.lineText,
      result.query,
    )) {
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
    for (const range of workspaceSearchMatchRanges(text, result.query)) {
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
