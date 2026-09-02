/**
 * Nightfox palette data is derived from EdenEast/nightfox.nvim at commit
 * 4dacd3f0185a2227bdf3b6c0975a8f0bf87cac9a (MIT, James Simpson).
 *
 * Memoka intentionally consumes the stable palette values, not Neovim
 * highlight groups. Components use the semantic token layer below and never
 * depend directly on a Nightfox palette field.
 */

export const APPLICATION_THEME_IDS = [
  "nightfox",
  "dayfox",
  "dawnfox",
  "duskfox",
  "nordfox",
  "terafox",
  "carbonfox",
] as const;

export type ApplicationThemeId = (typeof APPLICATION_THEME_IDS)[number];
export type ApplicationThemeAppearance = "dark" | "light";
export type MarkupHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export const DEFAULT_APPLICATION_THEME_ID: ApplicationThemeId = "nightfox";

export interface ApplicationThemePalette {
  readonly bg0: string;
  readonly bg1: string;
  readonly bg2: string;
  readonly bg3: string;
  readonly bg4: string;
  readonly fg0: string;
  readonly fg1: string;
  readonly fg2: string;
  readonly fg3: string;
  readonly selection: string;
  readonly selectionStrong: string;
  readonly comment: string;
  readonly black: string;
  readonly red: string;
  readonly green: string;
  readonly yellow: string;
  readonly blue: string;
  readonly magenta: string;
  readonly cyan: string;
  readonly white: string;
  readonly orange: string;
  readonly pink: string;
}

export interface ApplicationThemeTokens {
  readonly canvas: string;
  readonly canvasGlow: string;
  readonly workspaceGap: string;
  readonly chrome: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly surfaceHover: string;
  readonly surfaceInset: string;
  readonly overlaySurface: string;
  readonly overlayBackdrop: string;
  readonly shadow: string;
  readonly text: string;
  readonly textStrong: string;
  readonly textMuted: string;
  readonly textSubtle: string;
  readonly textInverse: string;
  readonly border: string;
  readonly borderSubtle: string;
  readonly focus: string;
  readonly focusMuted: string;
  readonly link: string;
  readonly linkMuted: string;
  readonly selection: string;
  readonly selectionStrong: string;
  readonly selectionBorder: string;
  readonly selectionText: string;
  readonly selectionMuted: string;
  readonly caretNormal: string;
  readonly caretNormalFill: string;
  readonly caretVisual: string;
  readonly caretVisualFill: string;
  readonly caretShadow: string;
  readonly caretInsert: string;
  readonly info: string;
  readonly success: string;
  readonly successSurface: string;
  readonly warning: string;
  readonly warningSurface: string;
  readonly danger: string;
  readonly dangerText: string;
  readonly dangerSurface: string;
  readonly dangerSelected: string;
  readonly dangerBorder: string;
  readonly searchMatchSurface: string;
  readonly searchMatchBorder: string;
  readonly codeText: string;
  readonly codeSurface: string;
  readonly quote: string;
  readonly horizontalRule: string;
  readonly markupStrong: string;
  readonly markupItalic: string;
  readonly markupStrikethrough: string;
  readonly markupRaw: string;
  readonly markupLinkUrl: string;
  readonly markupLinkReference: string;
  readonly markupHeading1: string;
  readonly markupHeading2: string;
  readonly markupHeading3: string;
  readonly markupHeading4: string;
  readonly markupHeading5: string;
  readonly markupHeading6: string;
}

export interface ApplicationThemeDefinition {
  readonly id: ApplicationThemeId;
  readonly name: string;
  readonly appearance: ApplicationThemeAppearance;
  readonly palette: ApplicationThemePalette;
  readonly tokens: ApplicationThemeTokens;
}

interface ThemeSource {
  readonly id: ApplicationThemeId;
  readonly name: string;
  readonly appearance: ApplicationThemeAppearance;
  readonly palette: ApplicationThemePalette;
}

