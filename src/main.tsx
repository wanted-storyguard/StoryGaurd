import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./workbench.css";
import "./theme.css";
import { ThemeProvider } from "./components/ThemeProvider";
import { initializeTheme } from "./lib/theme";

initializeTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider><App /></ThemeProvider>
  </React.StrictMode>,
);
