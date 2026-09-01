import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  searchKeySequence,
  searchKeymap,
  type SearchKeymapContext,
} from "../core/search-keymap";

export interface SearchPaneProps<Item> {
  readonly ariaLabel: string;
  readonly inputAriaLabel: string;
  readonly focusSurface: string;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** Best match first. The pane presents the best match nearest the input. */
  readonly items: readonly Item[];
  readonly itemId: (item: Item) => string;
  readonly renderItem: (item: Item, query: string) => ReactNode;
  readonly renderPreview: (item: Item | null) => ReactNode;
  readonly prompt: ReactNode;
  readonly countLabel: ReactNode;
  readonly onAccept?: (item: Item) => void;
  readonly onRestore?: (item: Item) => void;
  readonly initialSelectedItemId?: string | null;
  readonly onSelectionChange?: (item: Item | null) => void;
  readonly onClose: () => void;
  readonly restoreFocus: () => void;
  readonly commandContext?: SearchKeymapContext;
  readonly busy?: boolean;
  readonly closeDisabled?: boolean;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  readonly listFooter?: ReactNode;
  readonly focused?: boolean;
  readonly className?: string;
  readonly dataAttributes?: Readonly<Record<string, string | undefined>>;
  readonly idPrefix?: string;
}

export function SearchPane<Item>({
  ariaLabel,
  inputAriaLabel,
  focusSurface,
  query,
  onQueryChange,
  items,
  itemId,
  renderItem,
  renderPreview,
  prompt,
  countLabel,
  onAccept,
  onRestore,
  initialSelectedItemId = null,
  onSelectionChange,
  onClose,
  restoreFocus,
  commandContext = "search.insert",
  busy = false,
  closeDisabled = false,
  error = null,
  empty = null,
  listFooter = null,
  focused = true,
  className = "",
  dataAttributes = {},
  idPrefix = "search-pane",
}: SearchPaneProps<Item>) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(
    initialSelectedItemId,
  );
  const displayedItems = useMemo(() => [...items].reverse(), [items]);
  const requestedIndex = selectedItemId
    ? displayedItems.findIndex((item) => itemId(item) === selectedItemId)
    : -1;
  const selectedIndex =
    requestedIndex >= 0
      ? requestedIndex
      : Math.max(0, displayedItems.length - 1);
  const selected = displayedItems[selectedIndex] ?? null;
  const listId = `${idPrefix}-results`;

  useEffect(() => {
    onSelectionChange?.(selected);
  }, [onSelectionChange, selected]);

  useEffect(() => {
    queueMicrotask(() => {
      if (list.current) list.current.scrollTop = list.current.scrollHeight;
    });
  }, [displayedItems]);

  useEffect(() => {
    const selectedElement = list.current?.querySelector<HTMLElement>(
      `#${idPrefix}-result-${selectedIndex}`,
    );
    selectedElement?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [displayedItems, idPrefix, selectedIndex]);

  useEffect(() => {
    const focusInput = (): void => {
      if (input.current?.isConnected) input.current.focus();
    };
    focusInput();
    queueMicrotask(focusInput);
    const frame = window.requestAnimationFrame(focusInput);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const close = (): void => {
    if (closeDisabled) return;
    onClose();
    queueMicrotask(restoreFocus);
  };

  return (
    <section
      className={`workspace-search-overlay search-pane focus-surface${focused ? " focus-surface--focused" : ""}${className ? ` ${className}` : ""}`}
      aria-label={ariaLabel}
      data-memoka-focus-surface={focusSurface}
      {...dataAttributes}
    >
      <div className="workspace-search-left search-pane__left">
        <div
          ref={list}
          id={listId}
          className="workspace-search-list search-pane__list"
          role="listbox"
          aria-label="検索結果"
        >
          {displayedItems.map((item, index) => (
            <button
              id={`${idPrefix}-result-${index}`}
              key={itemId(item)}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className={`workspace-search-row search-pane__row${index === selectedIndex ? " workspace-search-row--selected search-pane__row--selected" : ""}`}
              disabled={busy}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setSelectedItemId(itemId(item))}
            >
              {renderItem(item, query)}
            </button>
          ))}
          {displayedItems.length === 0 && empty}
        </div>
        {listFooter}
        <div className="workspace-search-input-row search-pane__input-row">
          <span className="workspace-search-prompt search-pane__prompt">
            {prompt}
          </span>
          <input
            ref={input}
            value={query}
            role="combobox"
            aria-label={inputAriaLabel}
            aria-controls={listId}
            aria-expanded="true"
            aria-activedescendant={
              selected ? `${idPrefix}-result-${selectedIndex}` : undefined
            }
            autoComplete="off"
            spellCheck="false"
            readOnly={busy}
            aria-busy={busy}
            onChange={(event) => {
              setSelectedItemId(null);
              onQueryChange(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              const sequence = searchKeySequence(event);
              if (!sequence) return;
              const command = searchKeymap.resolve(commandContext, sequence);
              if (!command) return;
              event.preventDefault();
              if (command === "search.close") {
                close();
              } else if (command === "search.select_next") {
                const next =
                  displayedItems[
                    Math.min(selectedIndex + 1, displayedItems.length - 1)
                  ];
                if (next) setSelectedItemId(itemId(next));
              } else if (command === "search.select_previous") {
                const previous = displayedItems[Math.max(0, selectedIndex - 1)];
                if (previous) setSelectedItemId(itemId(previous));
              } else if (command === "search.restore" && selected) {
                onRestore?.(selected);
              } else if (command === "search.accept" && selected) {
                onAccept?.(selected);
              }
            }}
          />
          {error && <span className="workspace-search-error">{error}</span>}
          <span className="workspace-search-count" role="status">
            {countLabel}
          </span>
        </div>
      </div>
      {renderPreview(selected)}
    </section>
  );
}
