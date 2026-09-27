import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ApplicationNoteSearch,
  type ApplicationNoteSearchSession,
} from "../app/src/components/ApplicationNoteSearch";
import type {
  CoreRuntime,
  NoteSearchNavigationResult,
} from "../app/src/core/runtime";
import {
  noteFuzzyWords,
  type NoteFuzzyWord,
} from "../app/src/core/note-fuzzy-search";
import type {
  NoteSearchDirection,
  NoteSearchLocation,
  NoteSearchOrigin,
} from "../app/src/core/note-search";
import { loadNoteMigemo } from "../app/src/core/note-migemo";

vi.mock("../app/src/core/note-migemo", () => ({
  loadNoteMigemo: vi.fn(async () => ({
    query: (query: string) =>
      query === "kensaku" ? "検索" : query === "no-to" ? "ノート" : query,
  })),
}));

function harness(
  customWords?: NoteFuzzyWord[],
  direction: NoteSearchDirection = "forward",
) {
  const origin = {
    stable: { noteId: "note-1" },
    location: { sectionId: "note-1", blockId: "block-1", offset: 0 },
  } as NoteSearchOrigin;
  const defaultWords = [
    ...noteFuzzyWords(
      ["k", "e", "n", "s", "a", "k", "u"],
      [10, 11, 12, 13, 14, 15, 16],
    ),
    ...noteFuzzyWords(["検", "索"], [30, 31]),
  ];
  const words = customWords ?? defaultWords;
  const showHints = vi.fn();
  const clearHints = vi.fn();
  const onClose = vi.fn();
  const onMessage = vi.fn();
  const searchNote = vi.fn(
    async (
      _windowId,
      _origin,
      query: string,
    ): Promise<NoteSearchNavigationResult> => ({
      handled: true,
      detail: "search:note:forward:1/1",
      query,
      matchCount: 1,
      matchIndex: 0,
      wrapped: false,
    }),
  );
  const searchFuzzyNote = vi.fn(
    async (
      _windowId: string,
      _origin: NoteSearchOrigin,
      query: string,
      _pattern: string,
    ): Promise<NoteSearchNavigationResult> => {
      void _pattern;
      return {
        handled: true,
        detail: "search:note:forward:1/2",
        query,
        matchCount: 2,
        matchIndex: 0,
        wrapped: false,
      };
    },
  );
  const selectFuzzyNoteSearch = vi.fn(
    async (
      _windowId: string,
      _origin: NoteSearchOrigin,
      query: string,
      _pattern: string,
      _location: NoteSearchLocation,
      _direction: NoteSearchDirection,
    ) => {
      void _pattern;
      void _location;
      void _direction;
      return {
        handled: true,
        detail: "search:note:forward:2/2",
        destination: null,
        query,
        matchCount: 2,
        matchIndex: 1,
        wrapped: false,
      };
    },
  );
  const session: ApplicationNoteSearchSession = {
    windowId: "window-1",
    direction,
    origin,
    applyDestination: vi.fn(() => "search:note:forward:1/1"),
    requestInputMethodDeactivation: vi.fn(),
    restoreFocus: vi.fn(),
    visibleWords: () => words,
    locationAt: (position) => ({
      sectionId: "note-1",
      blockId: "block-1",
      offset: position,
    }),
    showHints,
    clearHints,
    viewport: () => null,
  };
  render(
    <ApplicationNoteSearch
      runtime={
        {
          searchNote,
          searchFuzzyNote,
          selectFuzzyNoteSearch,
        } as unknown as CoreRuntime
      }
      session={session}
      onClose={onClose}
      onMessage={onMessage}
    />,
  );
  const input = screen.getByRole("textbox", { name: "ノート内を検索" });
  return {
    input,
    session,
    showHints,
    clearHints,
    onClose,
    onMessage,
    searchNote,
    searchFuzzyNote,
    selectFuzzyNoteSearch,
  };
}

