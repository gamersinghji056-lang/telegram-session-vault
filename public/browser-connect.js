const MTCUTE_URL = "https://esm.sh/@mtcute/web@0.32.1?bundle";
const SLOT_KEY = "tg-vault-browser-slots-v1";
const NOTICE_KEY = "tg-vault-browser-notices-v1";
const MAX_ACCOUNTS = 100;
const RECONNECT_CONCURRENCY = 5;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[c]));

let TelegramClientClass = null;
let slots = loadJson(SLOT_KEY, []);
let notices = loadJson(NOTICE_KEY, []);
const clients = new Map();
const connecting = new Set();

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "") || fallback; } catch { return fallback; }
}
function saveSlots() { localStorage.setItem(SLOT_KEY, JSON.stringify(slots)); renderAccounts(); }
function saveNotices() {
  notices = notices.slice(0, 200);
  localStorage.setItem(NOTICE_KEY, JSON.stringify(notices));
  renderNotices();
}
function slotStatusClass(status) {
  if (status === "ONLINE") return "online";
  if (status === "CONNECTING") return "busy";
  if (status === "ERROR" || status === "REAUTH_REQUIRED") return "error";
  return "";
}
function setSlot(id, patch) {
  const s = slots.find(x => x.id === id);
  if (!s) return;
  Object.assign(s, patch);
  saveSlots();
}

function renderAccounts() {
  $("#count").textContent = `${slots.length} / ${MAX_ACCOUNTS}`;
  $("#accounts").innerHTML = slots.map(s => `
    <div class="accountItem">
      <div class="accountTop">
        <div>
          <b><span class="statusDot ${slotStatusClass(s.status)}"></span>${esc(s.label || s.phone || "Telegram account")}</b>
          <div class="muted small">${esc(s.phone || "")}${s.telegramId ? ` · TG ${esc(s.telegramId)}` : ""}</div>
          <div class="muted small">${esc(s.status || "SAVED")}${s.error ? ` · ${esc(s.error)}` : ""}</div>
        </div>
      </div>
      <div class="toolbar" style="margin-top:10px">
        <button class="btn primary" data-connect="${esc(s.id)}">Connect</button>
        <button class="btn ghost" data-disconnect="${esc(s.id)}">Sleep</button>
      </div>
    </div>
  `).join("") || '<div class="muted" style="margin-top:12px">No browser-direct accounts yet.</div>';

  document.querySelectorAll("[data-connect]").forEach(b => b.onclick = () => connectSlot(b.dataset.connect, false));
  document.querySelectorAll("[data-disconnect]").forEach(b => b.onclick = () => disconnectSlot(b.dataset.disconnect));
}
function renderNotices() {
  $("#notices").innerHTML = notices.map(n => `
    <div class="noticeItem">
      <div><b>${esc(n.accountLabel || "Telegram")}</b> <span class="muted small">${esc(new Date(n.date).toLocaleString())}</span></div>
      <div style="margin-top:5px;white-space:pre-wrap">${esc(n.text || "[service message]")}</div>
    </div>
  `).join("") || '<div class="muted">No service notices received in this browser yet.</div>';
}

function creds() {
  const apiId = Number(sessionStorage.getItem("tgApiId") || $("#apiId").value || 0);
  const apiHash = String(sessionStorage.getItem("tgApiHash") || $("#apiHash").value || "").trim();
  if (!Number.isInteger(apiId) || apiId <= 0 || apiHash.length < 8) throw new Error("Enter valid Telegram API ID and API Hash first.");
  return { apiId, apiHash };
}
function saveCreds() {
  const apiId = Number($("#apiId").value || 0);
  const apiHash = String($("#apiHash").value || "").trim();
  if (!Number.isInteger(apiId) || apiId <= 0 || apiHash.length < 8) throw new Error("Invalid API credentials.");
  sessionStorage.setItem("tgApiId", String(apiId));
  sessionStorage.setItem("tgApiHash", apiHash);
  alert("Credentials are set for this browser tab.");
}
function restoreCredInputs() {
  $("#apiId").value = sessionStorage.getItem("tgApiId") || "";
  $("#apiHash").value = sessionStorage.getItem("tgApiHash") || "";
}

async function loadClientClass() {
  if (TelegramClientClass) return TelegramClientClass;
  const mod = await import(MTCUTE_URL);
  if (!mod.TelegramClient) throw new Error("Browser MTProto module did not load.");
  TelegramClientClass = mod.TelegramClient;
  return TelegramClientClass;
}

