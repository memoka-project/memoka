export const JAPANESE_WORD_SEGMENTATION_MODES = [
  "fine",
  "budoux",
  "unicode",
] as const;

export type JapaneseWordSegmentationMode =
  (typeof JAPANESE_WORD_SEGMENTATION_MODES)[number];

export const JAPANESE_LINE_BREAK_SEGMENTATION_MODES = [
  "fine",
  "budoux",
  "native",
] as const;

export type JapaneseLineBreakSegmentationMode =
  (typeof JAPANESE_LINE_BREAK_SEGMENTATION_MODES)[number];

export interface JapaneseSegmentationConfiguration {
  readonly wordSegmentation: JapaneseWordSegmentationMode;
  readonly lineBreakSegmentation: JapaneseLineBreakSegmentationMode;
}

export const DEFAULT_JAPANESE_WORD_SEGMENTATION: JapaneseWordSegmentationMode =
  "fine";
export const DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION: JapaneseLineBreakSegmentationMode =
  "fine";

export const DEFAULT_JAPANESE_SEGMENTATION_CONFIGURATION: JapaneseSegmentationConfiguration =
  {
    wordSegmentation: DEFAULT_JAPANESE_WORD_SEGMENTATION,
    lineBreakSegmentation: DEFAULT_JAPANESE_LINE_BREAK_SEGMENTATION,
  };

type JapaneseSegmentationListener = (
  configuration: JapaneseSegmentationConfiguration,
) => void;

let currentConfiguration = DEFAULT_JAPANESE_SEGMENTATION_CONFIGURATION;
const listeners = new Set<JapaneseSegmentationListener>();

export function normalizeJapaneseWordSegmentationMode(
  value: string,
): JapaneseWordSegmentationMode | null {
  const normalized = value.trim().toLocaleLowerCase();
  return (
    JAPANESE_WORD_SEGMENTATION_MODES.find(
      (candidate) => candidate === normalized,
    ) ?? null
  );
}

export function normalizeJapaneseLineBreakSegmentationMode(
  value: string,
): JapaneseLineBreakSegmentationMode | null {
  const normalized = value.trim().toLocaleLowerCase();
  return (
    JAPANESE_LINE_BREAK_SEGMENTATION_MODES.find(
      (candidate) => candidate === normalized,
    ) ?? null
  );
}

export function getJapaneseSegmentationConfiguration(): JapaneseSegmentationConfiguration {
  return currentConfiguration;
}

/**
 * Applies application-wide Japanese text semantics without recreating Editors.
 * Editor extensions subscribe to this store; Vim commands read it at dispatch.
 */
export function setJapaneseSegmentationConfiguration(
  configuration: JapaneseSegmentationConfiguration,
): void {
  if (
    currentConfiguration.wordSegmentation === configuration.wordSegmentation &&
    currentConfiguration.lineBreakSegmentation ===
      configuration.lineBreakSegmentation
  ) {
    return;
  }
  currentConfiguration = { ...configuration };
  for (const listener of listeners) listener(currentConfiguration);
}

export function subscribeJapaneseSegmentationConfiguration(
  listener: JapaneseSegmentationListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetJapaneseSegmentationConfiguration(): void {
  setJapaneseSegmentationConfiguration(
    DEFAULT_JAPANESE_SEGMENTATION_CONFIGURATION,
  );
}
