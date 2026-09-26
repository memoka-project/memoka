import type { Migemo } from "jsmigemo";
import { normalizeWorkspaceSearchText } from "./workspace-search";

const JAPANESE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export interface WorkspaceQueryTerm {
  readonly literal: string;
  readonly migemoPattern: string | null;
}

export interface WorkspaceTextMatch {
  readonly score: number;
  readonly ranges: readonly { from: number; to: number }[];
  readonly source: "literal" | "fuzzy" | "migemo";
}

/** Only the same unambiguous romaji form as Note search invokes Migemo. */
export function compileWorkspaceQuery(
  query: string,
  migemo: Migemo | null,
): WorkspaceQueryTerm[] {
  const terms = new Map<string, WorkspaceQueryTerm>();
  for (const word of query.trim().split(/\s+/u).filter(Boolean)) {
    const literal = normalizeWorkspaceSearchText(word);
    const migemoPattern =
      migemo && /^[a-z][a-z-]*$/u.test(word) && word.length <= 128
        ? migemo.query(word)
        : null;
    const previous = terms.get(literal);
    if (!previous || (!previous.migemoPattern && migemoPattern)) {
      terms.set(literal, { literal, migemoPattern });
    }
  }
  return [...terms.values()];
}

function sourceRange(
  text: string,
  normalizedFrom: number,
  normalizedTo: number,
): { from: number; to: number } {
  let from = 0;
  let to = text.length;
  let source = 0;
  for (const character of text) {
    source += character.length;
    const next = normalizeWorkspaceSearchText(text.slice(0, source));
    if (next.length <= normalizedFrom) from = source;
    if (next.length >= normalizedTo) {
      to = source;
      break;
    }
  }
  return { from, to: Math.max(from + 1, to) };
}

function fuzzyMatch(text: string, term: string): WorkspaceTextMatch | null {
  if (!term) return null;
  const normalized = normalizeWorkspaceSearchText(text);
  const direct = normalized.indexOf(term);
  if (direct >= 0) {
    return {
      score: direct === 0 ? 1 : 0.92,
      ranges: [sourceRange(text, direct, direct + term.length)],
      source: "literal",
    };
  }
  let cursor = 0;
  const positions: number[] = [];
  for (const character of term) {
    const found = normalized.indexOf(character, cursor);
    if (found < 0) return null;
    positions.push(found);
    cursor = found + character.length;
  }
  const span = positions.at(-1)! - positions[0]! + 1;
  const score = Math.max(0.15, Math.min(0.85, term.length / span));
  return {
    score,
    ranges: positions.map((position) =>
      sourceRange(text, position, position + 1),
    ),
    source: "fuzzy",
  };
}

function migemoMatch(
  text: string,
  pattern: string | null,
  literal: string,
): WorkspaceTextMatch | null {
  if (!pattern) return null;
  for (const match of text.matchAll(new RegExp(pattern, "gi"))) {
    if (!match[0]) continue;
    if (
      !JAPANESE_SCRIPT.test(match[0]) &&
      !normalizeWorkspaceSearchText(match[0]).includes(literal)
    ) {
      continue;
    }
    return {
      score: 0.9,
      ranges: [{ from: match.index, to: match.index + match[0].length }],
      source: "migemo",
    };
  }
  return null;
}

export function matchWorkspaceTitleTerm(
  text: string,
  term: WorkspaceQueryTerm,
): WorkspaceTextMatch | null {
  const fuzzy = fuzzyMatch(text, term.literal);
  const migemo = migemoMatch(text, term.migemoPattern, term.literal);
  if (!fuzzy) return migemo;
  if (!migemo || fuzzy.score >= migemo.score) return fuzzy;
  return migemo;
}

export function matchWorkspaceBodyTerm(
  text: string,
  term: WorkspaceQueryTerm,
): WorkspaceTextMatch | null {
  const normalized = normalizeWorkspaceSearchText(text);
  const index = normalized.indexOf(term.literal);
  const literal: WorkspaceTextMatch | null =
    index < 0
      ? null
      : {
          score: 1,
          ranges: [sourceRange(text, index, index + term.literal.length)],
          source: "literal",
        };
  return literal ?? migemoMatch(text, term.migemoPattern, term.literal);
}

export function matchWorkspaceBodyLine(
  text: string,
  terms: readonly WorkspaceQueryTerm[],
): { score: number; ranges: readonly { from: number; to: number }[] } | null {
  if (terms.length === 0) return null;
  const matches = terms.map((term) => matchWorkspaceBodyTerm(text, term));
  if (matches.some((match) => !match)) return null;
  return {
    score:
      matches.reduce((sum, match) => sum + (match?.score ?? 0), 0) /
      matches.length,
    ranges: mergeWorkspaceMatchRanges(
      matches.flatMap((match) => match?.ranges ?? []),
    ),
  };
}

export function mergeWorkspaceMatchRanges(
  ranges: readonly { from: number; to: number }[],
): Array<{ from: number; to: number }> {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function workspaceMatchRanges(
  text: string,
  terms: readonly WorkspaceQueryTerm[],
  mode: "title" | "body",
): Array<{ from: number; to: number }> {
  const ranges = terms.flatMap((term) => {
    const match =
      mode === "title"
        ? matchWorkspaceTitleTerm(text, term)
        : matchWorkspaceBodyTerm(text, term);
    return match?.ranges ?? [];
  });
  return mergeWorkspaceMatchRanges(ranges);
}