function localAsk(title, help, type = "text") {
  return new Promise((resolve, reject) => {
    const modal = $("#localPrompt");
    const input = $("#localPromptInput");
    $("#localPromptTitle").textContent = title;
    $("#localPromptHelp").textContent = help || "";
    input.type = type;
    input.value = "";
    modal.classList.remove("hidden");
    setTimeout(() => input.focus(), 20);

    const finish = (ok) => {
      modal.classList.add("hidden");
      $("#localPromptOk").onclick = null;
      $("#localPromptCancel").onclick = null;
      input.onkeydown = null;
      if (!ok) reject(new Error("LOGIN_CANCELLED"));
      else resolve(input.value.trim());
    };
    $("#localPromptOk").onclick = () => finish(true);
    $("#localPromptCancel").onclick = () => finish(false);
    input.onkeydown = (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    };
  });
}

function messagePeerId(msg) {
  const values = [
    msg?.sender?.id,
    msg?.senderId,
    msg?.chat?.id,
    msg?.chatId
  ];
  for (const v of values) {
    if (v !== undefined && v !== null) return String(v);
  }
  return "";
}
function hookServiceMessages(slot, tg) {
  tg.onNewMessage.add((msg) => {
    try {
      if (messagePeerId(msg) !== "777000") return;
      notices.unshift({
        id: `${slot.id}:${msg.id || Date.now()}`,
        slotId: slot.id,
        accountLabel: slot.label || slot.phone || "Telegram",
        text: String(msg.text || ""),
        date: msg.date instanceof Date ? msg.date.toISOString() : new Date().toISOString()
      });
      saveNotices();
    } catch (e) {
      console.warn("service notice handler", e);
    }
  });
}

async function connectSlot(id, isNew) {
  if (connecting.has(id)) return;
  const slot = slots.find(x => x.id === id);
  if (!slot) return;
  connecting.add(id);
  setSlot(id, { status:"CONNECTING", error:"" });

  try {
    const { apiId, apiHash } = creds();
    const TelegramClient = await loadClientClass();

    let tg = clients.get(id);
    if (!tg) {
      tg = new TelegramClient({
        apiId,
        apiHash,
        storage: `tg-vault-browser-${id}`,
        updates: { catchUp: true }
      });
      hookServiceMessages(slot, tg);
      clients.set(id, tg);
    }

    const me = await tg.start({
      phone: async () => {
        const value = await localAsk("Telegram phone", "Enter this account owner's phone number in international format, e.g. +919876543210");
        slot.phone = value;
        saveSlots();
        return value;
      },
      code: async () => localAsk("Telegram login code", "Enter the code Telegram sent to this account. It stays inside this browser flow."),
      password: async () => localAsk("Telegram 2-step password", "Enter the account owner's Telegram 2FA password. It is not sent to Railway.", "password"),
      invalidCodeCallback: async (kind) => {
        alert(kind === "password" ? "Invalid Telegram 2FA password. Try again." : "Invalid Telegram login code. Try again.");
      }
    });

    setSlot(id, {
      label: me?.displayName || me?.firstName || slot.phone || "Telegram account",
      telegramId: me?.id != null ? String(me.id) : "",
      status: "ONLINE",
      error: "",
      connectedAt: new Date().toISOString()
    });
  } catch (e) {
    const text = String(e?.message || e || "Connection failed");
    setSlot(id, {
      status: /AUTH|PASSWORD|PHONE_CODE|LOGIN/i.test(text) ? "REAUTH_REQUIRED" : "ERROR",
      error: text.slice(0, 160)
    });
    if (isNew && /LOGIN_CANCELLED/.test(text)) {
      slots = slots.filter(x => x.id !== id);
      saveSlots();
    }
  } finally {
    connecting.delete(id);
  }
}

async function disconnectSlot(id) {
  const tg = clients.get(id);
  try { if (tg) await tg.disconnect(); } catch {}
  clients.delete(id);
  setSlot(id, { status:"SLEEPING", error:"" });
}

async function addAccount() {
  if (slots.length >= MAX_ACCOUNTS) return alert("100 account limit reached for this browser profile.");
  try { creds(); } catch (e) { return alert(e.message); }

  const id = crypto.randomUUID();
  slots.push({ id, label:`Account ${slots.length + 1}`, phone:"", telegramId:"", status:"SAVED", error:"" });
  saveSlots();
  await connectSlot(id, true);
}

async function reconnectAll() {
  try { creds(); } catch (e) { return alert(e.message); }
  const queue = slots.slice();
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      await connectSlot(item.id, false);
    }
  }
  const workers = Array.from({ length: Math.min(RECONNECT_CONCURRENCY, queue.length) }, () => worker());
  await Promise.all(workers);
}

$("#saveCreds").onclick = () => { try { saveCreds(); } catch(e) { alert(e.message); } };
$("#addAccount").onclick = addAccount;
$("#reconnectAll").onclick = reconnectAll;
$("#clearNotices").onclick = () => { notices = []; saveNotices(); };

window.addEventListener("beforeunload", () => {
  for (const tg of clients.values()) {
    try { tg.disconnect(); } catch {}
  }
});

restoreCredInputs();
renderAccounts();
renderNotices();
