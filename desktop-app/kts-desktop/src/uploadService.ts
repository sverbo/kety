/**
 * Upload service - shared types and helpers for the capture upload flow.
 * No network/cloud calls; everything here runs entirely on-device.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type UploadProgress = {
  phase: "idle" | "signing" | "uploading" | "done" | "error";
  current: number;
  total: number;
  message: string;
};

// ── Share links ──────────────────────────────────────────────────────────────

export type ShareExpiryUnit = "hours" | "days";

const KNOWLEDGE_SHARE_STEM_INPUT_MAX = 180;

/**
 * Live input for the share stem field: a–z, 0–9, underscore, hyphen; A–Z → lowercase.
 * Space and tab become a hyphen; multiple hyphens in a row are collapsed to one.
 * Any other character does not appear.
 */
export function filterKnowledgeShareStemInput(raw: string): string {
  let out = "";
  for (const ch of raw) {
    if (ch === " " || ch === "\t") {
      out += "-";
    } else if (
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "_" ||
      ch === "-"
    ) {
      out += ch;
    } else if (ch >= "A" && ch <= "Z") {
      out += ch.toLowerCase();
    }
  }
  out = out.replace(/-+/g, "-");
  return out.slice(0, KNOWLEDGE_SHARE_STEM_INPUT_MAX);
}

/** Match backend rules: lowercase a-z, digits, underscores, hyphens (accents stripped). */
export function sanitizeKnowledgeShareStem(raw: string): string {
  const s = raw.normalize("NFD").replace(/\p{M}/gu, "");
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "file";
}

/** Default stem from a file basename (path segment, extension stripped). */
export function basenameToDefaultShareStem(basename: string): string {
  const base = basename.trim().replace(/\\/g, "/").split("/").pop() ?? "";
  const cut = base.lastIndexOf(".");
  const without = cut > 0 ? base.slice(0, cut) : base;
  const stem = sanitizeKnowledgeShareStem(without);
  return stem || "file";
}
