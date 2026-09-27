import type { EditorState } from "@tiptap/pm/state";
import { NodeSelection } from "@tiptap/pm/state";
import { defaultVimBlockSemantics } from "./block-semantics";
import { graphemes } from "./graphemes";
import {
  containsJapaneseText,
  segmentVimWordCharacters,
} from "./word-semantics";

export type VimFindDirection = 1 | -1;

export interface VimFindHint {
  label: string;
  position: number;
  character: string;
}

interface FindLine {
  positions: number[];
  characters: string[];
  cursor: number;
}

const LOWERCASE_HINT_ALPHABET = "asdfghjklqwertyuiopzxcvbnm";
const UPPERCASE_HINT_ALPHABET = LOWERCASE_HINT_ALPHABET.toUpperCase();
const HINT_SUFFIX_ALPHABET = [...LOWERCASE_HINT_ALPHABET];
const MAX_HINTS_PER_INITIAL = HINT_SUFFIX_ALPHABET.length ** 2;

function currentFindLine(
  state: EditorState,
  cursorOverride?: number,
): FindLine | null {
  const lines = defaultVimBlockSemantics.logicalLines({ state });
  if (lines.length === 0) return null;
  const cursor =
    cursorOverride ??
    (state.selection instanceof NodeSelection
      ? state.selection.from
      : state.selection.head);
  const line = lines[defaultVimBlockSemantics.currentLineIndex(lines, cursor)];
  if (!line || line.kind === "block-atom") return null;
  const positions = line.cursorPositions;
  // A TableRow's `to` is its last cursor position, unlike a text line's end.
  const lineEnd = line.blockNodeName === "tableRow" ? line.blockTo : line.to;
  const characters = positions.map((position, index) => {
    const next = Math.min(positions[index + 1] ?? lineEnd, lineEnd);
    if (next <= position) return "";
    return (
      graphemes(state.doc.textBetween(position, next, "", "\uFFFC"))[0] ?? ""
    );
  });
  return { positions, characters, cursor };
}

export function vimFindCharacterDestination(
  state: EditorState,
  direction: VimFindDirection,
  character: string,
  count: number,
  cursorOverride?: number,
): number | null {
  return (
    vimFindMotionTarget(
      state,
      direction,
      character,
      count,
      false,
      cursorOverride,
    )?.destination ?? null
  );
}

export interface VimFindMotionTarget {
  match: number;
  destination: number;
}

export function vimFindMotionTarget(
  state: EditorState,
  direction: VimFindDirection,
  character: string,
  count: number,
  till: boolean,
  cursorOverride?: number,
  skipMatch?: number,
): VimFindMotionTarget | null {
  const current = currentFindLine(state, cursorOverride);
  if (!current) return null;
  const matches = current.positions.flatMap((position, index) =>
    (direction === 1 ? position > current.cursor : position < current.cursor) &&
    current.characters[index] === character &&
    position !== skipMatch
      ? [position]
      : [],
  );
  if (direction === -1) matches.reverse();
  const match = matches[Math.max(1, count) - 1];
  if (match === undefined) return null;
  const destination = till
    ? current.positions[current.positions.indexOf(match) - direction]
    : match;
  return destination === undefined ? null : { match, destination };
}

/** Resolve an exact phrase hint without re-searching for its first character. */
export function vimFindHintMotionTarget(
  state: EditorState,
  direction: VimFindDirection,
  hint: VimFindHint,
  till: boolean,
  cursorOverride?: number,
): VimFindMotionTarget | null {
  const current = currentFindLine(state, cursorOverride);
  if (!current) return null;
  const index = current.positions.indexOf(hint.position);
  if (
    index < 0 ||
    current.characters[index] !== hint.character ||
    (direction === 1
      ? hint.position <= current.cursor
      : hint.position >= current.cursor)
  )
    return null;
  const destination = till
    ? current.positions[index - direction]
    : hint.position;
  return destination === undefined
    ? null
    : { match: hint.position, destination };
}

