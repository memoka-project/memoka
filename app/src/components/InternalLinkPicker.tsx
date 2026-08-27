import {
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  completionOptionId,
  type InternalLinkCompletionSnapshot,
} from "../editor/internal-link-completion";

export interface InternalLinkPickerProps {
  completion: InternalLinkCompletionSnapshot;
  onSelect: (sectionId: string) => void;
}

export function InternalLinkPicker({
  completion,
  onSelect,
}: InternalLinkPickerProps) {
  const selectedOption = useRef<HTMLDivElement>(null);
  const style = {
    left: completion.anchor.left,
    top: completion.anchor.top,
  } satisfies CSSProperties;
  const keepEditorFocus = (event: MouseEvent): void => event.preventDefault();
  const selectedSectionId =
    completion.candidates[completion.selectedIndex]?.sectionId ?? null;
  useLayoutEffect(() => {
    selectedOption.current?.scrollIntoView?.({ block: "nearest" });
  }, [completion.selectedIndex, selectedSectionId]);

  return createPortal(
    <div
      id={completion.popupId}
      className="internal-link-picker"
      role="listbox"
      aria-label="内部リンク候補"
      style={style}
      onMouseDown={keepEditorFocus}
    >
      <div className="internal-link-picker__heading">
        <span>INTERNAL LINK</span>
        <span>[[{completion.query}</span>
      </div>
      <div className="internal-link-picker__results">
        {completion.candidates.length > 0 ? (
          completion.candidates.map((candidate, index) => {
            const selected = index === completion.selectedIndex;
            return (
              <div
                id={completionOptionId(completion.popupId, candidate.sectionId)}
                key={candidate.sectionId}
                className={`internal-link-picker__option${selected ? " internal-link-picker__option--selected" : ""}`}
                role="option"
                aria-selected={selected}
                ref={selected ? selectedOption : undefined}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(candidate.sectionId);
                }}
              >
                <span className="internal-link-picker__title">
                  {candidate.title}
                </span>
                <span className="internal-link-picker__context">
                  {candidate.parentPath} · {candidate.shortId}
                </span>
              </div>
            );
          })
        ) : (
          <p className="internal-link-picker__empty">
            一致するSectionがありません
          </p>
        )}
      </div>
      <div className="internal-link-picker__guide">
        ↑↓ / Ctrl-n/p 選択 · Enter / Tab 挿入 · Esc 閉じる
      </div>
    </div>,
    document.body,
  );
}
