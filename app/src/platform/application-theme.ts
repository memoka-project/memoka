import {
  applicationTheme,
  type ApplicationThemeId,
  type ApplicationThemeTokens,
} from "../core/application-theme";

export const APPLICATION_THEME_DATA_ATTRIBUTE = "data-memoka-theme";
export const APPLICATION_THEME_APPEARANCE_DATA_ATTRIBUTE =
  "data-memoka-theme-appearance";

const TOKEN_VARIABLES: Readonly<
  Record<keyof ApplicationThemeTokens, `--memoka-color-${string}`>
> = {
  canvas: "--memoka-color-canvas",
  canvasGlow: "--memoka-color-canvas-glow",
  workspaceGap: "--memoka-color-workspace-gap",
  chrome: "--memoka-color-chrome",
  surface: "--memoka-color-surface",
  surfaceRaised: "--memoka-color-surface-raised",
  surfaceHover: "--memoka-color-surface-hover",
  surfaceInset: "--memoka-color-surface-inset",
  overlaySurface: "--memoka-color-overlay-surface",
  overlayBackdrop: "--memoka-color-overlay-backdrop",
  shadow: "--memoka-color-shadow",
  text: "--memoka-color-text",
  textStrong: "--memoka-color-text-strong",
  textMuted: "--memoka-color-text-muted",
  textSubtle: "--memoka-color-text-subtle",
  textInverse: "--memoka-color-text-inverse",
  border: "--memoka-color-border",
  borderSubtle: "--memoka-color-border-subtle",
  focus: "--memoka-color-focus",
  focusMuted: "--memoka-color-focus-muted",
  link: "--memoka-color-link",
  linkMuted: "--memoka-color-link-muted",
  selection: "--memoka-color-selection",
  selectionStrong: "--memoka-color-selection-strong",
  selectionBorder: "--memoka-color-selection-border",
  selectionText: "--memoka-color-selection-text",
  selectionMuted: "--memoka-color-selection-muted",
  caretNormal: "--memoka-color-caret-normal",
  caretNormalFill: "--memoka-color-caret-normal-fill",
  caretVisual: "--memoka-color-caret-visual",
  caretVisualFill: "--memoka-color-caret-visual-fill",
  caretShadow: "--memoka-color-caret-shadow",
  caretInsert: "--memoka-color-caret-insert",
  info: "--memoka-color-info",
  success: "--memoka-color-success",
  successSurface: "--memoka-color-success-surface",
  warning: "--memoka-color-warning",
  warningSurface: "--memoka-color-warning-surface",
  danger: "--memoka-color-danger",
  dangerText: "--memoka-color-danger-text",
  dangerSurface: "--memoka-color-danger-surface",
  dangerSelected: "--memoka-color-danger-selected",
  dangerBorder: "--memoka-color-danger-border",
  searchMatchSurface: "--memoka-color-search-match-surface",
  searchMatchBorder: "--memoka-color-search-match-border",
  codeText: "--memoka-color-code-text",
  codeSurface: "--memoka-color-code-surface",
  quote: "--memoka-color-quote",
  horizontalRule: "--memoka-color-horizontal-rule",
  markupStrong: "--memoka-color-markup-strong",
  markupItalic: "--memoka-color-markup-italic",
  markupStrikethrough: "--memoka-color-markup-strikethrough",
  markupRaw: "--memoka-color-markup-raw",
  markupLinkUrl: "--memoka-color-markup-link-url",
  markupLinkReference: "--memoka-color-markup-link-reference",
  markupHeading1: "--memoka-color-markup-heading-1",
  markupHeading2: "--memoka-color-markup-heading-2",
  markupHeading3: "--memoka-color-markup-heading-3",
  markupHeading4: "--memoka-color-markup-heading-4",
  markupHeading5: "--memoka-color-markup-heading-5",
  markupHeading6: "--memoka-color-markup-heading-6",
};

export type ApplicationThemeCssProperties = Readonly<
  Record<`--memoka-color-${string}`, string>
>;

export function applicationThemeCssProperties(
  themeId: ApplicationThemeId,
): ApplicationThemeCssProperties {
  const tokens = applicationTheme(themeId).tokens;
  return Object.fromEntries(
    Object.entries(TOKEN_VARIABLES).map(([token, variable]) => [
      variable,
      tokens[token as keyof ApplicationThemeTokens],
    ]),
  ) as ApplicationThemeCssProperties;
}

export function applyApplicationTheme(
  target: HTMLElement,
  themeId: ApplicationThemeId,
): void {
  const theme = applicationTheme(themeId);
  target.setAttribute(APPLICATION_THEME_DATA_ATTRIBUTE, theme.id);
  target.setAttribute(
    APPLICATION_THEME_APPEARANCE_DATA_ATTRIBUTE,
    theme.appearance,
  );
  target.style.colorScheme = theme.appearance;
  for (const [name, value] of Object.entries(
    applicationThemeCssProperties(themeId),
  )) {
    target.style.setProperty(name, value);
  }
}
