import { useCallback, useMemo, useState, type CSSProperties } from "react";
import {
  applicationTheme,
  filterApplicationThemes,
  type ApplicationThemeDefinition,
  type ApplicationThemeId,
} from "../core/application-theme";
import { SearchPane } from "./SearchPane";

export interface ThemePickerSession {
  readonly initialThemeId: ApplicationThemeId;
  readonly restoreFocus: () => void;
}

export function ThemePicker({
  session,
  onPreview,
  onAccept,
  onCancel,
  focused = true,
}: {
  session: ThemePickerSession;
  onPreview: (theme: ApplicationThemeId) => void;
  onAccept: (theme: ApplicationThemeId) => Promise<void>;
  onCancel: () => void;
  focused?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const themes = useMemo(() => filterApplicationThemes(query), [query]);
  const preview = useCallback(
    (theme: ApplicationThemeDefinition | null): void => {
      if (theme) onPreview(theme.id);
    },
    [onPreview],
  );

  const accept = async (theme: ApplicationThemeDefinition): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onAccept(theme.id);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : `テーマを保存できませんでした: ${String(cause)}`,
      );
      setBusy(false);
    }
  };

  return (
    <SearchPane
      ariaLabel="カラーテーマを選択"
      inputAriaLabel="カラーテーマを検索"
      focusSurface="theme-picker"
      query={query}
      onQueryChange={(value) => {
        setQuery(value);
        setError(null);
      }}
      items={themes}
      itemId={(theme) => theme.id}
      initialSelectedItemId={session.initialThemeId}
      onSelectionChange={preview}
      renderItem={(theme) => (
        <span className="theme-picker__row">
          <strong>{theme.name}</strong>
          <span>{theme.appearance === "dark" ? "Dark" : "Light"}</span>
        </span>
      )}
      renderPreview={(theme) => <ThemePreview theme={theme} />}
      prompt="colo›"
      countLabel={`${themes.length} themes`}
      onAccept={(theme) => void accept(theme)}
      onClose={onCancel}
      restoreFocus={session.restoreFocus}
      busy={busy}
      closeDisabled={busy}
      error={error}
      empty={
        <p className="workspace-search-empty">一致するテーマがありません</p>
      }
      focused={focused}
      className="theme-picker"
      dataAttributes={{ "data-search-target": "theme" }}
      idPrefix="theme-picker"
    />
  );
}

function ThemePreview({ theme }: { theme: ApplicationThemeDefinition | null }) {
  if (!theme) {
    return (
      <div className="workspace-search-preview-pane theme-picker__preview" />
    );
  }
  const sample = applicationTheme(theme.id);
  const style = {
    "--theme-preview-bg": sample.tokens.canvas,
    "--theme-preview-surface": sample.tokens.surfaceRaised,
    "--theme-preview-text": sample.tokens.text,
    "--theme-preview-muted": sample.tokens.textMuted,
    "--theme-preview-focus": sample.tokens.focus,
    "--theme-preview-selection": sample.tokens.selectionStrong,
    "--theme-preview-heading": sample.tokens.markupHeading1,
    "--theme-preview-strong": sample.tokens.markupStrong,
    "--theme-preview-italic": sample.tokens.markupItalic,
    "--theme-preview-raw": sample.tokens.markupRaw,
    "--theme-preview-link-url": sample.tokens.markupLinkUrl,
    "--theme-preview-link-reference": sample.tokens.markupLinkReference,
  } as CSSProperties;
  const swatches = [
    sample.palette.red,
    sample.palette.orange,
    sample.palette.yellow,
    sample.palette.green,
    sample.palette.cyan,
    sample.palette.blue,
    sample.palette.magenta,
  ];
  return (
    <div className="workspace-search-preview-pane theme-picker__preview">
      <div className="theme-picker__sample" style={style}>
        <div className="theme-picker__sample-tabs">
          <span className="theme-picker__sample-tab">Memoka</span>
        </div>
        <div className="theme-picker__sample-body">
          <span className="theme-picker__sample-gutter">12</span>
          <div>
            <strong className="theme-picker__sample-heading">
              {sample.name}
            </strong>
            <p>
              <strong className="theme-picker__sample-strong">太字</strong>
              <em className="theme-picker__sample-italic">斜体</em>
              <code className="theme-picker__sample-code">inline code</code>
            </p>
            <p>
              <span className="theme-picker__sample-external-link">
                外部リンク
              </span>
              <span className="theme-picker__sample-internal-link">
                内部リンク
              </span>
            </p>
            <p className="theme-picker__sample-selection">選択中のテキスト</p>
          </div>
        </div>
        <div className="theme-picker__swatches" aria-label="テーマ配色">
          {swatches.map((color) => (
            <span key={color} style={{ backgroundColor: color }} />
          ))}
        </div>
      </div>
    </div>
  );
}
