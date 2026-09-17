const SESSIONS_KEY = "ketyMeetRecentSessions";

const ICON_COPY =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_SYNC =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>';
const ICON_TRASH =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

let toastTimer = null;

function showToast(text, ok) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.className = ok === true ? "ok" : ok === false ? "err" : "";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.textContent = "";
    el.className = "";
    toastTimer = null;
  }, 3500);
}

function copyToClipboard(text) {
  const t = String(text || "");
  if (!t) return Promise.resolve(false);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(t).then(
      () => true,
      () => copyToClipboardFallback(t)
    );
  }
  return Promise.resolve(copyToClipboardFallback(t));
}

function copyToClipboardFallback(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

function fmtTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return "";
  }
}

function refreshCcReminder() {
  const wrap = document.getElementById("cc-reminder");
  const soft = document.getElementById("banner-soft");
  chrome.runtime.sendMessage({ type: "KETY_MEET_CC_STATUS" }, (res) => {
    if (!wrap) return;
    const needs = !!(res && res.needCc);
    wrap.hidden = !needs;
    if (soft) soft.hidden = needs;
  });
}

function renderList(sessions) {
  const listEl = document.getElementById("list");
  if (!listEl) return;
  listEl.innerHTML = "";
  const sorted = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!sorted.length) {
    listEl.innerHTML =
      '<p class="empty">No meetings saved in this browser yet. Join a Meet, turn on captions (CC), and keep the tab open.</p>';
    return;
  }
  for (const s of sorted) {
    const div = document.createElement("div");
    div.className = "row";
    const title = document.createElement("div");
    title.className = "row-title";
    title.textContent = s.title && s.title.trim() ? s.title.trim() : "Google Meet";
    const meta = document.createElement("div");
    meta.className = "row-meta";
    meta.textContent = fmtTime(s.updatedAt);
    const transcript = document.createElement("pre");
    transcript.className = "meet-transcript";
    const fullText = (s.lastText || "").trim();
    transcript.textContent = fullText || "-";
    const actions = document.createElement("div");
    actions.className = "meet-actions";
    const btnDelete = document.createElement("button");
    btnDelete.type = "button";
    btnDelete.className = "icon-btn";
    btnDelete.title = "Remove from this list (your Kety app is unchanged)";
    btnDelete.setAttribute("aria-label", "Remove from list");
    btnDelete.innerHTML = ICON_TRASH;
    btnDelete.addEventListener("click", () => {
      chrome.runtime.sendMessage(
        { type: "KETY_MEET_DELETE_SESSION", segmentId: s.segmentId },
        (r) => {
          if (!chrome.runtime.lastError && r && r.ok) load();
        }
      );
    });
    const btnCopy = document.createElement("button");
    btnCopy.type = "button";
    btnCopy.className = "icon-btn";
    btnCopy.title = "Copy text";
    btnCopy.setAttribute("aria-label", "Copy meeting text");
    btnCopy.innerHTML = ICON_COPY;
    btnCopy.disabled = !fullText;
    btnCopy.addEventListener("click", () => {
      copyToClipboard(fullText).then((ok) => {
        showToast(ok ? "Copied to clipboard." : "Couldn't copy-try again.", ok);
      });
    });
    const canSync = s.syncWithAppEnabled === true;
    const synced =
      typeof s.lastSyncedToAppAt === "number" &&
      Number.isFinite(s.lastSyncedToAppAt) &&
      s.lastSyncedToAppAt > 0;
    const btnSync = document.createElement("button");
    btnSync.type = "button";
    btnSync.className = "btn-sync-app";
    btnSync.innerHTML = `${ICON_SYNC}<span>${synced ? "Resync with app" : "Sync with app"}</span>`;
    btnSync.disabled = !fullText || !canSync;
    btnSync.title = !canSync
      ? "Leave the Meet tab first, then you can send to Kety."
      : synced
        ? "Already sent to Kety. Tap to send again if the transcript changed."
        : "Send this meeting to the Kety app on your computer.";
    btnSync.addEventListener("click", () => {
      btnSync.disabled = true;
      btnCopy.disabled = true;
      btnDelete.disabled = true;
      chrome.runtime.sendMessage(
        { type: "KETY_MEET_MANUAL_PUSH", segmentId: s.segmentId },
        (r) => {
          const hasText = !!(s.lastText || "").trim();
          btnSync.disabled = !hasText || !canSync;
          btnCopy.disabled = !hasText;
          btnDelete.disabled = false;
          if (chrome.runtime.lastError) {
            showToast(chrome.runtime.lastError.message, false);
            load();
            return;
          }
          if (r && r.ok) {
            showToast(synced ? "Updated in Kety." : "Sent to Kety.", true);
            load();
            return;
          }
          if (r && r.error === "meet_tab_still_open") {
            showToast("Leave the Meet tab first, then send to Kety.", false);
            return;
          }
          showToast("Couldn't send to Kety. Is the app open on this computer?", false);
          load();
        }
      );
    });
    actions.appendChild(btnDelete);
    actions.appendChild(btnCopy);
    if (synced) {
      const tick = document.createElement("span");
      tick.className = "sync-done-check";
      tick.setAttribute("aria-label", "Already sent to Kety");
      tick.title = "Already sent to Kety";
      tick.textContent = "✓";
      actions.appendChild(tick);
    }
    actions.appendChild(btnSync);
    div.appendChild(title);
    div.appendChild(meta);
    div.appendChild(transcript);
    div.appendChild(actions);
    const errMsg =
      typeof s.lastPushError === "string" && s.lastPushError.trim() ? s.lastPushError.trim() : "";
    if (errMsg) {
      const errEl = document.createElement("p");
      errEl.className = "meet-sync-err";
      errEl.setAttribute("role", "alert");
      errEl.textContent = errMsg;
      div.appendChild(errEl);
    }
    listEl.appendChild(div);
  }
}

function load() {
  chrome.runtime.sendMessage({ type: "KETY_MEET_LIST_SESSIONS" }, (res) => {
    if (chrome.runtime.lastError) {
      const listEl = document.getElementById("list");
      if (listEl) {
        listEl.innerHTML =
          '<p class="empty">We couldn’t load your meetings. Open Settings and check your link to Kety.</p>';
      }
      refreshCcReminder();
      return;
    }
    if (!res || !res.ok) {
      const listEl = document.getElementById("list");
      if (listEl) listEl.innerHTML = '<p class="empty">Something went wrong. Open Settings and try again.</p>';
      refreshCcReminder();
      return;
    }
    renderList(res.sessions || []);
    refreshCcReminder();
  });
}

document.getElementById("open-options")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("retention-hint").textContent =
  "Meetings stay here for 24 hours. Close the Meet tab to send to Kety-or tap Sync with app. If you use auto-send in Kety, it happens when you leave the call.";

setInterval(refreshCcReminder, 2000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[SESSIONS_KEY]) load();
});

load();
refreshCcReminder();
