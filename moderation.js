/* ─────────────────────────────────────────────────────────────────────────────
   moderation.js — shared by index.html and every game page

   • startGuard()      → game pages: live kick / ban / warn while someone is playing
   • openReportModal() → "🚩 Report" popup (games + main site)
   • anti-troll helpers (cooldown, strikes, junk filter) used by suggestions + reports
   ───────────────────────────────────────────────────────────────────────────── */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, updateDoc, onSnapshot, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ── CONFIG ──────────────────────────────────────────────────────────────── */
export const firebaseConfig = {
  apiKey: "AIzaSyCoK5dtkZwEIo0-1RqqaT3PAI0gUpBLLDQ",
  authDomain: "good-school-work.github.io",
  projectId: "good-school-work",
  storageBucket: "good-school-work.firebasestorage.app",
  messagingSenderId: "111606118885",
  appId: "1:111606118885:web:d492e59aa0661e2543d70c"
};

// Keep these numbers in sync with firestore.rules (the rules are what really enforce them)
export const SUBMIT_COOLDOWN_SEC = 120;  // min gap between any suggestion / report
export const NEW_ACCOUNT_MIN     = 10;   // brand-new accounts can't submit for this long
export const MAX_STRIKES         = 3;    // flagged-as-troll submissions before submissions are blocked

export const app  = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);

/* ── SMALL HELPERS ───────────────────────────────────────────────────────── */
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export const tsMs = t => (t && typeof t.toMillis === "function") ? t.toMillis() : (typeof t === "number" ? t : 0);

/** A ban is active if banned=true and it hasn't expired (bannedUntil is ms-since-epoch, absent = permanent). */
export function isBanActive(d) {
  if (!d || !d.banned) return false;
  return !d.bannedUntil || d.bannedUntil > Date.now();
}
export function describeBanEnd(d) {
  if (!d?.bannedUntil) return "This ban is permanent.";
  return "Your ban ends " + new Date(d.bannedUntil).toLocaleString() + ".";
}

