import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./authContext";
import TrayNotePanel from "./TrayNotePanel";
import DictationHud from "./DictationHud";

const panel = new URLSearchParams(window.location.search).get("panel");
const Root =
  panel === "tray-note"
    ? TrayNotePanel
    : panel === "dictation-hud"
      ? DictationHud
      : App;

const tree =
  panel === "tray-note" ? (
    <AuthProvider>
      <Root />
    </AuthProvider>
  ) : panel === "dictation-hud" ? (
    <Root />
  ) : (
    <AuthProvider>
      <App />
    </AuthProvider>
  );

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{tree}</React.StrictMode>,
);
