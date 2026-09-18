import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { iconTokens } from "../core/symbols";
import {
  SYMBOL_SPACE_CLASS,
  symbolSpacingOffsets,
} from "../core/symbol-spacing";
import { loadSymbolIcons, symbolIconMask } from "../editor/symbol-icons";

export function SymbolIcon({ name }: { name: string }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    let active = true;
    void loadSymbolIcons()
      .then(() => {
        if (active) refresh((value) => value + 1);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const mask = symbolIconMask(name);
  return mask ? (
    <span
      role="img"
      aria-label={name}
      className="memoka-symbol-icon"
      style={{ "--symbol-mask": mask } as CSSProperties}
    />
  ) : (
    <span>{`:lucide-${name}:`}</span>
  );
}

/** Display-only title renderer. Never use for editable inputs or persisted HTML. */
export function SymbolText({
  text,
  highlights = [],
}: {
  text: string;
  highlights?: readonly { from: number; to: number }[];
}) {
  const tokens = iconTokens(text);
  const spaces = symbolSpacingOffsets(text, tokens);
  return (
    <>
      {tokens.map((token, index) => {
        const prefix = highlightedText(
          text,
          tokens[index - 1]?.to ?? 0,
          token.from,
          highlights,
          spaces,
        );
        const icon = <SymbolIcon name={token.name} />;
        return (
          <span key={token.from}>
            {prefix}
            {spaces.includes(token.from) && (
              <span className={SYMBOL_SPACE_CLASS} aria-hidden="true" />
            )}
            {highlights.some(
              (range) => range.from < token.to && range.to > token.from,
            ) ? (
              <mark className="workspace-search-match">{icon}</mark>
            ) : (
              icon
            )}
          </span>
        );
      })}
      {highlightedText(
        text,
        tokens.at(-1)?.to ?? 0,
        text.length,
        highlights,
        spaces,
      )}
    </>
  );
}

function highlightedText(
  text: string,
  from: number,
  to: number,
  ranges: readonly { from: number; to: number }[],
  spaces: readonly number[],
): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = from;
  for (const offset of spaces) {
    if (offset < from || offset >= to) continue;
    parts.push(highlightedSegment(text, cursor, offset, ranges));
    parts.push(
      <span
        key={`space:${offset}`}
        className={SYMBOL_SPACE_CLASS}
        aria-hidden="true"
      />,
    );
    cursor = offset;
  }
  parts.push(highlightedSegment(text, cursor, to, ranges));
  return parts;
}

function highlightedSegment(
  text: string,
  from: number,
  to: number,
  ranges: readonly { from: number; to: number }[],
): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = from;
  for (const range of ranges) {
    const start = Math.max(cursor, range.from);
    const end = Math.min(to, range.to);
    if (start >= end) continue;
    if (cursor < start) parts.push(text.slice(cursor, start));
    parts.push(
      <mark className="workspace-search-match" key={start}>
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < to) parts.push(text.slice(cursor, to));
  return parts;
}
