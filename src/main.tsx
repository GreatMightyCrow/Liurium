// First import: it declares the cascade layer order before any component styles load.
import "./styles/index.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, themeFrom } from "./app/theme";

// Before the first render, so the page never paints in the wrong theme.
applyTheme(document.documentElement, themeFrom(window.location.search));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
