import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// A tab open across a rebuild asks for chunk hashes that no longer exist; reload to get the new ones.
window.addEventListener("vite:preloadError", () => window.location.reload());

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
