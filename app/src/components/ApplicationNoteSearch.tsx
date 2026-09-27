import { useCallback, useEffect, useRef, useState } from "react";
import type { CoreRuntime, NoteSearchNavigationResult } from "../core/runtime";
import type { EditorNavigationDestination } from "../core/editor-navigation";
import {
  noteSearchStatusMessage,
  type NoteSearchDirection,
  type NoteSearchOrigin,
  type NoteSearchLocation,
} from "../core/note-search";
import {
  matchNoteFuzzyWords,
  migemoPatternForQuery,
  type NoteFuzzyWord,
} from "../core/note-fuzzy-search";
import { loadNoteMigemo } from "../core/note-migemo";
import { allocateVimSearchHintLabels } from "../vim/find-character";
import {
  commandLineKeySequence,
  commandLineKeymap,
} from "../core/command-line-keymap";

export interface ApplicationNoteSearchSession {
  readonly windowId: string;
  readonly direction: NoteSearchDirection;
  readonly origin: NoteSearchOrigin;
  readonly applyDestination: (
    destination: EditorNavigationDestination,
    detail: string,
  ) => string | null;
  readonly requestInputMethodDeactivation: () => void;
  readonly restoreFocus: () => void;
  readonly focusResult?: () => void;
  readonly visibleWords?: () => readonly NoteFuzzyWord[];
  readonly locationAt?: (position: number) => NoteSearchLocation | null;
  readonly showHints?: (
    hints: readonly { label: string; position: number }[],
    typed: string,
  ) => void;
  readonly clearHints?: () => void;
  readonly viewport?: () => HTMLElement | null;
  readonly onViewChange?: (listener: () => void) => () => void;
}

interface NoteSearchHint {
  readonly label: string;
  readonly position: number;
}

const MIGEMO_INPUT = /^[a-z][a-z-]*$/u;

