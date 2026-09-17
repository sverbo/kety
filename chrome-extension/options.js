const KEYS = {
  token: "ketyMeetBridgeToken",
  port: "ketyMeetBridgePort",
};

const defaults = {
  [KEYS.token]: "",
  [KEYS.port]: 17171,
};

const ICON_COPY =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_SYNC =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>';
const ICON_TRASH =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

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

function $(id) {
  return document.getElementById(id);
}

function setStatus(text, ok) {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + (ok === true ? "ok" : ok === false ? "err" : "");
}

function setMeetStatus(text, ok) {
  const el = $("meet-status");
  if (!el) return;
  el.textContent = text;
  el.className = ok === true ? "ok" : ok === false ? "err" : "";
  el.style.color =
    ok === true ? "#248a3d" : ok === false ? "#d93025" : "rgba(0,0,0,0.55)";
}

function fmtTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "";
  }
}

function loadMeetings() {
  chrome.runtime.sendMessage({ type: "KETY_MEET_LIST_SESSIONS" }, (res) => {
    if (chrome.runtime.lastError) {
      setMeetStatus(chrome.runtime.lastError.message, false);
      return;
    }
    if (!res || !res.ok) {
      setMeetStatus("Couldn't load this list.", false);
      return;
    }
    renderMeetings(res.sessions || []);
  });
}

function renderMeetings(sessions) {
  const host = $("meetings-list");
  host.innerHTML = "";
  if (!sessions.length) {
    host.innerHTML =
      '<p class="muted">No meetings here yet. Open Google Meet, turn on <strong>captions (CC)</strong>, and keep that tab open while you talk.</p>';
    return;
  }
  for (const s of sessions) {
    const div = document.createElement("div");
    div.className = "meet-row";
    const title = document.createElement("div");
    title.className = "meet-row-title";
    title.textContent = s.title || "Google Meet";
    const meta = document.createElement("div");
    meta.className = "meet-row-meta";
    meta.textContent = `${fmtTime(s.updatedAt)} · ${(s.meetUrl || "").slice(0, 72)}${(s.meetUrl || "").length > 72 ? "…" : ""}`;
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
          if (!chrome.runtime.lastError && r && r.ok) loadMeetings();
        }
      );
    });
    const btnCopy = document.createElement("button");
    btnCopy.type = "button";
    btnCopy.className = "icon-btn";
    btnCopy.title = "Copy meeting text";
    btnCopy.setAttribute("aria-label", "Copy meeting text");
    btnCopy.innerHTML = ICON_COPY;
    btnCopy.disabled = !fullText;
    btnCopy.addEventListener("click", () => {
      copyToClipboard(fullText).then((ok) => {
        if (ok) setMeetStatus("Copied.", true);
        else setMeetStatus("Couldn't copy.", false);
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
            setMeetStatus(chrome.runtime.lastError.message, false);
            loadMeetings();
            return;
          }
          if (r && r.ok) {
            setMeetStatus(synced ? "Updated in Kety." : "Sent to Kety.", true);
            loadMeetings();
          } else {
            if (r && r.error === "meet_tab_still_open") {
              setMeetStatus("Leave the Meet tab first, then send to Kety.", false);
              return;
            }
            setMeetStatus("Couldn't send to Kety. Is the app open on this computer?", false);
            loadMeetings();
          }
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
      errEl.className = "meet-row-sync-err";
      errEl.setAttribute("role", "alert");
      errEl.textContent = errMsg;
      div.appendChild(errEl);
    }
    host.appendChild(div);
  }
}

function applyStorageToForm(s) {
  $("token").value = s[KEYS.token] || "";
  $("port").value = s[KEYS.port];
}

/** When installed from Kety’s ZIP, kety-bridge-preset.json pre-fills token + port into extension storage. */
function loadOptionsForm() {
  const presetUrl = chrome.runtime.getURL("kety-bridge-preset.json");
  fetch(presetUrl)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((preset) => {
      chrome.storage.local.get(defaults, (s) => {
        if (chrome.runtime.lastError) {
          applyStorageToForm({ ...defaults });
          return;
        }
        const base = { ...defaults, ...s };
        let token = base[KEYS.token] || "";
        let port = base[KEYS.port];
        if (preset && typeof preset.bridgeToken === "string" && preset.bridgeToken.trim()) {
          token = preset.bridgeToken.trim();
          port = Math.min(65535, Math.max(1, Number(preset.bridgePort) || 17171));
          chrome.storage.local.set(
            { [KEYS.token]: token, [KEYS.port]: port },
            () => applyStorageToForm({ ...base, [KEYS.token]: token, [KEYS.port]: port })
          );
        } else {
          applyStorageToForm(base);
        }
      });
    });
}

loadOptionsForm();

$("save").addEventListener("click", () => {
  const token = $("token").value.trim();
  const port = Math.min(65535, Math.max(1, parseInt($("port").value, 10) || 17171));
  chrome.storage.local.set(
    {
      [KEYS.token]: token,
      [KEYS.port]: port,
    },
    () => {
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message, false);
        return;
      }
      setStatus("Saved", true);
      loadMeetings();
    }
  );
});

loadMeetings();
setInterval(loadMeetings, 12000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.ketyMeetRecentSessions) loadMeetings();
});
