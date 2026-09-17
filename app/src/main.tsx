import ReactDOM from "react-dom/client";
import { App } from "./App";
import {
  DEFAULT_APPLICATION_THEME_ID,
  setCustomApplicationThemes,
} from "./core/application-theme";
import { DEFAULT_APPLICATION_ZOOM_PERCENT } from "./core/application-appearance";
import {
  createDefaultApplicationConfigPort,
  loadApplicationConfig,
} from "./platform/application-config";
import { applyApplicationTheme } from "./platform/application-theme";
import {
  applyApplicationIndentWidth,
  applyApplicationFont,
  applyApplicationNoteMaxWidth,
  applyNoteAppearance,
  createDefaultApplicationZoomPort,
} from "./platform/application-appearance";
import { setJapaneseSegmentationConfiguration } from "./core/japanese-segmentation";
import "./styles.css";

applyApplicationTheme(document.documentElement, DEFAULT_APPLICATION_THEME_ID);
const root = ReactDOM.createRoot(document.getElementById("root")!);
const applicationConfig = createDefaultApplicationConfigPort();
const applicationZoom = createDefaultApplicationZoomPort();
void loadApplicationConfig().then(
  async ({
    config,
    theme,
    customThemes,
    fontFamily,
    noteAppearance,
    zoomPercent,
    noteMaxWidthPx,
    lineNumberMinWidthPx,
    indentWidthPx,
    japaneseWordSegmentation,
    japaneseLineBreakSegmentation,
    warning,
  }) => {
    setCustomApplicationThemes(customThemes ?? {});
    applyApplicationTheme(document.documentElement, theme);
    applyApplicationFont(document.documentElement, fontFamily);
    applyNoteAppearance(document.documentElement, noteAppearance);
    applyApplicationNoteMaxWidth(document.documentElement, noteMaxWidthPx);
    applyApplicationIndentWidth(document.documentElement, indentWidthPx);
    setJapaneseSegmentationConfiguration({
      wordSegmentation: japaneseWordSegmentation,
      lineBreakSegmentation: japaneseLineBreakSegmentation,
    });
    let appliedZoomPercent = zoomPercent;
    let startupWarning = warning;
    try {
      await applicationZoom.setZoomPercent(zoomPercent);
    } catch (cause) {
      appliedZoomPercent = DEFAULT_APPLICATION_ZOOM_PERCENT;
      const detail = `Zoom設定を適用できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`;
      startupWarning = startupWarning ? `${startupWarning}; ${detail}` : detail;
    }
    root.render(
      <App
        applicationConfig={applicationConfig}
        applicationZoom={applicationZoom}
        initialTheme={theme}
        initialFontFamily={fontFamily}
        initialNoteAppearance={noteAppearance}
        initialZoomPercent={appliedZoomPercent}
        initialNoteMaxWidthPx={noteMaxWidthPx}
        initialLineNumberMinWidthPx={lineNumberMinWidthPx}
        initialIndentWidthPx={indentWidthPx}
        initialJapaneseWordSegmentation={japaneseWordSegmentation}
        initialJapaneseLineBreakSegmentation={japaneseLineBreakSegmentation}
        keyConfig={config}
        keyConfigWarning={startupWarning}
      />,
    );
  },
);