/* ── BAN SCREEN (shown on the main site) ─────────────────────────────────── */
export function renderBanScreen(d) {
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0d0d0d;padding:20px;">
      <div style="text-align:center;color:white;font-family:'Nunito',Arial,sans-serif;max-width:460px;">
        <div style="font-size:5em;margin-bottom:16px;">🚫</div>
        <h1 style="color:#ff4444;font-size:2.4em;margin-bottom:10px;">You are banned.</h1>
        ${d?.banReason ? `<div style="background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:12px 16px;margin:14px 0;color:#ddd;"><b>Reason:</b> ${esc(d.banReason)}</div>` : ""}
        <p style="color:#aaa;margin-bottom:6px;">${esc(describeBanEnd(d))}</p>
        <p style="color:#777;font-size:14px;">Contact an admin if you believe this is a mistake.</p>
        <button id="ban-signout" style="margin-top:22px;padding:10px 22px;border-radius:10px;border:1px solid #444;background:#1a1a1a;color:#ddd;font-weight:700;cursor:pointer;">Sign out</button>
      </div>
    </div>`;
  document.getElementById("ban-signout").onclick = () => signOut(auth).then(() => location.replace(location.pathname));
}

/** Once a ban screen is up, reload the moment an admin unbans (or the ban expires). */
export function watchForUnban(uid) {
  return onSnapshot(doc(db, "users", uid), snap => {
    if (!isBanActive(snap.data())) location.replace(location.pathname);
  });
}

/* ── WARNING OVERLAY (works on any page — styles are inline) ─────────────── */
export function showWarnOverlay(message) {
  document.getElementById("warn-overlay")?.remove();
  const o = document.createElement("div");
  o.id = "warn-overlay";
  o.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;z-index:2147483647;padding:20px;font-family:'Nunito',Arial,sans-serif;";
  o.innerHTML = `
    <div style="background:#1a1a1a;border:2px solid #ffaa00;border-radius:16px;padding:28px;max-width:420px;width:100%;text-align:center;color:#eee;">
      <h2 style="color:#ffaa00;margin:0 0 10px;">⚠️ Warning</h2>
      <p style="margin:0 0 12px;">You have received a warning from an admin.</p>
      <div style="background:#262626;border-radius:10px;padding:12px;margin-bottom:12px;color:#fff;font-weight:700;word-break:break-word;">${esc(message || "Please follow the rules.")}</div>
      <p style="font-size:12px;color:#888;margin:0 0 16px;">Further violations may result in a ban.</p>
      <button id="warn-ok" style="padding:10px 26px;border:0;border-radius:10px;background:#ffaa00;color:#111;font-weight:800;cursor:pointer;">I understand</button>
    </div>`;
  document.body.appendChild(o);
  document.getElementById("warn-ok").onclick = async () => {
    o.remove();
    const u = auth.currentUser;
    if (u) await updateDoc(doc(db, "users", u.uid), { warned: false, warnMessage: "" }).catch(() => {});
  };
}

/* ── GAME-PAGE GUARD: live kick / ban / warn while playing ───────────────── */
/**
 * Call once from a game page (pages live in /games/, so home is ../index.html).
 * - not signed in  → sent to the main site to log in (and bounced back afterwards)
 * - banned         → sent to the main site, which shows the ban screen
 * - kicked         → signed out and sent to the main site
 * - warned         → warning overlay on top of the game, instantly
 */
export function startGuard() {
  const page = location.pathname.split("/").pop() || "";
  const home = qs => new URL("../index.html" + qs, location.href).href;
  const go   = qs => {
    // Embedded games (e.g. Rivals) install their own "Leave site? Changes may be lost" prompt.
    // Removing the iframes first means there's nothing left to ask, so the redirect just happens.
    window.onbeforeunload = null;
    document.querySelectorAll("iframe").forEach(f => f.remove());
    location.replace(home(qs));
  };

  // Black cover so a banned/kicked player never sees the game flash up first
  const cover = document.createElement("div");
  cover.style.cssText = "position:fixed;inset:0;background:#000;z-index:2147483646;display:flex;align-items:center;justify-content:center;color:#888;font:700 14px 'Nunito',Arial,sans-serif;";
  cover.textContent = "Checking your account…";
  (document.body || document.documentElement).appendChild(cover);
  const failTimer = setTimeout(() => { cover.textContent = "Couldn't verify your account. Check your connection and reload."; }, 10000);

  let unsub = null;
  onAuthStateChanged(auth, user => {
    if (unsub) { unsub(); unsub = null; }
    if (!user) return go("?next=" + encodeURIComponent("games/" + page));

    unsub = onSnapshot(doc(db, "users", user.uid), snap => {
      const d = snap.data();
      if (!d) return go("");                       // no profile yet → main site creates it

      if (d.banned && !isBanActive(d)) {            // temp ban just expired → clear it
        updateDoc(doc(db, "users", user.uid), { banned: false }).catch(() => {});
      }
      if (isBanActive(d)) return go("?banned=1");   // LIVE BAN

      if (d.kicked) {                               // LIVE KICK
        updateDoc(doc(db, "users", user.uid), { kicked: false })
          .catch(() => {}).then(() => signOut(auth)).then(() => go("?kicked=1"));
        return;
      }

      clearTimeout(failTimer);
      cover.remove();
      addReportButton();
      if (d.warned && d.warnMessage && !document.getElementById("warn-overlay")) showWarnOverlay(d.warnMessage); // LIVE WARN
    }, () => { cover.textContent = "Couldn't verify your account. Check your connection and reload."; });
  });
}

function addReportButton() {
  if (document.getElementById("mod-report-btn")) return;
  const b = document.createElement("button");
  b.id = "mod-report-btn";
  b.textContent = "🚩 Report";
  b.style.cssText = "position:fixed;top:14px;left:150px;z-index:2000;padding:7px 12px;border-radius:999px;background:rgba(17,17,17,.8);color:#f3f3f3;border:1px solid rgba(255,255,255,.12);font:700 12px/1 'Nunito',Arial,sans-serif;cursor:pointer;backdrop-filter:blur(6px);";
  b.onclick = () => openReportModal({ gameId: (location.pathname.split("/").pop() || "").replace(/\.html$/i, "") });
  document.body.appendChild(b);
}

/* ── ANTI-TROLL: junk filter ─────────────────────────────────────────────── */
// Tweak this list as you like. Whole-word matches (so "Sussex" is fine) …
const BAD_WORDS = new Set(["fuck","fucking","shit","bitch","cunt","dick","cock","pussy","penis","vagina","porn","porno","sex","sexy","whore","slut","rape","nazi","hitler","kys","retard","retarded","fag","faggot","nigga","nigger","asshole","bastard","cum","tits","boobs"]);
// … and these are caught even when glued inside other text ("fuuuuck", "f.u.c.k")
const BAD_STEMS = ["fuck","shit","cunt","nigg","fagg","bitch","whore"];

export function looksLikeTroll(text, { allowDomains = true } = {}) {
  const t = String(text || "").trim();
  if (t.length < 3) return "That's too short — add a bit more detail.";
  if (/(.)\1{5,}/i.test(t)) return "Please don't spam repeated characters.";
  if (/https?:\/\/|www\./i.test(t) && !allowDomains) return "Links aren't allowed here.";
  if (/https?:\/\//i.test(t)) return "Please type the name instead of pasting a link.";
  if ((t.match(/[A-Z]/g) || []).length > 12 && t === t.toUpperCase()) return "Please don't type in all caps.";
  const leet = t.toLowerCase().replace(/0/g,"o").replace(/1/g,"i").replace(/3/g,"e").replace(/4/g,"a").replace(/5/g,"s").replace(/[@]/g,"a").replace(/\$/g,"s");
  const tokens = leet.split(/[^a-z]+/).filter(Boolean);
  const collapsed = leet.replace(/[^a-z]/g, "").replace(/(.)\1+/g, "$1");  // fuuuck → fuck
  if (tokens.some(w => BAD_WORDS.has(w)) || BAD_STEMS.some(s => collapsed.includes(s)))
    return "Please keep it clean — that was blocked by the filter.";
  return null;
}

/* ── ANTI-TROLL: can this user submit right now? (friendly pre-check; the Firestore rules are the real lock) ── */
export function submitBlockReason(d) {
  if (!d) return "Please sign in first.";
  if (d.submitBlocked) return "You can't send suggestions or reports any more because too many of yours were flagged as spam.";
  const created = tsMs(d.createdAt);
  if (created) {
    const wait = NEW_ACCOUNT_MIN * 60000 - (Date.now() - created);
    if (wait > 0) return `New accounts have to wait ${Math.ceil(wait / 60000)} more minute(s) before sending suggestions or reports.`;
  }
  const last = tsMs(d.lastSubmitAt);
  if (last) {
    const wait = SUBMIT_COOLDOWN_SEC * 1000 - (Date.now() - last);
    if (wait > 0) return `Slow down! You can send another in ${Math.ceil(wait / 1000)}s.`;
  }
  return null;
}

/** Writes the document AND stamps lastSubmitAt in one atomic batch (the rules check both together). */
export async function submitFeedback(collectionName, docId, data) {
  const user = auth.currentUser;
  if (!user) throw new Error("not-signed-in");
  const batch = writeBatch(db);
  batch.set(doc(db, collectionName, docId), { ...data, uid: user.uid, timestamp: new Date().toISOString() });
  batch.update(doc(db, "users", user.uid), { lastSubmitAt: serverTimestamp() });
  await batch.commit();
}

/* ── REPORT MODAL ────────────────────────────────────────────────────────── */
export const REPORT_TYPES = {
  broken:        "🛠️ Game is broken / won't load",
  bug:           "🐞 Bug or glitch",
  inappropriate: "🔞 Inappropriate content or ads",
  user:          "👤 Report a player",
  other:         "💬 Something else"
};

/**
 * openReportModal({ gameId, games })
 *   gameId : preselect/lock a game (basename of its html file, e.g. "Space-Waves")
 *   games  : [{id, name}] → shows a game dropdown (used on the main site)
 */
export async function openReportModal({ gameId = "", games = null } = {}) {
  document.getElementById("report-overlay")?.remove();
  const o = document.createElement("div");
  o.id = "report-overlay";
  o.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:2147483645;padding:16px;font-family:'Nunito',Arial,sans-serif;";
  const field = "width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #333;background:#101010;color:#eee;font:600 14px 'Nunito',Arial,sans-serif;margin-bottom:10px;";
  o.innerHTML = `
    <div style="background:#1a1a1a;border:1px solid #333;border-radius:16px;padding:22px;max-width:420px;width:100%;color:#eee;">
      <h3 style="margin:0 0 4px;">🚩 Send a report</h3>
      <p style="margin:0 0 14px;color:#999;font-size:13px;">Reports go straight to the admins. Fake or joke reports get flagged and can lock your account out of sending more.</p>
      <select id="rp-type" style="${field}">${Object.entries(REPORT_TYPES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
      ${games ? `<select id="rp-game" style="${field}"><option value="">— Which game? (optional) —</option>${games.map(g => `<option value="${esc(g.id)}"${g.id === gameId ? " selected" : ""}>${esc(g.name)}</option>`).join("")}</select>` : ""}
      <textarea id="rp-details" maxlength="500" placeholder="What happened? (a few words is fine)" style="${field}min-height:90px;resize:vertical;"></textarea>
      <div id="rp-msg" style="min-height:18px;font-size:13px;font-weight:700;margin-bottom:8px;"></div>
      <div style="display:flex;gap:10px;">
        <button id="rp-send"   style="flex:1;padding:10px;border:0;border-radius:10px;background:#6c63ff;color:#fff;font-weight:800;cursor:pointer;">Send report</button>
        <button id="rp-cancel" style="padding:10px 18px;border-radius:10px;border:1px solid #444;background:#222;color:#ddd;font-weight:700;cursor:pointer;">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(o);
  const $ = id => o.querySelector("#" + id);
  const msg = (t, ok) => { $("rp-msg").style.color = ok ? "#4cd964" : "#ff6b6b"; $("rp-msg").textContent = t; };
  $("rp-cancel").onclick = () => o.remove();
  o.addEventListener("click", e => { if (e.target === o) o.remove(); });

  $("rp-send").onclick = async () => {
    const btn = $("rp-send");
    const user = auth.currentUser;
    if (!user) return msg("Please sign in first.");
    const type    = $("rp-type").value;
    const details = $("rp-details").value.trim();
    const gid     = games ? $("rp-game").value : gameId;
    if (details.length < 5) return msg("Please add a few words about what's wrong.");
    const junk = looksLikeTroll(details, { allowDomains: false });
    if (junk) return msg(junk);

    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const me = (await getDoc(doc(db, "users", user.uid))).data();
      const why = submitBlockReason(me);
      if (why) { msg(why); return; }
      // One report per player / game / type (so the same report can't be spammed)
      const id = `${user.uid}_${gid || "site"}_${type}` + ((type === "user" || type === "other") ? "_" + Date.now() : "");
      await submitFeedback("reports", id, {
        type, gameId: gid || "", details,
        reporterEmail: user.email || "", reporterName: me?.displayName || "", status: "open"
      });
      msg("✅ Report sent — thank you!", true);
      setTimeout(() => o.remove(), 1500);
    } catch (e) {
      msg(e.code === "permission-denied"
        ? "Couldn't send — you may have already reported that, or you're sending too fast."
        : "Failed to send. Try again.");
    } finally {
      btn.disabled = false; btn.textContent = "Send report";
    }
  };
}
