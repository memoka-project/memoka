import ReactDOM from "react-dom/client";
import { App } from "./App";
import { loadApplicationKeyConfig } from "./platform/application-config";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);
void loadApplicationKeyConfig().then(({ config, warning }) => {
  root.render(<App keyConfig={config} keyConfigWarning={warning} />);
});
