/**
 * Sélecteurs DOM alignés sur le projet capcopy (MIT) :
 * https://github.com/k1LoW/capcopy - adapté pour Kety.
 */
const SELECTORS = {
  captionContainer: ".nMcdL.bj4p3b",
  captionText: ".ygicle.VbkSUe",
  speaker: ".adE6rb",
};

const SESSIONS_KEY = "ketyMeetRecentSessions";
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * While CC is on but no one is speaking, Meet often keeps caption tiles in the DOM (empty lines).
 * When the user turns CC off, those tiles usually disappear entirely. We use that to guess
 * "subtitles toggled off" vs "silence" - imperfect if Meet changes DOM.
 */
let gapCaptionsLikelyTurnedOff = false;

function getCaptions() {
  const captionItems = document.querySelectorAll(SELECTORS.captionContainer);
  const speakers = document.querySelectorAll(SELECTORS.speaker);
  const captions = [];
  captionItems.forEach((item, index) => {
    const text = item.querySelector(SELECTORS.captionText)?.textContent || "";
    const speaker = speakers[index]?.textContent || "";
    if (text.trim()) captions.push({ speaker: speaker.trim(), text: text.trim() });
  });
  return captions;
}

function formatCaptions(captions) {
  return captions.map((c) => `${c.speaker}: ${c.text}`).join("\n");
}

/** Meet home / landing / new meeting - not an in-call room URL. */
function meetUrlIndicatesActiveCall() {
  const path = (typeof location !== "undefined" ? location.pathname || "" : "").replace(/\/+$/, "") || "/";
  if (path === "/") return false;
  const lower = path.toLowerCase();
  if (lower.startsWith("/landing")) return false;
  if (lower === "/new" || lower.startsWith("/new/")) return false;
  if (lower.startsWith("/lookup")) return false;
  return /^\/[a-z0-9]+-[a-z0-9]+-[a-z0-9]{3,}/i.test(path);
}

/** Room code from Meet path (e.g. /abc-defg-hij → abc-defg-hij), lowercase. */
function meetRoomCodeFromPathname(pathname) {
  const path = String(pathname || "").replace(/\/+$/, "") || "/";
  const m = path.match(/^\/([a-z0-9]+-[a-z0-9]+-[a-z0-9]{3,})/i);
  return m ? String(m[1]).toLowerCase() : "";
}

function meetRoomCodeFromLocation() {
  try {
    const path = typeof location !== "undefined" ? location.pathname || "" : "";
    return meetRoomCodeFromPathname(path);
  } catch {
    return "";
  }
}

/** Same room id from a full Meet URL (for rows saved before `meetCode` existed, or odd paths). */
function meetRoomCodeFromUrlString(url) {
  try {
    const u = new URL(String(url || ""), "https://meet.google.com");
    return meetRoomCodeFromPathname(u.pathname || "");
  } catch {
    return "";
  }
}

/**
 * `call` = in-room (URL looks like a meeting link); show CC badge if captions off.
 * `welcome` = Meet home, landing, etc.
 * `ended` = post-meeting / left screen (same URL may still contain a room code).
 */
function meetPageSurfaceKind() {
  if (!meetUrlIndicatesActiveCall()) return "welcome";
  const title = ((typeof document !== "undefined" ? document.title : "") || "").toLowerCase();
  const bodySlice =
    typeof document !== "undefined" && document.body?.innerText
      ? document.body.innerText.slice(0, 12000)
      : "";
  const bodyLower = bodySlice.toLowerCase();
  if (
    title.includes("you left the meeting") ||
    title.includes("vous avez quitté") ||
    bodyLower.includes("you left the meeting") ||
    bodyLower.includes("vous avez quitté la réunion") ||
    bodyLower.includes("vous avez quitté l'appel") ||
    bodyLower.includes("return to home") ||
    bodyLower.includes("revenir à l'accueil") ||
    bodyLower.includes("the meeting has ended") ||
    bodyLower.includes("la réunion est terminée") ||
    bodyLower.includes("the call ended") ||
    bodyLower.includes("l'appel est terminé")
  ) {
    return "ended";
  }
  return "call";
}

function segmentIdForTab() {
  const key = "kety_meet_segment_id_v1";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

function pruneSessions(arr) {
  const list = Array.isArray(arr) ? arr : [];
  const now = Date.now();
  return list.filter(
    (s) =>
      s &&
      typeof s.updatedAt === "number" &&
      now - s.updatedAt < TTL_MS &&
      typeof s.segmentId === "string"
  );
}

function formatTimestampForDivider(atMs) {
  try {
    return new Date(atMs).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    });
  } catch {
    return String(atMs);
  }
}

