const PATH_CAPTIONS = "/v1/google-meet-captions";
const PATH_CONFIG = "/v1/chrome-extension-config";
const SESSIONS_KEY = "ketyMeetRecentSessions";
const STORAGE_TOKEN = "ketyMeetBridgeToken";
const STORAGE_PORT = "ketyMeetBridgePort";
const TTL_MS = 24 * 60 * 60 * 1000;
/** Maps Meet tab id → caption segment id (session storage so it survives SW restarts until browser exit). */
const TAB_SEGMENT_REGISTRY_KEY = "ketyMeetTabToSegment";
const LAST_AUTO_SYNC_ERR_KEY = "ketyMeetLastAutoSyncError";
const DEFAULT_ACTION_TITLE = "Kety for Google Meet";

const MSG_KETY_UNREACHABLE =
  "Couldn't reach Kety. Open the Kety app on this computer-it needs to be running to receive your meeting.";
const MSG_TOKEN_MISMATCH =
  "Kety didn't recognize this link. Open Kety → Settings → Chrome extension and paste the latest code here.";
const MSG_SEND_FAILED =
  "Couldn't send to Kety. Open the Kety app on this computer, then try Sync with app.";

/** Meet tabs that recently reported no caption strip (remind user to turn CC on). */
const meetTabsWithoutCaptions = new Set();

let autoSendCache = { value: true, at: 0, token: "", port: 0 };

function userMessageForFailedPush(out) {
  if (!out || out.ok) return "";
  const errBody = out.body && typeof out.body === "object" ? out.body : {};
  const code = errBody.error;
  if (out.status === 401) return MSG_TOKEN_MISMATCH;
  if (out.status === 503 || code === "meet_bridge_not_configured") return MSG_KETY_UNREACHABLE;
  return MSG_SEND_FAILED;
}

async function markSessionPushFailed(segmentId, message) {
  const sid = typeof segmentId === "string" ? segmentId.trim() : "";
  const msg = String(message || "").trim();
  if (!sid || !msg) return;
  const r = await chrome.storage.local.get({ [SESSIONS_KEY]: [] });
  const raw = r[SESSIONS_KEY];
  const list = Array.isArray(raw) ? raw : [];
  const idx = list.findIndex((s) => s && s.segmentId === sid);
  if (idx < 0) return;
  const next = [...list];
  const cur = { ...(next[idx] && typeof next[idx] === "object" ? next[idx] : {}) };
  cur.lastPushError = msg;
  cur.lastPushAttemptAt = Date.now();
  next[idx] = cur;
  await chrome.storage.local.set({ [SESSIONS_KEY]: next });
}

function refreshMeetToolbarBadge() {
  const show = meetTabsWithoutCaptions.size > 0;
  void chrome.action.setBadgeText({ text: show ? "!" : "" });
  void chrome.action.setBadgeBackgroundColor({ color: show ? "#D93025" : "#888888" });
  void chrome.action.setTitle({
    title: show
      ? "Turn on captions (CC) in Meet - Kety needs them to save your call"
      : DEFAULT_ACTION_TITLE,
  });
}

function tabRegistryArea() {
  return chrome.storage.session || chrome.storage.local;
}

async function readTabSegmentMap() {
  const area = tabRegistryArea();
  const v = await area.get(TAB_SEGMENT_REGISTRY_KEY);
  const m = v[TAB_SEGMENT_REGISTRY_KEY];
  return m && typeof m === "object" && !Array.isArray(m) ? { ...m } : {};
}

async function writeTabSegmentMap(map) {
  await tabRegistryArea().set({ [TAB_SEGMENT_REGISTRY_KEY]: map });
}

function pruneSessions(list) {
  const arr = Array.isArray(list) ? list : [];
  const now = Date.now();
  return arr.filter(
    (s) =>
      s &&
      typeof s.updatedAt === "number" &&
      now - s.updatedAt < TTL_MS &&
      typeof s.segmentId === "string"
  );
}

