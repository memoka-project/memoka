import type { WorkspaceSearchResult } from "./workspace-search";

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const INITIAL_WEIGHTS = [6, 2, 1.5, 0.8, 0.7, 0.5] as const;
const LEARNING_RATE = 0.05;

export interface SearchRankingVisit {
  readonly score: number;
  readonly lastOpenedAt: string;
}

export interface SearchRankingState {
  readonly schemaVersion: 1;
  readonly visits: Readonly<Record<string, SearchRankingVisit>>;
  readonly previousNoteId: string | null;
  readonly weights: readonly number[];
}

export interface SearchRankingContext {
  readonly state: SearchRankingState;
  readonly now: string;
  readonly activeNoteId: string | null;
  readonly openNoteIds: ReadonlySet<string>;
  readonly paths: ReadonlyMap<string, string>;
}

export interface RankedWorkspaceResult {
  readonly result: WorkspaceSearchResult;
  /** Normalized match quality for the Note title or body line. */
  readonly match: number;
  /** Normalized match quality for the Note Tree ancestor path. */
  readonly pathMatch: number;
}

export function emptySearchRankingState(): SearchRankingState {
  return {
    schemaVersion: 1,
    visits: {},
    previousNoteId: null,
    weights: [...INITIAL_WEIGHTS],
  };
}

export function readSearchRankingState(value: unknown): SearchRankingState {
  if (!value || typeof value !== "object") return emptySearchRankingState();
  const candidate = value as Partial<SearchRankingState>;
  if (
    candidate.schemaVersion !== 1 ||
    !candidate.visits ||
    typeof candidate.visits !== "object" ||
    !Array.isArray(candidate.weights) ||
    candidate.weights.length !== INITIAL_WEIGHTS.length ||
    candidate.weights.some(
      (weight) => typeof weight !== "number" || !Number.isFinite(weight),
    )
  ) {
    return emptySearchRankingState();
  }
  const visits: Record<string, SearchRankingVisit> = {};
  for (const [noteId, visit] of Object.entries(candidate.visits)) {
    if (
      visit &&
      typeof visit.score === "number" &&
      Number.isFinite(visit.score) &&
      visit.score >= 0 &&
      typeof visit.lastOpenedAt === "string" &&
      Number.isFinite(Date.parse(visit.lastOpenedAt))
    ) {
      visits[noteId] = visit;
    }
  }
  return {
    schemaVersion: 1,
    visits,
    previousNoteId:
      typeof candidate.previousNoteId === "string"
        ? candidate.previousNoteId
        : null,
    weights: candidate.weights.map((weight, index) =>
      Math.max(
        INITIAL_WEIGHTS[index]! * 0.5,
        Math.min(INITIAL_WEIGHTS[index]! * 2, weight),
      ),
    ),
  };
}

function decayedVisit(
  visit: SearchRankingVisit | undefined,
  now: string,
): number {
  if (!visit) return 0;
  const elapsed = Math.max(0, Date.parse(now) - Date.parse(visit.lastOpenedAt));
  return visit.score * 2 ** (-elapsed / HALF_LIFE_MS);
}

export function recordSearchRankingOpen(
  state: SearchRankingState,
  noteId: string,
  previousNoteId: string | null,
  now: string,
): SearchRankingState {
  const previous = state.visits[noteId];
  return {
    ...state,
    previousNoteId:
      previousNoteId === noteId ? state.previousNoteId : previousNoteId,
    visits: {
      ...state.visits,
      [noteId]: {
        score: decayedVisit(previous, now) + 1,
        lastOpenedAt: now,
      },
    },
  };
}

function proximity(
  left: string | undefined,
  right: string | undefined,
): number {
  if (!left || !right) return 0;
  const a = left.split("/").filter(Boolean);
  const b = right.split("/").filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common])
    common += 1;
  return common / Math.max(1, a.length, b.length);
}

export function rankingFeatures(
  item: RankedWorkspaceResult,
  context: SearchRankingContext,
): readonly number[] {
  const noteId = item.result.noteId;
  const rawVisit = decayedVisit(context.state.visits[noteId], context.now);
  return [
    item.match,
    item.pathMatch,
    rawVisit / (rawVisit + 3),
    context.openNoteIds.has(noteId) ? 1 : 0,
    context.state.previousNoteId === noteId ? 1 : 0,
    proximity(
      context.paths.get(noteId),
      context.activeNoteId
        ? context.paths.get(context.activeNoteId)
        : undefined,
    ),
  ];
}

export function rankingScore(
  item: RankedWorkspaceResult,
  context: SearchRankingContext,
): number {
  return rankingFeatures(item, context).reduce(
    (total, feature, index) =>
      total +
      feature * (context.state.weights[index] ?? INITIAL_WEIGHTS[index]!),
    0,
  );
}

export function rankingNoteScore(
  noteId: string,
  context: SearchRankingContext,
): number {
  const features = rankingFeatures(
    {
      result: { noteId } as WorkspaceSearchResult,
      match: 0,
      pathMatch: 0,
    },
    context,
  );
  return features.reduce(
    (total, feature, index) =>
      total +
      feature * (context.state.weights[index] ?? INITIAL_WEIGHTS[index]!),
    0,
  );
}

export function rankWorkspaceResults(
  items: readonly RankedWorkspaceResult[],
  context: SearchRankingContext,
  limit: number,
): RankedWorkspaceResult[] {
  return [...items]
    .sort(
      (a, b) =>
        rankingScore(b, context) - rankingScore(a, context) ||
        b.result.updatedAt.localeCompare(a.result.updatedAt) ||
        a.result.noteId.localeCompare(b.result.noteId) ||
        (a.result.logicalLineNumber ?? 0) - (b.result.logicalLineNumber ?? 0),
    )
    .slice(0, limit);
}

export function learnSearchRankingSelection(
  state: SearchRankingState,
  selected: RankedWorkspaceResult,
  skipped: readonly RankedWorkspaceResult[],
  context: SearchRankingContext,
): SearchRankingState {
  if (skipped.length === 0) return state;
  const chosen = rankingFeatures(selected, context);
  const upper = skipped.map((item) => rankingFeatures(item, context));
  return {
    ...state,
    weights: state.weights.map((weight, index) => {
      const average =
        upper.reduce((sum, features) => sum + (features[index] ?? 0), 0) /
        upper.length;
      const learned = weight + LEARNING_RATE * ((chosen[index] ?? 0) - average);
      return Math.max(
        INITIAL_WEIGHTS[index]! * 0.5,
        Math.min(INITIAL_WEIGHTS[index]! * 2, learned),
      );
    }),
  };
}
