// First import: it declares the cascade layer order before any component styles load.
import "./styles/index.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { blockBrowserBehavior } from "./app/desktopOnly";
import { applyTheme, followMode, themeFrom } from "./app/theme";

// Before the first render, so the page never paints in the wrong theme. The mode keeps
// following the window for as long as the page lives.
applyTheme(document.documentElement, themeFrom(window.location.search));
followMode(document.documentElement);
// The dev server keeps the browser's menu and reload for debugging.
if (!import.meta.env.DEV) {
  blockBrowserBehavior(window);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
