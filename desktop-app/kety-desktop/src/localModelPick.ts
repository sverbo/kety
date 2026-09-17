import type { QwenModelsStatus, WhisperStatus } from "./appTypes";

/** Best-effort sort key from a human-readable size label (e.g. "1.2 GiB", "800 MB"). */
function sizeLabelSortKey(sizeLabel: string): number {
  const normalized = sizeLabel.replace(/,/g, ".").toLowerCase();
  const m = normalized.match(/(\d+(?:\.\d+)?)\s*([tgmk])?i?b/);
  if (!m) return 0;
  const n = parseFloat(m[1]!);
  const u = (m[2] ?? "m") as string;
  const mult =
    u === "t" ? 1e12 : u === "g" ? 1e9 : u === "m" ? 1e6 : u === "k" ? 1e3 : 1e6;
  return n * mult;
}

export function largestInstalledQwenFilename(status: QwenModelsStatus | null): string | null {
  const installed = status?.models.filter((m) => m.installed) ?? [];
  if (installed.length === 0) return null;
  return [...installed].sort(
    (a, b) => sizeLabelSortKey(b.sizeLabel) - sizeLabelSortKey(a.sizeLabel),
  )[0]!.filename;
}

export function largestInstalledWhisperFilename(status: WhisperStatus | null): string | null {
  const installed = status?.models.filter((m) => m.installed) ?? [];
  if (installed.length === 0) return null;
  return [...installed].sort(
    (a, b) => sizeLabelSortKey(b.sizeLabel) - sizeLabelSortKey(a.sizeLabel),
  )[0]!.filename;
}
