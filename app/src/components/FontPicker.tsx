import { useCallback, useMemo, useState, type CSSProperties } from "react";
import {
  APPLICATION_FONT_PRESETS,
  filterApplicationFontPresets,
  normalizeApplicationFontFamily,
  type ApplicationFontDefinition,
} from "../core/application-appearance";
import { SearchPane } from "./SearchPane";

export interface FontPickerSession {
  readonly initialFontFamily: string;
  readonly restoreFocus: () => void;
}

export function FontPicker({
  session,
  onPreview,
  onAccept,
  onCancel,
  focused = true,
}: {
  session: FontPickerSession;
  onPreview: (fontFamily: string) => void;
  onAccept: (fontFamily: string) => Promise<void>;
  onCancel: () => void;
  focused?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialItem = useMemo(
    () => fontDefinitionForFamily(session.initialFontFamily),
    [session.initialFontFamily],
  );
  const fonts = useMemo(() => {
    const presets = [...filterApplicationFontPresets(query)];
    if (query.trim().length === 0) {
      return presets.some((font) => font.family === initialItem.family)
        ? presets
        : [initialItem, ...presets];
    }
    const customFamily = normalizeApplicationFontFamily(query);
    if (customFamily && !presets.some((font) => font.family === customFamily)) {
      presets.push(customFontDefinition(customFamily));
    }
    return presets;
  }, [initialItem, query]);
  const preview = useCallback(
    (font: ApplicationFontDefinition | null): void => {
      if (font) onPreview(font.family);
    },
    [onPreview],
  );

  const accept = async (font: ApplicationFontDefinition): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onAccept(font.family);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : `フォントを保存できませんでした: ${String(cause)}`,
      );
      setBusy(false);
    }
  };

  return (
    <SearchPane
      ariaLabel="アプリケーションフォントを選択"
      inputAriaLabel="フォント名またはfont-familyを入力"
      focusSurface="font-picker"
      query={query}
      onQueryChange={(value) => {
        setQuery(value);
        setError(null);
      }}
      items={fonts}
      itemId={(font) => font.id}
      initialSelectedItemId={initialItem.id}
      onSelectionChange={preview}
      renderItem={(font) => (
        <span className="font-picker__row">
          <strong>{font.name}</strong>
          <span>{font.description}</span>
        </span>
      )}
      renderPreview={(font) => <FontPreview font={font} />}
      prompt="font›"
      countLabel={`${fonts.length} fonts`}
      onAccept={(font) => void accept(font)}
      onClose={onCancel}
      restoreFocus={session.restoreFocus}
      busy={busy}
      closeDisabled={busy}
      error={error}
      empty={
        <p className="workspace-search-empty">
          有効なfont-familyを入力してください
        </p>
      }
      focused={focused}
      className="font-picker"
      dataAttributes={{ "data-search-target": "font" }}
      idPrefix="font-picker"
    />
  );
}

function FontPreview({ font }: { font: ApplicationFontDefinition | null }) {
  if (!font) {
    return (
      <div className="workspace-search-preview-pane font-picker__preview" />
    );
  }
  return (
    <div className="workspace-search-preview-pane font-picker__preview">
      <div
        className="font-picker__sample"
        style={{ fontFamily: font.family } as CSSProperties}
      >
        <span className="font-picker__sample-label">{font.family}</span>
        <h2>日本語とABCのノートタイトル</h2>
        <p>Vimの操作感で、Markdownを意識せずサクサク書けるメモ帳。</p>
        <p>
          <strong>Bold 太字</strong> · <em>Italic 斜体</em> · 0123456789
        </p>
        <code>const memoka = "note";</code>
      </div>
    </div>
  );
}

function fontDefinitionForFamily(family: string): ApplicationFontDefinition {
  return (
    APPLICATION_FONT_PRESETS.find((font) => font.family === family) ??
    customFontDefinition(family, "現在のカスタムフォント")
  );
}

function customFontDefinition(
  family: string,
  description = "入力したfont-familyを使用",
): ApplicationFontDefinition {
  return {
    id: `custom:${family}`,
    name: family,
    family,
    description,
  };
}