function formatContinuationDivider(atMs) {
  const t = formatTimestampForDivider(atMs);
  return [
    "────────────────────────────────────────",
    `Captions continue · ${t}`,
    "────────────────────────────────────────",
  ].join("\n");
}

const CONTINUATION_DIVIDER_MARKER = "────────────────────────────────────────";

function parseCaptionSpeakerLines(str) {
  const lines = [];
  for (const part of String(str || "").split(/\n\n+/)) {
    const block = part.trim();
    if (!block || block.startsWith("────")) continue;
    for (const line of block.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const m = t.match(/^([^:]+):\s*(.+)$/);
      if (m) lines.push({ speaker: m[1].trim(), text: m[2].trim() });
    }
  }
  return lines;
}

function formatCaptionSpeakerLines(lines) {
  return lines.map((l) => `${l.speaker}: ${l.text}`).join("\n");
}

/**
 * Meet keeps the active speaker in the visible caption strip and rewrites that text
 * until another speaker appears. So the last stored speaker is mutable; older speakers
 * are committed.
 */
function trySpeakerStateCaptionMerge(prev, inc) {
  const prevLines = parseCaptionSpeakerLines(prev);
  const incLines = parseCaptionSpeakerLines(inc);
  if (!incLines.length) return prev;
  if (!prevLines.length) return inc;

  if (prevLines[prevLines.length - 1].speaker === incLines[0].speaker) {
    return formatCaptionSpeakerLines([...prevLines.slice(0, -1), ...incLines]);
  }

  return null;
}

function splitTranscriptForLineMerge(str) {
  const s = String(str || "");
  const markerAt = s.lastIndexOf(CONTINUATION_DIVIDER_MARKER);
  if (markerAt < 0) return { head: "", tail: s.trim() };
  const blockStart = s.lastIndexOf("\n\n", markerAt);
  const cut = blockStart >= 0 ? blockStart : markerAt;
  return { head: s.slice(0, cut).trimEnd(), tail: s.slice(cut + (blockStart >= 0 ? 2 : 0)).trim() };
}

function joinTranscriptAfterLineMerge(head, mergedTail) {
  const tail = String(mergedTail || "").trim();
  if (!head) return tail;
  if (!tail) return head;
  return `${head}\n\n${tail}`;
}

/**
 * Join the current Meet caption strip with text already stored. The last stored speaker
 * stays mutable while the same speaker is visible; a new first speaker commits the old one.
 */
function appendMeetCaptionNeverDrop(existing, incomingStrip, nowMs, insertContinuationBanner) {
  const prev = String(existing || "").trimEnd();
  const inc = String(incomingStrip || "").trim();
  if (!inc) return prev;
  if (!prev) return inc;
  const { head: prevHead, tail: prevTail } = splitTranscriptForLineMerge(prev);
  const lineMergedTail = trySpeakerStateCaptionMerge(prevTail, inc);
  if (lineMergedTail != null) {
    return joinTranscriptAfterLineMerge(prevHead, lineMergedTail);
  }
  const lineMergedFull = trySpeakerStateCaptionMerge(prev, inc);
  if (lineMergedFull != null) return lineMergedFull;

  if (insertContinuationBanner) {
    return `${prev}\n\n${formatContinuationDivider(nowMs)}\n\n${inc}`;
  }
  return `${prev}\n\n${inc}`;
}

/**
 * Longest transcript already saved for this tab or the same Meet room (rejoin / new tab).
 * Uses `meetCode` on the row when present, otherwise parses `meetUrl`, so older sessions still
 * join the same room after a new `segmentId` (e.g. sessionStorage reset) or CC toggles.
 */
function longestStoredTranscriptForMeet(arr, segmentId, roomKey) {
  const key = String(roomKey || "").trim().toLowerCase();
  let best = "";
  for (const s of arr) {
    if (!s) continue;
    const sameSeg = s.segmentId === segmentId;
    let rowRoom = "";
    if (typeof s.meetCode === "string" && s.meetCode.trim()) {
      rowRoom = s.meetCode.trim().toLowerCase();
    } else if (typeof s.meetUrl === "string" && s.meetUrl.trim()) {
      rowRoom = meetRoomCodeFromUrlString(s.meetUrl);
    }
    const sameRoom = key && rowRoom && rowRoom === key;
    if (!sameSeg && !sameRoom) continue;
    const t = typeof s.lastText === "string" ? s.lastText : "";
    if (t.length > best.length) best = t;
  }
  return best;
}