/** Expand less-preferred slots first; leave short labels for nearer phrases. */
function allocateHintLabels(
  count: number,
  initials: readonly string[],
  suffixAlphabet: string = LOWERCASE_HINT_ALPHABET,
): string[] {
  if (count <= 0 || initials.length === 0) return [];
  const singles = [...initials];
  const doubles: string[] = [];
  const triples: string[] = [];
  const initialOrder = initials.join("");
  const compare = (left: string, right: string): number => {
    for (let index = 0; index < left.length; index += 1) {
      const order = index === 0 ? initialOrder : suffixAlphabet;
      const difference =
        order.indexOf(left[index]!) - order.indexOf(right[index]!);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  let slots = singles.length;
  let sortedDoubles = false;
  while (slots < count) {
    if (singles.length > 0) {
      const prefix = singles.pop()!;
      doubles.push(...[...suffixAlphabet].map((letter) => prefix + letter));
    } else if (doubles.length > 0) {
      if (!sortedDoubles) {
        doubles.sort(compare);
        sortedDoubles = true;
      }
      const prefix = doubles.pop()!;
      triples.push(...[...suffixAlphabet].map((letter) => prefix + letter));
    } else {
      break;
    }
    slots += suffixAlphabet.length - 1;
  }
  return [...singles, ...doubles, ...triples]
    .sort((left, right) => {
      if (left.length !== right.length) return left.length - right.length;
      return compare(left, right);
    })
    .slice(0, count);
}

/** Exhaust lowercase labels of up to three keys before using uppercase. */
export function allocateVimFindHintLabels(
  count: number,
  reserved: ReadonlySet<string>,
): string[] {
  const lowercase = [...LOWERCASE_HINT_ALPHABET].filter(
    (letter) => !reserved.has(letter),
  );
  const uppercase = [...UPPERCASE_HINT_ALPHABET].filter(
    (letter) => !reserved.has(letter),
  );
  const lowercaseCount = Math.min(
    count,
    lowercase.length * MAX_HINTS_PER_INITIAL,
  );
  return [
    ...allocateHintLabels(lowercaseCount, lowercase),
    ...allocateHintLabels(count - lowercaseCount, uppercase),
  ];
}

/** Uppercase-only labels keep lowercase search input unambiguous. */
export function allocateVimSearchHintLabels(count: number): string[] {
  return allocateHintLabels(
    Math.min(count, UPPERCASE_HINT_ALPHABET.length ** 3),
    [...UPPERCASE_HINT_ALPHABET],
    UPPERCASE_HINT_ALPHABET,
  );
}

export function vimFindHints(
  state: EditorState,
  direction: VimFindDirection,
  cursorOverride?: number,
): VimFindHint[] {
  const current = currentFindLine(state, cursorOverride);
  if (!current) return [];
  const { positions, characters, cursor } = current;
  const hardBoundaryBefore = positions.map(
    (position, index) =>
      index > 0 &&
      position !==
        (positions[index - 1] ?? 0) + (characters[index - 1] ?? "").length,
  );
  const segments = segmentVimWordCharacters(characters, hardBoundaryBefore);
  const starts: Array<{ position: number; character: string }> = [];
  for (let index = 0; index < positions.length; index += 1) {
    const segment = segments[index];
    const position = positions[index]!;
    const character = characters[index] ?? "";
    if (
      segment === null ||
      segment === segments[index - 1] ||
      (direction === 1 ? position <= cursor : position >= cursor) ||
      !character
    )
      continue;
    let text = "";
    for (
      let next = index;
      next < positions.length && segments[next] === segment;
      next += 1
    ) {
      text += characters[next];
    }
    if (containsJapaneseText(text)) starts.push({ position, character });
  }
  if (direction === -1) starts.reverse();
  const reserved = new Set(
    characters.flatMap((character, index) =>
      /^[a-zA-Z]$/u.test(character) &&
      (direction === 1
        ? positions[index]! > cursor
        : positions[index]! < cursor)
        ? [character]
        : [],
    ),
  );
  const labels = allocateVimFindHintLabels(starts.length, reserved);
  return starts.slice(0, labels.length).map((start, index) => ({
    ...start,
    label: labels[index]!,
  }));
}
