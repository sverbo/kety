import type { OffSessionVideo } from "./App";

/** Retourne uniquement la transcription native du recording (aucun fallback legacy). */
export function offSessionVideoTranscription(
  video: OffSessionVideo
): string | undefined {
  const t = video.transcription?.trim();
  return t && t.length > 0 ? t : undefined;
}

/** Résumé court pour l’UI (module séparé pour éviter les imports circulaires avec App). */
export function formatOffSessionContextFocus(
  cf:
    | {
        appName: string | null;
        bundleId: string | null;
        processId: number;
        windowName: string | null;
        windowOwnerName: string | null;
      }
    | undefined
): string | null {
  if (!cf) return null;
  const app =
    (cf.appName && cf.appName.trim()) ||
    (cf.bundleId && cf.bundleId.trim()) ||
    (cf.processId ? `pid ${cf.processId}` : null);
  if (!app) return null;
  const win =
    (cf.windowName && cf.windowName.trim()) ||
    (cf.windowOwnerName && cf.windowOwnerName.trim());
  return win ? `${app} · ${win}` : app;
}