/** Serialize storage read-merge-write so concurrent ticks cannot drop text. */
let meetStorageWriteChain = Promise.resolve();

function upsertMeetRecent(segmentId, incomingStripText, options) {
  const opts = options && typeof options === "object" ? options : {};
  const meetCodeOpt = typeof opts.meetCode === "string" ? opts.meetCode.trim().toLowerCase() : "";
  const insertContinuationBanner = opts.insertContinuationBanner === true;

  const incoming = String(incomingStripText == null ? "" : incomingStripText).trim();
  if (!segmentId || !incoming) return;
  if (!chrome.storage?.local) return;

  const currentHref = typeof location !== "undefined" ? location.href : "";
  const roomKey = meetCodeOpt || meetRoomCodeFromUrlString(currentHref);

  meetStorageWriteChain = meetStorageWriteChain.then(
    () =>
      new Promise((resolve) => {
        chrome.storage.local.get({ [SESSIONS_KEY]: [] }, (r) => {
          if (chrome.runtime.lastError) {
            resolve();
            return;
          }
          const raw = r && r[SESSIONS_KEY];
          const list = Array.isArray(raw) ? raw : [];
          let arr = pruneSessions(list);
          const now = Date.now();
          const prevStored = longestStoredTranscriptForMeet(arr, segmentId, roomKey);
          const merged = appendMeetCaptionNeverDrop(prevStored, incoming, now, insertContinuationBanner);

          if (roomKey) {
            arr = arr.filter((s) => {
              if (!s) return true;
              let rowRoom = "";
              if (typeof s.meetCode === "string" && s.meetCode.trim()) {
                rowRoom = s.meetCode.trim().toLowerCase();
              } else if (typeof s.meetUrl === "string" && s.meetUrl.trim()) {
                rowRoom = meetRoomCodeFromUrlString(s.meetUrl);
              }
              if (!rowRoom || rowRoom !== roomKey) return true;
              return s.segmentId === segmentId;
            });
          }
          const idx = arr.findIndex((s) => s.segmentId === segmentId);
          const row = {
            segmentId,
            meetUrl: currentHref,
            title: typeof document !== "undefined" ? document.title || "" : "",
            lastText: merged,
            updatedAt: now,
            ...(roomKey ? { meetCode: roomKey } : {}),
          };
          if (idx >= 0) arr[idx] = { ...(arr[idx] && typeof arr[idx] === "object" ? arr[idx] : {}), ...row };
          else arr.unshift(row);
          chrome.storage.local.set({ [SESSIONS_KEY]: arr }, () => {
            void chrome.runtime.lastError;
            resolve();
          });
        });
      })
  );
  void meetStorageWriteChain.catch(() => {});
}

/** Fixed interval to read the Meet caption strip into local storage (not user-configurable). */
const CAPTION_POLL_MS = 2000;

function tick() {
  const meetSurfaceKind = meetPageSurfaceKind();
  const text = formatCaptions(getCaptions());
  const hasCaptions = text.trim().length > 0;
  const captionTileCount = document.querySelectorAll(SELECTORS.captionContainer).length;

  if (meetSurfaceKind !== "call") {
    gapCaptionsLikelyTurnedOff = false;
  } else if (!hasCaptions && captionTileCount === 0) {
    /** No text and no caption tiles - usually CC off, or Meet cleared the strip entirely. */
    gapCaptionsLikelyTurnedOff = true;
  }

  chrome.runtime.sendMessage(
    { type: "KETY_MEET_CAPTION_STATE", hasCaptions, meetSurfaceKind },
    () => void chrome.runtime.lastError
  );
  if (meetSurfaceKind !== "call") return;
  if (!hasCaptions) return;

  const sid = segmentIdForTab();
  const insertContinuationBanner = gapCaptionsLikelyTurnedOff;
  gapCaptionsLikelyTurnedOff = false;

  upsertMeetRecent(sid, text, {
    meetCode: meetRoomCodeFromLocation(),
    insertContinuationBanner,
  });
}

let pollTimer = null;

function schedulePoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(tick, CAPTION_POLL_MS);
}

schedulePoll();
tick();

/** Lets the background worker remove this meeting from recent storage when the Meet tab is closed. */
chrome.runtime.sendMessage(
  { type: "KETY_MEET_REGISTER_TAB", segmentId: segmentIdForTab() },
  () => void chrome.runtime.lastError
);