async function fetchAutoSendFromKety(token, port) {
  const now = Date.now();
  if (
    autoSendCache.token === token &&
    autoSendCache.port === port &&
    now - autoSendCache.at < 5000
  ) {
    return autoSendCache.value;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}${PATH_CONFIG}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      autoSendCache = { value: true, at: now, token, port };
      return true;
    }
    const j = await res.json();
    const v = j.autoSendMeetCaptures !== false;
    autoSendCache = { value: v, at: now, token, port };
    return v;
  } catch {
    autoSendCache = { value: true, at: now, token, port };
    return true;
  }
}

async function postCaptions(token, port, segmentId, text, manual) {
  const url = `http://127.0.0.1:${port}${PATH_CAPTIONS}`;
  const body = { segmentId, text };
  if (manual) body.manual = true;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const bodyText = await res.text();
  let bodyJson = null;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    bodyJson = { raw: bodyText };
  }
  return { ok: res.ok, status: res.status, body: bodyJson };
}

/** After a successful send to Kety (manual or auto), persist so the UI can show Resync + ✓. */
async function markSessionSyncedToApp(segmentId) {
  const sid = typeof segmentId === "string" ? segmentId.trim() : "";
  if (!sid) return;
  const r = await chrome.storage.local.get({ [SESSIONS_KEY]: [] });
  const raw = r[SESSIONS_KEY];
  const list = Array.isArray(raw) ? raw : [];
  const idx = list.findIndex((s) => s && s.segmentId === sid);
  if (idx < 0) return;
  const now = Date.now();
  const next = [...list];
  const cur = { ...(next[idx] && typeof next[idx] === "object" ? next[idx] : {}) };
  cur.lastSyncedToAppAt = now;
  delete cur.lastPushError;
  next[idx] = cur;
  await chrome.storage.local.set({ [SESSIONS_KEY]: next });
}

/**
 * When Kety has "automatically send Meet" on, push the stored transcript after the Meet tab
 * closes (same payload as Sync with app). No-op if the toggle is off or Kety is unreachable.
 */
async function tryAutoSyncAfterMeetTabClosed(segmentId) {
  const sid = typeof segmentId === "string" ? segmentId.trim() : "";
  if (!sid) return;
  const cfg = await chrome.storage.local.get({
    [STORAGE_TOKEN]: "",
    [STORAGE_PORT]: 17171,
    [SESSIONS_KEY]: [],
  });
  const token = String(cfg[STORAGE_TOKEN] || "").trim();
  if (!token) return;
  const port = Number(cfg[STORAGE_PORT]) || 17171;
  const allowAuto = await fetchAutoSendFromKety(token, port);
  if (!allowAuto) return;

  const rawList = cfg[SESSIONS_KEY];
  const base = Array.isArray(rawList) ? rawList : [];
  let list = pruneSessions(base);
  if (list.length !== base.length) {
    await chrome.storage.local.set({ [SESSIONS_KEY]: list });
  }
  const row = list.find((s) => s && s.segmentId === sid);
  const text = row && typeof row.lastText === "string" ? row.lastText : "";
  if (!String(text).trim()) return;
  try {
    const out = await postCaptions(token, port, sid, text, true);
    if (out.ok) {
      await markSessionSyncedToApp(sid);
    } else {
      const msg = userMessageForFailedPush(out);
      await markSessionPushFailed(sid, msg);
    }
  } catch {
    await markSessionPushFailed(sid, MSG_KETY_UNREACHABLE);
  }
}

function pruneStaleMeetSessionsToStorage() {
  chrome.storage.local.get({ [SESSIONS_KEY]: [] }, (r) => {
    const raw = r[SESSIONS_KEY];
    const list = Array.isArray(raw) ? raw : [];
    const pruned = pruneSessions(list);
    if (pruned.length !== list.length) {
      chrome.storage.local.set({ [SESSIONS_KEY]: pruned });
    }
  });
}