describe("Note fuzzy search input", () => {
  it("uses a backward prompt and searches Migemo backward on Enter", async () => {
    const { input, searchFuzzyNote, onMessage } = harness([], "backward");
    expect(input.closest(".application-commandline")?.textContent).toContain(
      "?",
    );
    fireEvent.change(input, { target: { value: "kensaku" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(searchFuzzyNote).toHaveBeenCalledTimes(1));
    expect(searchFuzzyNote).toHaveBeenCalledWith(
      "window-1",
      expect.anything(),
      "kensaku",
      "検索",
      "backward",
    );
    expect(onMessage).toHaveBeenCalled();
  });

  it("keeps backward direction after selecting a hint", async () => {
    const { input, showHints, selectFuzzyNoteSearch } = harness(
      undefined,
      "backward",
    );
    fireEvent.change(input, { target: { value: "kensaku" } });
    await waitFor(() => expect(showHints.mock.lastCall?.[0]).toHaveLength(2));
    const entries = showHints.mock.lastCall?.[0] as Array<{
      label: string;
      position: number;
    }>;
    const label = entries.find(({ position }) => position === 30)?.label;
    expect(label).toBeDefined();
    for (const letter of label!) fireEvent.keyDown(input, { key: letter });
    await waitFor(() => expect(selectFuzzyNoteSearch).toHaveBeenCalledTimes(1));
    expect(selectFuzzyNoteSearch.mock.lastCall?.[5]).toBe("backward");
  });

  it("keeps a question mark inside the query on the literal path", async () => {
    const { input, searchNote, searchFuzzyNote } = harness();
    fireEvent.change(input, { target: { value: "no?to" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(searchNote).toHaveBeenCalledTimes(1));
    expect(searchNote).toHaveBeenCalledWith(
      "window-1",
      expect.anything(),
      "no?to",
      1,
      "forward",
    );
    expect(searchFuzzyNote).not.toHaveBeenCalled();
  });

  it("keeps a hyphenated romaji query in Migemo mode", async () => {
    const words = noteFuzzyWords(["ノ", "ー", "ト"], [30, 31, 32]);
    const { input, showHints, searchNote, searchFuzzyNote } = harness(words);
    fireEvent.change(input, { target: { value: "no-" } });
    fireEvent.change(input, { target: { value: "no-to" } });
    await waitFor(() =>
      expect(showHints).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ position: 30 })]),
        "",
      ),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(searchFuzzyNote).toHaveBeenCalledTimes(1));
    expect(searchFuzzyNote).toHaveBeenCalledWith(
      "window-1",
      expect.anything(),
      "no-to",
      "ノート",
      "forward",
    );
    expect(searchNote).not.toHaveBeenCalled();
  });

  it("returns to Normal mode after Enter finds no literal match", async () => {
    const { input, searchNote, onClose, onMessage, session } = harness();
    searchNote.mockResolvedValueOnce({
      handled: false,
      detail: "search:note:not-found:NASA",
      query: "NASA",
      matchCount: 0,
      matchIndex: null,
      wrapped: false,
    });
    fireEvent.change(input, { target: { value: "NASA" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onMessage).toHaveBeenCalledWith("パターンが見つかりません: NASA");
    expect(session.requestInputMethodDeactivation).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(session.restoreFocus).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("searches Migemo words on Enter without choosing a visible hint", async () => {
    const { input, searchNote, searchFuzzyNote, onClose } = harness([]);
    fireEvent.change(input, { target: { value: "kensaku" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(searchFuzzyNote).toHaveBeenCalledTimes(1));
    expect(searchFuzzyNote).toHaveBeenCalledWith(
      "window-1",
      expect.anything(),
      "kensaku",
      "検索",
      "forward",
    );
    expect(searchNote).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns to Normal with an error when Enter finds no fuzzy match", async () => {
    const { input, searchFuzzyNote, onMessage, onClose } = harness([]);
    searchFuzzyNote.mockResolvedValueOnce({
      handled: false,
      detail: "search:note:not-found:kensaku",
      query: "kensaku",
      matchCount: 0,
      matchIndex: null,
      wrapped: false,
    });
    fireEvent.change(input, { target: { value: "kensaku" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onMessage).toHaveBeenCalledWith("パターンが見つかりません: kensaku");
  });

  it("retains literal Enter search when the offline Migemo dictionary fails", async () => {
    vi.mocked(loadNoteMigemo).mockRejectedValueOnce(
      new Error("辞書を読み込めません"),
    );
    const { input, searchNote, showHints } = harness();
    fireEvent.change(input, { target: { value: "kensaku" } });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "辞書を読み込めません",
      ),
    );
    expect(
      showHints.mock.calls.every(([entries]) => entries.length === 0),
    ).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(searchNote).toHaveBeenCalledTimes(1));
    expect(searchNote.mock.lastCall?.[2]).toBe("kensaku");
  });

  it("filters a two-letter uppercase hint while keeping the lowercase query", async () => {
    const words = Array.from(
      { length: 30 },
      (_, index) => noteFuzzyWords(["a"], [index + 100])[0]!,
    );
    const { input, showHints, selectFuzzyNoteSearch } = harness(words);
    fireEvent.change(input, { target: { value: "a" } });
    await waitFor(() => expect(showHints.mock.lastCall?.[0]).toHaveLength(30));
    const entries = showHints.mock.lastCall?.[0] as Array<{
      label: string;
      position: number;
    }>;
    const target = entries.find(({ label }) => label.length === 2);
    expect(target).toBeDefined();
    fireEvent.keyDown(input, { key: target!.label[0] });
    expect(showHints).toHaveBeenLastCalledWith(entries, target!.label[0]);
    fireEvent.keyDown(input, { key: target!.label[1] });
    await waitFor(() => expect(selectFuzzyNoteSearch).toHaveBeenCalledTimes(1));
    expect(selectFuzzyNoteSearch.mock.lastCall?.[2]).toBe("a");
    expect(selectFuzzyNoteSearch.mock.lastCall?.[4]).toMatchObject({
      offset: target!.position,
    });
  });

  it("shows uppercase hints and commits only lowercase query on a label jump", async () => {
    const { input, showHints, onClose, selectFuzzyNoteSearch, searchNote } =
      harness();
    fireEvent.change(input, { target: { value: "kensaku" } });
    await waitFor(() =>
      expect(showHints).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ position: 30 })]),
        "",
      ),
    );
    const entries = showHints.mock.lastCall?.[0] as Array<{
      label: string;
      position: number;
    }>;
    const label = entries.find(({ position }) => position === 30)?.label;
    expect(label).toMatch(/^[A-Z]{1,3}$/u);
    for (const letter of label!) fireEvent.keyDown(input, { key: letter });
    await waitFor(() => expect(selectFuzzyNoteSearch).toHaveBeenCalledTimes(1));
    expect(selectFuzzyNoteSearch).toHaveBeenCalledWith(
      "window-1",
      expect.anything(),
      "kensaku",
      "検索",
      { sectionId: "note-1", blockId: "block-1", offset: 30 },
      "forward",
    );
    expect(searchNote).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Enter and non-label uppercase input on the literal search path", async () => {
    const { input, showHints, searchNote, selectFuzzyNoteSearch } = harness();
    fireEvent.change(input, { target: { value: "kensaku" } });
    await waitFor(() => expect(showHints.mock.lastCall?.[0]).toHaveLength(2));
    fireEvent.keyDown(input, { key: "Z" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(searchNote).toHaveBeenCalledTimes(1));
    expect(searchNote).toHaveBeenCalledWith(
      "window-1",
      expect.anything(),
      "kensakuZ",
      1,
      "forward",
    );
    expect(selectFuzzyNoteSearch).not.toHaveBeenCalled();
  });

  it("accepts a multi-character uppercase-start literal query", async () => {
    const { input, searchNote, showHints } = harness();
    fireEvent.keyDown(input, { key: "N" });
    fireEvent.change(input, { target: { value: "NASA" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(searchNote).toHaveBeenCalledTimes(1));
    expect(searchNote).toHaveBeenCalledWith(
      "window-1",
      expect.anything(),
      "NASA",
      1,
      "forward",
    );
    expect(showHints).not.toHaveBeenCalled();
  });
});
