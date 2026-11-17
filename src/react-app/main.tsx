import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/plus-jakarta-sans";
// Page style fonts. A browser downloads a font only when a page uses it.
import "@fontsource-variable/inter";
import "@fontsource-variable/nunito";
import "@fontsource-variable/space-grotesk";
// Base styles first, so screen-specific styles imported by App can override them.
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
