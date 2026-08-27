export type VimWordClass = "han" | "hiragana" | "katakana" | "alphanumeric";

type RawVimWordClass = VimWordClass | "kana-shared" | "inherited" | null;

function rawVimWordClass(value: string): RawVimWordClass {
  if (/\p{Script=Han}/u.test(value)) return "han";
  if (/\p{Script=Hiragana}/u.test(value)) return "hiragana";
  if (/\p{Script=Katakana}/u.test(value)) return "katakana";
  if (
    /\p{Script_Extensions=Hiragana}/u.test(value) &&
    /\p{Script_Extensions=Katakana}/u.test(value)
  ) {
    return "kana-shared";
  }
  if (/[\p{L}\p{N}_]/u.test(value)) return "alphanumeric";
  if (/\p{M}/u.test(value)) return "inherited";
  return null;
}

function isResolvedWordClass(value: RawVimWordClass): value is VimWordClass {
  return (
    value === "han" ||
    value === "hiragana" ||
    value === "katakana" ||
    value === "alphanumeric"
  );
}

function adjacentWordClass(
  classes: readonly RawVimWordClass[],
  index: number,
  direction: -1 | 1,
): VimWordClass | null {
  let cursor = index + direction;
  while (classes[cursor] === "kana-shared" || classes[cursor] === "inherited") {
    cursor += direction;
  }
  const candidate = classes[cursor] ?? null;
  return isResolvedWordClass(candidate) ? candidate : null;
}

export function classifyVimWordCharacters(
  characters: readonly string[],
): Array<VimWordClass | null> {
  const raw = characters.map(rawVimWordClass);
  return raw.map((value, index) => {
    if (isResolvedWordClass(value) || value === null) return value;
    const previous = adjacentWordClass(raw, index, -1);
    const next = adjacentWordClass(raw, index, 1);
    if (value === "kana-shared") {
      if (previous === "hiragana" || previous === "katakana") return previous;
      if (next === "hiragana" || next === "katakana") return next;
      return "katakana";
    }
    return previous ?? next;
  });
}