const SOURCES: readonly ThemeSource[] = [
  {
    id: "nightfox",
    name: "Nightfox",
    appearance: "dark",
    palette: palette({
      bg: ["#131a24", "#192330", "#212e3f", "#29394f", "#39506d"],
      fg: ["#d6d6d7", "#cdcecf", "#aeafb0", "#71839b"],
      selection: ["#2b3b51", "#3c5372"],
      comment: "#738091",
      accents: [
        "#393b44",
        "#c94f6d",
        "#81b29a",
        "#dbc074",
        "#719cd6",
        "#9d79d6",
        "#63cdcf",
        "#dfdfe0",
        "#f4a261",
        "#d67ad2",
      ],
    }),
  },
  {
    id: "dayfox",
    name: "Dayfox",
    appearance: "light",
    palette: palette({
      bg: ["#e4dcd4", "#f6f2ee", "#dbd1dd", "#d3c7bb", "#aab0ad"],
      fg: ["#302b5d", "#3d2b5a", "#643f61", "#824d5b"],
      selection: ["#e7d2be", "#a4c1c2"],
      comment: "#837a72",
      accents: [
        "#352c24",
        "#a5222f",
        "#396847",
        "#ac5402",
        "#2848a9",
        "#6e33ce",
        "#287980",
        "#f2e9e1",
        "#955f61",
        "#a440b5",
      ],
    }),
  },
  {
    id: "dawnfox",
    name: "Dawnfox",
    appearance: "light",
    palette: palette({
      bg: ["#ebe5df", "#faf4ed", "#ebe0df", "#ebdfe4", "#bdbfc9"],
      fg: ["#4c4769", "#575279", "#625c87", "#a8a3b3"],
      selection: ["#d0d8d8", "#b8cece"],
      comment: "#9893a5",
      accents: [
        "#575279",
        "#b4637a",
        "#618774",
        "#ea9d34",
        "#286983",
        "#907aa9",
        "#56949f",
        "#e5e9f0",
        "#d7827e",
        "#d685af",
      ],
    }),
  },
  {
    id: "duskfox",
    name: "Duskfox",
    appearance: "dark",
    palette: palette({
      bg: ["#191726", "#232136", "#2d2a45", "#373354", "#4b4673"],
      fg: ["#eae8ff", "#e0def4", "#cdcbe0", "#6e6a86"],
      selection: ["#433c59", "#63577d"],
      comment: "#817c9c",
      accents: [
        "#393552",
        "#eb6f92",
        "#a3be8c",
        "#f6c177",
        "#569fba",
        "#c4a7e7",
        "#9ccfd8",
        "#e0def4",
        "#ea9a97",
        "#eb98c3",
      ],
    }),
  },
  {
    id: "nordfox",
    name: "Nordfox",
    appearance: "dark",
    palette: palette({
      bg: ["#232831", "#2e3440", "#39404f", "#444c5e", "#5a657d"],
      fg: ["#c7cdd9", "#cdcecf", "#abb1bb", "#7e8188"],
      selection: ["#3e4a5b", "#4f6074"],
      comment: "#60728a",
      accents: [
        "#3b4252",
        "#bf616a",
        "#a3be8c",
        "#ebcb8b",
        "#81a1c1",
        "#b48ead",
        "#88c0d0",
        "#e5e9f0",
        "#c9826b",
        "#bf88bc",
      ],
    }),
  },
  {
    id: "terafox",
    name: "Terafox",
    appearance: "dark",
    palette: palette({
      bg: ["#0f1c1e", "#152528", "#1d3337", "#254147", "#2d4f56"],
      fg: ["#eaeeee", "#e6eaea", "#cbd9d8", "#587b7b"],
      selection: ["#293e40", "#425e5e"],
      comment: "#6d7f8b",
      accents: [
        "#2f3239",
        "#e85c51",
        "#7aa4a1",
        "#fda47f",
        "#5a93aa",
        "#ad5c7c",
        "#a1cdd8",
        "#ebebeb",
        "#ff8349",
        "#cb7985",
      ],
    }),
  },
  {
    id: "carbonfox",
    name: "Carbonfox",
    appearance: "dark",
    palette: palette({
      bg: ["#0c0c0c", "#161616", "#252525", "#353535", "#535353"],
      fg: ["#f9fbff", "#f2f4f8", "#b6b8bb", "#7a7b7d"],
      selection: ["#2a2a2a", "#525253"],
      comment: "#6e6f70",
      accents: [
        "#282828",
        "#ee5396",
        "#25be6a",
        "#08bdba",
        "#78a9ff",
        "#be95ff",
        "#33b1ff",
        "#dfdfe0",
        "#3ddbd9",
        "#ff7eb6",
      ],
    }),
  },
];

export const APPLICATION_THEMES: readonly ApplicationThemeDefinition[] =
  SOURCES.map((source) => ({
    ...source,
    tokens: semanticTokens(source.palette),
  }));

const THEMES_BY_ID = new Map(
  APPLICATION_THEMES.map((theme) => [theme.id, theme] as const),
);

export function isApplicationThemeId(
  value: string,
): value is ApplicationThemeId {
  return THEMES_BY_ID.has(value as ApplicationThemeId);
}

export function applicationTheme(
  id: ApplicationThemeId,
): ApplicationThemeDefinition {
  const theme = THEMES_BY_ID.get(id);
  if (!theme) throw new Error(`Unknown application theme: ${id}`);
  return theme;
}

export function normalizeApplicationThemeId(
  value: string,
): ApplicationThemeId | null {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return isApplicationThemeId(normalized) ? normalized : null;
}

/** Maps the displayed Root to H1 and repeats the H1-H6 colors after H6. */
export function markupHeadingLevelForSectionDepth(
  depth: number,
): MarkupHeadingLevel {
  if (!Number.isSafeInteger(depth) || depth < 0) {
    throw new Error(`Section depth must be a non-negative integer: ${depth}`);
  }
  return ((depth % 6) + 1) as MarkupHeadingLevel;
}

export function nextMarkupHeadingLevel(
  level: MarkupHeadingLevel,
): MarkupHeadingLevel {
  return level === 6 ? 1 : ((level + 1) as MarkupHeadingLevel);
}

