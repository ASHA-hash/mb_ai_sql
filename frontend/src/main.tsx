import React from "react";
import ReactDOM from "react-dom/client";
import { applyThemeFromStorage } from "./lib/useTheme";
import App from "./App";
import "./index.css";

applyThemeFromStorage();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
