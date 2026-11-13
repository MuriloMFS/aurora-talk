import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono";
import "@aurora/ui/tokens.css";
import "./app.css";
import "./ui.css";
import "./conversation.css";
import "./settings.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Elemento #root ausente em index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
