import ReactDOM from "react-dom/client";
import { App } from "./App";
import { DEFAULT_APPLICATION_THEME_ID } from "./core/application-theme";
import {
  createDefaultApplicationConfigPort,
  loadApplicationConfig,
} from "./platform/application-config";
import { applyApplicationTheme } from "./platform/application-theme";
import "./styles.css";

applyApplicationTheme(document.documentElement, DEFAULT_APPLICATION_THEME_ID);
const root = ReactDOM.createRoot(document.getElementById("root")!);
void loadApplicationConfig().then(
  ({ config, theme, waitForMirrorOnExit, warning }) => {
    applyApplicationTheme(document.documentElement, theme);
    root.render(
      <App
        applicationConfig={createDefaultApplicationConfigPort()}
        initialTheme={theme}
        keyConfig={config}
        keyConfigWarning={warning}
        waitForMirrorOnExit={waitForMirrorOnExit}
      />,
    );
  },
);