/** Bundled by Kety’s ZIP: same secret as the app, applied without opening Options. */
async function applyBundledBridgePresetIfPresent() {
  try {
    const url = chrome.runtime.getURL("kety-bridge-preset.json");
    const res = await fetch(url);
    if (!res.ok) return;
    const preset = await res.json();
    if (!preset || typeof preset.bridgeToken !== "string" || !preset.bridgeToken.trim()) return;
    const token = preset.bridgeToken.trim();
    const port = Math.min(65535, Math.max(1, Number(preset.bridgePort) || 17171));
    await chrome.storage.local.set({
      [STORAGE_TOKEN]: token,
      [STORAGE_PORT]: port,
    });
  } catch {
    /* missing file or invalid JSON - dev load without preset */
  }
}

void applyBundledBridgePresetIfPresent();

chrome.runtime.onInstalled.addListener(() => {
  void applyBundledBridgePresetIfPresent();
  chrome.alarms.get("ketyMeetPruneStorage", (a) => {
    if (chrome.runtime.lastError || !a) {
      chrome.alarms.create("ketyMeetPruneStorage", { periodInMinutes: 360 });
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ketyMeetPruneStorage") {
    pruneStaleMeetSessionsToStorage();
  }
});

pruneStaleMeetSessionsToStorage();

chrome.tabs.onRemoved.addListener((tabId) => {
  const beforeCc = meetTabsWithoutCaptions.size;
  meetTabsWithoutCaptions.delete(tabId);
  if (meetTabsWithoutCaptions.size !== beforeCc) refreshMeetToolbarBadge();
  void (async () => {
    try {
      const map = await readTabSegmentMap();
      const key = String(tabId);
      const segmentId = map[key];
      if (!segmentId) return;
      delete map[key];
      await writeTabSegmentMap(map);
      await tryAutoSyncAfterMeetTabClosed(segmentId);
    } catch {
      /* ignore */
    }
  })();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "KETY_MEET_CC_STATUS") {
    sendResponse({ needCc: meetTabsWithoutCaptions.size > 0 });
    return false;
  }

  if (msg?.type === "KETY_MEET_CAPTION_STATE") {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false });
      return false;
    }
    /** Only remind on active call pages (not Meet home / landing / post-meeting). */
    const surface =
      typeof msg.meetSurfaceKind === "string" && msg.meetSurfaceKind.trim()
        ? msg.meetSurfaceKind.trim()
        : "call";
    const before = meetTabsWithoutCaptions.size;
    if (surface !== "call") {
      meetTabsWithoutCaptions.delete(tabId);
    } else if (msg.hasCaptions === true) {
      meetTabsWithoutCaptions.delete(tabId);
    } else {
      meetTabsWithoutCaptions.add(tabId);
    }
    if (meetTabsWithoutCaptions.size !== before) refreshMeetToolbarBadge();
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === "KETY_MEET_LIST_SESSIONS") {
    void (async () => {
      try {
        try {
          await chrome.storage.local.remove(LAST_AUTO_SYNC_ERR_KEY);
        } catch {
          /* ignore */
        }
        const r = await chrome.storage.local.get({ [SESSIONS_KEY]: [] });
        const raw = r[SESSIONS_KEY];
        const base = Array.isArray(raw) ? raw : [];
        let sessions = pruneSessions(base).sort(
          (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
        );
        if (sessions.length !== base.length) {
          await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
        }
        const map = await readTabSegmentMap();
        const liveSegmentIds = new Set(Object.values(map));
        sessions = sessions.map((s) => ({
          ...s,
          syncWithAppEnabled:
            !!(typeof s.lastText === "string" && s.lastText.trim()) && !liveSegmentIds.has(s.segmentId),
        }));
        sendResponse({ ok: true, sessions });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (msg?.type === "KETY_MEET_DELETE_SESSION") {
    const segmentId = typeof msg.segmentId === "string" ? msg.segmentId.trim() : "";
    void (async () => {
      try {
        if (!segmentId) {
          sendResponse({ ok: false, error: "missing_segment_id" });
          return;
        }
        const r = await chrome.storage.local.get({ [SESSIONS_KEY]: [] });
        const raw = r[SESSIONS_KEY];
        const list = Array.isArray(raw) ? raw : [];
        const next = list.filter((s) => s && s.segmentId !== segmentId);
        if (next.length === list.length) {
          sendResponse({ ok: false, error: "session_not_found" });
          return;
        }
        await chrome.storage.local.set({ [SESSIONS_KEY]: next });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (msg?.type === "KETY_MEET_MANUAL_PUSH") {
    const segmentId = typeof msg.segmentId === "string" ? msg.segmentId.trim() : "";
    void (async () => {
      try {
        const map = await readTabSegmentMap();
        const liveSegmentIds = new Set(Object.values(map));
        if (liveSegmentIds.has(segmentId)) {
          sendResponse({
            ok: false,
            error: "meet_tab_still_open",
            detail: "Close the Google Meet tab first, then use Sync with app.",
          });
          return;
        }
        const cfg = await chrome.storage.local.get({
          ketyMeetBridgeToken: "",
          ketyMeetBridgePort: 17171,
          [SESSIONS_KEY]: [],
        });
        const token = String(cfg.ketyMeetBridgeToken || "").trim();
        if (!token) {
          sendResponse({ ok: false, error: "missing_token" });
          return;
        }
        const port = Number(cfg.ketyMeetBridgePort) || 17171;
        const rawList = cfg[SESSIONS_KEY];
        const baseList = Array.isArray(rawList) ? rawList : [];
        let list = pruneSessions(baseList);
        if (list.length !== baseList.length) {
          await chrome.storage.local.set({ [SESSIONS_KEY]: list });
        }
        const row = list.find((s) => s.segmentId === segmentId);
        const text = row && typeof row.lastText === "string" ? row.lastText : "";
        if (!segmentId || !text.trim()) {
          sendResponse({ ok: false, error: "no_caption_text_for_segment" });
          return;
        }
        const out = await postCaptions(token, port, segmentId, text, true);
        if (out.ok) {
          await markSessionSyncedToApp(segmentId);
        } else {
          const um = userMessageForFailedPush(out);
          if (um) await markSessionPushFailed(segmentId, um);
        }
        sendResponse({ ...out, manual: true });
      } catch (e) {
        await markSessionPushFailed(segmentId, MSG_KETY_UNREACHABLE);
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (msg?.type === "KETY_MEET_REGISTER_TAB") {
    const tabId = sender.tab?.id;
    const segmentId = typeof msg.segmentId === "string" ? msg.segmentId.trim() : "";
    if (tabId == null || !segmentId) {
      sendResponse({ ok: false });
      return false;
    }
    void (async () => {
      try {
        const map = await readTabSegmentMap();
        map[String(tabId)] = segmentId;
        await writeTabSegmentMap(map);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (msg?.type !== "KETY_MEET_PUSH") return;

  const segmentId = typeof msg.segmentId === "string" ? msg.segmentId : "";
  const text = typeof msg.text === "string" ? msg.text : "";
  if (!segmentId.trim() || !text.trim()) {
    sendResponse({ ok: false, error: "empty_payload" });
    return;
  }

  chrome.storage.local.get(
    {
      ketyMeetBridgeToken: "",
      ketyMeetBridgePort: 17171,
    },
    async (cfg) => {
      const token = String(cfg.ketyMeetBridgeToken || "").trim();
      if (!token) {
        sendResponse({ ok: false, error: "missing_token" });
        return;
      }
      const port = Number(cfg.ketyMeetBridgePort) || 17171;
      try {
        const allowAuto = await fetchAutoSendFromKety(token, port);
        if (!allowAuto) {
          sendResponse({
            ok: false,
            skipped: true,
            error: "auto_send_off_in_kety",
            status: 403,
          });
          return;
        }
        const out = await postCaptions(token, port, segmentId, text, false);
        sendResponse(out);
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    }
  );
  return true;
});