export function ApplicationNoteSearch({
  runtime,
  session,
  onClose,
  onMessage,
  focused = true,
}: {
  runtime: CoreRuntime;
  session: ApplicationNoteSearchSession;
  onClose: () => void;
  onMessage: (message: string) => void;
  focused?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const raw = useRef("");
  const labelPrefix = useRef("");
  const literal = useRef(false);
  const hints = useRef<readonly NoteSearchHint[]>([]);
  const migemoPattern = useRef("");
  const loading = useRef(false);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const closed = useRef(false);

  const clearHints = useCallback(() => {
    hints.current = [];
    loading.current = false;
    generation.current += 1;
    session.clearHints?.();
  }, [session]);

  const close = useCallback((): void => {
    closed.current = true;
    clearHints();
    session.requestInputMethodDeactivation();
    onClose();
    queueMicrotask(session.restoreFocus);
  }, [clearHints, onClose, session]);

  const finishNavigation = useCallback(
    (navigation: NoteSearchNavigationResult, query: string): boolean => {
      if (!navigation.handled) {
        const message = noteSearchError(
          navigation.detail,
          navigation.query ?? query,
        );
        if (navigation.detail.startsWith("search:note:not-found:")) {
          onMessage(message);
          close();
          return false;
        }
        setError(message);
        return false;
      }
      if (
        navigation.destination &&
        !session.applyDestination(navigation.destination, navigation.detail)
      ) {
        setError("一致位置を現在のEditorへ反映できませんでした");
        return false;
      }
      const message = noteSearchStatusMessage(navigation);
      if (message) onMessage(message);
      closed.current = true;
      clearHints();
      session.requestInputMethodDeactivation();
      onClose();
      requestAnimationFrame(session.focusResult ?? session.restoreFocus);
      return true;
    },
    [clearHints, close, onClose, onMessage, session],
  );

  const executeHint = useCallback(
    async (hint: NoteSearchHint, query: string, pattern: string) => {
      if (busyRef.current || closed.current) return;
      const location = session.locationAt?.(hint.position);
      if (!location) {
        setError("検索候補の位置が変わりました");
        clearHints();
        return;
      }
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const navigation = await runtime.selectFuzzyNoteSearch(
          session.windowId,
          session.origin,
          query,
          pattern,
          location,
          session.direction,
        );
        finishNavigation(navigation, query);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [clearHints, finishNavigation, runtime, session],
  );

  const refreshHints = useCallback(
    async (query: string): Promise<void> => {
      if (!session.visibleWords || !session.showHints || !query) {
        clearHints();
        return;
      }
      const current = ++generation.current;
      loading.current = true;
      hints.current = [];
      session.showHints([], "");
      try {
        const migemo = await loadNoteMigemo();
        if (current !== generation.current || closed.current || literal.current)
          return;
        const pattern = migemoPatternForQuery(migemo, query);
        migemoPattern.current = pattern;
        const results = matchNoteFuzzyWords(
          session.visibleWords(),
          query,
          pattern,
        );
        const labels = allocateVimSearchHintLabels(results.length);
        hints.current = results
          .slice(0, labels.length)
          .map((result, index) => ({
            label: labels[index]!,
            position: result.position,
          }));
        loading.current = false;
        const prefix = labelPrefix.current;
        if (
          prefix &&
          !hints.current.some(({ label }) => label.startsWith(prefix))
        ) {
          literal.current = true;
          clearHints();
          return;
        }
        session.showHints(hints.current, prefix);
        const selected = hints.current.find(({ label }) => label === prefix);
        if (selected) void executeHint(selected, query, pattern);
      } catch (cause) {
        if (current !== generation.current || closed.current) return;
        literal.current = true;
        clearHints();
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [clearHints, executeHint, session],
  );

  useEffect(() => {
    input.current?.focus();
    const viewport = session.viewport?.();
    const refresh = () => {
      if (literal.current || !raw.current) return;
      const query = raw.current.slice(
        0,
        raw.current.length - labelPrefix.current.length,
      );
      void refreshHints(query);
    };
    viewport?.addEventListener("scroll", refresh);
    window.addEventListener("resize", refresh);
    const unsubscribe = session.onViewChange?.(refresh);
    return () => {
      unsubscribe?.();
      viewport?.removeEventListener("scroll", refresh);
      window.removeEventListener("resize", refresh);
    };
  }, [refreshHints, session]);

  useEffect(
    () => () => {
      closed.current = true;
      generation.current += 1;
      session.clearHints?.();
    },
    [session],
  );

  const execute = async (): Promise<void> => {
    if (busyRef.current) return;
    const query = raw.current;
    const fuzzy =
      !literal.current && query.length <= 128 && MIGEMO_INPUT.test(query);
    busyRef.current = true;
    setBusy(true);
    setError(null);
    clearHints();
    try {
      let navigation: NoteSearchNavigationResult;
      if (fuzzy) {
        const migemo = await loadNoteMigemo().catch(() => null);
        navigation = migemo
          ? await runtime.searchFuzzyNote(
              session.windowId,
              session.origin,
              query,
              migemoPatternForQuery(migemo, query),
              session.direction,
            )
          : await runtime.searchNote(
              session.windowId,
              session.origin,
              query,
              1,
              session.direction,
            );
      } else {
        navigation = await runtime.searchNote(
          session.windowId,
          session.origin,
          query,
          1,
          session.direction,
        );
      }
      finishNavigation(navigation, query);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const inputValue = (next: string): void => {
    raw.current = next;
    setValue(next);
    setError(null);
    if (literal.current) return;
    if (!MIGEMO_INPUT.test(next)) {
      literal.current = next.length > 0;
      labelPrefix.current = "";
      clearHints();
      return;
    }
    labelPrefix.current = "";
    void refreshHints(next);
  };

  return (
    <div
      className={`application-commandline application-commandline--active focus-surface${focused ? " focus-surface--focused" : ""}`}
      data-memoka-focus-surface="note-search"
    >
      <span className="commandline-prompt">
        {session.direction === "forward" ? "/" : "?"}
      </span>
      <input
        ref={input}
        value={value}
        aria-label="ノート内を検索"
        autoComplete="off"
        spellCheck="false"
        readOnly={busy}
        aria-busy={busy}
        onChange={(event) => {
          inputValue(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Backspace" && labelPrefix.current) {
            event.preventDefault();
            raw.current = raw.current.slice(0, -1);
            labelPrefix.current = labelPrefix.current.slice(0, -1);
            setValue(raw.current);
            session.showHints?.(hints.current, labelPrefix.current);
            return;
          }
          const sequence = commandLineKeySequence(event);
          if (!sequence) return;
          const command = commandLineKeymap.resolve(
            "command-line.insert",
            sequence,
          );
          if (command) {
            event.preventDefault();
            if (command === "command-line.close") close();
            else void execute();
            return;
          }
          if (!/^[A-Z]$/u.test(event.key) || event.ctrlKey) return;
          event.preventDefault();
          const next = raw.current + event.key;
          if (literal.current || !raw.current) {
            literal.current = true;
            clearHints();
            raw.current = next;
            setValue(next);
            return;
          }
          const prefix = labelPrefix.current + event.key;
          if (
            hints.current.some(({ label }) => label.startsWith(prefix)) ||
            loading.current
          ) {
            raw.current = next;
            setValue(next);
            labelPrefix.current = prefix;
            session.showHints?.(hints.current, prefix);
            const selected = hints.current.find(
              ({ label }) => label === prefix,
            );
            if (selected) {
              const query = raw.current.slice(0, -prefix.length);
              void executeHint(selected, query, migemoPattern.current);
            }
            return;
          }
          literal.current = true;
          clearHints();
          raw.current = next;
          setValue(next);
        }}
      />
      {error && (
        <span className="commandline-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function noteSearchError(detail: string, query: string): string {
  if (detail === "search:note:no-pattern") {
    return "前回の検索パターンがありません";
  }
  if (detail.startsWith("search:note:not-found:")) {
    return `パターンが見つかりません: ${query}`;
  }
  if (detail === "search:note:stale-target") {
    return "検索候補の位置が変わりました";
  }
  return detail;
}
