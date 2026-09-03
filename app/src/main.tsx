import ReactDOM from "react-dom/client";
import { App } from "./App";
import { DEFAULT_APPLICATION_THEME_ID } from "./core/application-theme";
import { DEFAULT_APPLICATION_ZOOM_PERCENT } from "./core/application-appearance";
import {
  createDefaultApplicationConfigPort,
  loadApplicationConfig,
} from "./platform/application-config";
import { applyApplicationTheme } from "./platform/application-theme";
import {
  applyApplicationFont,
  applyApplicationNoteMaxWidth,
  createDefaultApplicationZoomPort,
} from "./platform/application-appearance";
import "./styles.css";

applyApplicationTheme(document.documentElement, DEFAULT_APPLICATION_THEME_ID);
const root = ReactDOM.createRoot(document.getElementById("root")!);
const applicationConfig = createDefaultApplicationConfigPort();
const applicationZoom = createDefaultApplicationZoomPort();
void loadApplicationConfig().then(
  async ({
    config,
    theme,
    fontFamily,
    zoomPercent,
    noteMaxWidthPx,
    waitForMirrorOnExit,
    warning,
  }) => {
    applyApplicationTheme(document.documentElement, theme);
    applyApplicationFont(document.documentElement, fontFamily);
    applyApplicationNoteMaxWidth(document.documentElement, noteMaxWidthPx);
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
        initialZoomPercent={appliedZoomPercent}
        initialNoteMaxWidthPx={noteMaxWidthPx}
        keyConfig={config}
        keyConfigWarning={startupWarning}
        waitForMirrorOnExit={waitForMirrorOnExit}
      />,
    );
  },
);
