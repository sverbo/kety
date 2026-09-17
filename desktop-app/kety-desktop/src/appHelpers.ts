import type { ConfirmKind } from "./appTypes";

// ── Model label helpers (mirror Rust catalogs) ────────────────────────────────

export function whisper_setup_MODELS_LABEL(filename: string): string {
  const MAP: Record<string, string> = {
    "ggml-tiny.bin": "Tiny",
    "ggml-base.bin": "Base",
    "ggml-small.bin": "Small",
    "ggml-medium.bin": "Medium",
    "ggml-large-v3.bin": "Large v3",
  };
  return MAP[filename] ?? filename;
}

export function qwen_setup_MODELS_LABEL(filename: string): string {
  const MAP: Record<string, string> = {
    "qwen2.5-0.5b-instruct-q4_k_m.gguf": "Qwen2.5 0.5B (Q4_K_M)",
    "qwen2.5-1.5b-instruct-q4_k_m.gguf": "Qwen2.5 1.5B (Q4_K_M)",
    "qwen2.5-3b-instruct-q6_k.gguf": "Qwen2.5 3B (Q6_K)",
  };
  return MAP[filename] ?? filename;
}

// ── Confirm dialog copy ───────────────────────────────────────────────────────

export function getConfirmCopy(kind: ConfirmKind): {
  title: string;
  intro: string;
  bullets: string[];
  warning: string;
  confirmLabel: string;
} {
  switch (kind.type) {
    case "deleteSelected": {
      const n = kind.items.length;
      const hasMedia = kind.items.some(
        (i) => i.kind === "offImage" || i.kind === "offVideo"
      );
      return {
        title: `Delete ${n} selected item${n === 1 ? "" : "s"}?`,
        intro: "This will permanently delete all selected items.",
        bullets: [],
        warning: hasMedia
          ? "Files (screenshots, recordings) will be deleted from disk and cannot be recovered."
          : "The deleted items cannot be recovered.",
        confirmLabel: `Delete ${n}`,
      };
    }
    case "deleteOffNote":
      return {
        title: "Delete this note?",
        intro: "This note will be removed from the local list.",
        bullets: [],
        warning: "The text cannot be recovered.",
        confirmLabel: "Delete",
      };
    case "deleteOffImage":
      return {
        title: "Delete this screenshot?",
        intro: "The file will be deleted from disk and removed from the list.",
        bullets: [],
        warning: "The file cannot be recovered.",
        confirmLabel: "Delete",
      };
    case "deleteOffVideo":
      return {
        title: "Delete this recording?",
        intro: "The file will be deleted from disk and removed from the list.",
        bullets: [],
        warning: "The file cannot be recovered.",
        confirmLabel: "Delete",
      };
    case "removeWhisperModel": {
      const { label, isSelected, nextFilename } = kind;
      const nextLabel = nextFilename ? whisper_setup_MODELS_LABEL(nextFilename) : null;
      return {
        title: `Remove ${label} model?`,
        intro: "The model file will be deleted from disk.",
        bullets: [],
        warning: isSelected
          ? nextFilename
            ? `This is your active model. Dictation will automatically switch to ${nextLabel}.`
            : "This is your only installed model. Dictation will be set to Disabled."
          : "",
        confirmLabel: "Remove",
      };
    }
    case "removeQwenModel": {
      const { label, isSelected, nextFilename } = kind;
      const nextLabel = nextFilename ? qwen_setup_MODELS_LABEL(nextFilename) : null;
      return {
        title: `Remove ${label}?`,
        intro: "The GGUF file will be deleted from this device.",
        bullets: [],
        warning: isSelected
          ? nextFilename
            ? `This is your preferred local model. Selection will switch to ${nextLabel}.`
            : "This is your only downloaded model. Local Qwen selection will be cleared."
          : "",
        confirmLabel: "Remove",
      };
    }
    case "removeEmbedModel": {
      const { label, isActive } = kind;
      return {
        title: `Remove ${label}?`,
        intro: "The model file will be deleted from this device.",
        bullets: [],
        warning: isActive
          ? "This is your active embedding model. Local indexing will be set to Disabled until you select another model."
          : "",
        confirmLabel: "Remove",
      };
    }
    case "localModelInUseWarning": {
      const places = kind.usedIn.map((u) => u.label).join(" and ");
      return {
        title: `Cannot remove ${kind.modelLabel}`,
        intro: `This model is currently selected in ${places}. Please choose a different model there before removing it.`,
        bullets: [],
        warning: "",
        confirmLabel: "Got it",
      };
    }
    default: {
      const _x: never = kind;
      return _x;
    }
  }
}
