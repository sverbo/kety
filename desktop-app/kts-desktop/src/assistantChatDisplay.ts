/**
 * Réponses assistant : le modèle ajoute `[START_CONTEXT]` … `[END_CONTEXT]` pour l’historique
 * et les follow-ups. L’utilisateur ne doit voir que la partie avant le premier délimiteur complet.
 * Pendant le streaming, si le suffixe est un préfixe de ce délimiteur, on le masque (à partir de
 * `[START` pour éviter de couper sur un simple `[` Markdown).
 */
export const ASSISTANT_START_CONTEXT_DELIM = "[START_CONTEXT]";

/** Longueur minimale du suffixe partiel à masquer (évite de tronquer sur `[` seul). */
const MIN_PARTIAL_SUFFIX = 6; // "[START"

export function displayAssistantAnswerForUser(raw: string): string {
  const d = ASSISTANT_START_CONTEXT_DELIM;
  const complete = raw.indexOf(d);
  if (complete !== -1) {
    return raw.slice(0, complete).trimEnd();
  }
  for (let k = d.length - 1; k >= MIN_PARTIAL_SUFFIX; k--) {
    if (raw.endsWith(d.slice(0, k))) {
      return raw.slice(0, -k).trimEnd();
    }
  }
  return raw;
}