export function filterApplicationThemes(
  query: string,
): readonly ApplicationThemeDefinition[] {
  const terms = normalizeSearch(query).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return APPLICATION_THEMES;
  return APPLICATION_THEMES.filter((theme) => {
    const searchable = normalizeSearch(
      `${theme.id} ${theme.name} ${theme.appearance} ${theme.appearance === "dark" ? "dark dark-theme 暗色" : "light light-theme 明色"}`,
    );
    return terms.every((term) => searchable.includes(term));
  });
}

function palette(input: {
  readonly bg: readonly [string, string, string, string, string];
  readonly fg: readonly [string, string, string, string];
  readonly selection: readonly [string, string];
  readonly comment: string;
  readonly accents: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
}): ApplicationThemePalette {
  return {
    bg0: input.bg[0],
    bg1: input.bg[1],
    bg2: input.bg[2],
    bg3: input.bg[3],
    bg4: input.bg[4],
    fg0: input.fg[0],
    fg1: input.fg[1],
    fg2: input.fg[2],
    fg3: input.fg[3],
    selection: input.selection[0],
    selectionStrong: input.selection[1],
    comment: input.comment,
    black: input.accents[0],
    red: input.accents[1],
    green: input.accents[2],
    yellow: input.accents[3],
    blue: input.accents[4],
    magenta: input.accents[5],
    cyan: input.accents[6],
    white: input.accents[7],
    orange: input.accents[8],
    pink: input.accents[9],
  };
}

function semanticTokens(
  palette: ApplicationThemePalette,
): ApplicationThemeTokens {
  return {
    canvas: palette.bg1,
    canvasGlow: alpha(palette.blue, 0.18),
    workspaceGap: palette.bg2,
    chrome: palette.bg0,
    surface: palette.bg1,
    surfaceRaised: palette.bg2,
    surfaceHover: palette.bg3,
    surfaceInset: palette.bg0,
    overlaySurface: palette.bg0,
    overlayBackdrop: alpha(palette.black, 0.74),
    shadow: alpha(palette.black, 0.52),
    text: palette.fg1,
    textStrong: palette.fg0,
    textMuted: palette.fg2,
    textSubtle: palette.fg3,
    textInverse: palette.bg1,
    border: palette.bg4,
    borderSubtle: mix(palette.bg1, palette.bg4, 0.48),
    focus: palette.blue,
    focusMuted: alpha(palette.blue, 0.36),
    link: palette.blue,
    linkMuted: alpha(palette.blue, 0.55),
    selection: palette.selection,
    selectionStrong: palette.selectionStrong,
    selectionBorder: palette.bg4,
    selectionText: palette.fg0,
    selectionMuted: alpha(palette.blue, 0.55),
    caretNormal: palette.fg0,
    caretNormalFill: alpha(palette.blue, 0.48),
    caretVisual: palette.yellow,
    caretVisualFill: alpha(palette.yellow, 0.58),
    caretShadow: alpha(palette.black, 0.7),
    caretInsert: palette.fg0,
    info: palette.cyan,
    success: palette.green,
    successSurface: mix(palette.bg1, palette.green, 0.14),
    warning: palette.yellow,
    warningSurface: mix(palette.bg1, palette.yellow, 0.12),
    danger: palette.red,
    dangerText: palette.red,
    dangerSurface: mix(palette.bg1, palette.red, 0.12),
    dangerSelected: mix(palette.bg1, palette.red, 0.35),
    dangerBorder: mix(palette.bg4, palette.red, 0.5),
    searchMatchSurface: mix(palette.bg1, palette.yellow, 0.34),
    searchMatchBorder: palette.yellow,
    codeText: palette.fg0,
    codeSurface: palette.bg0,
    quote: palette.comment,
    horizontalRule: palette.bg4,
    // Follow Nightfox's Treesitter markup families where possible. Memoka's
    // depth-aware heading colors are an H1-H6 rainbow extension; deeper
    // Sections intentionally retain the H6 color.
    markupStrong: palette.red,
    markupItalic: palette.yellow,
    markupStrikethrough: palette.comment,
    markupRaw: palette.cyan,
    markupLinkUrl: palette.orange,
    markupLinkReference: palette.magenta,
    markupHeading1: palette.red,
    markupHeading2: palette.orange,
    markupHeading3: palette.yellow,
    markupHeading4: palette.green,
    markupHeading5: palette.cyan,
    markupHeading6: palette.blue,
  };
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function alpha(hex: string, opacity: number): string {
  const [red, green, blue] = parseHex(hex);
  const percentage = Math.round(opacity * 100);
  return `rgb(${red} ${green} ${blue} / ${percentage}%)`;
}

function mix(background: string, foreground: string, amount: number): string {
  const from = parseHex(background);
  const to = parseHex(foreground);
  const channels = from.map((channel, index) =>
    Math.round(channel + (to[index] - channel) * amount),
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(value: string): [number, number, number] {
  if (!/^#[\da-f]{6}$/iu.test(value)) {
    throw new Error(`Theme colors must use six-digit hex: ${value}`);
  }
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}
