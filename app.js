/* Ayers Aquariums - mobile web app
 * Talks to the Apps Script API (config.js -> apiUrl) with a Google sign-in token.
 * Roles come from the App Users tab: Admin, Editor (specific tanks), Viewer.
 */
(function () {
  "use strict";

  const CFG = window.AA_CONFIG || {};
  const TOKEN_KEY = "aa_id_token";        // Google sign-in pass (only until the server gives a session)
  const SESSION_KEY = "aa_session";       // the app's own session: { token, exp }

  const state = {
    token: null,
    me: null,
    schema: null,
    data: null,
    users: null,
    booting: false,
    authMessage: "",
    notAllowedEmail: "",
    gisReady: false,
    browseType: "species",
    query: "",
    showRetired: false,
    showRemoved: false,
    receipts: [],
    receiptLinks: [],
    vendors: [],
    receiptFilter: "all",
    receiptQuery: "",
    showRetiredReceipts: false,
    photoCache: {},
    testTypes: [],
    waterSessions: [],
    waterTests: [],
    methods: ["Strip", "Liquid", "Digital"],
    waterTank: (function () { try { return localStorage.getItem("aa_water_tank") || ""; } catch (e) { return ""; } })(),
    waterDays: (function () { try { return Number(localStorage.getItem("aa_water_days")) || 60; } catch (e) { return 60; } })(),
    waterChanges: [],
    showRetiredMaint: false,
    maintTank: (function () { try { return localStorage.getItem("aa_maint_tank") || ""; } catch (e) { return ""; } })(),
    wishes: [],
    compat: [],
    photos: [],
    priceItems: [], prices: [], priceUnits: [], priceQuery: "", priceFilter: "all", priceOpen: {},
    lookups: [], lookupTypes: [], listQuery: "", receiptLines: [],
    treatments: [], treatmentDoses: [], doseUnits: [], stockOptions: [], showPastTrt: false,
    wishOptions: { priorities: ["High", "Medium", "Low"], statuses: ["Researching", "Want", "Purchased", "Not getting"] },
    wishFilter: "open",
    wishTank: "",
    itemPhotos: {}
  };

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------
  const esc = v => String(v === null || v === undefined ? "" : v)
    .replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  // "2026-11-16" for a date input or an ID; blank for no date.
  const fmtISO = d => d ? d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") : "";
  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
    if (!m) return s || "";
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  const today = () => fmtISO(new Date());
  function parseJwt(t) {
    try {
      const p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const json = decodeURIComponent(atob(p).split("").map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join(""));
      return JSON.parse(json);
    } catch (e) { return null; }
  }
  function tokenValid(t) {
    const p = t && parseJwt(t);
    return !!(p && p.exp && p.exp * 1000 > Date.now() + 60 * 1000);
  }
  let toastTimer;
  function toast(msg, isError) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ""; }, isError ? 4500 : 2200);
  }
  // ------------------------------------------------------------------
  // Pop-ups (forms, confirmations, photo viewer, sign-in, spinner): while one is open,
  // everything behind it is made inert (no clicks, no keyboard, Tab can't reach it), Tab
  // cycles inside the pop-up, and focus goes back where it was when the pop-up closes.
  // Closing happens however the pop-up is removed (Cancel, X, after saving...).
  // ------------------------------------------------------------------
  const modals = [];   // open pop-ups, newest last: { el, inerted, prev }
  function modalOpen(el, focusEl) {
    const inerted = [];
    Array.from(document.body.children).forEach(c => {
      if (c === el || c.id === "toast" || c.tagName === "SCRIPT" || c.inert) return;
      c.inert = true; inerted.push(c);
    });
    modals.push({ el: el, inerted: inerted, prev: document.activeElement });
    const target = focusEl || el;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    // Tab / Shift+Tab wrap around inside the pop-up.
    el.addEventListener("keydown", e => {
      if (e.key !== "Tab") return;
      const items = $$('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', el)
        .filter(x => x.offsetParent !== null && !x.closest("[hidden]"));
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement) || document.activeElement === target)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  // When a pop-up leaves the page, un-lock what it locked and return focus.
  new MutationObserver(() => {
    for (let i = modals.length - 1; i >= 0; i--) {
      const m = modals[i];
      if (document.body.contains(m.el)) continue;
      m.inerted.forEach(c => { c.inert = false; });
      modals.splice(i, 1);
      if (i === modals.length && m.prev && document.body.contains(m.prev) && !m.prev.closest("[inert]")) {
        try { m.prev.focus({ preventScroll: true }); } catch (e) { /* gone */ }
      }
    }
  }).observe(document.body, { childList: true });

  // Full-screen spinner. onCancel (optional): shows a Cancel button with a label (for AI steps).
  function busy(on, onCancel, label) {
    let el = $(".busy");
    if (on && !el) {
      el = document.createElement("div");
      el.className = "busy";
      el.setAttribute("role", "alert"); el.setAttribute("aria-busy", "true");
      el.innerHTML = '<div class="spinner"></div>';
      document.body.appendChild(el);
      modalOpen(el);
    } else if (!on && el) { el.remove(); return; }
    if (on && el && onCancel) {
      el.innerHTML = '<div class="busy-box"><div class="spinner"></div>' + (label ? '<div class="busy-label">' + esc(label) + '</div>' : "") +
        '<button type="button" class="btn" data-busy-cancel>Cancel</button></div>';
      $("[data-busy-cancel]", el).addEventListener("click", () => { $("[data-busy-cancel]", el).disabled = true; onCancel(); });
      $("[data-busy-cancel]", el).focus();
    }
  }
  function thumbUrl(url, width) {
    if (!url) return "";
    if (/commons\.wikimedia\.org\/wiki\/Special:FilePath\//.test(url) && url.indexOf("?") === -1) return url + "?width=" + (width || 160);
    return url;
  }
  function isUrl(v) { return /^https?:\/\//i.test(String(v || "")); }
  // Item photos uploaded from the app live in Drive and are loaded through the server.
  function driveId(url) { const m = /drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/.exec(String(url || "")); return m ? m[1] : ""; }
  function photoHtml(url, cls, width, fallback) {
    if (!url) return fallback ? '<span class="' + cls + '">' + esc(fallback) + '</span>' : "";
    const id = driveId(url);
    if (id) {
      const c = state.itemPhotos[id];
      return '<img class="' + cls + ' drive-img" alt="" data-drive="' + esc(id) + '"' + (c && c.url ? ' src="' + c.url + '"' : "") + '>';
    }
    return '<img class="' + cls + '" loading="lazy" alt="" src="' + esc(thumbUrl(url, width)) + '">';
  }
  const photoQueue = [];
  let photoLoading = 0;
  function hydratePhotos(root) {
    $$("img[data-drive]", root || document).forEach(img => {
      const id = img.dataset.drive;
      const c = state.itemPhotos[id];
      if (c && c.url) { if (img.getAttribute("src") !== c.url) img.src = c.url; return; }
      if (!c) { state.itemPhotos[id] = { loading: true }; photoQueue.push(id); }
    });
    pumpPhotos();
  }
  function pumpPhotos() {
    while (photoLoading < 2 && photoQueue.length) {
      const id = photoQueue.shift();
      photoLoading++;
      api("itemPhoto", { fileId: id }).then(res => {
        const bin = atob(res.image.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        state.itemPhotos[id] = { url: URL.createObjectURL(new Blob([bytes], { type: res.image.mimeType || "image/jpeg" })) };
        $$('img[data-drive="' + CSS.escape(id) + '"]').forEach(img => { img.src = state.itemPhotos[id].url; });
      }).catch(() => {
        state.itemPhotos[id] = { error: true };
        $$('img[data-drive="' + CSS.escape(id) + '"]').forEach(img => img.classList.add("photo-error"));
      }).finally(() => { photoLoading--; pumpPhotos(); });
    }
  }

  const ICONS = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11L12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
    fish: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12c3-5 9-6.5 13-3l4-3v12l-4-3c-4 3.5-10 2-13-3z"/><circle cx="8" cy="11" r=".6" fill="currentColor"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M9 7h6M9 11h6"/><circle cx="12" cy="16" r="1.6"/></svg>',
    leaf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19c0-8 5-14 15-15-1 10-7 15-15 15z"/><path d="M5 19l8-8"/></svg>',
    pill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8.5" width="18" height="7" rx="3.5" transform="rotate(-40 12 12)"/><path d="M9.6 9.1l5.3 5.3" transform="rotate(0)"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M15.5 4.8a3.4 3.4 0 0 1 0 6.4M17.5 14.8c2 .7 3.4 2.4 4 5.2"/></svg>',
    flask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7.5 15h9"/></svg>',
    tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8" r="1.3"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    tanks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10c3 1.5 6 1.5 9 0s6-1.5 9 0"/></svg>',
    browse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.9.7 3.1 2.4 3.5 5.2"/></svg>',
    account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.2-6 8-6s7 2 8 6"/></svg>',
    water: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c3.2 4 5.5 7.2 5.5 10.2a5.5 5.5 0 0 1-11 0c0-3 2.3-6.2 5.5-10.2z"/><path d="M9.2 14.5a2.9 2.9 0 0 0 2.8 2.6"/></svg>',
    receipts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M20.5 16l-5-5-8.5 8.5"/></svg>',
    maint: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.3a1.8 1.8 0 0 0 2.5 2.5l5.8-5.8a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.3-.4-.4-2.3z"/></svg>',
    wish: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
  };

  // ------------------------------------------------------------------
  // Record types
  // ------------------------------------------------------------------
  const TYPES = {
    species: {
      label: "Species", one: "Species", id: "Species ID",
      title: r => r["Common Name"] || r["Species ID"],
      sub: r => r["Scientific Name"],
      img: r => r["Thumbnail URL"]
    },
    equipment: {
      label: "Equipment", one: "Equipment", id: "Equipment ID",
      title: r => [r["Manufacturer"], r["Filter Model"]].filter(Boolean).join(" ") || r["Category"] || r["Equipment ID"],
      // Serial number (when there is one) tells apart two of the same model.
      sub: r => [r["Category"], String(r["Serial Number"] || "").trim() ? "S/N " + String(r["Serial Number"]).trim() : ""].filter(Boolean).join(" · "),
      img: r => r["Thumbnail URL"]
    },
    plants: {
      label: "Plants", one: "Plant", id: "Plant ID",
      title: r => r["Common Name"] || r["Plant ID"],
      sub: r => r["Scientific Name"],
      img: r => r["Thumbnail URL"]
    },
    medications: {
      label: "Medications", one: "Medication / Supplement", id: "Product ID",
      title: r => r["Product Name"] || r["Product ID"],
      sub: r => [r["Manufacturer"], r["Product Type"]].filter(Boolean).join(" · "),
      img: () => ""
    },
    tanks: {
      label: "Tanks", one: "Tank", id: "Tank ID",
      title: r => r["Tank Name"] || r["Tank ID"],
      sub: r => [r["Volume (gal)"] ? r["Volume (gal)"] + " gal" : "", r["Aquarium Type"]].filter(Boolean).join(" · "),
      img: () => ""
    }
  };
  const ITEM_TYPES = ["species", "equipment", "plants"];

  const isAdmin = () => state.me && state.me.role === "Admin";
  const canEditTank = id => isAdmin() || (state.me && state.me.role === "Editor" && state.me.tanks.indexOf(id) !== -1);
  const canReceipts = () => state.me && (state.me.role === "Admin" || state.me.role === "Editor");
  const isRetired = r => String(r["Status"] || "").toLowerCase() === "retired";
  const findRec = (type, id) => (state.data[type] || []).find(r => r[TYPES[type].id] === id);
  function itemType(id) {
    for (const t of ITEM_TYPES) if (findRec(t, id)) return t;
    return null;
  }
  const isActiveAssignment = a => a["Active"] === true && !a["Date Removed"];
  // Wishlist rows on Tank Assignments: never in the tank (no Date Added).
  const isWishOnlyRow = a => !!a["Wish ID"] && !a["Date Added"] && a["Active"] !== true;
  const isPendingWishRow = a => isWishOnlyRow(a) && !a["Date Removed"];
  const isWishItem = r => String((r && r["Status"]) || "") === "Wishlist";
  const tankAssignments = (tankId, active) => state.data.assignments
    .filter(a => a["Tank ID"] === tankId && (active ? isActiveAssignment(a) : (!isActiveAssignment(a) && !isWishOnlyRow(a))));
  const tankName = id => { const t = findRec("tanks", id); return t ? t["Tank Name"] : id; };

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------
  // signal (optional): an AbortController signal; aborting stops waiting (error code CANCELLED).
  async function api(action, payload, signal) {
    // Use the app session while it's fresh; otherwise a Google sign-in pass from signing in.
    const useSession = !!(state.session && state.sessionExp > Date.now() + 30 * 1000);
    if (!useSession && !(state.token && tokenValid(state.token))) {
      const e = new Error("You were signed out after an hour without using the app. Please sign in again.");
      e.code = "AUTH";
      throw e;
    }
    let res;
    try {
      res = await fetch(CFG.apiUrl, {
        method: "POST",
        body: JSON.stringify(Object.assign({ action: action }, useSession ? { session: state.session } : { idToken: state.token }, payload || {})),
        signal: signal
      });
    } catch (err) {
      if (signal && signal.aborted) { const c = new Error("Cancelled."); c.code = "CANCELLED"; throw c; }
      const e = new Error("Can't reach the server. Check your connection and try again.");
      e.code = "NETWORK";
      throw e;
    }
    let json;
    try { json = await res.json(); } catch (err) {
      if (signal && signal.aborted) { const c = new Error("Cancelled."); c.code = "CANCELLED"; throw c; }
      const e = new Error("The server sent an unexpected response.");
      e.code = "ERROR";
      throw e;
    }
    if (json && json.session) setSession(json.session);   // each request renews the session
    if (signal && signal.aborted) { const c = new Error("Cancelled."); c.code = "CANCELLED"; throw c; }
    if (!json.ok) {
      const e = new Error(json.message || "Something went wrong.");
      e.code = json.code;
      e.email = json.email;
      throw e;
    }
    return json;
  }

  // An AI request that can be cancelled. job.run(action, payload) calls the server with a cancel ID;
  // job.cancel() stops waiting right away and tells the server to skip AI steps it hasn't started.
  function aiJob() {
    const ctrl = new AbortController();
    const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    let cancelled = false;
    return {
      get cancelled() { return cancelled; },
      run: (action, payload) => api(action, Object.assign({ cancelId: id }, payload || {}), ctrl.signal),
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        ctrl.abort();
        api("cancelAi", { cancelId: id }).catch(() => { /* best effort */ });
      }
    };
  }

  function handleError(err) {
    // Sign-in lapsed while a form is open: keep the form and ask to sign in on top of it.
    if (err.code === "AUTH" && state.me && $(".sheet-backdrop")) {
      clearToken();
      showReauth(err.message);
      return;
    }
    if (err.code === "AUTH" || err.code === "SETUP") {
      clearToken();
      state.me = null;
      state.authMessage = err.message;
      render();
    } else if (err.code === "NOT_ALLOWED") {
      clearToken();
      state.me = null;
      state.notAllowedEmail = err.email || "";
      if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
      render();
    } else {
      toast(err.message, true);
    }
  }

  // For form submit handlers: an expired sign-in keeps the form open (with the sign-in pop-up
  // on top) instead of closing it; other sign-in problems close it as before.
  function authStop(err) {
    handleError(err);
    if (err.code === "AUTH" && state.me) throw new Error("Your sign-in expired. Sign in again (your entries are kept), then tap Save.");
    return true;
  }

  // Sign-in pop-up over an open form (nothing typed is lost).
  function showReauth(msg) {
    if ($(".reauth")) return;
    const el = document.createElement("div");
    el.className = "reauth";
    el.innerHTML = '<div class="reauth-box"><h3>Sign in to continue</h3><p>' + esc(msg || "Your sign-in expired.") + '</p>' +
      '<p class="hint">What you entered is kept. After signing in, tap Save again.</p><div class="reauth-btn"></div>' +
      '<button type="button" class="btn" data-reauth-close>Not now</button></div>';
    document.body.appendChild(el);
    el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
    modalOpen(el, $(".reauth-box", el));
    $("[data-reauth-close]", el).addEventListener("click", () => el.remove());
    if (window.google && google.accounts && state.gisReady) {
      google.accounts.id.renderButton($(".reauth-btn", el), { theme: "filled_blue", size: "large", text: "signin_with", shape: "pill" });
      google.accounts.id.prompt();
    } else {
      $(".reauth-btn", el).innerHTML = '<p class="form-error-inline">Google sign-in didn’t load. Check your connection.</p>';
    }
  }

  function applyBootstrap(r) {
    state.me = r.user;
    state.schema = r.schema;
    state.data = r.data;
    state.users = r.users || null;
    state.receipts = r.receipts || [];
    state.receiptLinks = r.receiptLinks || [];
    state.vendors = r.vendors || [];
    state.people = r.people || [];
    state.otherAssignments = r.otherAssignments || [];
    state.testTypes = r.testTypes || [];
    state.waterSessions = r.waterSessions || [];
    state.waterTests = r.waterTests || [];
    if (r.methods) state.methods = r.methods;
    state.waterChanges = r.waterChanges || [];
    state.wishes = r.wishes || [];
    state.compat = r.compat || [];
    state.photos = r.photos || [];
    state.priceItems = r.priceItems || [];
    state.lookups = r.lookups || [];
    state.receiptLines = r.receiptLines || [];
    state.treatments = r.treatments || [];
    state.treatmentDoses = r.treatmentDoses || [];
    state.doseUnits = r.doseUnits || [];
    state.stockOptions = r.stockOptions || [];
    // Treatments need the matching server update; until then their screens stay hidden.
    state.hasTreatments = Array.isArray(r.treatments);
    // Item lines need the matching server update; until then the section stays hidden.
    state.hasReceiptLines = Array.isArray(r.receiptLines);
    state.lookupTypes = r.lookupTypes || [];
    state.prices = r.prices || [];
    state.priceUnits = r.priceUnits || ["oz", "lb", "g", "kg", "mL", "L", "fl oz", "gal", "count", "each"];
    state.photosOn = Array.isArray(r.photos);   // false until the server has Photos.gs
    if (r.wishOptions) state.wishOptions = r.wishOptions;
  }

  async function refresh(silent) {
    try {
      if (!silent) busy(true);
      applyBootstrap(await api("bootstrap"));
      render();
      if (!silent) toast("Up to date");
    } catch (err) {
      handleError(err);
    } finally {
      busy(false);
    }
  }

  // Runs a write, then reloads data.
  // Saves, then reloads the data in the background: the form closes as soon as the save
  // succeeds, and the screen updates a few seconds later (thin bar at the top meanwhile).
  // successMsg may be a function of the server's reply (e.g. to add notes).
  async function write(action, payload, successMsg) {
    busy(true);
    let res;
    try {
      res = await api(action, payload);
    } catch (err) {
      if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) return authStop(err);
      throw err;
    } finally {
      busy(false);
    }
    toast((typeof successMsg === "function" ? successMsg(res) : successMsg) || "Saved");
    refreshInBackground();
    return true;
  }

  // Reloads all data without blocking the screen. If several saves happen quickly,
  // only the newest reload is applied.
  let syncSeq = 0;
  async function refreshInBackground() {
    const mine = ++syncSeq;
    document.body.classList.add("syncing");
    try {
      const data = await api("bootstrap");
      if (mine !== syncSeq) return;
      applyBootstrap(data);
      render();
    } catch (err) {
      if (mine !== syncSeq) return;
      if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) handleError(err);
      else toast("Saved, but the screen couldn’t refresh. Tap refresh to update.", true);
    } finally {
      if (mine === syncSeq) document.body.classList.remove("syncing");
    }
  }

  // ------------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------------
  function setToken(t) { state.token = t; try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* storage off */ } }
  // Signing out (or an expired sign-in) clears both the Google pass and the app session.
  function clearToken() {
    state.token = null; state.session = null; state.sessionExp = 0;
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }
  // The server's session lasts an hour from the last request; the app keeps a slightly shorter estimate.
  function setSession(token) {
    state.session = token; state.sessionExp = Date.now() + 59 * 60 * 1000;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ token: token, exp: state.sessionExp })); } catch (e) { /* storage off */ }
  }
  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (s && s.token && s.exp > Date.now()) { state.session = s.token; state.sessionExp = s.exp; }
    } catch (e) { /* ignore */ }
  }

  function gisLoaded() {
    if (!window.google || !google.accounts || !CFG.clientId || CFG.clientId.indexOf("PASTE_") === 0) return;
    google.accounts.id.initialize({
      client_id: CFG.clientId,
      callback: onCredential,
      auto_select: true,
      itp_support: true,
      use_fedcm_for_prompt: true,
      cancel_on_tap_outside: false
    });
    state.gisReady = true;
    if (!state.me && !state.booting) renderSignIn();
  }

  function onCredential(resp) {
    if (!resp || !resp.credential) return;
    setToken(resp.credential);
    state.authMessage = "";
    state.notAllowedEmail = "";
    // Signed in again from the pop-up over an open form: keep everything and carry on.
    const re = $(".reauth");
    if (re && state.me) {
      re.remove();
      toast("Signed in again. Tap Save to finish.");
      refreshInBackground();
      return;
    }
    boot();
  }

  async function boot() {
    state.booting = true;
    render();
    try {
      applyBootstrap(await api("bootstrap"));
    } catch (err) {
      state.booting = false;
      handleError(err);
      return;
    }
    state.booting = false;
    render();
  }

  function signOut() {
    clearToken();
    state.me = null;
    state.data = null;
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    location.hash = "";
    render();
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function render() {
    if (state.booting) {
      $("#app").innerHTML = '<div class="signin"><img src="icons/icon-192.png" alt=""><h1>Ayers Aquariums</h1><div class="spinner"></div></div>';
      return;
    }
    if (!state.me) { renderSignIn(); return; }
    renderShell();
  }

  function renderSignIn() {
    const notConfigured = !CFG.clientId || CFG.clientId.indexOf("PASTE_") === 0 || !CFG.apiUrl || CFG.apiUrl.indexOf("PASTE_") === 0;
    let notice = "";
    if (notConfigured) notice = '<div class="notice">The app isn\'t fully set up yet (sign-in client ID or server address missing).</div>';
    else if (state.notAllowedEmail) notice = '<div class="notice">' + esc(state.notAllowedEmail) + ' isn\'t on the Ayers Aquariums user list. Ask Chris to add you, or sign in with a different Google account.</div>';
    else if (state.authMessage) notice = '<div class="notice">' + esc(state.authMessage) + '</div>';

    $("#app").innerHTML =
      '<div class="signin">' +
        '<img src="icons/icon-192.png" alt="">' +
        '<h1>Ayers Aquariums</h1>' +
        '<p>Sign in with the Google account Chris added to the app.</p>' +
        notice +
        '<div id="gsi-button"></div>' +
      '</div>';

    if (state.gisReady && !notConfigured) {
      const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      google.accounts.id.renderButton($("#gsi-button"), {
        type: "standard", theme: dark ? "filled_black" : "outline", size: "large",
        shape: "pill", text: "signin_with", logo_alignment: "left", width: 280
      });
      if (!state.notAllowedEmail) google.accounts.id.prompt();
    }
  }

  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, "");
    const parts = h.split("/").filter(Boolean).map(decodeURIComponent);
    return { name: parts[0] || "home", args: parts.slice(1) };
  }

  function renderShell() {
    const route = parseRoute();
    let view;
    switch (route.name) {
      case "home": view = viewHome(); break;
      case "tanks": view = viewTanks(); break;
      case "tank": view = viewTank(route.args[0]); break;
      case "browse": view = viewBrowse(); break;
      case "item": view = viewItem(route.args[0], route.args[1]); break;
      case "users": view = isAdmin() ? viewUsers() : viewTanks(); break;
      case "lists": view = isAdmin() ? viewLists() : viewHome(); break;
      case "wish": view = route.args[0] ? viewWish(route.args[0]) : viewWishlist(); break;
      case "account": view = viewAccount(); break;
      case "receipts": view = canReceipts() ? viewReceipts() : viewTanks(); break;
      case "water": view = route.args[1] ? viewWaterType(route.args[0], route.args[1]) : viewWater(route.args[0]); break;
      case "testtypes": view = isAdmin() ? viewTestTypes() : viewWater(); break;
      case "maint": view = viewMaintenance(route.args[0]); break;
      case "receipt": view = canReceipts() ? viewReceipt(route.args[0]) : viewTanks(); break;
      case "prices": view = viewPrices(); break;
      case "treatments": view = viewTreatments(); break;
      case "treatment": view = viewTreatment(route.args[0]); break;
      case "price": view = viewPriceItem(route.args[0]); break;
      default: view = viewHome();
    }
    const nav = stepNav(route);
    const tab = route.name === "tank" ? "tanks" : route.name === "item" ? "browse" : route.name === "receipt" ? "receipts" :
                route.name === "testtypes" ? "water" : (route.name === "users" || route.name === "account" || route.name === "prices" || route.name === "price" || route.name === "lists" || route.name === "treatments" || route.name === "treatment") ? "home" : route.name;
    const tabs = [["home", "Home"], ["tanks", "Tanks"], ["water", "Test"], ["maint", "Maint."], ["browse", "Browse"], ["wish", "Wishlist"]]
      .concat(canReceipts() ? [["receipts", "Receipts"]] : []);

    $("#app").innerHTML =
      '<header class="topbar">' +
        (view.back ? '<button class="icon-btn" data-act="back" aria-label="Back">' + ICONS.back + '</button>' : '<span style="width:6px"></span>') +
        '<h1>' + esc(view.title) + '</h1>' +
        (nav ? '<div class="step-nav">' +
          '<button class="icon-btn" data-act="step" data-href="' + esc(nav.prev || "") + '" aria-label="Previous"' + (nav.prev ? "" : " disabled") + '>' + ICONS.back + '</button>' +
          '<span class="step-pos" aria-live="polite">' + nav.pos + ' of ' + nav.total + '</span>' +
          '<button class="icon-btn" data-act="step" data-href="' + esc(nav.next || "") + '" aria-label="Next"' + (nav.next ? "" : " disabled") + '>' + ICONS.next + '</button>' +
        '</div>' : "") +
        '<button class="icon-btn" data-act="refresh" aria-label="Refresh">' + ICONS.refresh + '</button>' +
      '</header>' +
      '<main class="view' + (view.wide ? " wide" : "") + '">' + view.html + '</main>' +
      '<nav class="tabbar">' +
        tabs.map(t => '<a href="#/' + t[0] + '" class="' + (tab === t[0] ? "active" : "") + '">' + ICONS[t[0]] + '<span>' + t[1] + '</span></a>').join("") +
      '</nav>';

    if (view.after) view.after();
    hydratePhotos($("#app"));
    window.scrollTo(0, view.keepScroll ? window.scrollY : 0);
  }

  // ---------- Previous / Next on detail pages ----------
  // Steps through the list as it was left (search, filters, Show retired). If the record isn't in
  // that list (opened from somewhere else), the whole list of that kind is used instead.
  function stepNav(route) {
    const id = route.args[route.name === "item" ? 1 : 0];
    if (!id) return null;
    let lists;   // [ids in order, ...fallbacks]
    if (route.name === "tank") {
      lists = [tankRows().map(t => t["Tank ID"])];
    } else if (route.name === "item") {
      const type = route.args[0], T = TYPES[type];
      if (!T || !state.data[type]) return null;
      const all = state.data[type].filter(r => !isWishItem(r))
        .sort((a, b) => String(T.title(a)).localeCompare(String(T.title(b)))).map(r => r[T.id]);
      lists = [browseRows(type, state.browseType === type).map(r => r[T.id]), all];
    } else if (route.name === "receipt") {
      if (!canReceipts()) return null;
      lists = [receiptRows().map(r => r["Receipt ID"]),
               state.receipts.slice().sort((x, y) => receiptSortKey(y).localeCompare(receiptSortKey(x))).map(r => r["Receipt ID"])];
    } else if (route.name === "treatment") {
      const act = (state.treatments || []).filter(trtActive).sort((a, b) => (daysUntil(nextDue(a)) || 0) - (daysUntil(nextDue(b)) || 0)).map(t => t["Treatment ID"]);
      lists = [act, (state.treatments || []).map(t => t["Treatment ID"])];
    } else if (route.name === "price") {
      lists = [priceRows().map(p => p["Price Item ID"]), state.priceItems.slice().sort(byPriceName).map(p => p["Price Item ID"])];
    } else if (route.name === "wish") {
      lists = [wishRows().map(w => w["Wish ID"]),
               state.wishes.slice().sort((a, b) => String(b["Added At"] || "").localeCompare(String(a["Added At"] || ""))).map(w => w["Wish ID"])];
    } else return null;
    const ids = lists.find(l => l.indexOf(id) !== -1);
    if (!ids) return null;
    const i = ids.indexOf(id);
    const href = x => route.name === "item" ? "#/item/" + route.args[0] + "/" + encodeURIComponent(x) : "#/" + route.name + "/" + encodeURIComponent(x);
    return { pos: i + 1, total: ids.length, prev: i > 0 ? href(ids[i - 1]) : "", next: i < ids.length - 1 ? href(ids[i + 1]) : "" };
  }

  // ---------- "Did you mean…?" for typed names ----------
  // A typed vendor or item name that nearly matches an existing one (ignoring capitals, spaces,
  // punctuation and a leading "The", or 1–2 letters off) gets a question before it's saved.
  const nameKey = s => String(s || "").toLowerCase().replace(/^\s*the\s+/, "").replace(/[^a-z0-9]/g, "");
  function editDistance(a, b) {
    const d = [];
    for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  // The existing name the typed one closely matches, or "" (an exact match needs no question).
  function closeName(value, existing) {
    const v = String(value || "").replace(/\s+/g, " ").trim();
    if (!v) return "";
    const list = existing.map(e => String(e || "").trim()).filter(Boolean);
    if (list.some(e => e.replace(/\s+/g, " ").toLowerCase() === v.toLowerCase())) return "";
    const k = nameKey(v);
    if (k.length < 3) return "";
    let best = "", bestD = 99;
    list.forEach(e => {
      const ek = nameKey(e);
      if (!ek) return;
      const short = Math.min(k.length, ek.length);
      const allow = short >= 8 ? 2 : short >= 4 ? 1 : 0;
      const dist = ek === k ? 0 : (Math.abs(ek.length - k.length) > allow ? 99 : editDistance(k, ek));
      if (dist <= allow && dist < bestD) { best = e; bestD = dist; }
    });
    return best;
  }
  // Resolves to the name to save: the existing one, the typed one, or null to go back to the form.
  function askDidYouMean(value, match, kind) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      openSheet({
        title: "Did you mean " + match + "?",
        submitLabel: "Use " + match,
        body: '<p>“' + esc(value) + '” looks like your existing ' + esc(kind) + ' <b>' + esc(match) + '</b>.</p>' +
          '<div class="actions"><button type="button" class="btn" data-keep>Keep “' + esc(value) + '” as a new ' + esc(kind) + '</button></div>',
        onReady: form => {
          const back = form.parentElement;
          $("[data-keep]", form).addEventListener("click", () => { finish(String(value).replace(/\s+/g, " ").trim()); back.remove(); document.body.style.overflow = $(".sheet-backdrop") ? "hidden" : ""; });
          $$("[data-close]", form).forEach(b => b.addEventListener("click", () => finish(null)));
          back.addEventListener("click", e => { if (e.target === back) finish(null); });
        },
        onSubmit: () => { finish(match); return true; }
      });
    });
  }
  // Checks a typed name; returns the name to use, or null when the person went back to fix it.
  async function confirmName(value, existing, kind) {
    const match = closeName(value, existing);
    return match ? askDidYouMean(String(value).trim(), match, kind) : value;
  }
  const knownVendors = () => storeChoices().map(x => x.value);
  // Admin forms: a typed list value close to an existing one ("Hang on Back") asks first. False = stay on the form.
  async function checkListFields(vals, form, fields) {
    for (const f of fields) {
      if (!adminListField(f, f.readOnly) || !vals[f.name]) continue;
      const opts = f.lookup === "Vendor" ? knownVendors() : (f.options || []);
      const v = await confirmName(vals[f.name], opts, f.lookup + " value");
      if (v === null) return false;
      vals[f.name] = v;
      setComboValue(form, f.name, v);
    }
    return true;
  }
  // Sets a free-text picker's value (hidden field and the text shown).
  function setComboValue(form, name, v) {
    const h = $("input[type=hidden][name='" + name + "']", form);
    if (!h) return;
    h.value = v;
    const box = h.closest(".combo");
    const inp = box && $(".combo-input", box);
    if (inp) inp.value = v;
  }
  // For vendor fields: asks when needed and updates vals and the form. Returns false to stay on the form.
  async function checkVendorField(vals, form, name) {
    if (!vals[name]) return true;
    const v = await confirmName(vals[name], knownVendors(), "vendor");
    if (v === null) return false;
    vals[name] = v;
    if (form) setComboValue(form, name, v);
    return true;
  }

  // ---------- Price tracker ----------
  // Price Items: one per item (linked to a record, or a typed name). Prices: every price gathered.
  // The list shows the latest price at each store; Best = lowest price per unit.
  const canPrices = () => state.me && (state.me.role === "Admin" || state.me.role === "Editor");
  const UNIT_INFO = { oz: ["weight", 28.3495], lb: ["weight", 453.592], g: ["weight", 1], kg: ["weight", 1000],
                      mL: ["volume", 1], L: ["volume", 1000], "fl oz": ["volume", 29.5735], gal: ["volume", 3785.41],
                      count: ["count", 1], each: ["count", 1] };
  const unitKind = u => (UNIT_INFO[u] || ["other", 1])[0];
  const unitShort = u => u === "count" ? "ct" : u;
  const findPriceItem = id => state.priceItems.find(p => p["Price Item ID"] === id);
  const pricesFor = id => state.prices.filter(p => p["Price Item ID"] === id);
  const ONE_LABEL = { species: "Species", equipment: "Equipment", plants: "Plant", medications: "Medication", tanks: "Tank" };
  // Categories a receipt line can create a record in. Tanks and equipment get one record per unit.
  const NEW_RECORD_TYPES = [["tanks", "Tank"], ["species", "Species"], ["equipment", "Equipment"], ["plants", "Plant"], ["medications", "Medication / Supplement"]];
  const UNIQUE_RECORD_TYPES = ["tanks", "equipment"];
  function priceItemInfo(pi) {
    const rid = pi["Record ID"];
    if (!rid) return { name: String(pi["Item Name"] || pi["Price Item ID"]), linked: false, pill: "Other item", img: String(pi["Picture URL"] || "") };
    const x = recordOf(rid);
    if (!x) return { name: rid + " (record deleted)", linked: true, pill: rid, rid: rid, img: "" };
    // Linked items show their record's list picture.
    return { name: String(TYPES[x.type].title(x.rec)), linked: true, pill: rid + " · " + (ONE_LABEL[x.type] || TYPES[x.type].label), rid: rid, type: x.type,
             img: x.type === "medications" ? "" : String(TYPES[x.type].img(x.rec) || "") };
  }
  const byPriceName = (a, b) => priceItemInfo(a).name.localeCompare(priceItemInfo(b).name);
  const gatheredKey = p => String(p["Date Gathered"] || "") + " " + String(p["Added At"] || "");
  function fmtPerUnit(v, unit) {
    if (v === null || v === undefined || !isFinite(v)) return "";
    const amt = "$" + v.toFixed(v < 0.1 ? 3 : 2);
    return unit === "each" ? amt + " each" : amt + "/" + unitShort(unit);
  }
  const fmtSize = (n, u) => (Number(n) || n) + " " + unitShort(u);
  // "250 mL · $0.052/mL"; a single item ("1 each") needs no per-unit price.
  const sizePer = (p, per, unit) => fmtSize(p["Size"], p["Unit"]) + (p["Unit"] === "each" && Number(p["Size"]) === 1 && unit === "each" ? "" :
    " · " + (per === null ? "different unit" : fmtPerUnit(per, unit)));

  // Latest price per store, price per unit, and the best store, for one price item.
  function priceSummary(id) {
    const groups = {};
    pricesFor(id).forEach(p => {
      const k = String(p["Location"]).trim().toLowerCase();
      (groups[k] = groups[k] || []).push(p);
    });
    const stores = Object.keys(groups).map(k => {
      const hist = groups[k].slice().sort((a, b) => gatheredKey(b).localeCompare(gatheredKey(a)));
      return { loc: String(hist[0]["Location"]).trim(), latest: hist[0], history: hist };
    });
    // Compare in the kind of unit most stores use (weight, volume or count), shown in its most used unit.
    const tally = (list, key) => { const t = {}; list.forEach(s => { const v = key(s); t[v] = (t[v] || 0) + 1; }); return t; };
    const newestFirst = stores.slice().sort((a, b) => gatheredKey(b.latest).localeCompare(gatheredKey(a.latest)));
    const pick = (t, key) => { const max = Math.max.apply(null, Object.values(t)); return newestFirst.map(key).find(v => t[v] === max); };
    let kind = "", unit = "";
    if (stores.length) {
      kind = pick(tally(stores, s => unitKind(s.latest["Unit"])), s => unitKind(s.latest["Unit"]));
      const same = stores.filter(s => unitKind(s.latest["Unit"]) === kind);
      unit = pick(tally(same, s => s.latest["Unit"]), s => s.latest["Unit"]);
    }
    const perUnit = p => {
      const u = p["Unit"], size = Number(p["Size"]), price = Number(p["Price"]);
      if (unitKind(u) !== kind || !size || isNaN(price) || !UNIT_INFO[u] || !UNIT_INFO[unit]) return null;
      return price / (size * UNIT_INFO[u][1] / UNIT_INFO[unit][1]);
    };
    stores.forEach(s => { s.perUnit = perUnit(s.latest); s.history.forEach(h => { h._perUnit = perUnit(h); }); });
    stores.sort((a, b) => (a.perUnit === null) - (b.perUnit === null) || (a.perUnit || 0) - (b.perUnit || 0) || a.loc.localeCompare(b.loc));
    const best = stores.length && stores[0].perUnit !== null ? stores[0].loc : "";
    return { stores: stores, unit: unit, kind: kind, best: best, perUnit: perUnit };
  }

  // The Prices list as shown (search and filter), also used by Previous / Next.
  function priceRows() {
    const q = state.priceQuery.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    return state.priceItems
      .filter(pi => state.priceFilter === "all" || (state.priceFilter === "linked") === !!pi["Record ID"])
      .filter(pi => {
        if (!words.length) return true;
        const info = priceItemInfo(pi);
        const hay = [info.name, pi["Record ID"], pi["Price Item ID"]].concat(pricesFor(pi["Price Item ID"]).map(p => p["Location"])).join(" ").toLowerCase();
        return words.every(w => hay.indexOf(w) !== -1);
      })
      .sort(byPriceName);
  }

  function priceLabelHtml(pi, sum) {
    const info = priceItemInfo(pi);
    return '<div class="price-item-row">' + (info.img ? photoHtml(info.img, "thumb price-thumb", 160, "") : '<span class="thumb price-thumb">' + ICONS.tag + '</span>') +
      '<div class="price-item"><a href="#/price/' + encodeURIComponent(pi["Price Item ID"]) + '" class="price-name">' + esc(info.name) + '</a>' +
      '<div class="price-tags"><span class="pill' + (info.linked ? " edit" : "") + '">' + esc(info.pill) + '</span>' +
      (sum.unit ? '<span class="price-per">per ' + esc(unitShort(sum.unit)) + '</span>' : "") + '</div></div></div>';
  }
  function priceCellHtml(s, best, unit) {
    const p = s.latest;
    return '<div class="price-cell' + (best ? " best" : "") + '">' +
      '<div class="price-top"><span class="price-amt">' + esc(money(p["Price"])) + '</span>' + (best ? '<span class="pill best-pill">Best</span>' : "") + '</div>' +
      '<span class="price-size">' + esc(sizePer(p, s.perUnit, unit)) + '</span>' +
      '<span class="price-date">' + esc(fmtDate(p["Date Gathered"])) + '</span></div>';
  }

  function viewPrices() {
    const rows = priceRows();
    const sums = {};
    rows.forEach(pi => { sums[pi["Price Item ID"]] = priceSummary(pi["Price Item ID"]); });
    // One column per store that has a price in the rows shown.
    const storeSet = {};
    rows.forEach(pi => sums[pi["Price Item ID"]].stores.forEach(s => { const k = s.loc.toLowerCase(); if (!storeSet[k]) storeSet[k] = s.loc; }));
    const stores = Object.keys(storeSet).map(k => storeSet[k]).sort((a, b) => a.localeCompare(b));
    const count = f => state.priceItems.filter(pi => f === "all" || (f === "linked") === !!pi["Record ID"]).length;
    const addCell = (pi, loc) => canPrices()
      ? '<button type="button" class="price-add" data-act="add-price" data-item="' + esc(pi["Price Item ID"]) + '" data-loc="' + esc(loc) + '" aria-label="Add ' + esc(loc) + ' price for ' + esc(priceItemInfo(pi).name) + '">' + ICONS.plus + '<span>Add</span></button>'
      : '<span class="price-none">—</span>';
    const table = '<div class="price-table-wrap card"><table class="price-table"><thead><tr><th scope="col">Item</th>' +
      stores.map(st => '<th scope="col">' + esc(st) + '</th>').join("") + '</tr></thead><tbody>' +
      rows.map(pi => {
        const sum = sums[pi["Price Item ID"]];
        return '<tr><th scope="row">' + priceLabelHtml(pi, sum) + '</th>' + stores.map(st => {
          const s = sum.stores.find(x => x.loc.toLowerCase() === st.toLowerCase());
          return '<td>' + (s ? priceCellHtml(s, s.loc === sum.best, sum.unit) : addCell(pi, st)) + '</td>';
        }).join("") + '</tr>';
      }).join("") + '</tbody></table></div>';
    const cards = '<div class="price-cards">' + rows.map(pi => {
      const sum = sums[pi["Price Item ID"]];
      return '<div class="card price-card">' + priceLabelHtml(pi, sum) +
        sum.stores.map(s => '<div class="price-row' + (s.loc === sum.best ? " best" : "") + '"><div class="price-row-l"><span class="price-store">' + esc(s.loc) +
          (s.loc === sum.best ? ' <span class="pill best-pill">Best</span>' : "") + '</span><span class="price-date">' + esc(fmtDate(s.latest["Date Gathered"])) + '</span></div>' +
          '<div class="price-row-r"><span class="price-amt">' + esc(money(s.latest["Price"])) + '</span><span class="price-size">' + esc(sizePer(s.latest, s.perUnit, sum.unit)) + '</span></div></div>').join("") +
        (sum.stores.length ? "" : '<div class="hint">No prices yet.</div>') + '</div>';
    }).join("") + '</div>';
    const empty = '<div class="empty">' + (state.priceItems.length ? "Nothing matches." : (canPrices() ? "No prices yet. Tap Add price to start." : "No prices yet.")) + '</div>';
    return {
      title: "Prices", back: true, keepScroll: true, wide: true,
      html:
        '<div class="price-tools">' +
          '<input class="search" type="search" placeholder="Search items or stores…" aria-label="Search prices" value="' + esc(state.priceQuery) + '" data-act="price-search">' +
          '<div class="segmented">' + [["all", "All"], ["linked", "Linked records"], ["other", "Other items"]].map(x =>
            '<button class="' + (state.priceFilter === x[0] ? "on" : "") + '" data-act="price-filter" data-f="' + x[0] + '">' + x[1] + ' (' + count(x[0]) + ')</button>').join("") + '</div>' +
          (canPrices() ? '<button class="btn primary" data-act="add-price">' + ICONS.plus + 'Add price</button>' : "") +
        '</div>' +
        '<p class="hint">Each row is one item; each column is a store. <b class="best-word">Best</b> = lowest price per unit, so different sizes compare fairly. Tap an item for its price history.</p>' +
        (rows.length ? table + cards : empty)
    };
  }

  function viewPriceItem(id) {
    const pi = findPriceItem(id);
    if (!pi) return { title: "Prices", back: true, html: '<div class="empty">That item isn’t in the price tracker any more.</div>' };
    const info = priceItemInfo(pi);
    const sum = priceSummary(id);
    const bestStore = sum.stores.find(s => s.loc === sum.best);
    const summary = [sum.stores.length + (sum.stores.length === 1 ? " store" : " stores"), sum.unit ? "compared per " + unitShort(sum.unit) : "",
                     bestStore ? "best now " + bestStore.loc + " at " + fmtPerUnit(bestStore.perUnit, sum.unit) : ""].filter(Boolean).join(" · ");
    const cards = sum.stores.map(s => {
      const best = s.loc === sum.best;
      const key = id + "|" + s.loc;
      const open = !!state.priceOpen[key];
      const p = s.latest;
      return '<div class="card price-store-card' + (best ? " best" : "") + '">' +
        '<div class="price-store-head"><div class="price-store-l"><div class="price-store-name">' + esc(s.loc) + (best ? ' <span class="pill best-pill">Best</span>' : "") + '</div>' +
          '<div class="meta">Gathered ' + esc(fmtDate(p["Date Gathered"])) + ' · ' + esc(daysAgo(p["Date Gathered"])) + (p["Added By"] ? ' · by ' + esc(personName(p["Added By"])) : "") + '</div></div>' +
          '<div class="price-store-r"><span class="price-big">' + esc(money(p["Price"])) + '</span><span class="price-size">' + esc(sizePer(p, s.perUnit, sum.unit)) + '</span></div></div>' +
        '<div class="actions"><button class="btn small" data-act="price-history" data-item="' + esc(id) + '" data-loc="' + esc(s.loc) + '" aria-expanded="' + open + '">History (' + s.history.length + ')</button>' +
          (canPrices() ? '<button class="btn small" data-act="add-price" data-item="' + esc(id) + '" data-loc="' + esc(s.loc) + '">' + ICONS.plus + 'New price</button>' : "") + '</div>' +
        (open ? '<div class="price-hist"><table><thead><tr><th scope="col">Date gathered</th><th scope="col">Price</th><th scope="col">Size</th><th scope="col">Per unit</th>' +
          (canPrices() ? '<th scope="col"><span class="sr-only">Actions</span></th>' : "") + '</tr></thead><tbody>' +
          s.history.map(h => '<tr><td>' + esc(fmtDate(h["Date Gathered"])) + '</td><td><b>' + esc(money(h["Price"])) + '</b></td><td>' + esc(fmtSize(h["Size"], h["Unit"])) + '</td><td>' +
            esc(h._perUnit === null ? "—" : fmtPerUnit(h._perUnit, sum.unit)) + '</td>' +
            (canPrices() ? '<td class="r"><button class="btn small" data-act="edit-price" data-id="' + esc(h["Price ID"]) + '">Edit</button></td>' : "") + '</tr>').join("") +
          '</tbody></table></div>' : "") +
        '</div>';
    }).join("");
    // Typed items: a small picture slot to add, replace or remove the picture shown in the Prices list.
    const picSlot = !info.linked && (info.img || canPrices())
      ? '<div class="price-pic">' + (info.img ? photoHtml(info.img, "thumb price-pic-img", 300, "") : '<span class="thumb price-pic-img">' + ICONS.tag + '</span>') +
        (canPrices() ? '<div class="price-pic-btns"><button class="btn small" data-act="price-picture" data-id="' + esc(id) + '">' + (info.img ? "Replace picture" : ICONS.plus + "Add picture") + '</button>' +
          (info.img ? '<button class="btn small danger" data-act="price-picture-remove" data-id="' + esc(id) + '">Remove picture</button>' : "") + '</div>' : "") +
        '</div>'
      : "";
    const head = '<div class="card price-head">' + picSlot + '<h2>' + esc(info.name) + '</h2>' +
      '<div class="price-tags"><span class="pill' + (info.linked ? " edit" : "") + '">' + esc(info.pill) + '</span><span class="meta">' + esc(summary) + '</span></div>' +
      '<div class="actions">' +
        (canPrices() ? '<button class="btn primary" data-act="add-price" data-item="' + esc(id) + '">' + ICONS.plus + 'Add price</button>' : "") +
        (info.linked && info.type ? '<a class="btn" href="#/item/' + info.type + '/' + encodeURIComponent(info.rid) + '">Open ' + esc(info.rid) + '</a>' : "") +
        (canPrices() && !info.linked ? '<button class="btn" data-act="edit-price-item" data-id="' + esc(id) + '">Edit item</button>' : "") +
        (canPrices() && !info.linked && state.hasTreatments ? '<button class="btn" data-act="set-stock" data-price-item="' + esc(id) + '">Stock' + (pi["Stock"] ? ": " + esc(pi["Stock"]) : "") + '</button>' : "") +
        (canPrices() ? '<button class="btn danger" data-act="delete-price-item" data-id="' + esc(id) + '">Delete</button>' : "") +
      '</div></div>';
    return {
      title: info.name, back: true, keepScroll: true,
      html: head + '<div class="section"><div class="section-head"><h3>Latest price at each store (' + sum.stores.length + ')</h3><span class="meta">Cheapest per unit first</span></div>' +
        (cards || '<div class="card"><div class="empty">No prices yet.</div></div>') + '</div>'
    };
  }

  // Choices for the Item picker: items already priced, then records not priced yet.
  // Labels are unique; records carry their ID ("EQ-5 Fluval AC30").
  function priceItemChoices() {
    const items = [], map = {};
    const add = (label, sub, group, ref) => { if (map[label.toLowerCase()]) return; map[label.toLowerCase()] = ref; items.push({ value: label, label: label, sub: sub, group: group }); };
    state.priceItems.slice().sort(byPriceName).forEach(pi => {
      const info = priceItemInfo(pi);
      add(info.linked ? info.rid + " " + info.name : info.name, info.linked ? info.pill : "Other item", "Already priced", { priceItemId: pi["Price Item ID"] });
    });
    const priced = {};
    state.priceItems.forEach(pi => { if (pi["Record ID"]) priced[pi["Record ID"]] = true; });
    ["species", "equipment", "plants", "medications", "tanks"].forEach(ty => {
      const T = TYPES[ty];
      (state.data[ty] || []).filter(r => !isWishItem(r) && !isRetired(r) && !priced[r[T.id]])
        .sort((a, b) => String(T.title(a)).localeCompare(String(T.title(b))))
        .forEach(r => add(r[T.id] + " " + T.title(r), T.sub(r), T.label, { recordId: r[T.id] }));
    });
    return { items: items, map: map };
  }
  function storeChoices() {
    const seen = {}, out = [];
    (state.vendors || []).concat(state.prices.map(p => String(p["Location"]).trim())).forEach(v => {
      if (v && !seen[v.toLowerCase()]) { seen[v.toLowerCase()] = true; out.push(v); }
    });
    return out.sort((a, b) => a.localeCompare(b)).map(v => ({ value: v, label: v }));
  }
  const unitSelectHtml = (name, v) => '<select id="f_' + name + '" name="' + name + '" required data-label="Unit"><option value="">Unit</option>' +
    state.priceUnits.map(u => '<option value="' + esc(u) + '"' + (u === v ? " selected" : "") + '>' + esc(unitShort(u)) + '</option>').join("") + '</select>';
  function priceFieldsHtml(vals) {
    return comboHtml({ name: "Location", label: "Location", mode: "free", required: true, noThumbs: true, value: vals.loc || "",
                       placeholder: "Choose or type a store", newLabel: "will be added to your Vendor list" }, storeChoices()) +
      '<div class="price-grid">' +
        fieldHtml({ name: "Price", label: "Price ($)", type: "number", required: true }, vals.price) +
        '<div class="field"><label for="f_Size">Size <span class="req">*</span></label><div class="size-row">' +
          '<input type="number" step="any" inputmode="decimal" id="f_Size" name="Size" required data-label="Size" value="' + esc(vals.size === undefined ? "" : vals.size) + '">' +
          unitSelectHtml("Unit", vals.unit || "") + '</div></div>' +
      '</div>' +
      '<div class="price-live" hidden></div>' +
      fieldHtml({ name: "Date Gathered", label: "Date price gathered", type: "date", required: true }, vals.date || today());
  }
  // Shows the price per unit as it's typed, and how it compares with the other stores' latest prices.
  function wirePriceLive(form, itemIdFor, editingId) {
    const live = $(".price-live", form);
    const update = () => {
      const priceRaw = $("[name=Price]", form).value, price = Number(priceRaw), size = Number($("[name=Size]", form).value), unit = $("[name=Unit]", form).value;
      const loc = String($("input[name=Location]", form).value || "").trim().toLowerCase();
      if (priceRaw === "" || isNaN(price) || !size || !unit || !UNIT_INFO[unit]) { live.hidden = true; return; }
      const pid = itemIdFor();
      const sum = pid ? priceSummary(pid) : null;
      const showUnit = sum && sum.unit && unitKind(sum.unit) === unitKind(unit) ? sum.unit : unit;
      const per = price / (size * UNIT_INFO[unit][1] / UNIT_INFO[showUnit][1]);
      let note = "";
      if (sum) {
        const others = sum.stores.filter(s => s.loc.toLowerCase() !== loc && s.perUnit !== null && unitKind(sum.unit) === unitKind(unit) &&
                                         !(editingId && s.latest["Price ID"] === editingId));
        const cheaper = others.filter(s => s.perUnit < per).sort((a, b) => a.perUnit - b.perUnit)[0];
        if (others.length) note = cheaper ? " · " + cheaper.loc + " is cheaper at " + fmtPerUnit(cheaper.perUnit, showUnit) : " · cheapest of " + (others.length + 1) + " stores";
        if (sum.unit && unitKind(sum.unit) !== unitKind(unit)) note = " · other stores use " + unitKind(sum.unit) + ", so this can't be compared";
      }
      live.hidden = false;
      live.className = "price-live" + (note.indexOf("cheapest") !== -1 ? " good" : "");
      live.innerHTML = ICONS.tag + '<span>' + esc(fmtPerUnit(per, showUnit).replace("/", " per ") + note) + '</span>';
    };
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    update();
    return update;
  }

  // presetItem: a Price Item ID; presetLoc: a store name.
  function addPriceForm(presetItem, presetLoc) {
    if (!canPrices()) return;
    const ch = priceItemChoices();
    const pre = presetItem ? findPriceItem(presetItem) : null;
    const preLabel = pre ? (priceItemInfo(pre).linked ? priceItemInfo(pre).rid + " " + priceItemInfo(pre).name : priceItemInfo(pre).name) : "";
    const preUnit = pre ? priceSummary(presetItem).unit : "";
    // Matches the picker's labels, then a record ID typed on its own ("EQ-7"), then an exact name.
    const refFor = label => {
      const t = String(label || "").trim().toLowerCase();
      if (!t) return null;
      if (ch.map[t]) return ch.map[t];
      const byId = state.priceItems.find(pi => String(pi["Record ID"]).toLowerCase() === t);
      if (byId) return { priceItemId: byId["Price Item ID"] };
      const rec = recordOf(t.toUpperCase());
      if (rec && rec.type !== "tanks") return { recordId: t.toUpperCase() };
      const named = Object.keys(ch.map).filter(k => k === t || k.replace(/^[a-z]+-\d+ /, "") === t);
      return named.length === 1 ? ch.map[named[0]] : null;
    };
    openSheet({
      title: "Add price",
      submitLabel: "Save price",
      body:
        comboHtml({ name: "Item", label: "Item", mode: "free", required: true, noThumbs: true, value: preLabel,
                    placeholder: "Choose or type an item", newLabel: "will be added as a new item" }, ch.items) +
        '<p class="hint" style="margin-top:-6px">Pick a species, equipment, plant or medication, an item already priced, or type a new one.</p>' +
        priceFieldsHtml({ loc: presetLoc, unit: preUnit }),
      onReady: form => {
        $$("[data-combo]", form).forEach(wireCombo);
        const itemIdFor = () => { const r = refFor($("input[name=Item]", form).value); return r && r.priceItemId ? r.priceItemId : ""; };
        wirePriceLive(form, itemIdFor);
        // Choosing an item that's already priced fills in the unit it's compared in.
        $("input[name=Item]", form).addEventListener("change", () => {
          const pid = itemIdFor(), unitSel = $("[name=Unit]", form);
          if (pid && !unitSel.value) { unitSel.value = priceSummary(pid).unit || ""; unitSel.dispatchEvent(new Event("change", { bubbles: true })); }
        });
        if (!presetItem) setTimeout(() => { const i = $(".combo-input", form); if (i) i.focus(); }, 50);
      },
      onSubmit: async (vals, form) => {
        let label = String(vals.Item || "").trim();
        if (!label) throw new Error("Choose or type an item.");
        let ref = refFor(label);
        if (!ref) {
          // A new item name close to an existing one ("Seachem Primes") gets a question first.
          const names = {};
          ch.items.forEach(it => { names[it.label.replace(/^[A-Za-z]+-\d+ /, "")] = it.label; });
          const v = await confirmName(label, Object.keys(names), "item");
          if (v === null) return false;
          if (names[v]) { label = names[v]; ref = refFor(label); setComboValue(form, "Item", label); }
        }
        if (!(await checkVendorField(vals, form, "Location"))) return false;
        const item = ref ? ref : { name: label };
        return write("addPrice", { item: item, location: vals.Location, price: vals.Price, size: vals.Size, unit: vals.Unit, date: vals["Date Gathered"] }, "Price saved");
      }
    });
  }

  function editPriceForm(priceId) {
    const p = state.prices.find(x => x["Price ID"] === priceId);
    if (!p || !canPrices()) return;
    const pi = findPriceItem(p["Price Item ID"]);
    openSheet({
      title: "Edit price",
      submitLabel: "Save",
      body: '<p class="meta">' + esc(priceId + " · " + (pi ? priceItemInfo(pi).name : p["Price Item ID"])) + '</p>' +
        priceFieldsHtml({ loc: p["Location"], price: p["Price"], size: p["Size"], unit: p["Unit"], date: p["Date Gathered"] }) +
        '<div class="actions" style="margin-top:8px"><button type="button" class="btn danger" data-del-price>Delete this price</button></div>',
      onReady: form => {
        $$("[data-combo]", form).forEach(wireCombo);
        wirePriceLive(form, () => p["Price Item ID"], priceId);
        $("[data-del-price]", form).addEventListener("click", () => {
          openSheet({
            title: "Delete price?", submitLabel: "Delete", danger: true,
            body: '<p>Permanently delete the <b>' + esc(p["Location"]) + '</b> price of <b>' + esc(money(p["Price"])) + '</b> (' + esc(fmtSize(p["Size"], p["Unit"])) +
              ', gathered ' + esc(fmtDate(p["Date Gathered"])) + ')? This can’t be undone.</p>',
            onSubmit: async () => {
              const ok = await write("deletePrice", { priceId: priceId }, "Price deleted");
              $$(".sheet-backdrop").forEach(b => b.remove()); document.body.style.overflow = "";
              return ok;
            }
          });
        });
      },
      onSubmit: async (vals, form) => {
        if (vals.Location !== p["Location"] && !(await checkVendorField(vals, form, "Location"))) return false;
        return write("updatePrice", { priceId: priceId, location: vals.Location, price: vals.Price, size: vals.Size, unit: vals.Unit, date: vals["Date Gathered"] }, "Price updated");
      }
    });
  }

  function editPriceItemForm(id) {
    const pi = findPriceItem(id);
    if (!pi || pi["Record ID"] || !canPrices()) return;
    openSheet({
      title: "Edit item",
      submitLabel: "Save",
      body: '<p class="meta">' + esc(id) + '</p>' + fieldHtml({ name: "Item Name", label: "Name", required: true }, pi["Item Name"]),
      onSubmit: vals => write("updatePriceItem", { priceItemId: id, name: vals["Item Name"] }, "Item renamed")
    });
  }

  function pricePictureForm(id) {
    const pi = findPriceItem(id);
    if (!pi || pi["Record ID"] || !canPrices()) return;
    let image = null;
    const had = !!pi["Picture URL"];
    openSheet({
      title: had ? "Replace picture" : "Add picture",
      submitLabel: had ? "Replace" : "Add picture",
      body: '<p class="meta">' + esc(id + " " + priceItemInfo(pi).name) + '</p>' +
        '<div class="field"><label>Picture <span class="req">*</span></label>' + photoPickerHtml("f_ppic") + '</div>' +
        (had ? '<p class="hint">The current picture’s file moves to the Drive trash.</p>' : ""),
      onReady: form => {
        const pick = wirePhotoPicker(form, "f_ppic", async f => {
          pick.status("Preparing picture…");
          try { image = await prepareImage(f, 1200, 0.85); pick.preview(image.preview); pick.status(""); }
          catch (err) { image = null; pick.preview(""); pick.status(""); toast(err.message, true); }
        });
      },
      onSubmit: async () => {
        if (!image) throw new Error("Take or choose a picture first.");
        return write("setPriceItemPicture", { priceItemId: id, photo: { data: image.data, mimeType: image.mimeType } }, had ? "Picture replaced" : "Picture added");
      }
    });
  }

  function pricePictureRemoveForm(id) {
    const pi = findPriceItem(id);
    if (!pi || !pi["Picture URL"] || !canPrices()) return;
    openSheet({
      title: "Remove picture?", submitLabel: "Remove", danger: true,
      body: '<p>Remove the picture from <b>' + esc(priceItemInfo(pi).name) + '</b>? Its file moves to the Drive trash (Google keeps it 30 days).</p>',
      onSubmit: () => write("setPriceItemPicture", { priceItemId: id, remove: true }, "Picture removed")
    });
  }

  function deletePriceItemForm(id) {
    const pi = findPriceItem(id);
    if (!pi || !canPrices()) return;
    const n = pricesFor(id).length;
    const info = priceItemInfo(pi);
    openSheet({
      title: "Delete from price tracker?", submitLabel: "Delete", danger: true,
      body: '<p>Permanently delete <b>' + esc(info.name) + '</b> from the price tracker, with its <b>' + n + ' price' + (n === 1 ? "" : "s") + '</b>? This can’t be undone.</p>' +
        (info.linked ? '<p class="hint">' + esc(info.rid) + ' itself is not deleted; only its prices.</p>' : ""),
      onSubmit: async () => {
        const ok = await write("deletePriceItem", { priceItemId: id }, "Deleted from price tracker");
        if (ok) location.hash = "#/prices";
        return ok;
      }
    });
  }

  // ---------- Treatments (medication courses) ----------
  // A course: tank + medication + dose + every N days + how many doses (blank = ongoing).
  // Each dose given is logged; the next dose is worked out from the last one.
  const canTreat = tankId => canEditTank(tankId);
  const treatmentsFor = tankId => (state.treatments || []).filter(t => t["Tank ID"] === tankId);
  const dosesFor = id => (state.treatmentDoses || []).filter(d => d["Treatment ID"] === id)
    .sort((a, b) => Number(a["Dose No"]) - Number(b["Dose No"]));
  const findTreatment = id => (state.treatments || []).find(t => t["Treatment ID"] === id);
  const trtActive = t => String(t["Status"] || "Active") === "Active";
  const trtMed = t => findRec("medications", t["Product ID"]);
  const trtName = t => { const m = trtMed(t); return m ? TYPES.medications.title(m) : String(t["Product ID"] || "Treatment"); };
  const midnight = d => d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null;
  // "1 packet", "2 packets", "5 mL" — a unit written in plural loses its s for a single dose.
  const doseText = (amount, unit) => {
    const n = Number(amount);
    const u = String(unit || "");
    return (isNaN(n) ? amount : n) + " " + (n === 1 && /[a-z]s$/.test(u) ? u.slice(0, -1) : u);
  };
  const trtDoseText = t => doseText(t["Dose Amount"], t["Dose Unit"]);
  function trtEveryText(t) {
    const n = Number(t["Every Days"]) || 1;
    return n === 1 ? "daily" : n === 7 ? "weekly" : "every " + n + " days";
  }
  // The date the next dose is due, or null when the course isn't running.
  function nextDue(t) {
    if (!trtActive(t)) return null;
    const doses = dosesFor(t["Treatment ID"]);
    if (!doses.length) return midnight(parseDT(t["Start Date"]));
    const last = doses.map(d => parseDT(d["Given At"])).filter(Boolean).sort((a, b) => b - a)[0];
    if (!last) return midnight(parseDT(t["Start Date"]));
    const d = midnight(last);
    d.setDate(d.getDate() + (Number(t["Every Days"]) || 1));
    return d;
  }
  const daysUntil = d => d ? Math.round((d - midnight(new Date())) / 864e5) : null;
  const isDue = t => { const n = daysUntil(nextDue(t)); return n !== null && n <= 0; };
  const dueCount = () => (state.treatments || []).filter(t => trtActive(t) && isDue(t)).length;
  function dueText(t) {
    const n = daysUntil(nextDue(t));
    if (n === null) return "";
    if (n < 0) return n === -1 ? "Due since yesterday" : "Due " + (-n) + " days ago";
    return n === 0 ? "Due today" : n === 1 ? "Due tomorrow" : "Due in " + n + " days";
  }
  function trtProgress(t) {
    const given = dosesFor(t["Treatment ID"]).length;
    const total = t["Total Doses"] === "" || t["Total Doses"] === undefined ? "" : Number(t["Total Doses"]);
    return total === "" ? given + (given === 1 ? " dose given · ongoing" : " doses given · ongoing") : "Dose " + Math.min(given + 1, total) + " of " + total;
  }

  // One course as a card. showTank adds the tank's name (for the all-tanks screen).
  function treatmentCard(t, opts) {
    opts = opts || {};
    const id = t["Treatment ID"];
    const due = trtActive(t) ? dueText(t) : String(t["Status"]);
    const cls = !trtActive(t) ? "" : (isDue(t) ? " due" : "");
    const bits = [trtDoseText(t) + " " + trtEveryText(t), trtProgress(t), opts.showTank ? tankName(t["Tank ID"]) : "", t["Reason"]].filter(Boolean);
    return '<div class="card trt-card' + cls + '">' +
      '<div class="trt-top"><div class="trt-l"><a class="trt-name" href="#/treatment/' + encodeURIComponent(id) + '">' + esc(trtName(t)) + '</a>' +
        '<div class="sub">' + esc(bits.join(" · ")) + '</div></div>' +
        (due ? '<span class="pill ' + (trtActive(t) ? (isDue(t) ? "warn" : "edit") : "retired") + '">' + esc(due) + '</span>' : "") + '</div>' +
      (t["Water Change"] || t["Remove Carbon"] === true
        ? '<div class="trt-note">' + [t["Water Change"] ? "Water change: " + t["Water Change"] : "", t["Remove Carbon"] === true ? "Remove carbon / chemical media" : ""].filter(Boolean).map(esc).join(" · ") + '</div>' : "") +
      (canTreat(t["Tank ID"]) && trtActive(t)
        ? '<div class="actions"><button class="btn small primary" data-act="log-dose" data-id="' + esc(id) + '">' + ICONS.plus + 'Log dose</button>' +
          '<a class="btn small" href="#/treatment/' + encodeURIComponent(id) + '">Details</a></div>'
        : '<div class="actions"><a class="btn small" href="#/treatment/' + encodeURIComponent(id) + '">Details</a></div>') +
      '</div>';
  }

  // The Treatments section on a tank's page and on the Maint. screen.
  function treatmentSection(tankId, opts) {
    opts = opts || {};
    const all = treatmentsFor(tankId);
    const active = all.filter(trtActive).sort((a, b) => (daysUntil(nextDue(a)) || 0) - (daysUntil(nextDue(b)) || 0));
    const past = all.filter(t => !trtActive(t));
    return '<div class="section"><div class="section-head"><h3>Treatments (' + active.length + ')</h3>' +
      (canTreat(tankId) ? '<button class="btn small primary" data-act="add-treatment" data-tank="' + esc(tankId) + '">' + ICONS.plus + 'Start treatment</button>' : "") + '</div>' +
      (active.length ? active.map(t => treatmentCard(t)).join("")
                     : '<div class="card"><div class="empty">No treatments running.</div></div>') +
      (past.length && opts.showPast
        ? '<label class="check" style="margin-top:8px"><input type="checkbox" data-act="toggle-past-trt"' + (state.showPastTrt ? " checked" : "") + '> Show finished and stopped (' + past.length + ')</label>' +
          (state.showPastTrt ? past.map(t => treatmentCard(t)).join("") : "")
        : "") + '</div>';
  }

  // Every course across the tanks this person can see.
  function viewTreatments() {
    const all = (state.treatments || []).slice();
    const active = all.filter(trtActive).sort((a, b) => (daysUntil(nextDue(a)) || 0) - (daysUntil(nextDue(b)) || 0) ||
                                                        String(tankName(a["Tank ID"])).localeCompare(String(tankName(b["Tank ID"]))));
    const past = all.filter(t => !trtActive(t)).sort((a, b) => String(b["Ended At"] || "").localeCompare(String(a["Ended At"] || "")));
    const due = active.filter(isDue), later = active.filter(t => !isDue(t));
    const group = (title, list) => list.length
      ? '<div class="section"><div class="section-head"><h3>' + esc(title) + ' (' + list.length + ')</h3></div>' + list.map(t => treatmentCard(t, { showTank: true })).join("") + '</div>' : "";
    const tanks = state.data.tanks.filter(t => canEditTank(t["Tank ID"]) && !isRetired(t));
    return {
      title: "Treatments", back: true, keepScroll: true,
      html: (tanks.length ? '<div class="actions" style="margin:0 0 12px"><button class="btn primary" data-act="add-treatment">' + ICONS.plus + 'Start treatment</button></div>' : "") +
        (all.length ? "" : '<div class="empty">No treatments yet.' + (tanks.length ? " Tap Start treatment to begin one." : "") + '</div>') +
        group("Due now", due) + group("Coming up", later) +
        (past.length ? '<div class="section"><div class="section-head"><h3>Finished and stopped (' + past.length + ')</h3></div>' +
          '<label class="check"><input type="checkbox" data-act="toggle-past-trt"' + (state.showPastTrt ? " checked" : "") + '> Show them</label>' +
          (state.showPastTrt ? past.map(t => treatmentCard(t, { showTank: true })).join("") : "") + '</div>' : "")
    };
  }

  function viewTreatment(id) {
    const t = findTreatment(id);
    if (!t) return { title: "Treatment", back: true, html: '<div class="empty">That treatment wasn’t found.</div>' };
    const med = trtMed(t);
    const doses = dosesFor(id).slice().reverse();
    const may = canTreat(t["Tank ID"]);
    const total = t["Total Doses"] === "" ? "" : Number(t["Total Doses"]);
    const kv = [["Tank", tankName(t["Tank ID"])], ["Medication", trtName(t)], ["Reason", t["Reason"]],
                ["Dose", trtDoseText(t)], ["How often", trtEveryText(t).replace(/^./, c => c.toUpperCase())],
                ["Doses", total === "" ? "Ongoing (no end date)" : total + " in total"],
                ["Started", fmtDate(t["Start Date"])],
                ["Water change", t["Water Change"]], ["Remove carbon", t["Remove Carbon"] === true ? "Yes" : ""],
                ["Status", t["Status"] + (t["Ended At"] ? " · " + fmtDate(String(t["Ended At"]).slice(0, 10)) : "")],
                ["Notes", t["Notes"]]].filter(x => x[1]);
    const hero = '<div class="card hero"><h2>' + esc(trtName(t)) + '</h2>' +
      '<div class="meta">' + esc([tankName(t["Tank ID"]), trtDoseText(t) + " " + trtEveryText(t), trtProgress(t)].join(" · ")) + '</div>' +
      (trtActive(t) ? '<div class="meta ' + (isDue(t) ? "trt-due" : "") + '">' + esc(dueText(t) + " · " + fmtDate(fmtISO(nextDue(t)))) + '</div>' : "") +
      (may ? '<div class="actions">' +
        (trtActive(t) ? '<button class="btn primary" data-act="log-dose" data-id="' + esc(id) + '">' + ICONS.plus + 'Log dose</button>' : "") +
        '<button class="btn" data-act="edit-treatment" data-id="' + esc(id) + '">Edit</button>' +
        (trtActive(t) ? '<button class="btn" data-act="trt-status" data-id="' + esc(id) + '" data-status="Stopped">Stop</button>'
                      : '<button class="btn" data-act="trt-status" data-id="' + esc(id) + '" data-status="Active">Start again</button>') +
        '<button class="btn danger" data-act="delete-treatment" data-id="' + esc(id) + '">Delete</button>' +
      '</div>' : "") + '</div>';
    const doseList = '<div class="section"><div class="section-head"><h3>Doses given (' + doses.length + ')</h3></div>' +
      '<div class="card list">' + (doses.map(d =>
        
        '<div class="list-item"><div class="body"><div class="title">Dose ' + esc(d["Dose No"]) + ' · ' + esc(doseText(d["Dose Amount"], d["Dose Unit"])) + '</div>' +
        '<div class="sub">' + esc([fmtDT(d["Given At"]), d["Given By"] ? personName(d["Given By"]) : "", d["Notes"]].filter(Boolean).join(" · ")) + '</div></div>' +
        (may ? '<button class="btn small" data-act="edit-dose" data-id="' + esc(d["Dose ID"]) + '">Edit</button>' : "") + '</div>').join("")
        || '<div class="empty">No doses logged yet.</div>') + '</div></div>';
    const medLink = med ? '<div class="section"><div class="section-head"><h3>Medication</h3></div><div class="card list">' +
      '<a class="list-item" href="#/item/medications/' + encodeURIComponent(t["Product ID"]) + '"><div class="body"><div class="title">' + esc(TYPES.medications.title(med)) + '</div>' +
      '<div class="sub">' + esc([t["Product ID"], med["Standard Dose"] ? "Label dose: " + med["Standard Dose"] : "", med["Frequency / Duration"] || ""].filter(Boolean).join(" · ")) + '</div></div></a></div></div>' : "";
    return { title: trtName(t), back: true, keepScroll: true,
             html: hero + doseList + medLink + '<div class="section"><div class="section-head"><h3>Details</h3></div><div class="card kv">' +
               kv.map(x => '<div class="k">' + esc(x[0]) + '</div><div>' + esc(x[1]) + '</div>').join("") + '</div></div>' };
  }


  // Start or edit a course. tankId preselects a tank; id edits an existing course.
  function treatmentForm(tankId, id) {
    const t = id ? findTreatment(id) : null;
    if (id && !t) return;
    const tanks = state.data.tanks.filter(x => canEditTank(x["Tank ID"]) && (!isRetired(x) || (t && t["Tank ID"] === x["Tank ID"])));
    if (!tanks.length) { toast("You don’t have any tanks you can treat.", true); return; }
    const tank = t ? t["Tank ID"] : (tankId && tanks.some(x => x["Tank ID"] === tankId) ? tankId : tanks[0]["Tank ID"]);
    const meds = state.data.medications.filter(m => !isRetired(m))
      .sort((a, b) => String(TYPES.medications.title(a)).localeCompare(String(TYPES.medications.title(b))))
      .map(m => ({ value: m["Product ID"], label: TYPES.medications.title(m), sub: [m["Product ID"], m["Product Type"], m["Standard Dose"]].filter(Boolean).join(" · ") }));
    const units = (state.doseUnits || []).map(u => ({ value: u, label: u }));
    openSheet({
      title: t ? "Edit treatment" : "Start treatment",
      submitLabel: t ? "Save" : "Start",
      body:
        (t ? '<p class="meta">' + esc(t["Treatment ID"] + " · " + trtName(t) + " · " + tankName(tank)) + '</p>'
           : '<div class="field"><label for="f_tankId">Tank <span class="req">*</span></label><select id="f_tankId" name="tankId" required>' +
             tanks.map(x => '<option value="' + esc(x["Tank ID"]) + '"' + (x["Tank ID"] === tank ? " selected" : "") + '>' + esc(x["Tank Name"]) + '</option>').join("") + '</select></div>' +
             comboHtml({ name: "productId", label: "Medication", required: true, noThumbs: true, placeholder: "Choose a medication or supplement" }, meds)) +
        '<div class="trt-dose-hint hint"></div>' +
        '<div class="price-grid">' +
          '<div class="field"><label for="f_doseAmount">Dose <span class="req">*</span></label><div class="size-row">' +
            '<input type="number" step="any" inputmode="decimal" id="f_doseAmount" name="doseAmount" required data-label="Dose" value="' + esc(t ? t["Dose Amount"] : "") + '">' +
            '<select id="f_doseUnit" name="doseUnit" aria-label="Dose unit" required data-label="Dose unit"><option value="">Unit</option>' +
              units.map(u => '<option value="' + esc(u.value) + '"' + (t && t["Dose Unit"] === u.value ? " selected" : "") + '>' + esc(u.label) + '</option>').join("") + '</select></div></div>' +
          '<div class="field"><label for="f_everyDays">Every (days) <span class="req">*</span></label>' +
            '<input type="number" step="1" min="1" inputmode="numeric" id="f_everyDays" name="everyDays" required data-label="Every (days)" value="' + esc(t ? t["Every Days"] : "1") + '"></div>' +
        '</div>' +
        '<div class="field"><label for="f_totalDoses">Number of doses <span class="opt">blank = ongoing</span></label>' +
          '<input type="number" step="1" min="1" inputmode="numeric" id="f_totalDoses" name="totalDoses" value="' + esc(t ? t["Total Doses"] : "") + '" placeholder="e.g. 5"></div>' +
        fieldHtml({ name: "startDate", label: "Start date", type: "date", required: true }, t ? String(t["Start Date"]).slice(0, 10) : today()) +
        fieldHtml({ name: "reason", label: "Reason / what you’re treating" }, t ? t["Reason"] : "") +
        fieldHtml({ name: "waterChange", label: "Water change between doses" }, t ? t["Water Change"] : "") +
        '<div class="field"><label class="check"><input type="checkbox" name="removeCarbon"' + (t && t["Remove Carbon"] === true ? " checked" : "") + '> Remove carbon / chemical media</label></div>' +
        fieldHtml({ name: "notes", label: "Notes", type: "longtext" }, t ? t["Notes"] : ""),
      onReady: form => {
        $$("[data-combo]", form).forEach(wireCombo);
        const hint = $(".trt-dose-hint", form);
        const showHint = pid => {
          const m = findRec("medications", pid);
          const bits = m ? [m["Standard Dose"] ? "Label dose: " + m["Standard Dose"] : "", m["Frequency / Duration"] ? "Label says: " + m["Frequency / Duration"] : "",
                            m["Remove Carbon / Chemical Media"] ? "Carbon: " + m["Remove Carbon / Chemical Media"] : ""].filter(Boolean) : [];
          hint.textContent = bits.join(" · ");
          hint.hidden = !bits.length;
          const carbon = $("[name=removeCarbon]", form);
          if (m && !t && /yes|remove/i.test(String(m["Remove Carbon / Chemical Media"] || "")) && !carbon.checked) carbon.checked = true;
        };
        const pick = $("input[name=productId]", form);
        if (pick) pick.addEventListener("change", e => showHint(e.target.value));
        showHint(t ? t["Product ID"] : "");
      },
      onSubmit: vals => {
        const payload = { tankId: t ? t["Tank ID"] : vals.tankId, productId: t ? t["Product ID"] : vals.productId,
                          reason: vals.reason, doseAmount: vals.doseAmount, doseUnit: vals.doseUnit, everyDays: vals.everyDays,
                          totalDoses: vals.totalDoses, startDate: vals.startDate, waterChange: vals.waterChange,
                          removeCarbon: !!vals.removeCarbon, notes: vals.notes };
        if (!t && !payload.productId) throw new Error("Choose a medication or supplement.");
        return t ? write("updateTreatment", Object.assign({ id: id }, payload), "Treatment saved")
                 : write("addTreatment", payload, "Treatment started");
      }
    });
  }

  function logDoseForm(id) {
    const t = findTreatment(id);
    if (!t || !canTreat(t["Tank ID"])) return;
    const due = nextDue(t), n = dosesFor(id).length + 1;
    openSheet({
      title: "Log dose " + n,
      submitLabel: "Log dose",
      body: '<p class="meta">' + esc(trtName(t) + " · " + tankName(t["Tank ID"])) + '</p>' +
        (due ? '<p class="hint">' + esc(dueText(t) + " (" + fmtDate(fmtISO(due)) + "). Logging it later moves the following doses along to keep the " + trtEveryText(t) + " spacing.") + '</p>' : "") +
        '<div class="field"><label for="f_givenAt">Given at <span class="req">*</span></label>' +
          '<input type="datetime-local" id="f_givenAt" name="givenAt" required data-label="Given at" value="' + esc(nowLocal()) + '"></div>' +
        '<div class="field"><label for="f_doseAmount">Dose</label><div class="size-row">' +
          '<input type="number" step="any" inputmode="decimal" id="f_doseAmount" name="doseAmount" value="' + esc(t["Dose Amount"]) + '">' +
          '<input type="text" value="' + esc(t["Dose Unit"]) + '" readonly aria-label="Unit"></div></div>' +
        (t["Water Change"] ? '<p class="hint">Water change: ' + esc(t["Water Change"]) + '</p>' : "") +
        fieldHtml({ name: "notes", label: "Notes", type: "longtext" }, ""),
      onSubmit: vals => write("logDose", { treatmentId: id, givenAt: vals.givenAt, doseAmount: vals.doseAmount, notes: vals.notes },
                              res => res && res.finished ? "Last dose logged · treatment complete" : "Dose logged")
    });
  }

  function editDoseForm(doseId) {
    const d = (state.treatmentDoses || []).find(x => x["Dose ID"] === doseId);
    if (!d || !canTreat(d["Tank ID"])) return;
    openSheet({
      title: "Edit dose " + d["Dose No"],
      submitLabel: "Save",
      body: '<p class="meta">' + esc(doseId) + '</p>' +
        '<div class="field"><label for="f_givenAt">Given at <span class="req">*</span></label>' +
          '<input type="datetime-local" id="f_givenAt" name="givenAt" required data-label="Given at" value="' + esc(String(d["Given At"]).replace(" ", "T").slice(0, 16)) + '"></div>' +
        '<div class="field"><label for="f_doseAmount">Dose</label><div class="size-row">' +
          '<input type="number" step="any" inputmode="decimal" id="f_doseAmount" name="doseAmount" value="' + esc(d["Dose Amount"]) + '">' +
          '<input type="text" value="' + esc(d["Dose Unit"] || "") + '" readonly aria-label="Unit"></div></div>' +
        fieldHtml({ name: "notes", label: "Notes", type: "longtext" }, d["Notes"] || "") +
        '<div class="actions" style="margin-top:8px"><button type="button" class="btn danger" data-del-dose>Delete this dose</button></div>',
      onReady: form => {
        $("[data-del-dose]", form).addEventListener("click", () => {
          openSheet({
            title: "Delete dose?", submitLabel: "Delete", danger: true,
            body: '<p>Delete dose ' + esc(d["Dose No"]) + ' (' + esc(fmtDT(d["Given At"])) + ')? The doses after it are renumbered.</p>',
            onSubmit: async () => {
              const ok = await write("deleteDose", { doseId: doseId }, "Dose deleted");
              $$(".sheet-backdrop").forEach(b => b.remove()); document.body.style.overflow = "";
              return ok;
            }
          });
        });
      },
      onSubmit: vals => write("updateDose", { doseId: doseId, givenAt: vals.givenAt, doseAmount: vals.doseAmount, notes: vals.notes }, "Dose saved")
    });
  }

  function deleteTreatmentForm(id) {
    const t = findTreatment(id);
    if (!t || !canTreat(t["Tank ID"])) return;
    const n = dosesFor(id).length;
    openSheet({
      title: "Delete treatment?", submitLabel: "Delete", danger: true,
      body: '<p>Permanently delete this <b>' + esc(trtName(t)) + '</b> treatment on <b>' + esc(tankName(t["Tank ID"])) + '</b>, with its <b>' + n + ' dose' + (n === 1 ? "" : "s") + '</b>? This can’t be undone.</p>' +
        '<p class="hint">To keep the history, use Stop instead.</p>',
      onSubmit: async () => {
        const ok = await write("deleteTreatment", { id: id }, "Treatment deleted");
        if (ok) location.hash = "#/treatments";
        return ok;
      }
    });
  }
  // "2026-11-16T18:30" for a datetime-local field.
  function nowLocal() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") +
      "T" + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  // ---------- Stock (medications and typed price-tracker items) ----------
  const stockOf = r => String((r && r["Stock"]) || "").trim();
  const stockClass = v => /out of/i.test(v) ? "retired" : /need|order|low/i.test(v) ? "warn" : /on hand/i.test(v) ? "good" : "edit";
  const stockPill = v => v ? '<span class="pill ' + stockClass(v) + '">' + esc(v) + '</span>' : "";
  // Equipment isn't counted: anything active and not in a tank is in storage.
  const inStorage = (type, r) => type === "equipment" && !isRetired(r) && !isWishItem(r) &&
    !state.data.assignments.some(a => a["Item ID"] === r["Equipment ID"] && isActiveAssignment(a)) &&
    !(state.otherAssignments || []).some(a => a["Item ID"] === r["Equipment ID"]);

  function stockForm(opts) {
    const cur = opts.current || "";
    const options = (state.stockOptions || []).slice();
    if (cur && options.indexOf(cur) === -1) options.unshift(cur);
    openSheet({
      title: "Stock",
      submitLabel: "Save",
      body: '<p class="meta">' + esc(opts.label) + '</p>' +
        '<div class="field"><label for="f_stock">Stock</label><select id="f_stock" name="stock"><option value="">(not set)</option>' +
          options.map(o => '<option' + (o === cur ? " selected" : "") + '>' + esc(o) + '</option>').join("") + '</select></div>' +
        '<p class="hint">Set by hand. Entering a receipt line for this item marks it on hand. Admins can change the choices under Home › Dropdown lists.</p>',
      onSubmit: vals => write("setStock", Object.assign({ stock: vals.stock }, opts.key), "Stock saved")
    });
  }

  // ---------- Receipt item lines ----------
  // Optional lines on a receipt: item, qty, line price, size + unit. A priced line goes into the
  // price tracker for the receipt's vendor (price ÷ qty each); records on lines get linked.
  const linesFor = rid => (state.receiptLines || []).filter(l => l["Receipt ID"] === rid)
    .sort((a, b) => Number(a["Line No"]) - Number(b["Line No"]));
  // Turns a picked or typed item label into { priceItemId } | { recordId } | null (a new name).
  function makePriceItemRef(ch) {
    return label => {
      const t = String(label || "").trim().toLowerCase();
      if (!t) return null;
      if (ch.map[t]) return ch.map[t];
      const byId = state.priceItems.find(pi => String(pi["Record ID"]).toLowerCase() === t);
      if (byId) return { priceItemId: byId["Price Item ID"] };
      const rec = recordOf(t.toUpperCase());
      if (rec && rec.type !== "tanks") return { recordId: t.toUpperCase() };
      const named = Object.keys(ch.map).filter(k => k === t || k.replace(/^[a-z]+-\d+ /, "") === t);
      return named.length === 1 ? ch.map[named[0]] : null;
    };
  }
  // The label the item picker shows for a saved line.
  function lineItemLabel(l) {
    const pi = l["Price Item ID"] ? findPriceItem(l["Price Item ID"]) : null;
    if (pi) { const info = priceItemInfo(pi); return info.linked ? info.rid + " " + info.name : info.name; }
    if (l["Record ID"]) { const x = recordOf(l["Record ID"]); return l["Record ID"] + " " + (x ? TYPES[x.type].title(x.rec) : (l["Item Name"] || "")); }
    return String(l["Item Name"] || "");
  }
  function rlineRowHtml(i, line, ch) {
    line = line || {};
    return '<div class="rline" data-line="' + i + '">' +
      '<div class="rline-head"><span class="rline-no">Item ' + (i + 1) + '</span>' +
        '<button type="button" class="icon-btn rline-remove" data-remove-line aria-label="Remove item ' + (i + 1) + '">' + ICONS.close + '</button></div>' +
      comboHtml({ name: "li_item_" + i, label: "Item", mode: "free", noThumbs: true, value: line.label || "",
                  placeholder: "Choose or type an item", newLabel: "will be added as a new item" }, ch.items) +
      (isAdmin() ? '<div class="field rline-new" hidden><label for="f_li_new_' + i + '">Add as</label>' +
        '<select id="f_li_new_' + i + '" name="li_new_' + i + '">' +
          '<option value="">Other item — price tracker only</option>' +
          NEW_RECORD_TYPES.map(t => '<option value="' + t[0] + '"' + (line.newType === t[0] ? " selected" : "") + '>' + esc(t[1]) + '</option>').join("") +
        '</select><span class="hint">A new record is created and this receipt is linked to it. Fill in the rest on its page later.</span></div>' : "") +
      '<div class="rline-grid">' +
        '<div class="field"><label for="f_li_qty_' + i + '">Qty</label><input type="number" step="any" min="0" inputmode="decimal" id="f_li_qty_' + i + '" name="li_qty_' + i + '" value="' + esc(line.qty === undefined ? "" : line.qty) + '" placeholder="1"></div>' +
        '<div class="field"><label for="f_li_price_' + i + '">Price <span class="opt">for the line</span></label><input type="text" inputmode="decimal" id="f_li_price_' + i + '" name="li_price_' + i + '" value="' + esc(line.price === undefined ? "" : line.price) + '" placeholder="0.00" autocomplete="off"></div>' +
        '<div class="field"><label for="f_li_size_' + i + '">Size <span class="opt">each</span></label><div class="size-row">' +
          '<input type="number" step="any" inputmode="decimal" id="f_li_size_' + i + '" name="li_size_' + i + '" value="' + esc(line.size === undefined ? "" : line.size) + '">' +
          '<select id="f_li_unit_' + i + '" name="li_unit_' + i + '" aria-label="Unit"><option value="">Unit</option>' +
            state.priceUnits.map(u => '<option value="' + esc(u) + '"' + (u === line.unit ? " selected" : "") + '>' + esc(unitShort(u)) + '</option>').join("") + '</select></div></div>' +
      '</div><div class="rline-each hint"></div></div>';
  }
  function linesEditorHtml(lines, ch) {
    return '<div class="rlines" data-rlines>' + (lines || []).map((l, i) => rlineRowHtml(i, l, ch)).join("") + '</div>' +
      '<button type="button" class="btn small" data-add-line>' + ICONS.plus + 'Add item</button>' +
      '<p class="hint">Optional. A line with a price and size goes into Prices for this receipt’s store, as price ÷ qty each, dated the purchase date. Same price as the latest there just updates its date. Records on lines are linked to the receipt.</p>';
  }
  // getVendor() gives the store typed on the form (for filling in sizes).
  function wireLinesEditor(form, ch, getVendor) {
    const box = $("[data-rlines]", form);
    const refFor = makePriceItemRef(ch);
    let next = $$(".rline", box).length;
    const refresh = row => {
      const i = row.dataset.line;
      const qty = Number($("[name=li_qty_" + i + "]", row).value) || 1;
      const priceText = String($("[name=li_price_" + i + "]", row).value).replace(/[$,\s]/g, "");
      const size = Number($("[name=li_size_" + i + "]", row).value), unit = $("[name=li_unit_" + i + "]", row).value;
      const out = $(".rline-each", row);
      if (priceText === "" || isNaN(Number(priceText))) { out.textContent = ""; return; }
      const each = Number(priceText) / qty;
      out.textContent = money(each) + " each" + (size && unit ? " · " + fmtSize(size, unit) + (unit === "each" && size === 1 ? "" : " · " + fmtPerUnit(each / size, unit)) : " · add a size to put it in Prices");
    };
    const wireRow = row => {
      $$("[data-combo]", row).forEach(wireCombo);
      const i = row.dataset.line;
      // "Add as" shows while the typed item isn't already one of your records.
      const newBox = $(".rline-new", row), newSel = newBox && $("[name=li_new_" + i + "]", row);
      const refreshNew = () => {
        if (!newBox) return;
        const text = String($("input[name=li_item_" + i + "]", row).value || "").trim();
        const ref = refFor(text);
        const pi = ref && ref.priceItemId ? findPriceItem(ref.priceItemId) : null;
        const isRecord = !!(ref && (ref.recordId || (pi && pi["Record ID"])));
        newBox.hidden = !text || isRecord;
        if (newBox.hidden) newSel.value = "";
      };
      if (newSel) newSel.addEventListener("change", () => {
        // A record is one thing bought, so its size starts at 1 each.
        const sizeEl = $("[name=li_size_" + i + "]", row), unitEl = $("[name=li_unit_" + i + "]", row);
        if (newSel.value && !sizeEl.value && !unitEl.value) { sizeEl.value = "1"; unitEl.value = "each"; refresh(row); }
      });
      // Picking an item that's been priced fills in its size: this store's latest, else any store's.
      $("input[name=li_item_" + i + "]", row).addEventListener("change", e => {
        const ref = refFor(e.target.value);
        const sizeEl = $("[name=li_size_" + i + "]", row), unitEl = $("[name=li_unit_" + i + "]", row);
        if (!ref || !ref.priceItemId || sizeEl.value || unitEl.value) return;
        const sum = priceSummary(ref.priceItemId);
        const v = String(getVendor() || "").trim().toLowerCase();
        const s = sum.stores.find(x => x.loc.toLowerCase() === v) ||
                  sum.stores.slice().sort((a, b) => gatheredKey(b.latest).localeCompare(gatheredKey(a.latest)))[0];
        if (s) { sizeEl.value = Number(s.latest["Size"]) || s.latest["Size"]; unitEl.value = s.latest["Unit"]; refresh(row); }
      });
      row.addEventListener("input", () => { refresh(row); refreshNew(); });
      row.addEventListener("change", () => { refresh(row); refreshNew(); });
      $("[data-remove-line]", row).addEventListener("click", () => {
        row.remove();
        $$(".rline", box).forEach((r, n) => { $(".rline-no", r).textContent = "Item " + (n + 1); });
      });
      refresh(row);
      refreshNew();
    };
    $$(".rline", box).forEach(wireRow);
    $("[data-add-line]", form).addEventListener("click", () => {
      const tmp = document.createElement("div");
      tmp.innerHTML = rlineRowHtml(next++, {}, ch);
      const row = tmp.firstElementChild;
      $(".rline-no", row).textContent = "Item " + ($$(".rline", box).length + 1);
      box.appendChild(row);
      wireRow(row);
      const inp = $(".combo-input", row); if (inp) inp.focus();
    });
  }
  // Reads the lines from the form. Asks "Did you mean…?" for new item names; null = go back to the form.
  async function collectLines(vals, form, ch) {
    const refFor = makePriceItemRef(ch);
    const names = {};
    ch.items.forEach(it => { names[it.label.replace(/^[A-Za-z]+-\d+ /, "")] = it.label; });
    const out = [];
    const rows = $$(".rline", $("[data-rlines]", form));
    for (let n = 0; n < rows.length; n++) {
      const i = rows[n].dataset.line;
      let label = String(vals["li_item_" + i] || "").trim();
      const qty = vals["li_qty_" + i], price = vals["li_price_" + i], size = vals["li_size_" + i], unit = vals["li_unit_" + i];
      if (!label && !String(qty || "").trim() && !String(price || "").trim() && !String(size || "").trim()) continue;
      if (!label) throw new Error("Item " + (n + 1) + " needs an item name.");
      const p = String(price || "").replace(/[$,\s]/g, "");
      if (p && isNaN(Number(p))) throw new Error("Item " + (n + 1) + ": the price must be an amount like 24.99.");
      if (String(size || "").trim() && !unit) throw new Error("Item " + (n + 1) + ": choose a unit for the size.");
      const newType = String(vals["li_new_" + i] || "");
      let ref = refFor(label);
      // "Add as" set: a new record (or an existing typed item promoted to one).
      if (newType) {
        out.push({ item: { newType: newType, name: label }, qty: qty, price: p, size: size, unit: unit });
        continue;
      }
      if (!ref) {
        const v = await confirmName(label, Object.keys(names), "item");
        if (v === null) return null;
        if (names[v]) { label = names[v]; ref = refFor(label); setComboValue(form, "li_item_" + i, label); }
      }
      out.push({ item: ref || { name: label }, qty: qty, price: p, size: size, unit: unit });
    }
    return out;
  }
  function lineStatusText(l) {
    switch (String(l["Price Action"] || "")) {
      case "added": return "Added to prices";
      case "date": return "Same price, date updated";
      case "same": return "Same as a newer price";
      default: return l["Line Price"] === "" ? "" : "Not in prices (needs size, vendor and date)";
    }
  }
  function receiptLinesSection(r) {
    if (!state.hasReceiptLines) return "";
    const id = r["Receipt ID"];
    const lines = linesFor(id);
    const head = '<div class="section-head"><h3>Items (' + lines.length + ')</h3>' +
      (canReceipts() ? '<button class="btn small" data-act="edit-receipt-lines" data-id="' + esc(id) + '">' + (lines.length ? "Edit items" : ICONS.plus + "Add items") + '</button>' : "") + '</div>';
    if (!lines.length) return '<div class="section">' + head + '<div class="card"><div class="empty">No items entered.</div></div></div>';
    // How the lines add up against the receipt's own total.
    const priced = lines.filter(l => l["Line Price"] !== "" && l["Line Price"] !== undefined);
    const sum = priced.reduce((t, l) => t + Number(l["Line Price"]), 0);
    const total = String(r["Total"] || "").replace(/[$,\s]/g, "");
    const off = total !== "" && !isNaN(Number(total)) ? Math.round((sum - Number(total)) * 100) / 100 : null;
    const tally = priced.length
      ? '<div class="rl-tally' + (off !== null && Math.abs(off) >= 0.01 ? " warn" : "") + '">' +
        esc(priced.length + (priced.length === 1 ? " priced line · " : " priced lines · ") + money(sum) +
            (off === null ? "" : off === 0 ? " · matches the receipt total" :
             " of " + money(total) + " · " + money(Math.abs(off)) + (off > 0 ? " more than" : " short of") + " the total")) + '</div>'
      : "";
    return '<div class="section">' + head + '<div class="card list">' + lines.map(l => {
      const qty = Number(l["Qty"]) || 1;
      const price = l["Line Price"] === "" ? "" : Number(l["Line Price"]);
      const pi = l["Price Item ID"];
      const name = lineItemLabel(l);
      const sub = [qty !== 1 ? "Qty " + qty : "", price === "" ? "" : money(price) + (qty !== 1 ? " (" + money(price / qty) + " each)" : ""),
                   l["Size"] !== "" && l["Unit"] ? fmtSize(l["Size"], l["Unit"]) : "", lineStatusText(l)].filter(Boolean).join(" · ");
      return (pi ? '<a class="list-item" href="#/price/' + encodeURIComponent(pi) + '">' : '<div class="list-item">') +
        '<div class="body"><div class="title">' + esc(name) + '</div><div class="sub">' + esc(sub) + '</div></div>' + (pi ? '</a>' : '</div>');
    }).join("") + '</div>' + tally + '</div>';
  }
  function editReceiptLinesForm(id) {
    const r = findReceipt(id);
    if (!r || !canReceipts()) return;
    const ch = priceItemChoices();
    const lines = linesFor(id).map(l => ({ label: lineItemLabel(l), qty: l["Qty"], price: l["Line Price"], size: l["Size"], unit: l["Unit"] }));
    if (!lines.length) lines.push({});
    openSheet({
      title: "Items on " + receiptTitle(r),
      submitLabel: "Save items",
      body: '<p class="meta">' + esc([r["Vendor"], fmtDate(r["Purchase Date"])].filter(Boolean).join(" · ") || id) + '</p>' + linesEditorHtml(lines, ch),
      onReady: form => wireLinesEditor(form, ch, () => r["Vendor"] || ""),
      onSubmit: async (vals, form) => {
        const out = await collectLines(vals, form, ch);
        if (out === null) return false;
        return write("saveReceiptLines", { id: id, lines: out }, res => "Items saved" + (res && res.notes && res.notes.length ? ". " + res.notes.join(". ") : ""));
      }
    });
  }

  // ---------- Dropdown lists (Admins) ----------
  // The lists live on the Lookups tab. Admins add, rename, turn off / on and describe values.
  const STATUS_LISTS = ["Status", "Tank Status"];
  // How many records use a value (fields drawing from that list, plus vendor columns elsewhere).
  function lookupUseCount(type, value) {
    const key = s => String(s === undefined || s === null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
    const k = key(value);
    let n = 0;
    Object.keys(state.schema || {}).forEach(table => {
      const fields = (state.schema[table] || []).filter(f => f.lookup === type);
      if (!fields.length) return;
      (state.data[table] || []).forEach(r => fields.forEach(f => { if (key(r[f.name]) === k) n++; }));
    });
    if (type === "Vendor") {
      n += state.receipts.filter(r => key(r["Vendor"]) === k).length +
           state.wishes.filter(w => key(w["Vendor"]) === k).length +
           state.prices.filter(p => key(p["Location"]) === k).length;
    }
    return n;
  }

  function viewLists() {
    const types = state.lookupTypes || [];
    const q = String(state.listQuery || "").trim().toLowerCase();
    const cards = types.map(type => {
      const rows = (state.lookups || []).filter(r => r.type === type)
        .sort((a, b) => (a.inactive - b.inactive) || a.value.localeCompare(b.value));
      const shown = q ? rows.filter(r => (type + " " + r.value + " " + r.description).toLowerCase().indexOf(q) !== -1) : rows;
      if (q && !shown.length) return "";
      const on = rows.filter(r => !r.inactive).length;
      return '<div class="section"><div class="section-head"><h3>' + esc(type) + ' <span class="list-count">' + on + ' on' + (rows.length - on ? ' · ' + (rows.length - on) + ' off' : "") + '</span></h3>' +
        '<button class="btn small" data-act="lookup-add" data-type="' + esc(type) + '">' + ICONS.plus + 'Add value</button></div>' +
        (STATUS_LISTS.indexOf(type) !== -1 ? '<p class="hint">The app knows Active, Retired' + (type === "Tank Status" ? ", Storage" : ", Wishlist") +
          '. Any other status shows as-is and counts as not retired. Status can’t be typed in from forms.</p>' : "") +
        '<div class="card list">' + shown.map(r => {
          const used = lookupUseCount(type, r.value);
          return '<div class="list-item' + (r.inactive ? " dim" : "") + '"><div class="body"><div class="title">' + esc(r.value) + '</div>' +
            '<div class="sub">' + esc([r.description, used ? "used by " + used : "not used"].filter(Boolean).join(" · ")) + '</div></div>' +
            (r.inactive ? '<span class="pill retired">Off</span>' : "") +
            '<button class="btn small" data-act="lookup-edit" data-row="' + r.row + '">Edit</button></div>';
        }).join("") + '</div></div>';
    }).join("");
    return {
      title: "Dropdown lists", back: true, keepScroll: true,
      html: '<input class="search" type="search" placeholder="Search lists and values…" aria-label="Search dropdown lists" value="' + esc(state.listQuery || "") + '" data-act="list-search">' +
        '<p class="hint">These are the choices in the app’s dropdowns, kept on the sheet’s Lookups tab. Turned-off values are hidden from dropdowns but kept, so old records still show them.</p>' +
        (cards || '<div class="empty">' + (types.length ? "Nothing matches." : "No lists found on the Lookups tab.") + '</div>')
    };
  }

  function lookupAddForm(type) {
    const rows = (state.lookups || []).filter(r => r.type === type);
    openSheet({
      title: "Add to " + type,
      submitLabel: "Add",
      body: fieldHtml({ name: "value", label: "Value", required: true }, "") +
        fieldHtml({ name: "description", label: "Description", type: "longtext" }, "") +
        (STATUS_LISTS.indexOf(type) !== -1 ? '<p class="hint">The app only acts on Active, Retired' + (type === "Tank Status" ? ", Storage" : ", Wishlist") + '. A new status shows as-is and counts as not retired.</p>' : ""),
      onSubmit: async (vals, form) => {
        const typed = String(vals.value || "").replace(/\s+/g, " ").trim();
        const exact = rows.find(r => r.value.toLowerCase() === typed.toLowerCase());
        if (exact) throw new Error(exact.value + " is already on this list" + (exact.inactive ? " (turned off; use Edit to turn it back on)." : "."));
        const v = await confirmName(typed, rows.map(r => r.value), "value");
        if (v === null) return false;
        const hit = rows.find(r => r.value === v);
        if (hit) {
          if (hit.inactive) return write("updateLookup", { row: hit.row, type: type, value: hit.value, inactive: false }, hit.value + " turned back on");
          toast(hit.value + " is already on the list");
          return true;
        }
        return write("addLookup", { type: type, value: v, description: vals.description }, "Added to " + type);
      }
    });
  }

  function lookupEditForm(row) {
    const r = (state.lookups || []).find(x => x.row === Number(row));
    if (!r) return;
    const used = lookupUseCount(r.type, r.value);
    const others = (state.lookups || []).filter(x => x.type === r.type && x.row !== r.row);
    openSheet({
      title: "Edit " + r.type + " value",
      submitLabel: "Save",
      body: fieldHtml({ name: "value", label: "Value", required: true }, r.value) +
        '<p class="hint" data-rename-note hidden>Renaming also updates the ' + used + ' record' + (used === 1 ? "" : "s") + ' using “' + esc(r.value) + '”.</p>' +
        fieldHtml({ name: "description", label: "Description", type: "longtext" }, r.description) +
        '<div class="field"><label class="check"><input type="checkbox" name="inactive"' + (r.inactive ? " checked" : "") + '> Turned off (hidden from dropdowns; records keep it)</label></div>' +
        '<p class="meta">Used by ' + used + ' record' + (used === 1 ? "" : "s") + ' · Lookups row ' + r.row + '</p>',
      onReady: form => {
        const note = $("[data-rename-note]", form), inp = $("[name=value]", form);
        if (used) inp.addEventListener("input", () => { note.hidden = inp.value.replace(/\s+/g, " ").trim() === r.value; });
      },
      onSubmit: async vals => {
        const nv = String(vals.value || "").replace(/\s+/g, " ").trim();
        const payload = { row: r.row, type: r.type, value: r.value };
        if (nv !== r.value) {
          const clash = others.find(x => x.value.toLowerCase() === nv.toLowerCase());
          if (clash) throw new Error(clash.value + " is already on this list.");
          if (nv.toLowerCase() !== r.value.toLowerCase()) {
            const close = closeName(nv, others.map(x => x.value));
            if (close) {
              const pick = await askDidYouMean(nv, close, "value");
              if (pick === null) return false;
              if (pick === close) throw new Error(close + " is already on this list. Turn this value off instead, or pick a different name.");
            }
          }
          payload.newValue = nv;
        }
        if (String(vals.description || "").trim() !== r.description) payload.description = vals.description;
        if (!!vals.inactive !== r.inactive) payload.inactive = !!vals.inactive;
        if (Object.keys(payload).length === 3) { toast("No changes"); return true; }
        return write("updateLookup", payload, payload.newValue && used ? "Renamed; " + used + " record" + (used === 1 ? "" : "s") + " updated" : "Saved");
      }
    });
  }

  // ---------- Home ----------
  function viewHome() {
    const active = list => list.filter(r => !isRetired(r));
    const latest = (rows, field) => rows.filter(isLive).map(r => r[field]).filter(Boolean)
      .sort((a, b) => (parseDT(b) || 0) - (parseDT(a) || 0))[0];
    const lastTest = latest(state.waterSessions || [], "Tested At");
    const lastChange = latest(state.waterChanges || [], "Performed At");
    const link = (href, icon, label, info, act) => '<a class="home-link" href="' + href + '"' + (act ? ' data-act="home-browse" data-type="' + act + '"' : "") + '>' +
      '<span class="home-icon">' + ICONS[icon] + '</span><span class="home-text"><span class="home-label">' + esc(label) + '</span>' +
      (info ? '<span class="home-info">' + esc(info) + '</span>' : "") + '</span></a>';
    const group = (title, links) => '<div class="section"><div class="section-head"><h3>' + esc(title) + '</h3></div><div class="home-grid">' + links.join("") + '</div></div>';
    const n = (k, word) => k + " " + word;
    const openWishes = state.wishes.filter(wishIsOpen).length;
    const unassigned = state.receipts.filter(r => !isRetired(r) && receiptLinksFor(r["Receipt ID"]).length === 0).length;
    const html =
      group("Tanks", [
        link("#/tanks", "tanks", "Tanks", n(state.data.tanks.filter(t => tankStatus(t) === "Active").length, "active")),
        link("#/water", "water", "Water tests", lastTest ? "Last test " + daysAgo(lastTest) : "No tests logged"),
        link("#/maint", "maint", "Maintenance", lastChange ? "Last water change " + daysAgo(lastChange) : "No water changes logged")
      ].concat(state.hasTreatments ? [link("#/treatments", "pill", "Treatments",
          (state.treatments || []).filter(trtActive).length + " running" + (dueCount() ? " · " + dueCount() + " due" : ""))] : [])) +
      group("Collection", [
        link("#/browse", "fish", "Species", n(browseCount("species"), "active"), "species"),
        link("#/browse", "gear", "Equipment", n(browseCount("equipment"), "active"), "equipment"),
        link("#/browse", "leaf", "Plants", n(browseCount("plants"), "active"), "plants"),
        link("#/browse", "pill", "Medications", n(browseCount("medications"), "active"), "medications"),
        link("#/wish", "wish", "Wishlist", n(openWishes, "open"))
      ].concat(canReceipts() ? [link("#/receipts", "receipts", "Receipts", n(unassigned, "unassigned"))] : [])
       .concat([link("#/prices", "tag", "Prices", n(state.priceItems.length, state.priceItems.length === 1 ? "item" : "items") + " · " + n(state.prices.length, state.prices.length === 1 ? "price" : "prices"))])) +
      group("Account", [link("#/account", "account", "My account", state.me ? state.me.name || state.me.email : "")]
        .concat(isAdmin() ? [link("#/users", "users", "Users", ""), link("#/testtypes", "flask", "Test types", ""),
                          link("#/lists", "list", "Dropdown lists", (state.lookupTypes || []).length + " lists")] : []));
    return { title: "Ayers Aquariums", html: html };
  }
  const browseCount = type => state.data[type].filter(r => !isWishItem(r) && !isRetired(r)).length;

  // ---------- Tanks ----------
  // The Tanks list, in the order it's shown (also used by Previous / Next).
  // Tank status: Active (or blank), Storage, Retired. The list shows Active, then Storage, then Retired.
  const tankStatus = t => String(t["Status"] || "").trim() || "Active";
  const TANK_STATUS_ORDER = { Active: 0, Storage: 1, Retired: 2 };
  const tankRows = () => state.data.tanks.slice().sort((a, b) =>
    ((TANK_STATUS_ORDER[tankStatus(a)] ?? 1) - (TANK_STATUS_ORDER[tankStatus(b)] ?? 1)) ||
    String(a["Tank Name"]).localeCompare(String(b["Tank Name"])));
  function viewTanks() {
    const tanks = tankRows();
    const cards = tanks.map(t => {
      const id = t["Tank ID"];
      const assigned = tankAssignments(id, true);
      const counts = { species: 0, equipment: 0, plants: 0 };
      assigned.forEach(a => { const ty = itemType(a["Item ID"]); if (ty) counts[ty]++; });
      return '<a class="card tank-card ' + (isRetired(t) ? "dim" : "") + '" href="#/tank/' + encodeURIComponent(id) + '">' +
        '<div class="row1"><h2>' + esc(t["Tank Name"]) + '</h2>' +
          '<div class="tank-side">' + (t["Volume (gal)"] ? '<span class="vol">' + esc(t["Volume (gal)"]) + ' gal</span>' : "") +
          '<span class="pill tank-status ' + esc(tankStatus(t).toLowerCase()) + '">' + esc(tankStatus(t)) + '</span></div></div>' +
        '<div class="meta">' + esc([id, t["Aquarium Type"], t["Manufacturer"]].filter(Boolean).join(" · ")) + '</div>' +
        (isRetired(t) ? "" : '<div class="meta wc-line">' + ICONS.water + esc(lastWaterChangeText(id)) + '</div>') +
        '<div class="counts">' +
          '<span class="pill">' + counts.species + ' livestock</span>' +
          '<span class="pill">' + counts.equipment + ' equipment</span>' +
          (counts.plants ? '<span class="pill">' + counts.plants + ' plants</span>' : "") +
        '</div></a>';
    }).join("");
    const addBtn = isAdmin() ? '<div class="actions" style="margin:0 0 12px"><button class="btn primary" data-act="add-record" data-type="tanks">' + ICONS.plus + 'Add tank</button></div>' : "";
    return { title: "Tanks", html: addBtn + (cards || '<div class="empty">' + (isAdmin() ? "No tanks yet." : "No tanks are assigned to you yet. Ask Chris to add you to a tank.") + '</div>') };
  }

  // ---------- Tank detail ----------
  function viewTank(id) {
    const t = findRec("tanks", id);
    if (!t) return { title: "Tank", back: true, html: '<div class="empty">That tank wasn\'t found.</div>' };
    const editable = canEditTank(id);
    const active = tankAssignments(id, true);
    const groups = { species: [], equipment: [], plants: [] };
    active.forEach(a => { const ty = itemType(a["Item ID"]); if (ty) groups[ty].push(a); });

    const itemRow = (a, ty) => {
      const r = findRec(ty, a["Item ID"]);
      const T = TYPES[ty];
      const img = T.img(r);
      return '<div class="list-item" data-act="open-item" data-type="' + ty + '" data-id="' + esc(a["Item ID"]) + '">' +
        photoHtml(img, "thumb", 160, a["Item ID"].split("-")[0]) +
        '<div class="body"><div class="title">' + esc(T.title(r)) + '</div>' +
        '<div class="sub">' + esc([a["Item ID"], T.sub(r), a["Date Added"] ? "Added " + fmtDate(a["Date Added"]) : ""].filter(Boolean).join(" · ")) + '</div>' +
        (a["Notes"] ? '<div class="sub">' + esc(a["Notes"]) + '</div>' : "") + '</div>' +
        (editable ? '<button class="btn small danger" data-act="remove-assignment" data-row="' + a._row + '" data-tank="' + esc(id) + '" data-item="' + esc(a["Item ID"]) + '">Remove</button>' : "") +
        '</div>';
    };
    const group = (ty, label) =>
      '<div class="section"><div class="section-head"><h3>' + label + ' (' + groups[ty].length + ')</h3></div>' +
      '<div class="card list">' + (groups[ty].map(a => itemRow(a, ty)).join("") || '<div class="empty">None</div>') + '</div></div>';

    const params = state.data.waterParameters.filter(p => p["Tank ID"] === id);
    const paramsHtml =
      '<div class="section"><div class="section-head"><h3>Target ranges (' + params.length + ')</h3>' +
      (editable ? '<button class="btn small" data-act="add-param" data-tank="' + esc(id) + '">' + ICONS.plus + 'Add</button>' : "") + '</div>' +
      '<div class="card">' + (params.length ?
        '<table class="params"><thead><tr><th>Parameter</th><th>Target</th><th>Range</th></tr></thead><tbody>' +
        params.map(p => '<tr class="' + (editable ? "tap" : "") + '" ' + (editable ? 'data-act="edit-param" data-row="' + p._row + '"' : "") + '>' +
          '<td>' + esc(p["Parameter"]) + (p["Notes"] ? '<div class="sub meta">' + esc(p["Notes"]) + '</div>' : "") + '</td>' +
          '<td>' + esc([p["Target"], p["Units"]].filter(v => v !== "").join(" ")) + '</td>' +
          '<td>' + esc((p["Acceptable Min"] !== "" || p["Acceptable Max"] !== "") ? p["Acceptable Min"] + "–" + p["Acceptable Max"] : "") + '</td></tr>').join("") +
        '</tbody></table>' : '<div class="empty">None</div>') + '</div></div>';

    const removed = tankAssignments(id, false);
    const removedHtml = removed.length ?
      '<div class="section"><div class="toggle-row"><span>Removed items (' + removed.length + ')</span>' +
      '<button class="btn small" data-act="toggle-removed">' + (state.showRemoved ? "Hide" : "Show") + '</button></div>' +
      (state.showRemoved ? '<div class="card list">' + removed.map(a => {
        const ty = itemType(a["Item ID"]);
        const r = ty ? findRec(ty, a["Item ID"]) : null;
        return '<div class="list-item"' + (ty ? ' data-act="open-item" data-type="' + ty + '" data-id="' + esc(a["Item ID"]) + '"' : "") + '><div class="body">' +
          '<div class="title">' + esc(r ? TYPES[ty].title(r) : a["Item ID"]) + '</div>' +
          '<div class="sub">' + esc([a["Item ID"], a["Date Added"] ? "Added " + fmtDate(a["Date Added"]) : "", a["Date Removed"] ? "Removed " + fmtDate(a["Date Removed"]) : ""].filter(Boolean).join(" · ")) + '</div></div></div>';
      }).join("") + '</div>' : "") + '</div>' : "";

    const hero =
      '<div class="card hero"><h2>' + esc(t["Tank Name"]) + '</h2>' +
      '<div class="meta">' + esc([id, t["Volume (gal)"] ? t["Volume (gal)"] + " gal" : "", t["Aquarium Type"], t["Status"]].filter(Boolean).join(" · ")) + '</div>' +
      (editable ? '<div class="actions">' +
        '<button class="btn primary" data-act="add-assignment" data-tank="' + esc(id) + '">' + ICONS.plus + 'Add to tank</button>' +
        '<button class="btn" data-act="edit-record" data-type="tanks" data-id="' + esc(id) + '">Edit tank</button>' +
        (isAdmin() && !isRetired(t) ? '<button class="btn danger" data-act="retire" data-type="tanks" data-id="' + esc(id) + '">Retire</button>' : "") +
        (isAdmin() ? '<button class="btn danger" data-act="delete-record" data-type="tanks" data-id="' + esc(id) + '">Delete</button>' : "") +
      '</div>' : "") + '</div>';

    return {
      title: t["Tank Name"], back: true,
      html: hero + group("species", "Livestock") + group("equipment", "Equipment") + group("plants", "Plants") +
            wishSection(id) + waterSection(id) + maintSection(id) + (state.hasTreatments ? treatmentSection(id, { showPast: true }) : "") + paramsHtml + receiptsSection(id) + detailsSection("tanks", t, "Tank details") + removedHtml
    };
  }

  function detailsSection(type, r, heading) {
    const fields = (state.schema[type] || []).map(f => f.name)
      .filter(n => r[n] !== "" && r[n] !== undefined && r[n] !== null && !/Thumbnail URL/.test(n));
    if (!fields.length) return "";
    return '<div class="section"><div class="section-head"><h3>' + esc(heading) + '</h3></div><div class="card kv">' +
      fields.map(n => {
        let v = r[n];
        const f = state.schema[type].find(x => x.name === n);
        let html;
        if (f && f.type === "date") html = esc(fmtDate(v));
        else if (typeof v === "boolean") html = v ? "Yes" : "No";
        else if (isUrl(v)) html = '<a href="' + esc(v) + '" target="_blank" rel="noopener">Open link</a>';
        else html = esc(v);
        return '<div class="k">' + esc(n) + '</div><div>' + html + '</div>';
      }).join("") + '</div></div>';
  }

  // ---------- Browse ----------
  // A Browse list with the current search (when it's the type on screen) and Show retired setting.
  function browseRows(type, useSearch) {
    const T = TYPES[type];
    const q = useSearch ? state.query.trim().toLowerCase() : "";
    return state.data[type]
      .filter(r => !isWishItem(r))
      .filter(r => state.showRetired || !isRetired(r))
      .filter(r => !q || Object.keys(r).some(k => k !== "_row" && String(r[k]).toLowerCase().indexOf(q) !== -1))
      .sort((a, b) => String(T.title(a)).localeCompare(String(T.title(b))));
  }
  function viewBrowse() {
    const type = state.browseType;
    const T = TYPES[type];
    const rows = browseRows(type, true);
    const segs = ["species", "equipment", "plants", "medications"].map(t =>
      '<button class="' + (t === type ? "on" : "") + '" data-act="browse-type" data-type="' + t + '">' + TYPES[t].label + '</button>').join("");
    const list = rows.map(r => {
      const img = T.img(r);
      return '<div class="list-item ' + (isRetired(r) ? "dim" : "") + '" data-act="open-item" data-type="' + type + '" data-id="' + esc(r[T.id]) + '">' +
        (type !== "medications" ? photoHtml(img, "thumb", 160, String(r[T.id]).split("-")[0]) : "") +
        '<div class="body"><div class="title">' + esc(T.title(r)) + '</div><div class="sub">' + esc([r[T.id], T.sub(r)].filter(Boolean).join(" · ")) + '</div></div>' +
        (isRetired(r) ? '<span class="pill retired">Retired</span>'
          : type === "medications" ? stockPill(stockOf(r))
          : inStorage(type, r) ? '<span class="pill">In storage</span>' : "") + '</div>';
    }).join("");
    return {
      title: "Browse",
      keepScroll: true,
      html:
        '<div class="segmented">' + segs + '</div>' +
        '<input class="search" type="search" placeholder="Search ' + esc(T.label.toLowerCase()) + '…" value="' + esc(state.query) + '" data-act="search">' +
        '<div class="toggle-row"><label class="check" style="padding:0"><input type="checkbox" data-act="toggle-retired" ' + (state.showRetired ? "checked" : "") + '> Show retired</label>' +
        (isAdmin() ? '<button class="btn small primary" data-act="add-record" data-type="' + type + '">' + ICONS.plus + 'Add</button>' : "") + '</div>' +
        '<div class="card list">' + (list || '<div class="empty">Nothing found.</div>') + '</div>'
    };
  }

  // ---------- Item detail ----------
  function viewItem(type, id) {
    const T = TYPES[type];
    const r = T && findRec(type, id);
    if (!r) return { title: "Not found", back: true, html: '<div class="empty">That record wasn\'t found.</div>' };
    const img = T.img(r);
    let inTanks = "";
    if (ITEM_TYPES.indexOf(type) !== -1) {
      const rows = state.data.assignments.filter(a => a["Item ID"] === id && isActiveAssignment(a));
      const others = (state.otherAssignments || []).filter(a => a["Item ID"] === id);
      const total = rows.length + others.length;
      const addBtn = canAddItemToTank(type, r) ? '<button class="btn small" data-act="item-to-tank" data-type="' + type + '" data-id="' + esc(id) + '">' + ICONS.plus + 'Add to tank</button>' : "";
      inTanks = '<div class="section"><div class="section-head"><h3>In tanks (' + total + ')</h3>' + addBtn + '</div><div class="card list">' +
        (rows.map(a => '<a class="list-item" href="#/tank/' + encodeURIComponent(a["Tank ID"]) + '"><div class="body"><div class="title">' + esc(tankName(a["Tank ID"])) + '</div>' +
          '<div class="sub">' + esc([a["Tank ID"], a["Date Added"] ? "Added " + fmtDate(a["Date Added"]) : ""].filter(Boolean).join(" · ")) + '</div></div></a>').join("") +
         others.slice().sort((x, y) => String(x["Tank Name"]).localeCompare(String(y["Tank Name"]))).map(a =>
          '<div class="list-item"><div class="body"><div class="title">' + esc(a["Tank Name"]) + '</div>' +
          '<div class="sub">' + esc([a["Tank ID"], a["Date Added"] ? "Added " + fmtDate(a["Date Added"]) : ""].filter(Boolean).join(" · ")) + '</div></div></div>').join("") ||
          '<div class="empty">Not in any tank</div>') + '</div></div>';
    }
    const hero = '<div class="card">' +
      photoHtml(img, "big-img", 800, "") +
      '<div class="hero"><h2>' + esc(T.title(r)) + '</h2><div class="meta">' + esc([r[T.id], T.sub(r)].filter(Boolean).join(" · ")) + '</div>' +
      (isRetired(r) ? '<div class="counts"><span class="pill retired">Retired</span></div>' : isWishItem(r) ? '<div class="counts"><span class="pill wishpill">' + ICONS.wish + 'Wishlist</span></div>' : "") +
      (type === "medications" && state.hasTreatments
        ? '<div class="counts">' + (stockOf(r) ? stockPill(stockOf(r)) : '<span class="pill">Stock not set</span>') +
          (canPrices() ? '<button class="btn small" data-act="set-stock" data-id="' + esc(id) + '">Change</button>' : "") + '</div>'
        : inStorage(type, r) ? '<div class="counts"><span class="pill">In storage</span></div>' : "") +
      (isAdmin() ? '<div class="actions"><button class="btn" data-act="edit-record" data-type="' + type + '" data-id="' + esc(id) + '">Edit</button>' +
        (!isRetired(r) && "Status" in r ? '<button class="btn danger" data-act="retire" data-type="' + type + '" data-id="' + esc(id) + '">Retire</button>' : "") +
        '<button class="btn danger" data-act="delete-record" data-type="' + type + '" data-id="' + esc(id) + '">Delete</button></div>'
        : canEditItem(type, r) ? '<div class="actions"><button class="btn" data-act="edit-record" data-type="' + type + '" data-id="' + esc(id) + '">Edit details</button></div>' : "") +
      '</div></div>';
    const wishes = state.wishes.filter(w => w["Item ID"] === id && wishIsOpen(w));
    const wishNote = wishes.length ? '<div class="section"><div class="card list">' + wishes.map(wishRow).join("") + '</div></div>' : "";
    return { title: T.title(r), back: true, html: hero + photosSection(type, r) + wishNote + inTanks + receiptsSection(id, canItemReceipts(type, r) ? type : "") + detailsSection(type, r, "Details") };
  }

  // ---------- Users (admin) ----------
  function viewUsers() {
    const users = (state.users || []).slice().sort((a, b) => (b.active - a.active) || a.email.localeCompare(b.email));
    const rows = users.map(u =>
      '<div class="list-item user-row ' + (u.active ? "" : "dim") + '" data-act="edit-user" data-id="' + esc(u.id) + '">' +
      '<div class="body"><div class="title">' + esc(u.name || u.email) + '</div>' +
      '<div class="sub">' + esc([u.id, u.email].filter(Boolean).join(" · ")) + '</div>' +
      (u.role !== "Admin" ? '<div class="sub">Tanks: ' + esc(u.tanks.map(tankName).join(", ") || "none yet") + '</div>' : "") + '</div>' +
      '<span class="pill ' + (u.role === "Admin" ? "edit" : "") + '">' + esc(u.active ? u.role : "Inactive") + '</span></div>').join("");
    return {
      title: "Users", back: true,
      html: '<div class="actions" style="margin:0 0 12px"><button class="btn primary" data-act="add-user">' + ICONS.plus + 'Add user</button></div>' +
        '<div class="card list">' + (rows || '<div class="empty">No users.</div>') + '</div>' +
        '<p class="hint">Admins see and change everything. Editors see, edit and log water tests on their assigned tanks. Viewers see and log water tests on their assigned tanks. Everyone can browse species, equipment, plants and medications. Users sign in with the Google account email listed here.</p>'
    };
  }

  // ---------- Account ----------
  function viewAccount() {
    const me = state.me;
    const assigned = me.tanks.map(tankName).join(", ") || "None yet";
    const tankList = me.role === "Admin" ? "All tanks" : me.role === "Editor" ? assigned : "None (view only)";
    const testList = me.role === "Admin" ? "All tanks" : assigned;
    return {
      title: "Account",
      html: '<div class="card kv">' +
        '<div class="k">Name</div><div>' + esc(me.name || "") + '</div>' +
        '<div class="k">Email</div><div>' + esc(me.email) + '</div>' +
        '<div class="k">Role</div><div>' + esc(me.role) + '</div>' +
        '<div class="k">Can see</div><div>' + esc(me.role === "Admin" ? "All tanks" : assigned) + '</div>' +
        '<div class="k">Can edit</div><div>' + esc(tankList) + '</div>' +
        '<div class="k">Can log tests</div><div>' + esc(testList) + '</div>' +
        '<div class="k">App version</div><div>' + esc(APP_VERSION) + '</div></div>' +
        (isAdmin() ? '<div class="actions"><a class="btn primary" href="#/users">' + ICONS.users + 'Manage users</a></div>' : "") +
        '<div class="actions"><button class="btn" data-act="refresh">Refresh data</button><button class="btn danger" data-act="sign-out">Sign out</button></div>' +
        '<p class="hint" style="margin-top:16px"><b>Add to your home screen:</b> on iPhone, tap Share → Add to Home Screen. On Android, tap the ⋮ menu → Add to Home screen (or Install app).</p>'
    };
  }

  // ------------------------------------------------------------------
  // Forms
  // ------------------------------------------------------------------
  // Admins can type a new value into a dropdown that comes from the Lookups tab (never Status).
  const adminListField = (f, ro) => f.type === "list" && !!f.lookup && f.name !== "Status" && !ro && isAdmin();
  function fieldHtml(f, value, opts) {
    opts = opts || {};
    const id = "f_" + f.name.replace(/\W+/g, "_");
    const v = value === undefined || value === null ? "" : value;
    if (adminListField(f, f.readOnly || opts.readOnly)) {
      const items = (f.options || []).map(o => ({ value: o, label: o }));
      return comboHtml({ name: f.name, label: f.label || f.name, mode: "free", required: f.required, noThumbs: true, value: String(v),
                         placeholder: "Choose or type a new value", newLabel: "will be added to the " + f.lookup + " list" }, items);
    }
    const req = f.required ? ' required' : "";
    const ro = (f.readOnly || opts.readOnly) ? " readonly" : "";
    const label = '<label for="' + id + '">' + esc(f.label || f.name) + (f.required ? ' <span class="req">*</span>' : "") + '</label>';
    let input;
    switch (f.type) {
      case "list": {
        const options = (f.options || []).slice();
        if (v !== "" && options.indexOf(v) === -1) options.unshift(v);
        if (f.strict || ro) {
          input = '<select id="' + id + '" name="' + esc(f.name) + '"' + req + (ro ? " disabled" : "") + '><option value=""></option>' +
            options.map(o => '<option' + (o === v ? " selected" : "") + '>' + esc(o) + '</option>').join("") + '</select>';
        } else {
          input = '<input type="text" id="' + id + '" name="' + esc(f.name) + '" list="dl_' + id + '" value="' + esc(v) + '"' + req + ro + ' autocomplete="off">' +
            '<datalist id="dl_' + id + '">' + options.map(o => '<option value="' + esc(o) + '">').join("") + '</datalist>';
        }
        break;
      }
      case "number":
        input = '<input type="number" step="any" inputmode="decimal" id="' + id + '" name="' + esc(f.name) + '" value="' + esc(String(v).replace(/,/g, "")) + '"' + req + ro + '>';
        break;
      case "date":
        input = '<input type="date" id="' + id + '" name="' + esc(f.name) + '" value="' + esc(v) + '"' + req + ro + '>';
        break;
      case "url":
        input = '<input type="url" inputmode="url" id="' + id + '" name="' + esc(f.name) + '" value="' + esc(v) + '"' + req + ro + '>';
        break;
      case "longtext":
        input = '<textarea id="' + id + '" name="' + esc(f.name) + '"' + req + ro + '>' + esc(v) + '</textarea>';
        break;
      case "boolean":
        return '<div class="field"><label class="check"><input type="checkbox" name="' + esc(f.name) + '"' + (v === true ? " checked" : "") + (ro ? " disabled" : "") + '> ' + esc(f.name) + '</label></div>';
      case "select":
        input = '<select id="' + id + '" name="' + esc(f.name) + '"' + req + '>' + f.html + '</select>';
        break;
      default:
        input = '<input type="text" id="' + id + '" name="' + esc(f.name) + '" value="' + esc(v) + '"' + req + ro + '>';
    }
    return '<div class="field">' + label + input + (f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : "") + '</div>';
  }

  function collect(form) {
    const out = {};
    $$("input[name], select[name], textarea[name]", form).forEach(el => {
      if (el.disabled || el.readOnly) return;
      out[el.name] = el.type === "checkbox" ? el.checked : el.value;
    });
    return out;
  }

  // Opens a bottom sheet with a form. onSubmit(values) may throw to show an error.
  function openSheet(opts) {
    const back = document.createElement("div");
    back.className = "sheet-backdrop";
    back.innerHTML =
      '<form class="sheet" novalidate>' +
        '<div class="sheet-head"><h2>' + esc(opts.title) + '</h2><button type="button" class="icon-btn" data-close aria-label="Close">' + ICONS.close + '</button></div>' +
        '<div class="sheet-body"><div class="form-error" hidden></div>' + opts.body + '</div>' +
        '<div class="sheet-foot">' + (opts.noCancel ? "" : '<button type="button" class="btn" data-close>Cancel</button>') +
        '<button type="submit" class="btn ' + (opts.danger ? "danger" : "primary") + '">' + esc(opts.submitLabel || "Save") + '</button></div>' +
      '</form>';
    document.body.appendChild(back);
    document.body.style.overflow = "hidden";
    hydratePhotos(back);
    const form = $("form", back);
    form.setAttribute("role", "dialog"); form.setAttribute("aria-modal", "true"); form.setAttribute("aria-label", opts.title || "Form");
    modalOpen(back, form);
    const close = () => { back.remove(); document.body.style.overflow = ""; };
    $$("[data-close]", back).forEach(b => b.addEventListener("click", close));
    back.addEventListener("click", e => { if (e.target === back) close(); });
    if (opts.onReady) opts.onReady(form);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const errBox = $(".form-error", form);
      errBox.hidden = true;
      const missing = $$("[required]", form).filter(el => !el.disabled && String(el.value).trim() === "")
        .map(el => { if (el.dataset.label) return el.dataset.label; const l = el.id && $("label[for='" + el.id + "']", form); return l ? l.textContent.replace(/\s*\*\s*$/, "") : el.name; });
      if (missing.length) {
        errBox.textContent = "Please fill in: " + missing.join(", ") + ".";
        errBox.hidden = false;
        return;
      }
      try {
        const ok = await opts.onSubmit(collect(form), form);
        if (ok !== false) close();
      } catch (err) {
        errBox.textContent = err.message || String(err);
        errBox.hidden = false;
        $(".sheet-body", form).scrollTop = 0;
      }
    });
  }

  // Puts Read label suggestions into blank fields of an open record form, with a note on top.
  function applyPrefill(form, prefill) {
    const filled = [];
    Object.keys(prefill.suggestions || {}).forEach(name => {
      const el = $$("[name]", form).find(x => x.name === name);
      if (!el || String(el.value).trim() !== "") return;
      const v = String(prefill.suggestions[name]);
      if (el.tagName === "SELECT" && !$$("option", el).some(o => o.value === v || o.textContent === v)) return;
      el.value = v;
      el.classList.add("ai-filled", "ai-unverified");
      filled.push(name);
    });
    const note = document.createElement("div");
    note.className = "ai-result";
    note.innerHTML = '<div><b>' + (filled.length ? "Read from the label: " + esc(filled.join(", ")) : "Nothing new could be read from the label") + '</b></div>' +
      (prefill.notes ? '<div class="meta">' + esc(prefill.notes) + '</div>' : "") +
      (filled.length ? '<div class="ai-warn">Check the outlined fields against the photo before saving, especially serial and model numbers.</div>' : "");
    $(".sheet-body", form).insertBefore(note, $(".sheet-body", form).children[1] || null);
  }

  // prefill (optional): { suggestions: { field: value }, notes, source } from Read label;
  // fills blank fields only, outlined so they can be checked before saving.
  function recordForm(type, id, prefill) {
    const T = TYPES[type];
    const editing = !!id;
    const rec = editing ? findRec(type, id) : {};
    const fields = state.schema[type].filter(f => (editing || !f.readOnly) && (isAdmin() || f.name !== "Status"));
    const values = {};
    fields.forEach(f => {
      values[f.name] = editing ? rec[f.name] : (f.name === "Status" ? "Active" : "");
    });
    const ai = AI_TYPES.indexOf(type) !== -1 && (isAdmin() || canEditItem(type, rec));
    openSheet({
      title: (editing ? "Edit " : "Add ") + T.one.toLowerCase(),
      submitLabel: editing ? "Save" : "Add",
      body: (ai ? aiBarHtml() : "") + fields.map(f => fieldHtml(f, values[f.name])).join(""),
      onReady: form => {
        $$("[data-combo]", form).forEach(wireCombo);
        if (prefill) applyPrefill(form, prefill);
        if (!ai) return;
        const thumb = $('[name="Thumbnail URL"]', form);
        // Species and plants: a free Wikimedia Commons photo fills a blank Thumbnail URL (link only).
        const onPhoto = (type === "species" || type === "plants") && thumb ? p => {
          if (thumb.value.trim()) return;
          thumb.value = p.url; thumb.classList.add("ai-filled");
        } : null;
        wireAiFill(form, type, () => { const l = $('[name="Vendor Link"], [name="Product Page"]', form); return l ? l.value.trim() : ""; }, { onPhoto: onPhoto });
      },
      onSubmit: async (vals, form) => {
        if (!(await checkListFields(vals, form, fields))) return false;
        if (editing) {
          const changed = {};
          Object.keys(vals).forEach(k => {
            const before = rec[k] === undefined || rec[k] === null ? "" : rec[k];
            if (String(vals[k]) !== String(before)) changed[k] = vals[k];
          });
          if (!Object.keys(changed).length) { toast("No changes"); return true; }
          return write("update", { table: type, id: id, values: changed }, "Saved");
        }
        return write("add", { table: type, values: vals }, T.one + " added");
      }
    });
  }

  // Searchable picker: one text field that filters a tappable list below it.
  // items: [{ value, label, sub, group, img, disabled, note }]
  // f.mode: "single" (pick one from the list), "free" (pick or type a new value),
  //         "multi" (pick several; chips show the choices)
  function comboHtml(f, items) {
    const id = "f_" + f.name.replace(/\W+/g, "_");
    const mode = f.mode || "single";
    let lastGroup = null;
    const opts = items.map(it => {
      let head = "";
      if (it.group && it.group !== lastGroup) { head = '<div class="combo-group">' + esc(it.group) + '</div>'; lastGroup = it.group; }
      const search = [it.label, it.value, it.sub, it.group].filter(Boolean).join(" ").toLowerCase();
      const thumb = f.noThumbs ? "" : photoHtml(it.img, "thumb", 160, String(it.value).split("-")[0]);
      return head + '<button type="button" class="combo-opt' + (it.disabled ? " is-off" : "") + '" role="option"' + (it.disabled ? ' disabled aria-disabled="true"' : "") + ' data-value="' + esc(it.value) + '" data-label="' + esc(it.label) + '" data-search="' + esc(search) + '">' +
        thumb +
        '<span class="body"><span class="title">' + esc(it.label) + '</span>' + (f.noThumbs && !it.sub ? "" : '<span class="sub">' + esc([f.noThumbs ? "" : it.value, it.sub].filter(Boolean).join(" · ")) + '</span>') + '</span>' +
        (it.note ? '<span class="pill">' + esc(it.note) + '</span>' : "") + '<span class="tick" aria-hidden="true">✓</span></button>';
    }).join("");
    return '<div class="field combo" data-combo data-mode="' + mode + '"' + (f.newLabel ? ' data-new-label="' + esc(f.newLabel) + '"' : "") + '>' +
      '<label for="' + id + '_q">' + esc(f.label || f.name) + (f.required ? ' <span class="req">*</span>' : "") + '</label>' +
      '<input type="hidden" name="' + esc(f.name) + '" data-label="' + esc(f.label || f.name) + '" value="' + esc(f.value || "") + '"' + (f.required ? " required" : "") + '>' +
      (mode === "multi" ? '<div class="chips"></div>' : "") +
      '<div class="combo-box"><input type="text" id="' + id + '_q" class="combo-input" role="combobox" aria-expanded="false" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="' + esc(f.placeholder || "Tap to choose or type to search") + '" value="' + esc(mode === "multi" ? "" : (f.value || "")) + '">' +
      '<button type="button" class="combo-clear" aria-label="Clear"' + (f.value && mode !== "multi" ? "" : " hidden") + '>' + ICONS.close + '</button></div>' +
      '<div class="combo-list" role="listbox" hidden>' + (mode === "free" ? '<div class="combo-new" hidden></div>' : "") + opts + '<div class="combo-empty"' + (opts ? " hidden" : "") + '>No matches</div></div>' +
    '</div>';
  }

  function wireCombo(root) {
    const mode = root.dataset.mode || "single";
    const hidden = $("input[type=hidden]", root);
    const input = $(".combo-input", root);
    const list = $(".combo-list", root);
    const clear = $(".combo-clear", root);
    const chips = $(".chips", root);
    const newRow = $(".combo-new", root);
    const opts = $$(".combo-opt", list);
    const groups = $$(".combo-group", list);
    const empty = $(".combo-empty", list);
    const picked = [];
    const open = () => { list.hidden = false; input.setAttribute("aria-expanded", "true"); };
    const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); };
    const filter = q => {
      q = q.trim().toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      opts.forEach(o => { o.hidden = !words.every(w => o.dataset.search.indexOf(w) !== -1); });
      groups.forEach(g => {
        let n = g.nextElementSibling, any = false;
        while (n && !n.classList.contains("combo-group")) { if (n.classList.contains("combo-opt") && !n.hidden) any = true; n = n.nextElementSibling; }
        g.hidden = !any;
      });
      const anyShown = opts.some(o => !o.hidden);
      if (newRow) {
        const exact = opts.some(o => o.dataset.label.toLowerCase() === q);
        newRow.hidden = !q || exact;
        newRow.textContent = "“" + input.value.trim() + "” " + (root.dataset.newLabel || "will be added as new");
      }
      empty.hidden = anyShown || (newRow && !newRow.hidden);
    };
    const renderChips = () => {
      chips.innerHTML = picked.map(v => {
        const o = opts.find(x => x.dataset.value === v);
        return '<span class="chip">' + esc(o ? o.dataset.label : v) + '<button type="button" data-chip="' + esc(v) + '" aria-label="Remove">' + ICONS.close + '</button></span>';
      }).join("");
      hidden.value = picked.join(",");
      opts.forEach(o => o.classList.toggle("on", picked.indexOf(o.dataset.value) !== -1));
    };
    // A multi picker can start with choices already made (value="A,B").
    if (mode === "multi" && hidden.value) { hidden.value.split(",").filter(Boolean).forEach(v => picked.push(v)); renderChips(); }
    const pick = o => {
      if (mode === "multi") {
        const i = picked.indexOf(o.dataset.value);
        if (i === -1) picked.push(o.dataset.value); else picked.splice(i, 1);
        renderChips();
        input.value = "";
        filter("");
        return;
      }
      hidden.value = mode === "free" ? o.dataset.label : o.dataset.value;
      input.value = o.dataset.label;
      opts.forEach(x => x.classList.toggle("on", x === o));
      clear.hidden = false;
      close();
      input.blur();
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    };
    if (mode !== "multi" && hidden.value) {
      const cur = opts.find(o => (mode === "free" ? o.dataset.label : o.dataset.value) === hidden.value);
      if (cur) cur.classList.add("on");
    }
    input.addEventListener("focus", () => { if (mode === "multi" || !hidden.value) { filter(input.value); open(); } });
    input.addEventListener("click", () => {
      if (mode !== "multi" && hidden.value) input.select();
      filter(mode !== "multi" && hidden.value && mode !== "free" ? "" : (mode === "free" ? "" : input.value));
      open();
    });
    input.addEventListener("input", () => {
      if (mode === "single") { hidden.value = ""; opts.forEach(x => x.classList.remove("on")); }
      if (mode === "free") {
        hidden.value = input.value.trim();
        opts.forEach(x => x.classList.toggle("on", x.dataset.label.toLowerCase() === input.value.trim().toLowerCase()));
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
      }
      clear.hidden = mode === "multi" || !input.value;
      filter(input.value);
      open();
    });
    input.addEventListener("keydown", e => {
      if (e.key === "Escape") close();
      if (e.key === "Enter") {
        e.preventDefault();
        const first = opts.find(o => !o.hidden && !o.disabled);
        if (first && !list.hidden && !(mode === "free" && newRow && !newRow.hidden)) pick(first);
        else if (mode === "free") { close(); input.blur(); }
      }
    });
    list.addEventListener("click", e => {
      if (newRow && e.target === newRow) { close(); input.blur(); return; }
      const o = e.target.closest(".combo-opt");
      if (o && !o.disabled) pick(o);
    });
    if (chips) chips.addEventListener("click", e => {
      const b = e.target.closest("[data-chip]");
      if (!b) return;
      picked.splice(picked.indexOf(b.dataset.chip), 1);
      renderChips();
    });
    clear.addEventListener("click", () => {
      hidden.value = ""; input.value = ""; clear.hidden = true;
      opts.forEach(x => x.classList.remove("on"));
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
      filter(""); open(); input.focus();
    });
    document.addEventListener("click", e => { if (!root.contains(e.target)) close(); }, true);
  }

  // Tanks (other than this one) where a piece of equipment is currently active.
  function equipmentElsewhere(itemId, tankId) {
    const seen = {}, out = [];
    state.data.assignments.filter(a => a["Item ID"] === itemId && a["Tank ID"] !== tankId && isActiveAssignment(a))
      .concat((state.otherAssignments || []).filter(a => a["Item ID"] === itemId && a["Tank ID"] !== tankId))
      .forEach(a => { if (!seen[a["Tank ID"]]) { seen[a["Tank ID"]] = true; out.push({ id: a["Tank ID"], name: a["Tank Name"] || tankName(a["Tank ID"]) }); } });
    return out;
  }

  // ---------- From an item's page: add it to a tank, upload or link a receipt ----------
  // Tanks this person can add items to (Admins: all; Editors: their tanks), not retired.
  const tanksICanAddTo = () => state.data.tanks.filter(t => !isRetired(t) && canEditTank(t["Tank ID"]))
    .sort((a, b) => String(a["Tank Name"]).localeCompare(String(b["Tank Name"])));
  function canAddItemToTank(type, r) {
    return ITEM_TYPES.indexOf(type) !== -1 && !isWishItem(r) && !isRetired(r) && tanksICanAddTo().length > 0;
  }
  // Admins: any item. Editors: species, equipment or plants currently in one of their tanks.
  function canItemReceipts(type, r) {
    if (!canReceipts() || !r) return false;
    if (isAdmin()) return true;
    const id = r[TYPES[type].id];
    return ITEM_TYPES.indexOf(type) !== -1 &&
      state.data.assignments.some(a => a["Item ID"] === id && isActiveAssignment(a) && canEditTank(a["Tank ID"]));
  }

  function itemToTankForm(type, id) {
    const r = findRec(type, id);
    if (!r) return;
    const T = TYPES[type];
    const tanks = tanksICanAddTo().map(t => {
      const there = state.data.assignments.some(a => a["Tank ID"] === t["Tank ID"] && a["Item ID"] === id && isActiveAssignment(a));
      return { value: t["Tank ID"], label: t["Tank Name"], sub: [t["Volume (gal)"] ? t["Volume (gal)"] + " gal" : "", t["Aquarium Type"]].filter(Boolean).join(" · "),
               disabled: there, note: there ? "In tank" : "" };
    });
    const elsewhere = type === "equipment" ? equipmentElsewhere(id, "") : [];
    openSheet({
      title: "Add to tank",
      submitLabel: "Add",
      body:
        '<p class="meta">' + esc(id + " " + T.title(r)) + '</p>' +
        comboHtml({ name: "Tank ID", label: "Tank", required: true, noThumbs: true, placeholder: "Tap to choose a tank" }, tanks) +
        fieldHtml({ name: "Date Added", type: "date" }, today()) +
        fieldHtml({ name: "Notes", type: "longtext" }, "") +
        (elsewhere.length ? '<p class="hint">Equipment can only be in one tank. It’s now in ' + esc(elsewhere.map(o => o.id + " " + o.name).join(", ")) + '; you’ll be asked to confirm moving it.</p>' : ""),
      onReady: form => $$("[data-combo]", form).forEach(wireCombo),
      onSubmit: vals => {
        const tankId = vals["Tank ID"];
        const payload = { table: "assignments", values: { "Tank ID": tankId, "Item ID": id, "Date Added": vals["Date Added"], "Notes": vals["Notes"] } };
        const other = type === "equipment" ? equipmentElsewhere(id, tankId) : [];
        if (!other.length) return write("add", payload, "Added to " + tankName(tankId));
        const label = id + " " + T.title(r);
        const where = other.map(o => o.id + " " + o.name).join(", ");
        if (!other.every(o => canEditTank(o.id))) throw new Error(label + " is in " + where + ", which you don’t manage. Ask an admin to move it.");
        confirmMoveSheet([{ label: label, where: where }], tankId, payload);
        return false;
      }
    });
  }

  // Links receipts that are already uploaded to this item.
  function itemLinkReceiptForm(type, id) {
    const r = findRec(type, id);
    if (!r) return;
    const linked = new Set(receiptsForRecord(id).map(x => x["Receipt ID"]));
    const items = state.receipts.filter(x => !isRetired(x))
      .sort((x, y) => receiptSortKey(y).localeCompare(receiptSortKey(x)))
      .map(x => ({ value: x["Receipt ID"], label: receiptTitle(x), sub: [x["Receipt ID"], x["Vendor"], money(x["Total"])].filter(Boolean).join(" · "),
                   disabled: linked.has(x["Receipt ID"]), note: linked.has(x["Receipt ID"]) ? "Linked" : "" }));
    openSheet({
      title: "Link receipts",
      submitLabel: "Link",
      body: '<p class="meta">' + esc(id + " " + TYPES[type].title(r)) + '</p>' +
        (items.length ? comboHtml({ name: "receiptIds", label: "Receipts", mode: "multi", required: true, noThumbs: true, placeholder: "Search by name, store, date or total" }, items)
                      : '<p class="empty">No receipts uploaded yet. Use Upload instead.</p>'),
      onReady: form => $$("[data-combo]", form).forEach(wireCombo),
      onSubmit: async vals => {
        const ids = String(vals.receiptIds || "").split(",").filter(Boolean);
        if (!ids.length) throw new Error("Choose at least one receipt.");
        // One link call per receipt, then reload the data once.
        busy(true);
        try {
          for (const rid of ids) await api("linkReceipt", { id: rid, itemIds: [id] });
          toast(ids.length === 1 ? "Receipt linked" : ids.length + " receipts linked");
          refreshInBackground();
          return true;
        } catch (err) {
          if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) return authStop(err);
          throw err;
        } finally { busy(false); }
      }
    });
  }

  function assignmentForm(tankId) {
    const inTank = new Set(tankAssignments(tankId, true).map(a => a["Item ID"]));
    const items = [];
    ITEM_TYPES.forEach(ty => {
      const T = TYPES[ty];
      // Items already in this tank stay in the list, greyed out and labelled, so nobody thinks they're missing.
      state.data[ty].filter(r => !isWishItem(r) && (!isRetired(r) || inTank.has(r[T.id])))
        .sort((a, b) => String(T.title(a)).localeCompare(String(T.title(b))))
        .forEach(r => {
          const there = inTank.has(r[T.id]);
          const other = (!there && ty === "equipment") ? equipmentElsewhere(r[T.id], tankId) : [];
          items.push({ value: r[T.id], label: T.title(r), sub: T.sub(r), group: T.label, img: T.img(r),
                       disabled: there, note: there ? "In tank" : (other.length ? "In " + other.map(o => o.name).join(", ") : "") });
        });
    });
    openSheet({
      title: "Add to " + tankName(tankId),
      submitLabel: "Add",
      body:
        comboHtml({ name: "Item IDs", label: "Items", mode: "multi", required: true, placeholder: "Tap to choose, or type to search. Pick as many as you like" }, items) +
        fieldHtml({ name: "Date Added", type: "date" }, today()) +
        fieldHtml({ name: "Notes", type: "longtext" }, "") +
        '<p class="hint">The date and notes are saved on every item you pick. Only admins can add new species, equipment or plants to the lists. Ask Chris if something is missing.</p>',
      onReady: form => $$("[data-combo]", form).forEach(wireCombo),
      onSubmit: vals => {
        const ids = String(vals["Item IDs"] || "").split(",").map(x => x.trim()).filter(Boolean);
        if (!ids.length) throw new Error("Choose at least one item.");
        const payload = { tankId: tankId, itemIds: ids, dateAdded: vals["Date Added"], notes: vals["Notes"] };
        const done = (n, moved) => (n === 1 ? "1 item added to " : n + " items added to ") + tankName(tankId) + (moved ? " (" + moved + " moved)" : "");
        // Only equipment is limited to one tank; species and plants can be in several tanks.
        const moves = [], blocked = [];
        ids.forEach(id => {
          if (itemType(id) !== "equipment") return;
          const other = equipmentElsewhere(id, tankId);
          if (!other.length) return;
          const label = id + " " + TYPES.equipment.title(findRec("equipment", id) || {});
          const where = other.map(o => o.id + " " + o.name).join(", ");
          if (!other.every(o => canEditTank(o.id))) blocked.push(label + " is in " + where + ", which you don’t manage. Ask an admin to move it.");
          else moves.push({ label: label, where: where });
        });
        // Nothing is added if any item can't be.
        if (blocked.length) throw new Error("Nothing was added. " + blocked.join(" "));
        if (!moves.length) return write("addAssignments", payload, done(ids.length, 0));
        confirmMoveSheet(moves, tankId, payload, done(ids.length, moves.length));
        return false;   // keep the form open underneath until the move is confirmed
      }
    });
  }

  // Equipment can only be in one tank: confirm taking it out of the other tank first.
  // moves: [{ label, where }]. payload is an "addAssignments" request (tank page) or an "add" request (item page).
  function confirmMoveSheet(moves, tankId, payload, successMsg) {
    const many = payload.itemIds !== undefined;
    const date = fmtDate(many ? payload.dateAdded : payload.values["Date Added"]) || "today";
    const list = moves.length === 1
      ? '<p><b>' + esc(moves[0].label) + '</b> is currently in <b>' + esc(moves[0].where) + '</b>.</p>'
      : '<p>This equipment is currently in another tank:</p><ul class="move-list">' +
        moves.map(m => '<li><b>' + esc(m.label) + '</b>, in ' + esc(m.where) + '</li>').join("") + '</ul>';
    openSheet({
      title: "Move equipment?",
      submitLabel: moves.length === 1 ? "Yes, move it" : "Yes, move them",
      body: list +
        '<p>Remove ' + (moves.length === 1 ? "it" : "them") + ' from ' + (moves.length === 1 ? esc(moves[0].where) : "those tanks") +
        ' (marked inactive, Date Removed ' + esc(date) + ') and add ' + (many ? "everything you picked" : "it") + ' to <b>' + esc(tankId + " " + tankName(tankId)) + '</b>?</p>',
      onSubmit: async () => {
        const ok = await write(many ? "addAssignments" : "add", Object.assign({ confirmMove: true }, payload), successMsg || "Moved to " + tankName(tankId));
        $$(".sheet-backdrop").forEach(b => b.remove()); document.body.style.overflow = "";
        return ok;
      }
    });
  }

  function removeAssignmentForm(row, tankId, itemId) {
    const ty = itemType(itemId);
    const r = ty ? findRec(ty, itemId) : null;
    openSheet({
      title: "Remove from tank",
      submitLabel: "Remove",
      danger: true,
      body: '<p>Remove <b>' + esc(r ? TYPES[ty].title(r) : itemId) + '</b> from <b>' + esc(tankName(tankId)) + '</b>? It stays in the history with the date below.</p>' +
        fieldHtml({ name: "Date Removed", type: "date", required: true }, today()),
      onSubmit: vals => write("removeAssignment", { key: { row: row, tankId: tankId, itemId: itemId }, date: vals["Date Removed"] }, "Removed from tank")
    });
  }

  function paramForm(tankId, row) {
    const editing = row !== undefined;
    const rec = editing ? state.data.waterParameters.find(p => p._row === row) : { "Tank ID": tankId };
    if (!rec) { toast("That parameter changed. Refresh and try again.", true); return; }
    const fields = state.schema.waterParameters.filter(f => f.name !== "Tank ID" && f.name !== "Test Type ID");
    openSheet({
      title: (editing ? "Edit " : "Add ") + "water parameter",
      submitLabel: editing ? "Save" : "Add",
      body: '<p class="meta">' + esc(tankName(rec["Tank ID"])) + '</p>' +
        fields.map(f => fieldHtml(f, rec[f.name], { readOnly: editing && f.name === "Parameter" })).join(""),
      onReady: form => $$("[data-combo]", form).forEach(wireCombo),
      onSubmit: async (vals, form) => {
        if (!editing && !(await checkListFields(vals, form, fields))) return false;
        if (editing) {
          const changed = {};
          Object.keys(vals).forEach(k => { if (String(vals[k]) !== String(rec[k] === undefined ? "" : rec[k])) changed[k] = vals[k]; });
          if (!Object.keys(changed).length) { toast("No changes"); return true; }
          return write("update", { table: "waterParameters", key: { row: rec._row, tankId: rec["Tank ID"], parameter: rec["Parameter"] }, values: changed });
        }
        vals["Tank ID"] = tankId;
        return write("add", { table: "waterParameters", values: vals }, "Parameter added");
      }
    });
  }

  function retireForm(type, id) {
    const r = findRec(type, id);
    openSheet({
      title: "Retire " + TYPES[type].one.toLowerCase(),
      submitLabel: "Retire",
      danger: true,
      body: '<p>Mark <b>' + esc(TYPES[type].title(r)) + '</b> (' + esc(id) + ') as Retired? It stays in the sheet and history; it just stops showing as active. Nothing is deleted.</p>',
      onSubmit: () => write("retire", { table: type, id: id }, "Retired")
    });
  }

  // Permanent delete (admins). Lists what goes with the record, from the data the app already has.
  function deleteRecordForm(type, id) {
    const r = findRec(type, id);
    if (!r) return;
    const n = (k, v) => v ? "<li>" + v + " " + k + "</li>" : "";
    const isId = (row, col) => String(row[col] || "").trim() === id;
    let also = "";
    if (type === "tanks") {
      also = n("tank assignment rows (current and past items)", state.data.assignments.filter(a => isId(a, "Tank ID")).length) +
        n("target ranges", (state.data.waterParameters || []).filter(a => isId(a, "Tank ID")).length) +
        n("water test sessions (and their readings)", state.waterSessions.filter(a => isId(a, "Tank ID")).length) +
        n("water changes", state.waterChanges.filter(a => isId(a, "Tank ID")).length) +
        n("receipt links", state.receiptLinks.filter(a => isId(a, "Item ID")).length) +
        n("users' tank lists (the tank is taken off)", (state.users || []).filter(u => u.tanks.indexOf(id) !== -1).length) +
        n("receipt item lines", (state.receiptLines || []).filter(l => l["Record ID"] === id).length) +
        n("treatments (and their doses)", (state.treatments || []).filter(t => t["Tank ID"] === id).length);
    } else {
      const ph = state.photos.filter(p => p["Item ID"] === id).length;
      also = n("tank assignment rows (current and past)", state.data.assignments.filter(a => isId(a, "Item ID")).length) +
        n("receipt links", state.receiptLinks.filter(a => isId(a, "Item ID")).length) +
        n("wishes (and their compatibility checks)", state.wishes.filter(w => w["Item ID"] === id).length) +
        n("photos (files moved to Drive trash)", ph) +
        n("price tracker prices (and its price item)", (() => { const pi = state.priceItems.find(x => x["Record ID"] === id); return pi ? state.prices.filter(x => x["Price Item ID"] === pi["Price Item ID"]).length || 1 : 0; })()) +
        n("receipt item lines", (state.receiptLines || []).filter(l => l["Record ID"] === id).length) +
        n("treatments (and their doses)", type === "medications" ? (state.treatments || []).filter(t => t["Product ID"] === id).length : 0) +
        (driveId(r["Thumbnail URL"]) && !ph ? "<li>its uploaded list picture (moved to Drive trash)</li>" : "");
    }
    openSheet({
      title: "Delete " + TYPES[type].one.toLowerCase(),
      submitLabel: "Delete permanently",
      danger: true,
      body: '<p>Permanently delete <b>' + esc(TYPES[type].title(r)) + '</b> (' + esc(id) + ')? This can’t be undone from the app.</p>' +
        (also ? '<p>This also deletes:</p><ul>' + also + '</ul>' : '<p>Nothing else refers to it.</p>') +
        '<p class="hint">Use Retire instead to hide it but keep its history. The delete is noted in the Change Log.</p>',
      onSubmit: async () => {
        const ok = await write("deleteRecord", { table: type, id: id }, TYPES[type].one + " deleted");
        location.hash = type === "tanks" ? "#/tanks" : "#/browse";
        return ok;
      }
    });
  }

  function deleteReceiptForm(id) {
    const r = findReceipt(id);
    if (!r) return;
    const links = receiptLinksFor(id).length;
    openSheet({
      title: "Delete receipt",
      submitLabel: "Delete permanently",
      danger: true,
      body: '<p>Permanently delete <b>' + esc(receiptTitle(r)) + '</b> (' + esc(id) + ')? This can’t be undone from the app.</p>' +
        '<ul><li>The photo moves to the Drive trash (Google keeps it 30 days).</li>' +
        (links ? '<li>Its ' + links + ' link' + (links === 1 ? "" : "s") + ' to records ' + (links === 1 ? "is" : "are") + ' deleted.</li>' : "") + '</ul>' +
        '<p class="hint">Use Retire instead to hide it but keep it. The delete is noted in the Change Log.</p>',
      onSubmit: async () => {
        const ok = await write("deleteReceipt", { id: id }, "Receipt deleted");
        location.hash = "#/receipts";
        return ok;
      }
    });
  }

  function userForm(id) {
    const editing = !!id;
    const u = editing ? state.users.find(x => x.id === id) : { id: "", email: "", name: "", role: "Viewer", tanks: [], active: true };
    if (!u) { toast("That user changed. Refresh and try again.", true); return; }
    const isMe = editing && state.me && u.id === state.me.id;
    const tanks = state.data.tanks.slice().sort((a, b) => String(a["Tank Name"]).localeCompare(String(b["Tank Name"])));
    const tankBoxes = tanks.map(t => '<label class="check"><input type="checkbox" name="tank:' + esc(t["Tank ID"]) + '"' +
      (u.tanks.indexOf(t["Tank ID"]) !== -1 ? " checked" : "") + '> ' + esc(t["Tank Name"]) + ' <span class="meta">' + esc(t["Tank ID"]) + '</span></label>').join("");
    openSheet({
      title: editing ? "Edit user" : "Add user",
      body:
        (editing ? '<div class="field"><label>User ID</label><input type="text" value="' + esc(u.id) + '" readonly></div>' : "") +
        '<div class="field"><label for="f_email">Google account email <span class="req">*</span></label><input type="email" id="f_email" name="email" value="' + esc(u.email) + '" required' + (isMe ? " readonly" : "") + ' autocomplete="off">' +
          (editing && !isMe ? '<div class="hint">Changing the email keeps this person’s User ID and history.</div>' : "") + '</div>' +
        '<div class="field"><label for="f_name">Name</label><input type="text" id="f_name" name="name" value="' + esc(u.name) + '"></div>' +
        '<div class="field"><label for="f_role">Role</label><select id="f_role" name="role">' +
          ["Admin", "Editor", "Viewer"].map(r => '<option' + (r === u.role ? " selected" : "") + '>' + r + '</option>').join("") + '</select>' +
          '<div class="hint">Admin: everything. Editor: sees, edits + logs tests on assigned tanks. Viewer: sees + logs tests on assigned tanks.</div></div>' +
        '<div class="field" id="tank-picks"' + (u.role === "Admin" ? " hidden" : "") + '><label>Assigned tanks</label>' +
          '<div class="hint" id="tank-picks-hint">' + (u.role === "Editor" ? "Can see and edit these tanks and log water tests on them." : "Can see these tanks and log water tests on them.") + '</div>' + tankBoxes + '</div>' +
        '<div class="field"><label class="check"><input type="checkbox" name="active"' + (u.active ? " checked" : "") + '> Active (can sign in)</label></div>',
      onReady: form => {
        $("#f_role", form).addEventListener("change", e => {
          $("#tank-picks", form).hidden = e.target.value === "Admin";
          $("#tank-picks-hint", form).textContent = e.target.value === "Editor" ? "Can see and edit these tanks and log water tests on them." : "Can see these tanks and log water tests on them.";
        });
      },
      onSubmit: async (vals, form) => {
        const picked = $$("input[name^='tank:']", form).filter(el => el.checked).map(el => el.name.slice(5));
        const payload = { id: editing ? u.id : undefined, email: isMe ? u.email : vals.email, name: vals.name, role: vals.role, tanks: picked, active: vals.active };
        busy(true);
        try {
          const res = await api("saveUser", { user: payload });
          state.users = res.users;
          render();
          toast("User saved");
          return true;
        } catch (err) {
          if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) return authStop(err);
          throw err;
        } finally {
          busy(false);
        }
      }
    });
  }

  // ------------------------------------------------------------------
  // Receipts (admins + editors; admins edit and assign)
  // ------------------------------------------------------------------
  const RECEIPT_LINK_TYPES = ["tanks", "species", "equipment", "plants", "medications"];

  function recordOf(id) {
    for (const t of RECEIPT_LINK_TYPES) { const r = findRec(t, id); if (r) return { type: t, rec: r }; }
    return null;
  }
  const findReceipt = id => state.receipts.find(r => r["Receipt ID"] === id);
  const isActiveLink = l => l["Active"] === true && !l["Date Unlinked"];
  const receiptLinksFor = rid => state.receiptLinks.filter(l => l["Receipt ID"] === rid && isActiveLink(l));
  const receiptsForRecord = id => state.receiptLinks.filter(l => l["Item ID"] === id && isActiveLink(l))
    .map(l => findReceipt(l["Receipt ID"])).filter(Boolean);
  const receiptTitle = r => String(r["File Name"] || r["Receipt ID"]).replace(/\.(jpe?g|png|webp|gif|heic|heif)$/i, "");
  function money(v) {
    if (v === "" || v === undefined || v === null) return "";
    const n = Number(String(v).replace(/[$,]/g, ""));
    return isNaN(n) ? String(v) : n.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }
  // Accepts a User ID (USR-1) or, for older rows, an email.
  function personName(who) {
    if (!who) return "";
    if (state.me && (who === state.me.id || who === state.me.email)) return "You";
    const p = (state.people || []).find(x => x.id === who);
    if (p) return p.name;
    const u = (state.users || []).find(x => x.email === who || x.id === who);
    return u ? (u.name || u.email) : who;
  }
  const receiptSortKey = r => (r["Purchase Date"] || "") + " " + (r["Uploaded At"] || "");

  function receiptRow(r) {
    const n = receiptLinksFor(r["Receipt ID"]).length;
    return '<a class="list-item receipt-row ' + (isRetired(r) ? "dim" : "") + '" href="#/receipt/' + encodeURIComponent(r["Receipt ID"]) + '">' +
      '<span class="thumb rc">' + ICONS.receipts + '</span>' +
      '<div class="body"><div class="title">' + esc(receiptTitle(r)) + '</div>' +
      '<div class="sub">' + esc([r["Vendor"], r["Purchase Date"] ? fmtDate(r["Purchase Date"]) : "", money(r["Total"])].filter(Boolean).join(" · ")) + '</div></div>' +
      (isRetired(r) ? '<span class="pill retired">Retired</span>' : n ? '<span class="pill">' + n + ' linked</span>' : '<span class="pill warn">Unassigned</span>') +
      '</a>';
  }

  // addType: an item's type when this person may add receipts to it from its page (buttons in the heading).
  function receiptsSection(id, addType) {
    if (!canReceipts()) return "";
    const list = receiptsForRecord(id).sort((x, y) => receiptSortKey(y).localeCompare(receiptSortKey(x)));
    const btns = addType ? '<div class="head-btns"><button class="btn small" data-act="item-upload-receipt" data-type="' + addType + '" data-id="' + esc(id) + '">' + ICONS.plus + 'Upload</button>' +
      '<button class="btn small" data-act="item-link-receipt" data-type="' + addType + '" data-id="' + esc(id) + '">Link</button></div>' : "";
    return '<div class="section"><div class="section-head"><h3>Receipts (' + list.length + ')</h3>' + btns + '</div>' +
      '<div class="card list">' + (list.map(receiptRow).join("") || '<div class="empty">None</div>') + '</div></div>';
  }

  function receiptRows() {
    const q = state.receiptQuery.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    return state.receipts
      .filter(r => state.showRetiredReceipts || !isRetired(r))
      .filter(r => state.receiptFilter !== "unassigned" || receiptLinksFor(r["Receipt ID"]).length === 0)
      .filter(r => {
        if (!words.length) return true;
        const linked = receiptLinksFor(r["Receipt ID"]).map(l => { const x = recordOf(l["Item ID"]); return l["Item ID"] + " " + (x ? TYPES[x.type].title(x.rec) : ""); }).join(" ");
        const hay = [r["Receipt ID"], r["File Name"], r["Vendor"], r["Notes"], r["Uploaded By"], r["Purchase Date"], r["Total"], linked].join(" ").toLowerCase();
        return words.every(w => hay.indexOf(w) !== -1);
      })
      .sort((x, y) => receiptSortKey(y).localeCompare(receiptSortKey(x)));
  }
  function viewReceipts() {
    const rows = receiptRows();
    const unassigned = state.receipts.filter(r => !isRetired(r) && receiptLinksFor(r["Receipt ID"]).length === 0).length;
    return {
      title: "Receipts",
      keepScroll: true,
      html:
        '<div class="actions" style="margin:0 0 12px"><button class="btn primary" data-act="upload-receipt">' + ICONS.camera + 'Upload receipt</button></div>' +
        '<div class="segmented">' +
          '<button class="' + (state.receiptFilter === "all" ? "on" : "") + '" data-act="receipt-filter" data-f="all">All</button>' +
          '<button class="' + (state.receiptFilter === "unassigned" ? "on" : "") + '" data-act="receipt-filter" data-f="unassigned">Unassigned (' + unassigned + ')</button>' +
        '</div>' +
        '<input class="search" type="search" placeholder="Search receipts…" value="' + esc(state.receiptQuery) + '" data-act="receipt-search">' +
        (isAdmin() ? '<div class="toggle-row"><label class="check" style="padding:0"><input type="checkbox" data-act="toggle-retired-receipts" ' + (state.showRetiredReceipts ? "checked" : "") + '> Show retired</label></div>' : "") +
        '<div class="card list">' + (rows.map(receiptRow).join("") || '<div class="empty">' + (state.receipts.length ? "Nothing found." : "No receipts yet.") + '</div>') + '</div>'
    };
  }

  function viewReceipt(id) {
    const r = findReceipt(id);
    if (!r) return { title: "Receipt", back: true, html: '<div class="empty">That receipt wasn\'t found.</div>' };
    const links = receiptLinksFor(id);
    const cached = state.photoCache[id];
    const pdf = /\.pdf$/i.test(String(r["File Name"] || ""));
    const photo = '<div class="card receipt-photo" data-photo="' + esc(id) + '">' +
      (cached && cached.url ? receiptFileHtml(id, r, cached) :
       cached && cached.error ? '<div class="empty">' + esc(cached.error) + '</div>' :
       '<div class="photo-loading"><div class="spinner"></div><span>' + (pdf ? "Loading PDF…" : "Loading photo…") + '</span></div>') + '</div>';
    const hero = '<div class="card hero"><h2>' + esc(receiptTitle(r)) + '</h2>' +
      '<div class="meta">' + esc([id, r["Vendor"], money(r["Total"])].filter(Boolean).join(" · ")) + '</div>' +
      (isRetired(r) ? '<div class="counts"><span class="pill retired">Retired</span></div>' : links.length ? "" : '<div class="counts"><span class="pill warn">Unassigned</span></div>') +
      (isAdmin() ? '<div class="actions">' +
        '<button class="btn primary" data-act="link-receipt" data-id="' + esc(id) + '">' + ICONS.plus + 'Assign to records</button>' +
        '<button class="btn" data-act="edit-receipt" data-id="' + esc(id) + '">Edit</button>' +
        (isRetired(r) ? '<button class="btn" data-act="restore-receipt" data-id="' + esc(id) + '">Restore</button>'
                      : '<button class="btn danger" data-act="retire-receipt" data-id="' + esc(id) + '">Retire</button>') +
        '<button class="btn danger" data-act="delete-receipt" data-id="' + esc(id) + '">Delete</button>' +
        '</div>' : "") + '</div>';
    const linked = '<div class="section"><div class="section-head"><h3>Linked to (' + links.length + ')</h3></div><div class="card list">' +
      (links.map(l => {
        const x = recordOf(l["Item ID"]);
        const href = x ? (x.type === "tanks" ? "#/tank/" : "#/item/" + x.type + "/") + encodeURIComponent(l["Item ID"]) : "";
        return '<div class="list-item"' + (href ? ' data-act="go" data-href="' + esc(href) + '"' : "") + '>' +
          '<span class="thumb">' + esc(String(l["Item ID"]).split("-")[0]) + '</span>' +
          '<div class="body"><div class="title">' + esc(x ? TYPES[x.type].title(x.rec) : l["Item ID"]) + '</div>' +
          '<div class="sub">' + esc([l["Item ID"], x ? TYPES[x.type].one : "", l["Date Linked"] ? "Linked " + fmtDate(l["Date Linked"]) : ""].filter(Boolean).join(" · ")) + '</div></div>' +
          (isAdmin() ? '<button class="btn small danger" data-act="unlink-receipt" data-row="' + l._row + '" data-id="' + esc(id) + '" data-item="' + esc(l["Item ID"]) + '">Remove</button>' : "") +
          '</div>';
      }).join("") || '<div class="empty">' + (isAdmin() ? "Not linked yet. Tap “Assign to records”." : "Not linked yet. An admin will assign it.") + '</div>') +
      '</div></div>';
    const details = '<div class="section"><div class="section-head"><h3>Details</h3></div><div class="card kv">' +
      [["Vendor", esc(r["Vendor"])], ["Purchase date", esc(fmtDate(r["Purchase Date"]))], ["Total", esc(money(r["Total"]))],
       ["Notes", esc(r["Notes"])], ["File name", esc(r["File Name"])], ["Uploaded by", esc(personName(r["Uploaded By"]))],
       ["Uploaded", esc(r["Uploaded At"] ? fmtDate(String(r["Uploaded At"]).slice(0, 10)) + " " + String(r["Uploaded At"]).slice(11) : "")],
       ["Receipt ID", esc(id)]]
        .concat(isAdmin() && r["Photo Link"] ? [["Drive", '<a href="' + esc(r["Photo Link"]) + '" target="_blank" rel="noopener">Open in Drive</a>']] : [])
        .filter(p => p[1] !== "").map(p => '<div class="k">' + p[0] + '</div><div>' + p[1] + '</div>').join("") +
      '</div></div>';
    return { title: receiptTitle(r), back: true, html: photo + hero + receiptLinesSection(r) + linked + details, after: () => loadReceiptPhoto(id) };
  }

  async function loadReceiptPhoto(id) {
    if (state.photoCache[id]) return;
    state.photoCache[id] = { loading: true };
    try {
      const res = await api("receiptPhoto", { id: id });
      const bin = atob(res.image.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const mime = res.image.mimeType || "image/jpeg";
      state.photoCache[id] = { url: URL.createObjectURL(new Blob([bytes], { type: mime })), mime: mime };
    } catch (err) {
      if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) { delete state.photoCache[id]; handleError(err); return; }
      state.photoCache[id] = { error: err.message || "The photo couldn't be loaded." };
    }
    const box = $('[data-photo="' + CSS.escape(id) + '"]');
    if (box) {
      const c = state.photoCache[id];
      box.innerHTML = c.url ? receiptFileHtml(id, findReceipt(id) || {}, c) : '<div class="empty">' + esc(c.error) + '</div>';
    }
  }

  // The receipt's photo (tap to zoom), or for a PDF a card that opens it in the phone's PDF viewer.
  function receiptFileHtml(id, r, c) {
    if (c.mime === "application/pdf") {
      return '<a class="receipt-pdf" href="' + c.url + '" target="_blank" rel="noopener">' + ICONS.receipts +
        '<span class="body"><span class="title">' + esc(r["File Name"] || "Receipt PDF") + '</span><span class="sub">PDF · tap to open</span></span>' +
        '<span class="btn small primary">Open PDF</span></a>';
    }
    return '<img alt="Receipt photo" src="' + c.url + '" data-act="zoom-photo" data-id="' + esc(id) + '">';
  }

  function zoomPhoto(id) {
    const c = state.photoCache[id];
    if (!c || !c.url) return;
    const v = document.createElement("div");
    v.className = "photo-viewer";
    v.innerHTML = '<button type="button" class="icon-btn" aria-label="Close">' + ICONS.close + '</button><div class="pv-scroll"><img alt="Receipt photo" src="' + c.url + '"></div>';
    document.body.appendChild(v);
    document.body.style.overflow = "hidden";
    v.setAttribute("role", "dialog"); v.setAttribute("aria-modal", "true"); v.setAttribute("aria-label", "Receipt photo");
    modalOpen(v);
    const img = $("img", v);
    img.addEventListener("click", () => v.classList.toggle("full"));
    $("button", v).addEventListener("click", () => { v.remove(); document.body.style.overflow = ""; });
  }

  // A PDF file as { data (base64), mimeType } for upload.
  function readPdf(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve({ data: String(fr.result).replace(/^data:[^,]*,/, ""), mimeType: "application/pdf", preview: "" });
      fr.onerror = () => reject(new Error("That PDF couldn't be read."));
      fr.readAsDataURL(file);
    });
  }

  // Shrinks a photo to a sensible size and converts it to JPEG.
  function prepareImage(file, maxDim, quality) {
    maxDim = maxDim || 2000; quality = quality || 0.82;
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve({ preview: dataUrl, data: dataUrl.split(",")[1], mimeType: "image/jpeg" });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file can't be read as a photo. Try a JPG or PNG.")); };
      img.src = url;
    });
  }

  const vendorItems = () => state.vendors.slice().sort((x, y) => x.localeCompare(y)).map(v => ({ value: v, label: v }));
  const defaultReceiptName = (date, vendor) => [date || today(), vendor, "receipt"].filter(Boolean).join(" ");

  // ---------- Item photos (species, equipment, plants) ----------
  // Several photos per item (e.g. the whole filter, its serial label). Admins add, caption,
  // remove and pick the list picture; everyone signed in can view them.
  const PHOTO_TYPES = ["species", "equipment", "plants"];
  const photosFor = id => state.photos.filter(p => p["Item ID"] === id)
    .sort((a, b) => String(a["Added At"]).localeCompare(String(b["Added At"])));
  function photosSection(type, r) {
    if (PHOTO_TYPES.indexOf(type) === -1 || !state.photosOn) return "";
    const id = r[TYPES[type].id];
    const list = photosFor(id);
    if (!list.length && !isAdmin()) return "";
    const tiles = list.map(p =>
      '<button type="button" class="photo-tile" data-act="open-photo" data-id="' + esc(p["Photo ID"]) + '">' +
        photoHtml(p["Photo URL"], "tile-img", 400, "") +
        (String(r["Thumbnail URL"] || "") === String(p["Photo URL"]) ? '<span class="pill good tile-pill">List picture</span>' : "") +
        (p["Caption"] ? '<span class="tile-cap">' + esc(p["Caption"]) + '</span>' : "") +
      '</button>').join("");
    return '<div class="section"><div class="section-head"><h3>Photos (' + list.length + ')</h3>' +
      (isAdmin() ? '<button class="btn small" data-act="add-photo" data-type="' + type + '" data-id="' + esc(id) + '">' + ICONS.plus + 'Add</button>' : "") + '</div>' +
      (tiles ? '<div class="photo-grid">' + tiles + '</div>' : '<div class="card"><div class="empty">No photos yet. Add the whole item, its label (serial / model), the box…</div></div>') + '</div>';
  }

  function addPhotoForm(type, id) {
    const r = findRec(type, id);
    if (!r) return;
    let image = null;
    openSheet({
      title: "Add photo",
      submitLabel: "Add photo",
      body:
        '<p class="meta">' + esc(id + " " + TYPES[type].title(r)) + '</p>' +
        '<div class="field"><label>Photo <span class="req">*</span></label>' + photoPickerHtml("f_iphoto") + '</div>' +
        '<div class="field"><label for="f_caption">Caption <span class="opt">optional</span></label>' +
          '<input type="text" id="f_caption" name="caption" maxlength="100" placeholder="e.g. Serial label, Overall, Box" autocomplete="off"></div>' +
        '<div class="field"><label class="check"><input type="checkbox" name="useAsListPicture"> Use as list picture</label></div>',
      onReady: form => {
        // Labels need detail to stay readable, so photos are kept larger than receipts.
        const pick = wirePhotoPicker(form, "f_iphoto", async f => {
          pick.status("Preparing photo…");
          try { image = await prepareImage(f, 2400, 0.88); pick.preview(image.preview); pick.status(""); }
          catch (err) { image = null; pick.preview(""); pick.status(""); toast(err.message, true); }
        });
      },
      onSubmit: async vals => {
        if (!image) throw new Error("Take or choose a photo first.");
        return write("addItemPhoto", { itemId: id, photo: { data: image.data, mimeType: image.mimeType },
                                       caption: vals.caption, useAsListPicture: !!vals.useAsListPicture }, "Photo added");
      }
    });
  }

  function photoViewer(photoId) {
    const p = state.photos.find(x => x["Photo ID"] === photoId);
    if (!p) return;
    const type = p["Item Type"], itemId = p["Item ID"];
    const r = findRec(type, itemId);
    const isList = !!r && String(r["Thumbnail URL"] || "") === String(p["Photo URL"]);
    const admin = isAdmin();
    openSheet({
      title: p["Caption"] || "Photo",
      submitLabel: admin ? "Save caption" : "Close",
      noCancel: !admin,
      body:
        '<div class="viewer-wrap">' + photoHtml(p["Photo URL"], "viewer-img", 1600, "") + '</div>' +
        '<p class="meta">' + esc([itemId + (r ? " " + TYPES[type].title(r) : ""), p["Added At"] ? "Added " + fmtDate(String(p["Added At"]).slice(0, 10)) : ""].filter(Boolean).join(" · ")) + '</p>' +
        (admin
          ? '<div class="field"><label for="f_caption">Caption</label><input type="text" id="f_caption" name="caption" maxlength="100" value="' + esc(p["Caption"] || "") + '" autocomplete="off"></div>' +
            '<div class="actions">' +
              (isList ? '<span class="pill good">List picture</span>' : '<button type="button" class="btn small" data-photo-list>Use as list picture</button>') +
              (type === "equipment" ? '<button type="button" class="btn small ai-btn" data-photo-read>' + ICONS.sparkle + '<span>Read label</span></button>' +
                '<button type="button" class="btn small" data-read-cancel hidden>Cancel</button>' : "") +
              '<button type="button" class="btn small danger" data-photo-remove>Remove</button>' +
              '<button type="button" class="btn small danger" data-photo-delete>Delete</button>' +
            '</div><div class="ai-result" hidden></div>'
          : (p["Caption"] ? '<p>' + esc(p["Caption"]) + '</p>' : "")),
      onReady: form => {
        if (!admin) return;
        const close = () => { const b = $("[data-close]", form); if (b) b.click(); };
        const box = $(".ai-result", form);
        const listBtn = $("[data-photo-list]", form);
        if (listBtn) listBtn.addEventListener("click", async () => {
          listBtn.disabled = true;
          try { await write("setListPhoto", { photoId: photoId }, "List picture set"); close(); }
          catch (err) { listBtn.disabled = false; toast(err.message, true); }
        });
        $("[data-photo-remove]", form).addEventListener("click", () => {
          close();
          openSheet({
            title: "Remove photo", submitLabel: "Remove", danger: true,
            body: '<p>Remove this photo' + (p["Caption"] ? ' (<b>' + esc(p["Caption"]) + '</b>)' : "") + ' from ' + esc(itemId) + '? It’s hidden in the app and marked Removed on the Item Photos tab; the file stays in Drive.' +
              (isList ? ' It’s the list picture, so the item will go back to having no list picture.' : "") + '</p>',
            onSubmit: () => write("removeItemPhoto", { photoId: photoId }, "Photo removed")
          });
        });
        $("[data-photo-delete]", form).addEventListener("click", () => {
          close();
          openSheet({
            title: "Delete photo", submitLabel: "Delete permanently", danger: true,
            body: '<p>Permanently delete this photo' + (p["Caption"] ? ' (<b>' + esc(p["Caption"]) + '</b>)' : "") + ' from ' + esc(itemId) + '? Its row is deleted from the Item Photos tab and the file moves to the Drive trash (Google keeps it 30 days).' +
              (isList ? ' It’s the list picture, so the item will go back to having no list picture.' : "") + '</p>' +
              '<p class="hint">Use Remove instead to hide it but keep the file.</p>',
            onSubmit: () => write("deletePhoto", { photoId: photoId }, "Photo deleted")
          });
        });
        const readBtn = $("[data-photo-read]", form);
        const readCancel = $("[data-read-cancel]", form);
        let readJob = null;
        if (readCancel) readCancel.addEventListener("click", () => { if (readJob) readJob.cancel(); });
        if (readBtn) readBtn.addEventListener("click", async () => {
          const label = $("span", readBtn);
          readBtn.disabled = true; label.textContent = "Reading label…"; box.hidden = true;
          readJob = aiJob(); readCancel.hidden = false;
          try {
            const res = await readJob.run("aiReadLabel", { photoId: photoId, values: r || {} });
            if (!Object.keys(res.suggestions || {}).length) {
              box.innerHTML = '<div><b>Nothing new to fill.</b></div>' + (res.notes ? '<div class="meta">' + esc(res.notes) + '</div>' : "");
              box.hidden = false;
              return;
            }
            close();
            recordForm(type, itemId, res);
          } catch (err) {
            if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) { handleError(err); return; }
            box.innerHTML = err.code === "CANCELLED" ? '<div class="meta">Cancelled.</div>' : '<div class="form-error-inline">' + esc(err.message) + '</div>'; box.hidden = false;
          } finally { readBtn.disabled = false; label.textContent = "Read label"; readJob = null; readCancel.hidden = true; }
        });
      },
      onSubmit: async vals => {
        if (!admin) return true;
        if (String(vals.caption || "").trim() === String(p["Caption"] || "").trim()) return true;
        return write("updatePhoto", { photoId: photoId, caption: vals.caption }, "Caption saved");
      }
    });
  }

  // Photo picker with two buttons: "Take photo" opens the camera directly (capture),
  // "Choose image" opens the photo library / files. id is the base id for the two hidden inputs.
  // opts.pdf: "Choose" also accepts PDF files (receipts).
  function photoPickerHtml(id, opts) {
    const pdf = !!(opts && opts.pdf);
    return '<input type="file" accept="image/*" capture="environment" id="' + id + '_cam" hidden>' +
      '<input type="file" accept="' + (pdf ? "image/*,application/pdf,.pdf" : "image/*") + '" id="' + id + '" hidden>' +
      '<div class="photo-pick" data-photo-pick="' + id + '"><img class="photo-preview" alt="" hidden>' +
        '<div class="file-card" hidden>' + ICONS.receipts + '<span class="file-name"></span><span class="pill">PDF</span></div>' +
        '<div class="photo-btns">' +
          '<button type="button" class="btn" data-pick-camera>' + ICONS.camera + '<span>Take photo</span></button>' +
          '<button type="button" class="btn" data-pick-file>' + ICONS.image + '<span>' + (pdf ? "Choose image or PDF" : "Choose image") + '</span></button>' +
        '</div><div class="hint photo-status" hidden></div></div>';
  }
  // Wires the picker; onFile(file) runs when a photo is taken or chosen.
  // Returns { status(text), preview(url) } for showing progress and the picked photo.
  function wirePhotoPicker(form, id, onFile) {
    const cam = $("#" + id + "_cam", form), lib = $("#" + id, form);
    const box = $('[data-photo-pick="' + id + '"]', form);
    const prev = $(".photo-preview", box), st = $(".photo-status", box), card = $(".file-card", box);
    card.addEventListener("click", () => lib.click());
    $("[data-pick-camera]", box).addEventListener("click", () => cam.click());
    $("[data-pick-file]", box).addEventListener("click", () => lib.click());
    prev.addEventListener("click", () => lib.click());
    [cam, lib].forEach(input => input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      input.value = "";   // lets the same photo be picked again
      if (f) onFile(f);
    }));
    return {
      // status(text, onCancel?): progress text; onCancel adds a Cancel button (AI steps).
      status: (t, onCancel) => {
        st.textContent = t || ""; st.hidden = !t;
        if (t && onCancel) {
          const b = document.createElement("button");
          b.type = "button"; b.className = "btn small"; b.textContent = "Cancel"; b.style.marginLeft = "8px";
          b.addEventListener("click", () => { b.disabled = true; onCancel(); });
          st.appendChild(b);
        }
      },
      preview: url => { if (url) { prev.src = url; prev.hidden = false; card.hidden = true; } else { prev.removeAttribute("src"); prev.hidden = true; } },
      // file(name): shows a PDF card instead of a photo preview ("" hides it).
      file: name => { card.hidden = !name; $(".file-name", card).textContent = name || ""; if (name) { prev.removeAttribute("src"); prev.hidden = true; } }
    };
  }

  // presetItem (optional): an item ID to link the receipt to (opened from that item's page).
  function uploadReceiptForm(presetItem) {
    let image = null;
    const lineChoices = priceItemChoices();
    const preRec = presetItem ? recordOf(presetItem) : null;
    openSheet({
      title: "Upload receipt",
      submitLabel: "Upload",
      body:
        '<div class="field"><label>Photo <span class="req">*</span></label>' +
          photoPickerHtml("f_photo", { pdf: true }) + '</div>' +
        '<div class="field"><label for="f_fileName">File name <span class="req">*</span></label>' +
          '<input type="text" id="f_fileName" name="fileName" required value="' + esc(defaultReceiptName(today(), "")) + '">' +
          '<div class="hint">.jpg (or .pdf for a PDF) is added automatically.</div></div>' +
        comboHtml({ name: "vendor", label: "Store / vendor", mode: "free", noThumbs: true, newLabel: "will be added to the vendor list",
                    placeholder: "Choose or type a new vendor" }, vendorItems()) +
        fieldHtml({ name: "purchaseDate", label: "Purchase date", type: "date" }, today()) +
        '<div class="field"><label for="f_total">Total</label><input type="text" inputmode="decimal" id="f_total" name="total" placeholder="0.00" autocomplete="off"></div>' +
        fieldHtml({ name: "notes", label: "Notes", type: "longtext" }, "") +
        (presetItem && !isAdmin() ? '<p class="hint">This receipt will be linked to <b>' + esc(presetItem + (preRec ? " " + TYPES[preRec.type].title(preRec.rec) : "")) + '</b>.</p>' : "") +
        (isAdmin() ? '<div class="form-section"><h3>Assign to records <span class="opt">optional</span></h3>' +
          comboHtml({ name: "itemIds", label: "Records on this receipt", mode: "multi", value: presetItem || "",
                      placeholder: "Search tanks, species, equipment, plants, medications" }, linkableItems(new Set())) +
          '<p class="hint">Leave empty to assign later from the receipt’s page.</p></div>' : "") +
        (state.hasReceiptLines ? '<div class="form-section"><h3>Items on this receipt <span class="opt">optional</span></h3>' + linesEditorHtml([], lineChoices) + '</div>' : ""),
      onReady: form => {
        $$("[data-combo]", form).forEach(wireCombo);
        if (state.hasReceiptLines) wireLinesEditor(form, lineChoices, () => $("input[name=vendor]", form).value);
        const nameEl = $("#f_fileName", form);
        let nameTouched = false;
        nameEl.addEventListener("input", () => { nameTouched = true; });
        const refreshName = () => {
          if (nameTouched) return;
          nameEl.value = defaultReceiptName($("[name=purchaseDate]", form).value, $("input[name=vendor]", form).value.trim());
        };
        $("input[name=vendor]", form).addEventListener("change", refreshName);
        $("[name=purchaseDate]", form).addEventListener("change", refreshName);
        const pick = wirePhotoPicker(form, "f_photo", async f => {
          // PDFs are uploaded as-is (up to 10 MB); photos are shrunk first.
          if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
            if (f.size > 10 * 1024 * 1024) { toast("That PDF is larger than 10 MB.", true); return; }
            pick.status("Reading PDF…");
            try { image = await readPdf(f); pick.file(f.name); pick.status(""); }
            catch (err) { image = null; pick.file(""); pick.status(""); toast(err.message, true); }
            return;
          }
          pick.status("Preparing photo…");
          try {
            image = await prepareImage(f);
            pick.file("");
            pick.preview(image.preview);
            pick.status("");
          } catch (err) {
            image = null; pick.preview(""); pick.status("");
            toast(err.message, true);
          }
        });
      },
      onSubmit: async (vals, form) => {
        if (!image) throw new Error("Please add a photo or PDF of the receipt.");
        if (!(await checkVendorField(vals, form, "vendor"))) return false;
        const total = String(vals.total || "").replace(/[$,\s]/g, "");
        if (total && isNaN(Number(total))) throw new Error("Total must be an amount like 24.99.");
        const itemIds = isAdmin() ? String(vals.itemIds || "").split(",").filter(Boolean) : (presetItem ? [presetItem] : []);
        const lines = state.hasReceiptLines ? await collectLines(vals, form, lineChoices) : [];
        if (lines === null) return false;
        return write("uploadReceipt", {
          receipt: { fileName: vals.fileName, vendor: vals.vendor, purchaseDate: vals.purchaseDate, total: total, notes: vals.notes },
          image: { data: image.data, mimeType: image.mimeType },
          itemIds: itemIds, lines: lines
        }, res => (itemIds.length || (res && res.linked && res.linked.length) ? "Receipt uploaded and assigned" : "Receipt uploaded") +
                  (lines.length ? " with " + lines.length + " item" + (lines.length === 1 ? "" : "s") : "") +
                  (res && res.notes && res.notes.length ? ". " + res.notes.join(". ") : ""));
      }
    });
  }

  function editReceiptForm(id) {
    const r = findReceipt(id);
    if (!r) return;
    const cur = { fileName: receiptTitle(r), vendor: r["Vendor"] || "", purchaseDate: r["Purchase Date"] || "",
                  total: r["Total"] === "" || r["Total"] === undefined ? "" : String(r["Total"]), notes: r["Notes"] || "" };
    openSheet({
      title: "Edit receipt",
      body:
        '<div class="field"><label for="f_fileName">File name <span class="req">*</span></label>' +
          '<input type="text" id="f_fileName" name="fileName" required value="' + esc(cur.fileName) + '">' +
          '<div class="hint">The file in Drive is renamed too.</div></div>' +
        comboHtml({ name: "vendor", label: "Store / vendor", mode: "free", noThumbs: true, newLabel: "will be added to the vendor list",
                    placeholder: "Choose or type a new vendor", value: cur.vendor }, vendorItems()) +
        fieldHtml({ name: "purchaseDate", label: "Purchase date", type: "date" }, cur.purchaseDate) +
        '<div class="field"><label for="f_total">Total</label><input type="text" inputmode="decimal" id="f_total" name="total" value="' + esc(cur.total) + '" autocomplete="off"></div>' +
        fieldHtml({ name: "notes", label: "Notes", type: "longtext" }, cur.notes),
      onReady: form => $$("[data-combo]", form).forEach(wireCombo),
      onSubmit: async (vals, form) => {
        if (vals.vendor !== cur.vendor && !(await checkVendorField(vals, form, "vendor"))) return false;
        const total = String(vals.total || "").replace(/[$,\s]/g, "");
        if (total && isNaN(Number(total))) throw new Error("Total must be an amount like 24.99.");
        vals.total = total;
        const changed = {};
        Object.keys(cur).forEach(k => {
          const a = k === "total" ? (cur[k] === "" ? "" : Number(cur[k]).toFixed(2)) : String(cur[k]).trim();
          const b = k === "total" ? (vals[k] === "" ? "" : Number(vals[k]).toFixed(2)) : String(vals[k] || "").trim();
          if (a !== b) changed[k] = vals[k];
        });
        if (!Object.keys(changed).length) { toast("No changes"); return true; }
        return write("updateReceipt", { id: id, receipt: changed }, "Saved");
      }
    });
  }

  function linkableItems(already) {
    const items = [];
    RECEIPT_LINK_TYPES.forEach(ty => {
      const T = TYPES[ty];
      state.data[ty].slice().sort((x, y) => String(T.title(x)).localeCompare(String(T.title(y)))).forEach(rec => {
        const rid = rec[T.id];
        items.push({ value: rid, label: T.title(rec), group: T.label, img: T.img(rec),
                     sub: [T.sub(rec), isRetired(rec) ? "Retired" : ""].filter(Boolean).join(" · "),
                     disabled: already.has(rid), note: already.has(rid) ? "Linked" : "" });
      });
    });
    return items;
  }

  function linkReceiptForm(id) {
    const r = findReceipt(id);
    if (!r) return;
    const items = linkableItems(new Set(receiptLinksFor(id).map(l => l["Item ID"])));
    openSheet({
      title: "Assign " + receiptTitle(r),
      submitLabel: "Link",
      body: comboHtml({ name: "itemIds", label: "Records on this receipt", mode: "multi", required: true,
                        placeholder: "Search tanks, species, equipment, plants, medications" }, items) +
        '<p class="hint">Tap each record that’s on this receipt. If something isn’t in the database yet, add it first (Browse → Add), then come back and link it.</p>',
      onReady: form => $$("[data-combo]", form).forEach(wireCombo),
      onSubmit: vals => write("linkReceipt", { id: id, itemIds: String(vals.itemIds || "").split(",").filter(Boolean) }, "Linked")
    });
  }

  function unlinkReceiptForm(row, id, itemId) {
    const x = recordOf(itemId);
    openSheet({
      title: "Remove link",
      submitLabel: "Remove",
      danger: true,
      body: '<p>Unlink <b>' + esc(x ? TYPES[x.type].title(x.rec) : itemId) + '</b> from this receipt? The receipt and the record both stay; the link is kept in the history as removed.</p>',
      onSubmit: () => write("unlinkReceipt", { key: { row: row, receiptId: id, itemId: itemId } }, "Link removed")
    });
  }

  function retireReceiptForm(id, restore) {
    const r = findReceipt(id);
    openSheet({
      title: (restore ? "Restore" : "Retire") + " receipt",
      submitLabel: restore ? "Restore" : "Retire",
      danger: !restore,
      body: restore ? '<p>Make <b>' + esc(receiptTitle(r)) + '</b> active again?</p>'
                    : '<p>Mark <b>' + esc(receiptTitle(r)) + '</b> as Retired? The photo stays in Drive and the record stays in the sheet; it just stops showing in the list.</p>',
      onSubmit: () => write("retireReceipt", { id: id, restore: !!restore }, restore ? "Restored" : "Retired")
    });
  }

  // ------------------------------------------------------------------
  // Fill with AI (species, plants, equipment, medications)
  // ------------------------------------------------------------------
  const AI_TYPES = ["species", "plants", "equipment", "medications"];
  const canUseAi = () => state.me && (state.me.role === "Admin" || state.me.role === "Editor");
  // Editors can fix the details of a wishlist item they added.
  function canEditItem(type, r) {
    if (isAdmin()) return true;
    if (!r || !state.me || state.me.role !== "Editor" || !isWishItem(r)) return false;
    const id = r[TYPES[type].id];
    return state.wishes.some(w => w["Item ID"] === id && w["New Item"] === true && w["Added By"] === state.me.id);
  }

  function aiBarHtml() {
    return '<div class="ai-bar"><button type="button" class="btn small ai-btn" data-ai-fill>' + ICONS.sparkle + '<span>Fill with AI</span></button>' +
      '<button type="button" class="btn small" data-ai-cancel hidden>Cancel</button>' +
      '<span class="hint">Fills blank fields only. Check them before saving.</span></div><div class="ai-result" hidden></div>';
  }

  // Wires the "Fill with AI" button in a form. getLink() returns a product/info link to read, if any.
  // onPhoto(photo) receives a free Wikipedia/Commons photo when one is found (wishlist only).
  function wireAiFill(form, type, getLink, opts) {
    opts = opts || {};
    const btn = $("[data-ai-fill]", form);
    const box = $(".ai-result", form);
    if (!btn) return;
    // Scientific name picked from the list shown when a common name fits several species.
    let pickedSci = "";
    // The running lookup (null when idle); its Cancel button stops it.
    let job = null;
    const cancelBtn = $("[data-ai-cancel]", form);
    if (cancelBtn) cancelBtn.addEventListener("click", () => { if (job) job.cancel(); });
    btn.addEventListener("click", async () => {
      const t = typeof type === "function" ? type() : type;
      const scope = opts.scope ? opts.scope() : form;
      const values = {};
      $$("input[name], select[name], textarea[name]", scope).forEach(el => { if (el.type !== "checkbox" && el.type !== "file") values[el.name] = el.value; });
      if (pickedSci && !String(values["Scientific Name"] || "").trim()) values["Scientific Name"] = pickedSci;
      const label = $("span", btn);
      btn.disabled = true; label.textContent = (t === "species" || t === "plants") ? "Checking sources…" : "Asking the AI…";
      box.hidden = true;
      try {
        job = aiJob();
        if (cancelBtn) cancelBtn.hidden = false;
        const res = await job.run("aiFill", { table: t, values: values, link: getLink ? getLink() : "", findPhoto: !!opts.onPhoto });
        // The common name fits several species: list them to pick from, then look up the one picked.
        if ((res.choices || []).length) {
          box.classList.remove("unverified");
          box.innerHTML = '<div><b>Which one do you mean?</b></div><div class="meta">' + esc(res.notes || "") + '</div>' +
            '<div class="ai-choices">' + res.choices.map(c =>
              '<button type="button" class="match" data-sci="' + esc(c.scientificName) + '"><i>' + esc(c.scientificName) + '</i> ' +
              '<span>' + esc(c.commonName) + ' · ' + esc(c.source) + '</span></button>').join("") + '</div>';
          box.hidden = false;
          return;
        }
        let n = 0;
        Object.keys(res.suggestions || {}).forEach(name => {
          const el = $$("[name]", scope).find(x => x.name === name);
          if (!el || String(el.value).trim() !== "") return;
          const v = String(res.suggestions[name]);
          if (el.tagName === "SELECT" && !$$("option", el).some(o => o.value === v || o.textContent === v)) return;
          el.value = v;
          el.classList.add("ai-filled");
          if (res.fallback || (res.unverified || []).indexOf(name) !== -1) el.classList.add("ai-unverified");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          n++;
        });
        // Corrections to values you entered (a credible source disagreed), outlined in pink.
        const fixed = [];
        Object.keys(res.corrections || {}).forEach(name => {
          const el = $$("[name]", scope).find(x => x.name === name);
          const c = res.corrections[name];
          if (!el) return;
          if (el.tagName === "SELECT" && !$$("option", el).some(o => o.value === c.to || o.textContent === c.to)) return;
          el.value = c.to;
          el.classList.add("ai-corrected");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          fixed.push('<div class="meta"><b>' + esc(name) + ':</b> “' + esc(c.from) + '” → “' + esc(c.to) + '” <span class="src">(' +
                     esc(String(c.source).split(":")[0]) + (c.reason ? ": " + esc(c.reason) : "") + ')</span></div>');
        });
        if (res.photo && opts.onPhoto) opts.onPhoto(res.photo);
        const srcs = (res.sources || []).map(s => '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title) + '</a>').join(" · ");
        // Which fields came from which source.
        const bySource = {};
        Object.keys(res.fieldSources || {}).forEach(f => {
          if (!(f in (res.suggestions || {}))) return;
          const src = String(res.fieldSources[f]).split(":")[0];   // "Seriously Fish: Genus species" -> "Seriously Fish"
          (bySource[src] = bySource[src] || []).push(f);
        });
        const perSource = Object.keys(bySource).map(src => '<div class="meta"><b>' + esc(src) + ':</b> ' + esc(bySource[src].join(", ")) + '</div>').join("");
        box.classList.toggle("unverified", !!res.fallback);
        const someUnverified = !res.fallback && (res.unverified || []).some(f => f in (res.suggestions || {}));
        box.innerHTML =
          (someUnverified ? '<div class="ai-warn">Fields outlined in amber aren’t covered by the credible source, so they come from Wikipedia or the AI’s own knowledge. Verify them before saving.</div>' : "") +
          (res.fallback ? '<div class="ai-warn">No credible source (FishBase, Seriously Fish, SeaLifeBase, Tropica) has a page for this, so these come from Wikipedia or the AI’s own knowledge. Verify before saving.</div>' : "") +
          '<div><b>' + (n ? "Filled " + n + " field" + (n === 1 ? "" : "s") : fixed.length ? "No blank fields filled" : "Nothing new to fill") + '</b>' +
            (res.identified ? ' for <b>' + esc(res.identified) + '</b>' : "") +
            (res.confidence ? ' <span class="pill ' + (res.confidence === "High" ? "good" : res.confidence === "Low" ? "bad" : "warn") + '">' + esc(res.confidence) + ' confidence</span>' : "") + '</div>' +
          (res.notes ? '<div class="meta">' + esc(res.notes) + '</div>' : "") +
          '<div class="meta">Sources: ' + (srcs || "none: from the AI’s own knowledge, so double-check") + '</div>' +
          (res.cached ? '<div class="meta">You ran this same lookup in the last 6 hours, so this is the saved result.</div>' : "") +
          perSource +
          (fixed.length ? '<div class="ai-fixes"><div class="meta"><b>Corrected ' + fixed.length + ' value' + (fixed.length === 1 ? "" : "s") + ' you entered</b> (outlined in pink):</div>' + fixed.join("") + '</div>' : "") +
          ((res.notFound || []).length ? '<div class="meta">Not in the sources, left blank: ' + esc(res.notFound.join(", ")) + '</div>' : "") +
          (res.photo && opts.onPhoto ? '<div class="meta">Thumbnail: free photo from <a href="' + esc(res.photo.page || res.photo.url) + '" target="_blank" rel="noopener">Wikimedia Commons</a> (' + esc(res.photo.license) + ').</div>' : "") +
          (n ? '<div class="meta">AI-filled fields are highlighted.</div>' : "");
        box.hidden = false;
      } catch (err) {
        if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) { handleError(err); return; }
        box.classList.remove("unverified");
        box.innerHTML = err.code === "CANCELLED" ? '<div class="meta">Cancelled. Nothing was filled.</div>' : '<div class="form-error-inline">' + esc(err.message) + '</div>';
        box.hidden = false;
      } finally {
        btn.disabled = false; label.textContent = "Fill with AI";
        job = null;
        if (cancelBtn) cancelBtn.hidden = true;
      }
    });
    box.addEventListener("click", e => {
      const b = e.target.closest("[data-sci]");
      if (!b || btn.disabled) return;
      pickedSci = b.dataset.sci;
      const scope = opts.scope ? opts.scope() : form;
      const sciEl = $$("[name]", scope).find(x => x.name === "Scientific Name");
      if (sciEl && !String(sciEl.value).trim()) { sciEl.value = pickedSci; sciEl.dispatchEvent(new Event("input", { bubbles: true })); }
      btn.click();
    });
    form.addEventListener("input", e => {
      if (e.isTrusted && e.target.classList) e.target.classList.remove("ai-filled", "ai-unverified", "ai-corrected");
      if (e.isTrusted && e.target.name === "Common Name") pickedSci = "";   // a new name needs a new pick
    });
  }


  // ------------------------------------------------------------------
  // Wishlist
  // ------------------------------------------------------------------
  const WISH_TYPES = ["species", "plants", "equipment"];
  const findWish = id => state.wishes.find(w => w["Wish ID"] === id);
  const wishIsOpen = w => ["Purchased", "Not getting"].indexOf(String(w["Wish Status"])) === -1;
  const wishPending = id => state.data.assignments.filter(a => a["Wish ID"] === id && isPendingWishRow(a));
  const wishAdded = id => state.data.assignments.filter(a => a["Wish ID"] === id && !!a["Date Added"]);
  const wishItem = w => findRec(w["Item Type"], w["Item ID"]);
  const wishTitle = w => { const r = wishItem(w); return r ? TYPES[w["Item Type"]].title(r) : w["Item ID"]; };
  const compatFor = (wishId, tankId) => state.compat.find(c => c["Wish ID"] === wishId && c["Tank ID"] === tankId);
  const canAddWish = () => isAdmin() || (state.me && state.me.role === "Editor" && state.me.tanks.length > 0);
  const wishTanksAllowed = () => state.data.tanks.filter(t => !isRetired(t) && canEditTank(t["Tank ID"]))
    .sort((a, b) => String(a["Tank Name"]).localeCompare(String(b["Tank Name"])));
  function canManageWish(w) {
    if (isAdmin()) return true;
    if (!state.me || state.me.role !== "Editor") return false;
    return w["Added By"] === state.me.id || wishPending(w["Wish ID"]).some(a => canEditTank(a["Tank ID"]));
  }
  function canCloseWish(w) {
    if (isAdmin() || (state.me && w["Added By"] === state.me.id && state.me.role === "Editor")) return true;
    const pt = wishPending(w["Wish ID"]);
    return !!state.me && state.me.role === "Editor" && pt.length > 0 && pt.every(a => canEditTank(a["Tank ID"]));
  }
  const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };

  function verdictPill(v, short) {
    if (!v) return '<span class="pill">Not checked</span>';
    const cls = v === "Good" ? "good" : v === "Not recommended" ? "bad" : "warn";
    return '<span class="pill ' + cls + '">' + esc(short && v === "Not recommended" ? "Not rec." : v) + '</span>';
  }
  function wishStatusPill(w) {
    const s = String(w["Wish Status"] || "Want");
    const cls = s === "Purchased" ? "good" : s === "Not getting" ? "retired" : s === "Researching" ? "" : "edit";
    return '<span class="pill ' + cls + '">' + esc(s) + '</span>';
  }

  function wishRow(w, tankId) {
    const r = wishItem(w);
    const T = TYPES[w["Item Type"]] || TYPES.species;
    const pend = wishPending(w["Wish ID"]);
    const tanksLine = tankId
      ? verdictPill((compatFor(w["Wish ID"], tankId) || {})["Verdict"], true)
      : pend.map(a => '<span class="tank-chip">' + esc(tankName(a["Tank ID"])) + ' ' + verdictPill((compatFor(w["Wish ID"], a["Tank ID"]) || {})["Verdict"], true) + '</span>').join("");
    return '<a class="list-item wish-row ' + (wishIsOpen(w) ? "" : "dim") + '" href="#/wish/' + encodeURIComponent(w["Wish ID"]) + '">' +
      photoHtml(r ? T.img(r) : "", "thumb", 160, String(w["Item ID"]).split("-")[0]) +
      '<div class="body"><div class="title">' + esc(wishTitle(w)) + '</div>' +
      '<div class="sub">' + esc([w["Wish ID"], T.one, w["Priority"] ? w["Priority"] + " priority" : "", money(w["Estimated Price"])].filter(Boolean).join(" · ")) + '</div>' +
      (tanksLine ? '<div class="tank-chips">' + tanksLine + '</div>' : "") + '</div>' +
      (tankId ? "" : wishStatusPill(w)) + '</a>';
  }

  function wishSection(tankId) {
    const list = state.wishes.filter(w => wishIsOpen(w) && wishPending(w["Wish ID"]).some(a => a["Tank ID"] === tankId))
      .sort((a, b) => (PRIORITY_ORDER[a["Priority"]] ?? 1) - (PRIORITY_ORDER[b["Priority"]] ?? 1));
    if (!list.length && !(canEditTank(tankId) && canAddWish())) return "";
    return '<div class="section"><div class="section-head"><h3>Wishlist (' + list.length + ')</h3>' +
      (canEditTank(tankId) && canAddWish() ? '<button class="btn small" data-act="add-wish" data-tank="' + esc(tankId) + '">' + ICONS.plus + 'Add</button>' : "") + '</div>' +
      '<div class="card list">' + (list.map(w => wishRow(w, tankId)).join("") || '<div class="empty">None</div>') + '</div></div>';
  }

  function wishRows() {
    const f = state.wishFilter;
    const visibleTanks = state.data.tanks.filter(t => !isRetired(t));
    if (state.wishTank && !visibleTanks.some(t => t["Tank ID"] === state.wishTank)) state.wishTank = "";
    return state.wishes
      .filter(w => f === "open" ? wishIsOpen(w) : String(w["Wish Status"]) === (f === "purchased" ? "Purchased" : "Not getting"))
      .filter(w => !state.wishTank || state.data.assignments.some(a => a["Wish ID"] === w["Wish ID"] && a["Tank ID"] === state.wishTank &&
                                                                         (f === "open" ? isPendingWishRow(a) : true)))
      .sort((a, b) => ((PRIORITY_ORDER[a["Priority"]] ?? 1) - (PRIORITY_ORDER[b["Priority"]] ?? 1)) ||
                      String(b["Added At"] || "").localeCompare(String(a["Added At"] || "")));
  }
  function viewWishlist() {
    const f = state.wishFilter;
    const visibleTanks = state.data.tanks.filter(t => !isRetired(t)).sort((a, b) => String(a["Tank Name"]).localeCompare(String(b["Tank Name"])));
    const rows = wishRows();
    const count = k => state.wishes.filter(w => k === "open" ? wishIsOpen(w) : String(w["Wish Status"]) === (k === "purchased" ? "Purchased" : "Not getting")).length;
    return {
      title: "Wishlist",
      keepScroll: true,
      html:
        (canAddWish() ? '<div class="actions" style="margin:0 0 12px"><button class="btn primary" data-act="add-wish">' + ICONS.plus + 'Add wish</button></div>' : "") +
        '<div class="segmented">' +
          [["open", "Open"], ["purchased", "Purchased"], ["closed", "Not getting"]].map(x =>
            '<button class="' + (f === x[0] ? "on" : "") + '" data-act="wish-filter" data-f="' + x[0] + '">' + x[1] + ' (' + count(x[0]) + ')</button>').join("") +
        '</div>' +
        '<div class="field"><select data-act="wish-tank" aria-label="Tank"><option value="">All tanks</option>' +
          visibleTanks.map(t => '<option value="' + esc(t["Tank ID"]) + '"' + (t["Tank ID"] === state.wishTank ? " selected" : "") + '>' + esc(t["Tank Name"]) + '</option>').join("") +
        '</select></div>' +
        '<div class="card list">' + (rows.map(w => wishRow(w)).join("") || '<div class="empty">' + (state.wishes.length ? "Nothing here." : "No wishes yet.") + '</div>') + '</div>' +
        '<p class="hint">Compatibility is checked by AI (Google Gemini, free tier) against each tank’s target ranges and current stock. Treat it as a starting point, not the final word.</p>'
    };
  }

  function viewWish(id) {
    const w = findWish(id);
    if (!w) return { title: "Wish", back: true, html: '<div class="empty">That wish wasn’t found.</div>' };
    const type = w["Item Type"];
    const T = TYPES[type] || TYPES.species;
    const r = wishItem(w);
    const open = wishIsOpen(w);
    const pend = wishPending(id);
    const added = wishAdded(id);
    const manage = canManageWish(w);
    const canBuy = open && canUseAi() && wishTanksAllowed().length > 0;
    const img = r ? T.img(r) : "";
    const checked = state.compat.filter(c => c["Wish ID"] === id);
    const lastCheck = checked.map(c => c["Checked At"]).sort().pop();

    const hero = '<div class="card">' + photoHtml(img, "big-img", 800, "") +
      '<div class="hero"><h2>' + esc(wishTitle(w)) + '</h2>' +
      '<div class="meta">' + esc([id, T.one, w["Item ID"], r ? T.sub(r) : ""].filter(Boolean).join(" · ")) + '</div>' +
      '<div class="counts">' + wishStatusPill(w) + (w["Priority"] ? '<span class="pill">' + esc(w["Priority"]) + ' priority</span>' : "") + '</div>' +
      '<div class="actions">' +
        (canBuy ? '<button class="btn primary" data-act="purchase-wish" data-id="' + esc(id) + '">Mark purchased</button>' : "") +
        (manage ? '<button class="btn" data-act="edit-wish" data-id="' + esc(id) + '">Edit wish</button>' : "") +
        (r && canEditItem(type, r) && (isWishItem(r) || isAdmin()) ? '<button class="btn" data-act="edit-record" data-type="' + type + '" data-id="' + esc(w["Item ID"]) + '">Edit item</button>' : "") +
        (open && canCloseWish(w) ? '<button class="btn danger" data-act="close-wish" data-id="' + esc(id) + '">Not getting</button>' : "") +
      '</div></div></div>';

    const tankBlock = (tankId, extra) => {
      const c = compatFor(id, tankId);
      return '<div class="list-item compat-row"><div class="body">' +
        '<div class="title">' + esc(tankName(tankId)) + ' <span class="meta">' + esc(tankId) + '</span></div>' +
        (c && c["Reasons"] ? '<ul class="reasons">' + String(c["Reasons"]).split(/;\s*/).filter(Boolean).map(x => '<li>' + esc(x) + '</li>').join("") + '</ul>' : "") +
        (extra ? '<div class="sub">' + esc(extra) + '</div>' : "") + '</div>' +
        verdictPill(c && c["Verdict"]) + '</div>';
    };
    const wished = '<div class="section"><div class="section-head"><h3>Wished for (' + pend.length + ')</h3>' +
      (open && canUseAi() ? '<button class="btn small" data-act="check-wish" data-id="' + esc(id) + '">' + ICONS.sparkle + (checked.length ? "Recheck" : "Check") + '</button>' : "") + '</div>' +
      '<div class="card list">' + (pend.map(a => tankBlock(a["Tank ID"])).join("") || '<div class="empty">' + (open ? "No tanks picked yet." : "None") + '</div>') + '</div>' +
      (lastCheck ? '<p class="hint">Last checked ' + esc(fmtDTLong(lastCheck)) + '. Recheck after stocking or target ranges change.</p>' : "") + '</div>';
    const suggestions = checked.filter(c => c["Wished Tank"] !== true && !pend.some(a => a["Tank ID"] === c["Tank ID"]));
    const suggestHtml = open && suggestions.length ? '<div class="section"><div class="section-head"><h3>Other tanks that may suit it</h3></div>' +
      '<div class="card list">' + suggestions.map(c => tankBlock(c["Tank ID"])).join("") + '</div></div>' : "";
    const addedHtml = added.length ? '<div class="section"><div class="section-head"><h3>Added to tanks (' + added.length + ')</h3></div><div class="card list">' +
      added.map(a => '<a class="list-item" href="#/tank/' + encodeURIComponent(a["Tank ID"]) + '"><div class="body"><div class="title">' + esc(tankName(a["Tank ID"])) + '</div>' +
        '<div class="sub">' + esc([a["Item ID"], a["Date Added"] ? "Added " + fmtDate(a["Date Added"]) : "", a["Date Removed"] ? "Removed " + fmtDate(a["Date Removed"]) : ""].filter(Boolean).join(" · ")) + '</div></div></a>').join("") +
      '</div></div>' : "";
    const kv = [["Wish status", esc(w["Wish Status"])], ["Priority", esc(w["Priority"])], ["Estimated price", esc(money(w["Estimated Price"]))],
      ["Where to buy", esc(w["Vendor"])], ["Link", isUrl(w["Link"]) ? '<a href="' + esc(w["Link"]) + '" target="_blank" rel="noopener">Open link</a>' : esc(w["Link"])],
      ["Notes", esc(w["Notes"])], ["Purchase date", esc(fmtDate(w["Purchase Date"]))], ["Price paid", esc(money(w["Price Paid"]))],
      ["Receipt", esc(w["Receipt ID"])], ["Added by", esc(personName(w["Added By"]))],
      ["Added", esc(w["Added At"] ? fmtDTLong(w["Added At"]) : "")], ["Closed", esc(w["Closed At"] ? fmtDTLong(w["Closed At"]) : "")]]
      .filter(p => p[1] !== "");
    const details = '<div class="section"><div class="section-head"><h3>Wish details</h3></div><div class="card kv">' +
      kv.map(p => '<div class="k">' + p[0] + '</div><div>' + p[1] + '</div>').join("") + '</div></div>';
    const itemLink = r ? '<div class="section"><div class="card list"><a class="list-item" href="#/item/' + type + '/' + encodeURIComponent(w["Item ID"]) + '"><div class="body"><div class="title">' +
      esc(T.one) + ' details</div><div class="sub">' + esc(w["Item ID"]) + (isWishItem(r) ? " · on the wishlist until purchased" : "") + '</div></div></a></div></div>' : "";
    return { title: wishTitle(w), back: true, html: hero + wished + suggestHtml + addedHtml + details + itemLink };
  }

  // Fields of a species / plant / equipment record that the wish form asks for.
  function wishItemFields(type) {
    return (state.schema[type] || []).filter(f => !f.readOnly && f.type !== "url" && f.type !== "date" &&
      ["Status", "Vendor", "Serial Number"].indexOf(f.name) === -1);
  }

  function addWishForm(prefTank) {
    const tanks = wishTanksAllowed();
    if (!tanks.length && !isAdmin()) { toast("You don’t manage any tanks yet.", true); return; }
    let image = null, commons = null, reuseId = "", type = "species";
    const pri = state.wishOptions.priorities, sts = ["Researching", "Want"];
    openSheet({
      title: "Add to wishlist",
      submitLabel: "Add wish",
      body:
        '<div class="segmented wish-type">' + WISH_TYPES.map(t => '<button type="button" class="' + (t === type ? "on" : "") + '" data-wtype="' + t + '">' + TYPES[t].label + '</button>').join("") + '</div>' +
        '<div class="field"><label>Photo <span class="opt">optional</span></label>' +
          photoPickerHtml("f_wphoto") +
          '<div class="hint">The AI will try to identify it. The photo becomes the item’s picture.</div>' +
          '<div class="id-result" hidden></div></div>' +
        '<div class="reuse" hidden></div>' +
        '<div class="form-section"><h3>Item</h3>' + aiBarHtml() + '<div class="wish-details"></div><div class="matches" hidden></div></div>' +
        '<div class="form-section"><h3>Which tanks?</h3>' +
          (tanks.map(t => '<label class="check"><input type="checkbox" name="tank:' + esc(t["Tank ID"]) + '"' + (t["Tank ID"] === prefTank ? " checked" : "") + '> ' +
            esc(t["Tank Name"]) + ' <span class="meta">' + esc(t["Tank ID"]) + '</span></label>').join("") || '<p class="hint">No tanks.</p>') +
          (isAdmin() ? '<p class="hint">Leave all unchecked to just research it; the compatibility check will suggest tanks.</p>' : "") + '</div>' +
        '<div class="form-section"><h3>Wish details</h3>' +
          fieldHtml({ name: "w_priority", label: "Priority", type: "select", html: pri.map(p => '<option' + (p === "Medium" ? " selected" : "") + '>' + esc(p) + '</option>').join("") }) +
          fieldHtml({ name: "w_status", label: "Wish status", type: "select", html: sts.map(p => '<option' + (p === "Want" ? " selected" : "") + '>' + esc(p) + '</option>').join("") }) +
          '<div class="field"><label for="f_w_price">Estimated price</label><input type="text" inputmode="decimal" id="f_w_price" name="w_price" placeholder="0.00" autocomplete="off"></div>' +
          comboHtml({ name: "w_vendor", label: "Where to buy", mode: "free", noThumbs: true, newLabel: "will be added to the vendor list",
                      placeholder: "Choose or type a store" }, vendorItems()) +
          fieldHtml({ name: "w_link", label: "Link", type: "url", hint: "Product or store page. Fill with AI also reads it." }) +
          fieldHtml({ name: "w_notes", label: "Notes", type: "longtext" }) +
        '</div>',
      onReady: form => {
        $$("[data-combo]", form).forEach(wireCombo);
        const details = $(".wish-details", form), matches = $(".matches", form), reuse = $(".reuse", form);
        const renderDetails = () => {
          details.innerHTML = wishItemFields(type).map(f => fieldHtml(f, "")).join("");
          $$("[data-combo]", details).forEach(wireCombo);
          matches.hidden = true; matches.dataset.key = ""; commons = null;
          $(".ai-result", form).hidden = true;
        };
        const setReuse = id => {
          reuseId = id;
          const r = id ? findRec(type, id) : null;
          reuse.hidden = !r;
          reuse.innerHTML = r ? '<div class="notice">Using <b>' + esc(id + " " + TYPES[type].title(r)) + '</b>, already in your ' + esc(TYPES[type].label) + ' list. <button type="button" class="link-btn" data-unreuse>Add a new one instead</button></div>' : "";
          $(".form-section", form).hidden = !!r;
        };
        reuse.addEventListener("click", e => { if (e.target.closest("[data-unreuse]")) setReuse(""); });
        {
          const check = () => {
            if (type === "equipment") { matches.hidden = true; return; }
            const q = [$('[name="Common Name"]', details), $('[name="Scientific Name"]', details)].map(el => el ? el.value.trim().toLowerCase() : "").filter(v => v.length >= 3);
            const hits = !q.length ? [] : state.data[type].filter(r => !isWishItem(r) && q.some(v =>
              String(r["Common Name"] || "").toLowerCase().indexOf(v) !== -1 || String(r["Scientific Name"] || "").toLowerCase().indexOf(v) !== -1)).slice(0, 4);
            matches.hidden = !hits.length;
            const html = hits.length ? '<div class="hint">Already in your list:</div>' + hits.map(r =>
              '<button type="button" class="match" data-reuse="' + esc(r[TYPES[type].id]) + '">' + esc(r[TYPES[type].id] + " " + TYPES[type].title(r)) + ' <span>Use it</span></button>').join("") : "";
            const key = hits.map(r => r[TYPES[type].id]).join(",");
            if (matches.dataset.key !== key) { matches.dataset.key = key; matches.innerHTML = html; }   // re-rendering mid-tap would swallow the tap
          };
          details.addEventListener("input", check);
          details.addEventListener("change", check);
        }
        matches.addEventListener("click", e => { const b = e.target.closest("[data-reuse]"); if (b) setReuse(b.dataset.reuse); });
        $$("[data-wtype]", form).forEach(b => b.addEventListener("click", () => {
          if (b.dataset.wtype === type) return;
          type = b.dataset.wtype;
          $$("[data-wtype]", form).forEach(x => x.classList.toggle("on", x === b));
          setReuse(""); renderDetails();
        }));
        renderDetails();
        wireAiFill(form, () => type, () => ($('[name="w_link"]', form).value || "").trim(),
                   { scope: () => details, onPhoto: p => { if (!image) commons = p; } });

        // Photo + identify
        const idBox = $(".id-result", form);
        const applyGuess = (g, alt) => {
          const t = WISH_TYPES.indexOf(g.type) !== -1 ? g.type : type;
          if (t !== type) { type = t; $$("[data-wtype]", form).forEach(x => x.classList.toggle("on", x.dataset.wtype === t)); setReuse(""); renderDetails(); }
          const set = (n, v) => { const el = $('[name="' + n + '"]', details); if (el && v) { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); } };
          if (type === "equipment") { set("Manufacturer", g.manufacturer); set("Filter Model", g.model || g.name); }
          else { set("Common Name", alt ? alt.name : g.name); set("Scientific Name", alt ? alt.scientificName : g.scientificName); }
        };
        const pick = wirePhotoPicker(form, "f_wphoto", async f => {
          pick.status("Preparing photo…");
          try {
            image = await prepareImage(f, 1280, 0.85);
            commons = null;
            pick.preview(image.preview);
          } catch (err) { image = null; pick.preview(""); pick.status(""); toast(err.message, true); return; }
          const idJob = aiJob();
          pick.status("Identifying…", () => idJob.cancel());
          idBox.hidden = true;
          try {
            const g = await idJob.run("aiIdentify", { image: { data: image.data, mimeType: image.mimeType }, typeHint: type });
            const name = g.type === "equipment" ? [g.manufacturer, g.model || g.name].filter(Boolean).join(" ") : [g.name, g.scientificName ? "(" + g.scientificName + ")" : ""].filter(Boolean).join(" ");
            idBox.innerHTML = '<div><b>Looks like:</b> ' + esc(name || "not sure") + ' <span class="pill ' + (g.confidence === "High" ? "good" : g.confidence === "Low" ? "bad" : "warn") + '">' + esc(g.confidence) + ' confidence</span></div>' +
              (g.notes ? '<div class="meta">' + esc(g.notes) + '</div>' : "") +
              '<div class="actions">' + (name ? '<button type="button" class="btn small primary" data-guess="main">Use this</button>' : "") +
              (g.alternatives || []).map((a, i) => '<button type="button" class="btn small" data-guess="' + i + '">' + esc(a.name) + '</button>').join("") + '</div>';
            idBox.hidden = false;
            idBox.onclick = e => {
              const b = e.target.closest("[data-guess]");
              if (!b) return;
              applyGuess(g, b.dataset.guess === "main" ? null : g.alternatives[Number(b.dataset.guess)]);
              idBox.innerHTML = '<div class="meta">Name filled in. Tap “Fill with AI” for the rest.</div>';
            };
          } catch (err) {
            if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) { handleError(err); return; }
            idBox.innerHTML = err.code === "CANCELLED" ? '<div class="meta">Identification cancelled. The photo is kept; type the name instead.</div>'
                                                       : '<div class="form-error-inline">' + esc(err.message) + '</div>';
            idBox.hidden = false;
          } finally { pick.status(""); }
        });
      },
      onSubmit: async (vals, form) => {
        const picked = $$("input[name^='tank:']", form).filter(el => el.checked).map(el => el.name.slice(5));
        if (!isAdmin() && !picked.length) throw new Error("Check at least one of your tanks.");
        if (!(await checkVendorField(vals, form, "w_vendor"))) return false;
        if (!reuseId && !(await checkListFields(vals, form, wishItemFields(type)))) return false;
        const price = String(vals.w_price || "").replace(/[$,\s]/g, "");
        if (price && isNaN(Number(price))) throw new Error("Estimated price must be an amount like 24.99.");
        const values = {};
        if (!reuseId) {
          $$("input[name], select[name], textarea[name]", $(".wish-details", form)).forEach(el => { values[el.name] = el.value; });
          const req = wishItemFields(type).filter(f => f.required && !String(values[f.name] || "").trim()).map(f => f.name);
          if (req.length) throw new Error("Please fill in: " + req.join(", ") + ".");
        }
        const payload = {
          itemType: type, itemId: reuseId || undefined, values: values, tanks: picked,
          wish: { priority: vals.w_priority, status: vals.w_status, estimatedPrice: price, vendor: vals.w_vendor, link: vals.w_link, notes: vals.w_notes },
          photo: image ? { data: image.data, mimeType: image.mimeType } : undefined,
          thumbnail: !image && commons ? commons : undefined
        };
        busy(true);
        let res;
        try {
          res = await api("addWish", payload);
        } catch (err) {
          busy(false);
          if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) return authStop(err);
          throw err;
        }
        let note = "Added to the wishlist";
        // The compatibility check can be cancelled; the wish stays either way (Recheck later from its page).
        const chk = aiJob();
        busy(false); busy(true, () => chk.cancel(), "Checking compatibility…");
        try { await chk.run("checkWish", { wishId: res.wishId }); }
        catch (err) { note = err.code === "CANCELLED" ? "Added. Compatibility check cancelled; use Recheck on the wish later." : "Added. The compatibility check didn’t run: " + err.message; }
        busy(false); busy(true);
        try { applyBootstrap(await api("bootstrap")); } catch (err) { /* shown on next refresh */ }
        busy(false);
        location.hash = "#/wish/" + encodeURIComponent(res.wishId);
        render();
        toast(note, note !== "Added to the wishlist");
        return true;
      }
    });
  }

  function editWishForm(id) {
    const w = findWish(id);
    if (!w) return;
    const open = wishIsOpen(w);
    const pend = wishPending(id).map(a => a["Tank ID"]);
    const tanks = state.data.tanks.filter(t => !isRetired(t) && (canEditTank(t["Tank ID"]) || pend.indexOf(t["Tank ID"]) !== -1))
      .sort((a, b) => String(a["Tank Name"]).localeCompare(String(b["Tank Name"])));
    const cur = { priority: w["Priority"] || "", status: w["Wish Status"] || "", estimatedPrice: w["Estimated Price"] === "" ? "" : String(w["Estimated Price"]).replace(/[$,]/g, ""),
                  vendor: w["Vendor"] || "", link: w["Link"] || "", notes: w["Notes"] || "" };
    openSheet({
      title: "Edit wish",
      body: '<p class="meta">' + esc(id + " · " + wishTitle(w)) + '</p>' +
        fieldHtml({ name: "priority", label: "Priority", type: "select", html: state.wishOptions.priorities.map(p => '<option' + (p === cur.priority ? " selected" : "") + '>' + esc(p) + '</option>').join("") }) +
        (open ? fieldHtml({ name: "status", label: "Wish status", type: "select", html: ["Researching", "Want"].map(p => '<option' + (p === cur.status ? " selected" : "") + '>' + esc(p) + '</option>').join("") }) : "") +
        '<div class="field"><label for="f_price">Estimated price</label><input type="text" inputmode="decimal" id="f_price" name="estimatedPrice" value="' + esc(cur.estimatedPrice) + '" autocomplete="off"></div>' +
        comboHtml({ name: "vendor", label: "Where to buy", mode: "free", noThumbs: true, newLabel: "will be added to the vendor list", value: cur.vendor,
                    placeholder: "Choose or type a store" }, vendorItems()) +
        fieldHtml({ name: "link", label: "Link", type: "url" }, cur.link) +
        fieldHtml({ name: "notes", label: "Notes", type: "longtext" }, cur.notes) +
        (open ? '<div class="form-section"><h3>Which tanks?</h3>' + tanks.map(t => {
          const can = canEditTank(t["Tank ID"]);
          return '<label class="check"><input type="checkbox" name="tank:' + esc(t["Tank ID"]) + '"' + (pend.indexOf(t["Tank ID"]) !== -1 ? " checked" : "") + (can ? "" : " disabled") + '> ' +
            esc(t["Tank Name"]) + ' <span class="meta">' + esc(t["Tank ID"]) + (can ? "" : " · not yours to change") + '</span></label>';
        }).join("") + '<p class="hint">After changing tanks, tap Recheck on the wish.</p></div>' : ""),
      onReady: form => $$("[data-combo]", form).forEach(wireCombo),
      onSubmit: async (vals, form) => {
        if (vals.vendor !== cur.vendor && !(await checkVendorField(vals, form, "vendor"))) return false;
        const price = String(vals.estimatedPrice || "").replace(/[$,\s]/g, "");
        if (price && isNaN(Number(price))) throw new Error("Estimated price must be an amount like 24.99.");
        vals.estimatedPrice = price;
        const changed = {};
        ["priority", "status", "estimatedPrice", "vendor", "link", "notes"].forEach(k => {
          if (!(k in vals)) return;
          const a = k === "estimatedPrice" ? (cur[k] === "" ? "" : Number(cur[k]).toFixed(2)) : String(cur[k]).trim();
          const b = k === "estimatedPrice" ? (vals[k] === "" ? "" : Number(vals[k]).toFixed(2)) : String(vals[k] || "").trim();
          if (a !== b) changed[k] = vals[k];
        });
        const payload = { wishId: id, wish: changed };
        if (open) {
          const picked = $$("input[name^='tank:']", form).filter(el => el.checked).map(el => el.name.slice(5));
          if (!isAdmin() && !picked.length) throw new Error("Keep at least one tank checked, or use “Not getting”.");
          const same = picked.length === pend.length && picked.every(t => pend.indexOf(t) !== -1);
          if (!same) payload.tanks = picked;
        }
        if (!Object.keys(changed).length && !payload.tanks) { toast("No changes"); return true; }
        return write("updateWish", payload, "Wish saved");
      }
    });
  }

  function closeWishForm(id) {
    const w = findWish(id);
    if (!w) return;
    const r = wishItem(w);
    openSheet({
      title: "Not getting it?",
      submitLabel: "Close wish",
      danger: true,
      body: '<p>Close <b>' + esc(id + " " + wishTitle(w)) + '</b> as “Not getting”? Its tank rows are closed' +
        (w["New Item"] === true && r && isWishItem(r) ? ', and ' + esc(w["Item ID"]) + ' (added just for this wish) is marked Retired' : "") +
        '. Nothing is deleted.</p>',
      onSubmit: () => write("closeWish", { wishId: id }, "Wish closed")
    });
  }

  function purchaseWishForm(id) {
    const w = findWish(id);
    if (!w) return;
    const type = w["Item Type"];
    const r = wishItem(w);
    const pend = wishPending(id).map(a => a["Tank ID"]);
    const inTank = new Set(type === "equipment" ? [] : state.data.assignments.filter(a => a["Item ID"] === w["Item ID"] && isActiveAssignment(a)).map(a => a["Tank ID"]));
    const tanks = wishTanksAllowed();
    const receipts = canReceipts() ? state.receipts.filter(x => !isRetired(x)).sort((x, y) => receiptSortKey(y).localeCompare(receiptSortKey(x))) : [];
    openSheet({
      title: "Mark purchased",
      submitLabel: "Add to tanks",
      body: '<p class="meta">' + esc(id + " · " + wishTitle(w) + " (" + w["Item ID"] + ")") + '</p>' +
        fieldHtml({ name: "purchaseDate", label: "Purchase date", type: "date", required: true }, today()) +
        comboHtml({ name: "vendor", label: "Vendor", mode: "free", noThumbs: true, newLabel: "will be added to the vendor list", value: w["Vendor"] || "",
                    placeholder: "Choose or type a store" }, vendorItems()) +
        '<div class="field"><label for="f_paid">Price paid</label><input type="text" inputmode="decimal" id="f_paid" name="pricePaid" placeholder="' + esc(w["Estimated Price"] ? "Estimated " + money(w["Estimated Price"]) : "0.00") + '" autocomplete="off"></div>' +
        (canReceipts() ? fieldHtml({ name: "receiptId", label: "Receipt", type: "select", hint: "Optional. Upload it first under Receipts if it isn’t there.",
          html: '<option value="">None</option>' + receipts.map(x => '<option value="' + esc(x["Receipt ID"]) + '">' + esc([x["Receipt ID"], receiptTitle(x), money(x["Total"])].filter(Boolean).join(" · ")) + '</option>').join("") }) : "") +
        '<div class="form-section"><h3>Add to which tanks?</h3>' +
          (type === "equipment" ? '<p class="hint">Each tank gets its own piece of equipment. The first uses ' + esc(w["Item ID"]) + (r && !isWishItem(r) ? " only if it isn’t already in use; otherwise new Equipment IDs are created" : "; any others get new Equipment IDs with the same details") + '.</p>' : "") +
          tanks.map(t => {
            const tid = t["Tank ID"];
            const there = inTank.has(tid);
            return '<div class="tank-pick"><label class="check"><input type="checkbox" name="tank:' + esc(tid) + '"' + (pend.indexOf(tid) !== -1 && !there ? " checked" : "") + (there ? " disabled" : "") + '> ' +
              esc(t["Tank Name"]) + ' <span class="meta">' + esc(tid) + (there ? " · already in this tank" : pend.indexOf(tid) !== -1 ? " · wished" : "") + '</span></label>' +
              '<div class="tank-extra" hidden>' +
                fieldHtml({ name: "date:" + tid, label: "Date added", type: "date" }, today()) +
                fieldHtml({ name: "notes:" + tid, label: "Notes", type: "longtext" }, "") + '</div></div>';
          }).join("") + '</div>',
      onReady: form => {
        $$("[data-combo]", form).forEach(wireCombo);
        const sync = () => $$(".tank-pick", form).forEach(b => { $(".tank-extra", b).hidden = !$("input[type=checkbox]", b).checked; });
        form.addEventListener("change", sync);
        // Each tank's Date added follows the purchase date until it's changed by hand.
        $$("input[name^='date:']", form).forEach(el => el.addEventListener("input", () => { el.dataset.touched = "1"; }));
        $("[name=purchaseDate]", form).addEventListener("change", e => {
          $$("input[name^='date:']", form).forEach(el => { if (!el.dataset.touched) el.value = e.target.value; });
        });
        sync();
      },
      onSubmit: async (vals, form) => {
        const picked = $$("input[name^='tank:']", form).filter(el => el.checked && !el.disabled).map(el => el.name.slice(5));
        if (!picked.length) throw new Error("Choose at least one tank to add it to.");
        if (!(await checkVendorField(vals, form, "vendor"))) return false;
        const paid = String(vals.pricePaid || "").replace(/[$,\s]/g, "");
        if (paid && isNaN(Number(paid))) throw new Error("Price paid must be an amount like 24.99.");
        return write("purchaseWish", {
          wishId: id, purchaseDate: vals.purchaseDate, vendor: vals.vendor, pricePaid: paid, receiptId: vals.receiptId || "",
          tanks: picked.map(t => ({ tankId: t, dateAdded: vals["date:" + t] || vals.purchaseDate, notes: vals["notes:" + t] || "" }))
        }, "Added to " + picked.map(tankName).join(", "));
      }
    });
  }

  async function checkWishNow(id) {
    const chk = aiJob();
    busy(true, () => chk.cancel(), "Checking compatibility…");
    try {
      const res = await chk.run("checkWish", { wishId: id });
      toast(res.summary ? "Checked: " + res.summary : "Compatibility checked");
      refreshInBackground();
    } catch (err) {
      if (err.code === "CANCELLED") toast("Compatibility check cancelled");
      else if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) handleError(err); else toast(err.message, true);
    } finally {
      busy(false);
    }
  }

  // ------------------------------------------------------------------
  // Water testing
  // ------------------------------------------------------------------
  const canLogTank = id => isAdmin() || (state.me && state.me.tanks.indexOf(id) !== -1);
  const canCorrect = row => isAdmin() || (state.me && row["Tested By"] === state.me.id);
  const isLive = r => String(r["Status"] || "Active") !== "Retired";
  const activeTypes = () => state.testTypes.filter(isLive);
  const findType = id => state.testTypes.find(t => t["Test Type ID"] === id);
  const methodsOf = t => String(t["Allowed Methods"] || "").split(",").map(s => s.trim()).filter(m => state.methods.indexOf(m) !== -1);
  const unitsOf = t => (t && t["Units"]) ? " " + t["Units"] : "";
  const num = v => (v === "" || v === null || v === undefined || isNaN(Number(String(v).replace(/,/g, "")))) ? null : Number(String(v).replace(/,/g, ""));
  function parseDT(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(s || ""));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
  }
  const fmtDT = s => { const d = parseDT(s); return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : ""; };
  const fmtDTLong = s => { const d = parseDT(s); return d ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : ""; };
  const fmtNum = v => { const n = num(v); return n === null ? String(v) : String(Math.round(n * 1000) / 1000); };
  function localNow() {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function rangeFor(tankId, t) {
    const rows = state.data.waterParameters.filter(p => p["Tank ID"] === tankId);
    const r = rows.find(p => p["Test Type ID"] === t["Test Type ID"]) ||
              rows.find(p => String(p["Parameter"]).toLowerCase() === String(t["Name"]).toLowerCase());
    return r ? { min: num(r["Acceptable Min"]), max: num(r["Acceptable Max"]), target: r["Target"] } : { min: null, max: null, target: "" };
  }
  const rangeText = (rg, t) => (rg.min === null && rg.max === null) ? "No range set" :
    (rg.min !== null ? fmtNum(rg.min) : "–") + "–" + (rg.max !== null ? fmtNum(rg.max) : "–") + unitsOf(t);
  function checkValue(v, rg) {
    if (rg.min === null && rg.max === null) return null;
    if (rg.min !== null && v < rg.min) return { result: "Low", by: rg.min - v, limit: rg.min };
    if (rg.max !== null && v > rg.max) return { result: "High", by: v - rg.max, limit: rg.max };
    return { result: "In range" };
  }
  // Counts readings by result: out of range, in range, and no range set.
  function resultCounts(rows) {
    const c = { off: 0, ok: 0, none: 0 };
    rows.forEach(r => {
      if (r["Result"] === "High" || r["Result"] === "Low") c.off++;
      else if (r["Result"] === "In range") c.ok++;
      else c.none++;
    });
    return c;
  }
  function countPills(c) {
    const p = [];
    if (c.off) p.push('<span class="pill bad">' + c.off + ' out of range</span>');
    if (c.ok) p.push('<span class="pill good">✓ ' + (c.off || c.none ? c.ok + " in range" : "All in range") + '</span>');
    if (c.none) p.push('<span class="pill">' + c.none + ' no range</span>');
    return p.length ? '<div class="pill-stack">' + p.join("") + '</div>' : "";
  }
  function resultPill(result) {
    if (result === "High") return '<span class="pill bad">▲ High</span>';
    if (result === "Low") return '<span class="pill bad">▼ Low</span>';
    if (result === "In range") return '<span class="pill good">✓ In range</span>';
    return '<span class="pill">No range</span>';
  }
  const cutoffDate = () => { const d = new Date(); d.setDate(d.getDate() - state.waterDays); return d; };
  function readings(tankId, typeId, all) {
    const cut = cutoffDate();
    return state.waterTests.filter(r => r["Tank ID"] === tankId && r["Test Type ID"] === typeId && isLive(r))
      .map(r => Object.assign({}, r, { _t: parseDT(r["Tested At"]) }))
      .filter(r => r._t && (all || r._t >= cut))
      .sort((x, y) => x._t - y._t);
  }
  function defaultWaterTank() {
    const tanks = state.data.tanks.filter(t => !isRetired(t));
    if (state.waterTank && findRec("tanks", state.waterTank)) return state.waterTank;
    const mine = tanks.find(t => canLogTank(t["Tank ID"]));
    return (mine || tanks[0] || {})["Tank ID"] || "";
  }

  // Small single-series chart: acceptable range shaded, out-of-range points marked.
  function trendSvg(points, rg, t, big) {
    const W = 320, H = big ? 180 : 92, L = 34, R = 8, T = 10, B = 18;
    const now = new Date(), cut = cutoffDate();
    const vals = points.map(p => num(p["Value"]));
    let lo = Math.min.apply(null, vals.concat(rg.min !== null ? [rg.min] : []).concat(rg.max !== null ? [rg.max] : []));
    let hi = Math.max.apply(null, vals.concat(rg.min !== null ? [rg.min] : []).concat(rg.max !== null ? [rg.max] : []));
    if (lo === hi) { const pad = Math.abs(lo) * 0.1 || 1; lo -= pad; hi += pad; }
    const span = hi - lo; lo -= span * 0.12; hi += span * 0.12;
    const x = d => L + (W - L - R) * Math.max(0, Math.min(1, (d - cut) / (now - cut)));
    const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    let svg = '<svg class="trend" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' +
      esc(t["Name"] + " over the last " + state.waterDays + " days") + '">';
    if (rg.min !== null || rg.max !== null) {
      const y1 = y(rg.max !== null ? rg.max : hi), y2 = y(rg.min !== null ? rg.min : lo);
      svg += '<rect class="band" x="' + L + '" y="' + y1.toFixed(1) + '" width="' + (W - L - R) + '" height="' + Math.max(1.5, y2 - y1).toFixed(1) + '"/>';
    }
    svg += '<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '"/>';
    // Water changes in this window: dashed marker with a small drop at the bottom.
    const tankOfPts = points.length ? points[0]["Tank ID"] : "";
    let wcCount = 0;
    waterChangesFor(tankOfPts).forEach(w => {
      const d = parseDT(w["Performed At"]);
      if (!d || d < cut || d > now) return;
      wcCount++;
      const wx = x(d).toFixed(1);
      svg += '<g class="wc-mark"><title>' + esc("Water change " + fmtDT(w["Performed At"]) + (wcAmount(w) ? " · " + wcAmount(w) : "")) + '</title>' +
        '<line x1="' + wx + '" x2="' + wx + '" y1="' + T + '" y2="' + (H - B) + '"/>' +
        '<circle cx="' + wx + '" cy="' + (H - B) + '" r="2.6"/></g>';
    });
    const dataLo = Math.min.apply(null, vals), dataHi = Math.max.apply(null, vals);
    const ticks = (rg.min !== null || rg.max !== null) ? [rg.max, rg.min].filter(v => v !== null) : (dataLo === dataHi ? [dataHi] : [dataHi, dataLo]);
    ticks.filter((v, i, arr) => arr.indexOf(v) === i).forEach(v => {
      svg += '<text class="tick" x="' + (L - 4) + '" y="' + (y(v) + 3).toFixed(1) + '" text-anchor="end">' + esc(fmtNum(Math.round(v * 100) / 100)) + '</text>';
    });
    // Date labels along the bottom: 4 on the small cards, 6 on the big chart, evenly spaced.
    const nTicks = big ? 6 : 4;
    const longSpan = (now - cut) > 300 * 864e5;
    for (let i = 0; i < nTicks; i++) {
      const d = new Date(cut.getTime() + (now - cut) * i / (nTicks - 1));
      const tx = x(d);
      const label = i === nTicks - 1 ? "Today" : d.toLocaleDateString(undefined, longSpan ? { month: "short", year: "2-digit" } : { month: "short", day: "numeric" });
      if (i > 0 && i < nTicks - 1) svg += '<line class="grid" x1="' + tx.toFixed(1) + '" x2="' + tx.toFixed(1) + '" y1="' + T + '" y2="' + (H - B) + '"/>';
      svg += '<text class="tick" x="' + tx.toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' + (i === 0 ? "start" : i === nTicks - 1 ? "end" : "middle") + '">' + esc(label) + '</text>';
    }
    if (points.length > 1) {
      svg += '<path class="line" d="' + points.map((p, i) => (i ? "L" : "M") + x(p._t).toFixed(1) + " " + y(num(p["Value"])).toFixed(1)).join(" ") + '"/>';
    }
    points.forEach(p => {
      const off = p["Result"] === "High" || p["Result"] === "Low";
      svg += '<circle class="pt' + (off ? " off" : "") + '" cx="' + x(p._t).toFixed(1) + '" cy="' + y(num(p["Value"])).toFixed(1) + '" r="' + (off ? 4.5 : (big ? 3.5 : 2.8)) + '"/>';
    });
    svg += '</svg>';
    // Details for the hover / tap pop-up, one entry per point (x and y as fractions of the chart).
    const data = points.map(p => {
      const s = state.waterSessions.find(z => z["Session ID"] === p["Session ID"]) || {};
      const mn = num(p["Range Min"]), mx = num(p["Range Max"]);
      return {
        x: x(p._t) / W, y: y(num(p["Value"])) / H,
        id: p["Test ID"], sid: p["Session ID"],
        when: fmtDTLong(p["Tested At"]), val: fmtNum(p["Value"]) + unitsOf(t), res: p["Result"] || "",
        range: (mn === null && mx === null) ? "" : rangeText({ min: mn, max: mx }, t),
        method: p["Method"] || "", by: personName(p["Tested By"]),
        note: p["Notes"] || "", snote: s["Notes"] || ""
      };
    });
    return '<div class="trend-wrap" data-name="' + esc(t["Name"]) + '" data-points="' + esc(JSON.stringify(data)) + '">' + svg +
      (wcCount ? '<div class="wc-key"><span class="wc-key-line"></span>water change</div>' : "") +
      '<div class="trend-tip" role="tooltip" hidden></div></div>';
  }

  function waterCard(tankId, t) {
    const pts = readings(tankId, t["Test Type ID"]);
    const rg = rangeFor(tankId, t);
    const last = pts[pts.length - 1];
    return '<div class="card pad water-card' + (isLive(t) ? "" : " dim") + '" data-act="go" data-href="#/water/' + encodeURIComponent(tankId) + '/' + encodeURIComponent(t["Test Type ID"]) + '">' +
      '<div class="wc-head"><div><div class="title">' + esc(t["Name"]) + (isLive(t) ? "" : ' <span class="pill retired">Retired</span>') + '</div>' +
      '<div class="sub">' + esc((rg.min === null && rg.max === null) ? "No range set" : "Range " + rangeText(rg, t)) + '</div></div>' +
      (last ? '<div class="wc-last"><div class="val">' + esc(fmtNum(last["Value"]) + unitsOf(t)) + '</div>' + resultPill(last["Result"]) + '</div>' : "") + '</div>' +
      (pts.length ? trendSvg(pts, rg, t, false) + '<div class="sub">' + pts.length + ' reading' + (pts.length === 1 ? "" : "s") + ' · last ' + esc(fmtDT(last["Tested At"])) + '</div>'
                  : '<div class="empty small">No readings in the last ' + state.waterDays + ' days</div>') +
      '</div>';
  }

  function waterControls(tankId, base) {
    const tanks = state.data.tanks.slice().sort((x, y) => (isRetired(x) - isRetired(y)) || String(x["Tank Name"]).localeCompare(String(y["Tank Name"])));
    return '<div class="water-controls">' +
      '<select data-act="water-tank" aria-label="Tank">' + tanks.map(t => '<option value="' + esc(t["Tank ID"]) + '"' + (t["Tank ID"] === tankId ? " selected" : "") + '>' +
        esc(t["Tank Name"] + (isRetired(t) ? " (retired)" : "")) + '</option>').join("") + '</select>' +
      '<label class="days">Last <input type="number" min="1" max="3650" inputmode="numeric" value="' + state.waterDays + '" data-act="water-days" data-base="' + esc(base) + '"> days</label>' +
      '</div>';
  }

  function viewWater(tankId) {
    tankId = tankId || defaultWaterTank();
    if (!tankId) return { title: "Test", html: '<div class="empty">' + (isAdmin() ? "No tanks yet." : "No tanks are assigned to you yet.") + '</div>' };
    const types = activeTypes().concat(state.testTypes.filter(t => !isLive(t) && readings(tankId, t["Test Type ID"]).length));
    const tested = types.filter(t => readings(tankId, t["Test Type ID"]).length);
    const untested = types.filter(t => !readings(tankId, t["Test Type ID"]).length);
    const cut = cutoffDate();
    const sessions = state.waterSessions.filter(s => s["Tank ID"] === tankId && isLive(s) && (parseDT(s["Tested At"]) || 0) >= cut)
      .sort((x, y) => parseDT(y["Tested At"]) - parseDT(x["Tested At"])).slice(0, 15);
    const actions = '<div class="actions" style="margin:0 0 12px">' +
      (canLogTank(tankId) ? '<button class="btn primary" data-act="log-water" data-tank="' + esc(tankId) + '">' + ICONS.plus + 'Log water test</button>' : "") +
      (isAdmin() ? '<a class="btn" href="#/testtypes">Test types</a>' : "") + '</div>';
    const sessHtml = '<div class="section"><div class="section-head"><h3>Recent tests (' + sessions.length + ')</h3></div><div class="card list">' +
      (sessions.map(s => {
        const rs = state.waterTests.filter(r => r["Session ID"] === s["Session ID"] && isLive(r));
        const c = resultCounts(rs);
        return '<div class="list-item" data-act="water-session" data-id="' + esc(s["Session ID"]) + '"><div class="body">' +
          '<div class="title">' + esc(fmtDT(s["Tested At"])) + '</div>' +
          '<div class="sub">' + esc([rs.length + " reading" + (rs.length === 1 ? "" : "s"), personName(s["Tested By"]), s["Notes"]].filter(Boolean).join(" · ")) + '</div></div>' +
          countPills(c) + '</div>';
      }).join("") || '<div class="empty">No tests in the last ' + state.waterDays + ' days</div>') + '</div></div>';
    return {
      title: "Test · " + tankName(tankId),
      keepScroll: true,
      html: waterControls(tankId, "water") + actions + tested.map(t => waterCard(tankId, t)).join("") +
        (untested.length ? '<div class="card pad untested"><div class="sub">Not tested in the last ' + state.waterDays + ' days</div><div class="chips-row">' +
          untested.map(t => '<a class="chip-link" href="#/water/' + encodeURIComponent(tankId) + '/' + encodeURIComponent(t["Test Type ID"]) + '">' + esc(t["Name"]) + '</a>').join("") + '</div></div>' : "") +
        sessHtml
    };
  }

  function viewWaterType(tankId, typeId) {
    const t = findType(typeId);
    if (!t) return { title: "Water", back: true, html: '<div class="empty">That test type wasn’t found.</div>' };
    const rg = rangeFor(tankId, t);
    const pts = readings(tankId, typeId);
    const list = pts.slice().reverse();
    return {
      title: t["Name"] + " · " + tankName(tankId), back: true, keepScroll: true,
      html: waterControls(tankId, "water/" + typeId) +
        '<div class="card pad"><div class="sub" style="margin-bottom:6px">' + esc("Acceptable range: " + rangeText(rg, t)) +
          (rg.target !== "" && rg.target !== undefined ? esc(" · target " + rg.target) : "") + '</div>' +
          (pts.length ? trendSvg(pts, rg, t, true) : '<div class="empty">No readings in the last ' + state.waterDays + ' days</div>') + '</div>' +
        '<div class="section"><div class="section-head"><h3>Readings (' + list.length + ')</h3></div><div class="card list">' +
        (list.map(r => '<div class="list-item"' + (canCorrect(r) ? ' data-act="edit-reading" data-id="' + esc(r["Test ID"]) + '"' : "") + '><div class="body">' +
          '<div class="title">' + esc(fmtNum(r["Value"]) + unitsOf(t)) + '</div>' +
          '<div class="sub">' + esc([fmtDT(r["Tested At"]), r["Method"], personName(r["Tested By"])].filter(Boolean).join(" · ")) + '</div>' +
          (r["Notes"] ? '<div class="sub">' + esc(r["Notes"]) + '</div>' : "") + '</div>' + resultPill(r["Result"]) + '</div>').join("") ||
          '<div class="empty">None</div>') + '</div></div>'
    };
  }

  function waterSection(tankId) {
    const types = activeTypes();
    const latest = types.map(t => { const p = readings(tankId, t["Test Type ID"], true); return p.length ? { t: t, r: p[p.length - 1] } : null; }).filter(Boolean);
    return '<div class="section"><div class="section-head"><h3>Water tests</h3>' +
      '<a class="btn small" href="#/water/' + encodeURIComponent(tankId) + '">Trends</a></div>' +
      '<div class="card pad">' +
      (latest.length ? '<div class="latest-grid">' + latest.map(x => '<div class="lg-item' + (x.r["Result"] === "High" || x.r["Result"] === "Low" ? " off" : "") + '">' +
        '<div class="k">' + esc(x.t["Name"]) + '</div><div class="v">' + esc(fmtNum(x.r["Value"]) + unitsOf(x.t)) +
        (x.r["Result"] === "High" ? " ▲" : x.r["Result"] === "Low" ? " ▼" : "") + '</div></div>').join("") + '</div>' +
        '<div class="sub">Latest of each test</div>'
        : '<div class="empty">No water tests yet</div>') +
      (canLogTank(tankId) ? '<div class="actions"><button class="btn primary" data-act="log-water" data-tank="' + esc(tankId) + '">' + ICONS.plus + 'Log water test</button></div>' : "") +
      '</div></div>';
  }

  function logWaterForm(tankId) {
    const loggable = state.data.tanks.filter(t => !isRetired(t) && canLogTank(t["Tank ID"]));
    if (!loggable.length) { toast("You don’t have any tanks assigned for testing.", true); return; }
    if (!canLogTank(tankId)) tankId = loggable[0]["Tank ID"];
    let method = "Strip";
    try { const m = localStorage.getItem("aa_water_method"); if (state.methods.indexOf(m) !== -1) method = m; } catch (e) { /* ignore */ }
    const entered = {};   // typed values/notes survive switching method or tank
    const fmtLim = v => v === null ? "—" : fmtNum(v);
    const tableHtml = (tank, m) => {
      const types = activeTypes().filter(t => methodsOf(t).indexOf(m) !== -1);
      if (!types.length) return '<div class="empty">No active tests use ' + esc(m) + '. Add one under Test types.</div>';
      return '<div class="wt-table"><div class="wt-th"><span>Field</span><span>Entry</span><span>Note</span><span>Alert</span><span>Min</span><span>Max</span></div>' +
        types.map(t => {
          const id = t["Test Type ID"], rg = rangeFor(tank, t), prev = entered[id] || {};
          return '<div class="wt-tr" data-type="' + esc(id) + '">' +
            '<div class="wt-cells">' +
              '<label class="wt-field" for="wt_' + esc(id) + '">' + esc(t["Name"]) + (t["Units"] ? '<span class="u">' + esc(t["Units"]) + '</span>' : "") + '</label>' +
              '<input type="text" inputmode="decimal" id="wt_' + esc(id) + '" class="wt-val" autocomplete="off" value="' + esc(prev.value || "") + '">' +
              '<button type="button" class="wt-notebtn' + (prev.note ? " has" : "") + '" aria-label="Note for ' + esc(t["Name"]) + '">✎</button>' +
              '<span class="wt-flag" aria-live="polite"></span>' +
              '<span class="wt-lim">' + esc(fmtLim(rg.min)) + '</span>' +
              '<span class="wt-lim">' + esc(fmtLim(rg.max)) + '</span>' +
            '</div>' +
            '<input type="text" class="wt-note" placeholder="Note for ' + esc(t["Name"]) + '" value="' + esc(prev.note || "") + '"' + (prev.note ? "" : " hidden") + '>' +
            '<div class="wt-alert" hidden></div>' +
          '</div>';
        }).join("") + '</div>';
    };
    openSheet({
      title: "Log water test",
      submitLabel: "Save readings",
      body:
        '<div class="wt-top">' +
          '<div class="field"><label for="f_wtank">Tank</label><select id="f_wtank">' + loggable.map(t => '<option value="' + esc(t["Tank ID"]) + '"' + (t["Tank ID"] === tankId ? " selected" : "") + '>' + esc(t["Tank Name"]) + '</option>').join("") + '</select></div>' +
          '<div class="field"><label for="f_wmethod">Method</label><select id="f_wmethod">' + state.methods.map(m => '<option' + (m === method ? " selected" : "") + '>' + m + '</option>').join("") + '</select></div>' +
        '</div>' +
        '<div class="field"><label for="f_wnotes">Notes</label><textarea id="f_wnotes" placeholder="About this test as a whole (e.g. before water change)"></textarea></div>' +
        '<div class="field"><label for="f_wtime">Tested at</label><input type="datetime-local" id="f_wtime" value="' + localNow() + '" max="' + localNow() + '"></div>' +
        '<div id="wt-table-wrap">' + tableHtml(tankId, method) + '</div>' +
        '<p class="hint">Fill in only what you tested. Min/Max come from the tank’s Target ranges; ✎ adds a note to one reading.</p>',
      onReady: form => {
        const wrap = $("#wt-table-wrap", form);
        const tankSel = $("#f_wtank", form), methodSel = $("#f_wmethod", form);
        const wire = () => {
          $$(".wt-tr", wrap).forEach(row => {
            const id = row.dataset.type, t = findType(id);
            const input = $(".wt-val", row), note = $(".wt-note", row), btn = $(".wt-notebtn", row);
            const flag = $(".wt-flag", row), alertBox = $(".wt-alert", row);
            const check = () => {
              const raw = input.value.trim();
              entered[id] = Object.assign(entered[id] || {}, { value: input.value });
              row.classList.remove("is-off", "is-ok", "is-bad");
              alertBox.hidden = true; flag.textContent = ""; flag.title = "";
              if (!raw) return;
              const v = num(raw);
              if (v === null) { row.classList.add("is-bad"); flag.textContent = "!"; alertBox.textContent = "Enter a number"; alertBox.hidden = false; return; }
              const res = checkValue(v, rangeFor(tankSel.value, t));
              if (res && (res.result === "High" || res.result === "Low")) {
                row.classList.add("is-off");
                flag.textContent = res.result === "High" ? "▲" : "▼";
                alertBox.textContent = "⚠ " + t["Name"] + " " + fmtNum(v) + unitsOf(t) + " is " + fmtNum(Math.round(res.by * 1000) / 1000) + unitsOf(t) +
                  (res.result === "High" ? " above the max of " : " below the min of ") + fmtNum(res.limit) + unitsOf(t);
                alertBox.hidden = false;
              } else if (res) { row.classList.add("is-ok"); flag.textContent = "✓"; }
            };
            input.addEventListener("input", check);
            note.addEventListener("input", () => { entered[id] = Object.assign(entered[id] || {}, { note: note.value }); btn.classList.toggle("has", !!note.value.trim()); });
            btn.addEventListener("click", () => { note.hidden = !note.hidden; if (!note.hidden) note.focus(); });
            check();
          });
        };
        const redraw = () => { wrap.innerHTML = tableHtml(tankSel.value, methodSel.value); wire(); };
        wire();
        tankSel.addEventListener("change", redraw);
        methodSel.addEventListener("change", () => {
          try { localStorage.setItem("aa_water_method", methodSel.value); } catch (e) { /* ignore */ }
          redraw();
        });
      },
      onSubmit: async (vals, form) => {
        const methodNow = $("#f_wmethod", form).value;
        const readingsOut = [], bad = [];
        $$(".wt-tr", form).forEach(row => {
          const raw = $(".wt-val", row).value.trim();
          if (!raw) return;
          const t = findType(row.dataset.type);
          if (num(raw) === null) { bad.push(t["Name"]); return; }
          readingsOut.push({ testTypeId: row.dataset.type, value: num(raw), method: methodNow, notes: $(".wt-note", row).value.trim() });
        });
        if (bad.length) throw new Error("These need a number: " + bad.join(", ") + ".");
        if (!readingsOut.length) throw new Error("Enter at least one reading.");
        const tank = $("#f_wtank", form).value;
        busy(true);
        try {
          const res = await api("logWaterTest", { tankId: tank, testedAt: $("#f_wtime", form).value, method: methodNow,
                                                   notes: $("#f_wnotes", form).value, readings: readingsOut });
          state.waterTank = tank; try { localStorage.setItem("aa_water_tank", tank); } catch (e) { /* ignore */ }
          render();
          refreshInBackground();
          if (res.outOfRange && res.outOfRange.length) setTimeout(() => waterAlertSheet(tank, res.outOfRange, readingsOut.length), 50);
          else {
            const none = readingsOut.filter(r => { const t = findType(r.testTypeId); const rg = rangeFor(tank, t); return rg.min === null && rg.max === null; }).length;
            const ok = readingsOut.length - none;
            toast(readingsOut.length + " reading" + (readingsOut.length === 1 ? "" : "s") + " saved · " +
                  [ok ? ok + " in range" : "", none ? none + " no range set" : ""].filter(Boolean).join(", "));
          }
          return true;
        } catch (err) {
          if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) return authStop(err);
          throw err;
        } finally { busy(false); }
      }
    });
  }

  function waterAlertSheet(tankId, off, total) {
    openSheet({
      title: "⚠ Out of range",
      submitLabel: "OK",
      body: '<p>' + total + ' reading' + (total === 1 ? "" : "s") + ' saved for <b>' + esc(tankName(tankId)) + '</b>. ' +
        off.length + ' ' + (off.length === 1 ? "is" : "are") + ' outside the acceptable range:</p>' +
        '<div class="card list">' + off.map(o => {
          const u = o.units ? " " + o.units : "";
          const lim = o.result === "High" ? o.max : o.min;
          const by = Math.abs(Number(o.value) - Number(lim));
          return '<div class="list-item"><div class="body"><div class="title">' + esc(o.name) + ': ' + esc(fmtNum(o.value) + u) + '</div>' +
            '<div class="sub">' + esc(fmtNum(Math.round(by * 1000) / 1000) + u + (o.result === "High" ? " above the max of " : " below the min of ") + fmtNum(lim) + u) + '</div></div>' +
            resultPill(o.result) + '</div>';
        }).join("") + '</div>',
      onSubmit: () => true
    });
  }

  function sessionSheet(id) {
    const s = state.waterSessions.find(x => x["Session ID"] === id);
    if (!s) return;
    const rs = state.waterTests.filter(r => r["Session ID"] === id)
      .sort((a, b) => ((findType(a["Test Type ID"]) || {})["Order"] || 0) - ((findType(b["Test Type ID"]) || {})["Order"] || 0));
    const editable = canCorrect(s);
    const live = rs.filter(isLive);
    const okMethods = state.methods.filter(m => live.every(r => { const t = findType(r["Test Type ID"]); return !t || methodsOf(t).indexOf(m) !== -1; }));
    openSheet({
      title: tankName(s["Tank ID"]) + " · " + fmtDT(s["Tested At"]),
      submitLabel: editable ? "Save" : "Close",
      body: (editable
          ? '<div class="field"><label for="f_smethod">Method</label><select id="f_smethod" name="method">' +
              (okMethods.indexOf(s["Method"]) === -1 && s["Method"] ? '<option selected>' + esc(s["Method"]) + '</option>' : "") +
              okMethods.map(m => '<option' + (m === s["Method"] ? " selected" : "") + '>' + m + '</option>').join("") + '</select></div>' +
            '<div class="field"><label for="f_stime">Tested at</label><input type="datetime-local" id="f_stime" name="testedAt" value="' + esc(String(s["Tested At"]).replace(" ", "T")) + '"></div>' +
            '<div class="field"><label for="f_snotes">Test notes</label><textarea id="f_snotes" name="notes">' + esc(s["Notes"]) + '</textarea></div>'
          : (s["Notes"] ? '<p>' + esc(s["Notes"]) + '</p>' : "")) +
        '<p class="meta">' + esc([s["Session ID"], editable ? "" : s["Method"], "Logged by " + personName(s["Tested By"])].filter(Boolean).join(" · ")) + '</p>' +
        '<div class="card list">' + rs.map(r => {
          const t = findType(r["Test Type ID"]) || { Name: r["Test Type"], Units: r["Units"] };
          return '<div class="list-item' + (isLive(r) ? "" : " dim") + '"' + (canCorrect(r) ? ' data-act="edit-reading" data-id="' + esc(r["Test ID"]) + '"' : "") + '><div class="body">' +
            '<div class="title">' + esc(t["Name"] + ": " + fmtNum(r["Value"]) + unitsOf(t)) + '</div>' +
            '<div class="sub">' + esc([r["Notes"], isLive(r) ? "" : "Retired"].filter(Boolean).join(" · ")) + '</div></div>' +
            (isLive(r) ? resultPill(r["Result"]) : "") + '</div>';
        }).join("") + '</div>' +
        (editable ? '<p class="hint">Tap a reading to correct or retire it.</p>' : ""),
      onSubmit: vals => {
        if (!editable) return true;
        const changed = {};
        if (vals.testedAt && vals.testedAt !== String(s["Tested At"]).replace(" ", "T")) changed.testedAt = vals.testedAt;
        if (String(vals.notes || "").trim() !== String(s["Notes"] || "").trim()) changed.notes = vals.notes;
        if (vals.method && vals.method !== s["Method"]) changed.method = vals.method;
        if (!Object.keys(changed).length) return true;
        return write("updateWaterSession", { id: id, values: changed }, "Saved");
      }
    });
  }

  function readingForm(id) {
    const r = state.waterTests.find(x => x["Test ID"] === id);
    if (!r) return;
    $$(".sheet-backdrop").forEach(b => b.remove());
    document.body.style.overflow = "";
    const t = findType(r["Test Type ID"]) || { Name: r["Test Type"], Units: r["Units"], "Allowed Methods": r["Method"] };
    const rg = { min: num(r["Range Min"]), max: num(r["Range Max"]) };
    openSheet({
      title: "Edit " + t["Name"],
      body: '<p class="meta">' + esc([tankName(r["Tank ID"]), fmtDT(r["Tested At"]), r["Test ID"]].join(" · ")) + '</p>' +
        '<div class="field"><label for="f_rv">Value' + (t["Units"] ? " (" + esc(t["Units"]) + ")" : "") + ' <span class="req">*</span></label>' +
          '<input type="text" inputmode="decimal" id="f_rv" name="value" required value="' + esc(fmtNum(r["Value"])) + '">' +
          '<div class="hint">Range at the time: ' + esc(rangeText(rg, t)) + '</div></div>' +
        '<p class="hint">Method: ' + esc(r["Method"] || "—") + ' (change it on the test as a whole).</p>' +
        '<div class="field"><label for="f_rn">Note</label><input type="text" id="f_rn" name="notes" value="' + esc(r["Notes"]) + '"></div>' +
        '<div class="actions"><button type="button" class="btn ' + (isLive(r) ? "danger" : "") + '" data-retire>' + (isLive(r) ? "Retire this reading" : "Restore this reading") + '</button></div>',
      onReady: form => $("[data-retire]", form).addEventListener("click", async () => {
        try {
          await write("retireWaterReading", { id: id, restore: !isLive(r) }, isLive(r) ? "Reading retired" : "Reading restored");
          $$(".sheet-backdrop").forEach(b => b.remove()); document.body.style.overflow = "";
        } catch (err) { toast(err.message, true); }
      }),
      onSubmit: vals => {
        if (num(vals.value) === null) throw new Error("Value must be a number.");
        const changed = {};
        if (num(vals.value) !== num(r["Value"])) changed.value = num(vals.value);
        if (String(vals.notes || "").trim() !== String(r["Notes"] || "").trim()) changed.notes = vals.notes;
        if (!Object.keys(changed).length) { toast("No changes"); return true; }
        return write("updateWaterReading", { id: id, values: changed }, "Reading updated");
      }
    });
  }

  function viewTestTypes() {
    const rows = state.testTypes.slice().sort((a, b) => (isLive(b) - isLive(a)) || ((Number(a["Order"]) || 0) - (Number(b["Order"]) || 0)));
    return {
      title: "Test types", back: true,
      html: '<div class="actions" style="margin:0 0 12px"><button class="btn primary" data-act="add-testtype">' + ICONS.plus + 'Add test type</button></div>' +
        '<div class="card list">' + rows.map(t => '<div class="list-item' + (isLive(t) ? "" : " dim") + '" data-act="edit-testtype" data-id="' + esc(t["Test Type ID"]) + '">' +
          '<span class="thumb order">' + esc(t["Order"]) + '</span><div class="body"><div class="title">' + esc(t["Name"]) + (t["Units"] ? ' <span class="meta">' + esc(t["Units"]) + '</span>' : "") + '</div>' +
          '<div class="sub">' + esc([t["Test Type ID"], t["Allowed Methods"]].join(" · ")) + '</div></div>' +
          (isLive(t) ? "" : '<span class="pill retired">Retired</span>') + '</div>').join("") + '</div>' +
        '<p class="hint">Order sets the order tests appear in the app (lowest first). It’s also the “Order” column on the Test Types tab.</p>'
    };
  }

  function testTypeForm(id) {
    const t = id ? findType(id) : { "Name": "", "Units": "", "Allowed Methods": "Strip, Liquid", "Order": "", "Notes": "", "Status": "Active" };
    if (!t) return;
    const ms = methodsOf(t);
    openSheet({
      title: id ? "Edit test type" : "Add test type",
      body: (id ? '<p class="meta">' + esc(id) + '</p>' : "") +
        '<div class="field"><label for="f_tn">Name <span class="req">*</span></label><input type="text" id="f_tn" name="name" required value="' + esc(t["Name"]) + '" placeholder="e.g. Phosphate (PO4)"></div>' +
        '<div class="field"><label for="f_tu">Units</label><input type="text" id="f_tu" name="units" value="' + esc(t["Units"]) + '" placeholder="e.g. ppm"></div>' +
        '<div class="field"><label>Allowed methods</label>' + state.methods.map(m => '<label class="check"><input type="checkbox" name="m:' + m + '"' + (ms.indexOf(m) !== -1 ? " checked" : "") + '> ' + m + '</label>').join("") + '</div>' +
        '<div class="field"><label for="f_to">Order</label><input type="number" id="f_to" name="order" inputmode="numeric" value="' + esc(t["Order"]) + '" placeholder="Blank = end of the list"></div>' +
        '<div class="field"><label for="f_tno">Notes</label><textarea id="f_tno" name="notes">' + esc(t["Notes"]) + '</textarea></div>' +
        (id ? '<div class="actions"><button type="button" class="btn ' + (isLive(t) ? "danger" : "") + '" data-retire>' + (isLive(t) ? "Retire test type" : "Restore test type") + '</button></div>' +
              '<p class="hint">Retired tests disappear from new water tests; past readings stay in the history and charts.</p>' : ""),
      onReady: form => { const b = $("[data-retire]", form); if (b) b.addEventListener("click", async () => {
        try { await write("retireTestType", { id: id, restore: !isLive(t) }, isLive(t) ? "Test type retired" : "Test type restored");
              $$(".sheet-backdrop").forEach(x => x.remove()); document.body.style.overflow = ""; } catch (err) { toast(err.message, true); }
      }); },
      onSubmit: (vals, form) => {
        const methods = state.methods.filter(m => $("input[name='m:" + m + "']", form).checked);
        if (!methods.length) throw new Error("Choose at least one testing method.");
        return write("saveTestType", { id: id || undefined, values: { name: vals.name, units: vals.units, methods: methods, order: vals.order, notes: vals.notes } },
                     id ? "Saved" : "Test type added");
      }
    });
  }

  // ------------------------------------------------------------------
  // Maintenance (water changes for now; more types later)
  // ------------------------------------------------------------------
  const canCorrectBy = who => isAdmin() || (state.me && !!who && who === state.me.id);
  const tankVolume = id => { const t = findRec("tanks", id); return t ? num(t["Volume (gal)"]) : null; };
  function equipLabel(id) {
    const r = findRec("equipment", id);
    return id + (r ? " " + TYPES.equipment.title(r) : "");
  }
  // Active filter equipment assigned to a tank (Category starting "Filter").
  function tankFilters(tankId) {
    return tankAssignments(tankId, true)
      .map(a => findRec("equipment", a["Item ID"]))
      .filter(r => r && /^filter/i.test(String(r["Category"] || "")) && !isRetired(r))
      .map(r => r["Equipment ID"]);
  }
  function waterChangesFor(tankId, withRetired) {
    return state.waterChanges.filter(w => w["Tank ID"] === tankId && (withRetired || isLive(w)))
      .sort((a, b) => (parseDT(b["Performed At"]) || 0) - (parseDT(a["Performed At"]) || 0));
  }
  function daysAgo(s) {
    const d = parseDT(s);
    if (!d) return "";
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()), n = new Date();
    const b = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    const days = Math.round((b - a) / 864e5);
    return days <= 0 ? "today" : days === 1 ? "yesterday" : days + " days ago";
  }
  function wcAmount(w) {
    return [w["Percentage"] !== "" && w["Percentage"] !== undefined ? fmtNum(w["Percentage"]) + "%" : "",
            w["Gallons"] !== "" && w["Gallons"] !== undefined ? fmtNum(w["Gallons"]) + " gal" : ""].filter(Boolean).join(" · ");
  }
  const wcFilters = w => String(w["Filters Cleaned"] || "").split(",").map(x => x.trim()).filter(Boolean);
  function lastWaterChangeText(tankId) {
    const w = waterChangesFor(tankId)[0];
    return w ? "Last water change " + daysAgo(w["Performed At"]) : "No water changes logged";
  }
  function wcRow(w, showTank) {
    const f = wcFilters(w);
    return '<div class="list-item' + (isLive(w) ? "" : " dim") + '"' + (canCorrectBy(w["Performed By"]) ? ' data-act="edit-wc" data-id="' + esc(w["Water Change ID"]) + '"' : "") + '><div class="body">' +
      '<div class="title">' + esc((showTank ? tankName(w["Tank ID"]) + " · " : "") + fmtDT(w["Performed At"])) + '</div>' +
      '<div class="sub">' + esc([wcAmount(w) || "Amount not recorded", daysAgo(w["Performed At"]), personName(w["Performed By"])].filter(Boolean).join(" · ")) + '</div>' +
      (f.length ? '<div class="sub">Filter cleaned: ' + esc(f.map(equipLabel).join(", ")) + '</div>' : "") +
      (w["Notes"] ? '<div class="sub">' + esc(w["Notes"]) + '</div>' : "") + '</div>' +
      (isLive(w) ? "" : '<span class="pill retired">Retired</span>') + '</div>';
  }
  function defaultMaintTank() {
    if (state.maintTank && findRec("tanks", state.maintTank)) return state.maintTank;
    return defaultWaterTank();
  }

  function viewMaintenance(tankId) {
    tankId = tankId || defaultMaintTank();
    if (!tankId) return { title: "Maintenance", html: '<div class="empty">' + (isAdmin() ? "No tanks yet." : "No tanks are assigned to you yet.") + '</div>' };
    const tanks = state.data.tanks.slice().sort((x, y) => (isRetired(x) - isRetired(y)) || String(x["Tank Name"]).localeCompare(String(y["Tank Name"])));
    const all = waterChangesFor(tankId, true);
    const live = all.filter(isLive);
    const shown = state.showRetiredMaint ? all : live;
    const retiredCount = all.length - live.length;
    const last = live[0];
    return {
      title: "Maintenance · " + tankName(tankId), keepScroll: true,
      html: '<div class="water-controls"><select data-act="maint-tank" aria-label="Tank">' + tanks.map(t => '<option value="' + esc(t["Tank ID"]) + '"' + (t["Tank ID"] === tankId ? " selected" : "") + '>' +
          esc(t["Tank Name"] + (isRetired(t) ? " (retired)" : "")) + '</option>').join("") + '</select></div>' +
        '<div class="section"><div class="section-head"><h3>Water changes (' + live.length + ')</h3>' +
          (canLogTank(tankId) ? '<button class="btn small primary" data-act="log-wc" data-tank="' + esc(tankId) + '">' + ICONS.plus + 'Log water change</button>' : "") + '</div>' +
          '<div class="card pad wc-summary">' + (last
            ? '<div class="wc-big">' + esc(daysAgo(last["Performed At"]).replace(/^./, c => c.toUpperCase())) + '</div><div class="sub">Last water change · ' + esc([fmtDT(last["Performed At"]), wcAmount(last)].filter(Boolean).join(" · ")) + '</div>'
            : '<div class="sub">No water changes logged for this tank yet.</div>') + '</div>' +
          (shown.length ? '<div class="card list" style="margin-top:10px">' + shown.map(w => wcRow(w)).join("") + '</div>' : "") +
          (retiredCount ? '<label class="check" style="margin-top:8px"><input type="checkbox" data-act="toggle-retired-maint"' + (state.showRetiredMaint ? " checked" : "") + '> Show retired (' + retiredCount + ')</label>' : "") +
        '</div>' + (state.hasTreatments ? treatmentSection(tankId, { showPast: true }) : "")
    };
  }

  function maintSection(tankId) {
    const list = waterChangesFor(tankId);
    return '<div class="section"><div class="section-head"><h3>Maintenance</h3>' +
      '<a class="btn small" href="#/maint/' + encodeURIComponent(tankId) + '">All</a></div>' +
      '<div class="card pad"><div class="sub" style="margin-bottom:6px"><b>' + esc(lastWaterChangeText(tankId)) + '</b></div>' +
      (list.length ? '<div class="card list">' + list.slice(0, 3).map(w => wcRow(w)).join("") + '</div>' : "") +
      (canLogTank(tankId) ? '<div class="actions"><button class="btn primary" data-act="log-wc" data-tank="' + esc(tankId) + '">' + ICONS.plus + 'Log water change</button></div>' : "") +
      '</div></div>';
  }

  // Log (no id) or correct (id) a water change.
  function waterChangeForm(tankId, id) {
    const rec = id ? state.waterChanges.find(w => w["Water Change ID"] === id) : null;
    if (id && !rec) return;
    const loggable = state.data.tanks.filter(t => !isRetired(t) && canLogTank(t["Tank ID"]));
    if (!rec) {
      if (!loggable.length) { toast("You don’t have any tanks assigned.", true); return; }
      if (!canLogTank(tankId)) tankId = loggable[0]["Tank ID"];
    } else tankId = rec["Tank ID"];
    $$(".sheet-backdrop").forEach(b => b.remove()); document.body.style.overflow = "";
    const had = rec ? wcFilters(rec) : [];
    const filterHtml = tank => {
      const ids = tankFilters(tank).concat(had.filter(x => tankFilters(tank).indexOf(x) === -1));
      if (!ids.length) return '<div class="hint">No filters are assigned to this tank. Add one under Equipment on the tank page.</div>';
      return ids.map(x => '<label class="check"><input type="checkbox" class="wc-filter" value="' + esc(x) + '"' + (had.indexOf(x) !== -1 ? " checked" : "") + '> ' + esc(equipLabel(x)) + '</label>').join("");
    };
    const volHint = tank => { const v = tankVolume(tank); return v ? "Tank volume " + fmtNum(v) + " gal — fill in either box and the other is worked out." : "This tank has no Volume (gal) set, so fill in both boxes."; };
    const editable = !rec || canCorrectBy(rec["Performed By"]);
    openSheet({
      title: rec ? "Water change · " + tankName(tankId) : "Log water change",
      submitLabel: rec ? "Save" : "Save water change",
      body:
        (rec ? '<p class="meta">' + esc([rec["Water Change ID"], "Logged by " + personName(rec["Performed By"])].join(" · ")) + '</p>'
             : '<div class="field"><label for="f_wctank">Tank</label><select id="f_wctank">' + loggable.map(t => '<option value="' + esc(t["Tank ID"]) + '"' + (t["Tank ID"] === tankId ? " selected" : "") + '>' + esc(t["Tank Name"]) + '</option>').join("") + '</select></div>') +
        '<div class="field"><label for="f_wctime">Date / time</label><input type="datetime-local" id="f_wctime" value="' + esc(rec ? String(rec["Performed At"]).replace(" ", "T") : localNow()) + '" max="' + localNow() + '"></div>' +
        '<div class="wt-top">' +
          '<div class="field"><label for="f_wcpct">Percentage</label><div class="suffix-wrap"><input type="text" inputmode="decimal" id="f_wcpct" autocomplete="off" value="' + esc(rec && rec["Percentage"] !== "" ? fmtNum(rec["Percentage"]) : "") + '"><span>%</span></div></div>' +
          '<div class="field"><label for="f_wcgal">Gallons</label><div class="suffix-wrap"><input type="text" inputmode="decimal" id="f_wcgal" autocomplete="off" value="' + esc(rec && rec["Gallons"] !== "" ? fmtNum(rec["Gallons"]) : "") + '"><span>gal</span></div></div>' +
        '</div>' +
        '<div class="hint" id="wc-volhint" style="margin:-4px 0 12px">' + esc(volHint(tankId)) + '</div>' +
        '<div class="field"><label>Filter cleaning</label><div id="wc-filters" class="check-list">' + filterHtml(tankId) + '</div></div>' +
        '<div class="field"><label for="f_wcnotes">Notes</label><textarea id="f_wcnotes">' + esc(rec ? rec["Notes"] : "") + '</textarea></div>' +
        (rec && editable ? '<div class="actions"><button type="button" class="btn ' + (isLive(rec) ? "danger" : "") + '" data-retire>' + (isLive(rec) ? "Retire this water change" : "Restore this water change") + '</button></div>' : ""),
      onReady: form => {
        const pct = $("#f_wcpct", form), gal = $("#f_wcgal", form), tankSel = $("#f_wctank", form);
        const cur = () => tankSel ? tankSel.value : tankId;
        let driver = null;   // which box the person typed in last
        const fill = () => {
          const v = tankVolume(cur());
          if (!v || !driver) return;
          if (driver === "pct") { const p = num(pct.value); gal.value = p === null ? "" : String(Math.round(v * p / 10) / 10); }
          else { const g = num(gal.value); pct.value = g === null ? "" : String(Math.round(g / v * 1000) / 10); }
        };
        pct.addEventListener("input", () => { driver = "pct"; fill(); });
        gal.addEventListener("input", () => { driver = "gal"; fill(); });
        if (tankSel) tankSel.addEventListener("change", () => {
          $("#wc-filters", form).innerHTML = filterHtml(tankSel.value);
          $("#wc-volhint", form).textContent = volHint(tankSel.value);
          fill();
        });
        const rb = $("[data-retire]", form);
        if (rb) rb.addEventListener("click", async () => {
          try {
            await write("retireWaterChange", { id: id, restore: !isLive(rec) }, isLive(rec) ? "Water change retired" : "Water change restored");
            $$(".sheet-backdrop").forEach(b => b.remove()); document.body.style.overflow = "";
          } catch (err) { toast(err.message, true); }
        });
      },
      onSubmit: async (vals, form) => {
        const p = $("#f_wcpct", form).value.trim(), g = $("#f_wcgal", form).value.trim();
        if (p && num(p) === null) throw new Error("Percentage must be a number.");
        if (g && num(g) === null) throw new Error("Gallons must be a number.");
        if (p && (num(p) <= 0 || num(p) > 100)) throw new Error("Percentage must be between 0 and 100.");
        const filters = $$(".wc-filter", form).filter(c => c.checked).map(c => c.value);
        const when = $("#f_wctime", form).value;
        const notes = $("#f_wcnotes", form).value;
        if (!rec) {
          const tank = $("#f_wctank", form).value;
          const ok = await write("logWaterChange", { tankId: tank, performedAt: when, percentage: p, gallons: g, filters: filters, notes: notes }, "Water change saved");
          state.maintTank = tank; try { localStorage.setItem("aa_maint_tank", tank); } catch (e) { /* ignore */ }
          return ok;
        }
        if (!editable) return true;
        const changed = {};
        if (when && when !== String(rec["Performed At"]).replace(" ", "T")) changed.performedAt = when;
        if (num(p) !== num(rec["Percentage"])) changed.percentage = p;
        if (num(g) !== num(rec["Gallons"])) changed.gallons = g;
        if (filters.slice().sort().join(",") !== had.slice().sort().join(",")) changed.filters = filters;
        if (String(notes).trim() !== String(rec["Notes"] || "").trim()) changed.notes = notes;
        if (!Object.keys(changed).length) { toast("No changes"); return true; }
        return write("updateWaterChange", { id: id, values: changed }, "Water change updated");
      }
    });
  }

  // Pop-up with the details of one reading, placed over its point on the chart.
  // Mouse: shows while the pointer is over a point. Touch: tap the chart to show the nearest point.
  function trendPick(wrap, clientX, clientY, strict) {
    const pts = JSON.parse(wrap.dataset.points || "[]");
    if (!pts.length) return null;
    const rect = $(".trend", wrap).getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    let best = null, bestD = Infinity;
    pts.forEach((p, i) => {
      const dx = p.x * rect.width - px, dy = p.y * rect.height - py;
      const d = strict ? Math.hypot(dx, dy) : Math.abs(dx);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (strict && bestD > 14) return null;
    return best;
  }
  function showTrendTip(wrap, idx) {
    const tip = $(".trend-tip", wrap);
    const pts = JSON.parse(wrap.dataset.points || "[]");
    const p = pts[idx];
    if (!p) { hideTrendTip(wrap); return; }
    if (tip.dataset.idx === String(idx) && !tip.hidden) return;
    tip.dataset.idx = String(idx);
    const row = (k, v) => v ? '<div class="tt-row"><span>' + esc(k) + '</span><span>' + esc(v) + '</span></div>' : "";
    tip.innerHTML =
      '<div class="tt-head"><div><div class="tt-name">' + esc(wrap.dataset.name || "") + '</div><div class="tt-val">' + esc(p.val) + '</div></div>' + resultPill(p.res) + '</div>' +
      '<div class="tt-when">' + esc(p.when) + '</div>' +
      row("Range", p.range || "No range set") + row("Method", p.method) + row("Tested by", p.by) +
      (p.note ? '<div class="tt-note"><span>Reading note</span>' + esc(p.note) + '</div>' : "") +
      (p.snote ? '<div class="tt-note"><span>Test note</span>' + esc(p.snote) + '</div>' : "");
    tip.hidden = false;
    // Highlight the point.
    $$(".pt.hl", wrap).forEach(c => c.classList.remove("hl"));
    const c = $$(".trend .pt", wrap)[idx];
    if (c) c.classList.add("hl");
    // Place above the point (below if there is no room), kept inside the chart's width.
    const box = wrap.getBoundingClientRect(), svgR = $(".trend", wrap).getBoundingClientRect();
    const ptX = p.x * svgR.width + (svgR.left - box.left), ptY = p.y * svgR.height + (svgR.top - box.top);
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const left = Math.max(0, Math.min(box.width - tw, ptX - tw / 2));
    const above = ptY - th - 12;
    const spaceAbove = box.top + above;
    tip.style.left = left + "px";
    tip.style.top = (spaceAbove >= 64 ? above : ptY + 12) + "px";
  }
  function hideTrendTip(wrap) {
    const tip = $(".trend-tip", wrap);
    if (!tip) return;
    tip.hidden = true; tip.dataset.idx = "";
    $$(".pt.hl", wrap).forEach(c => c.classList.remove("hl"));
  }
  document.addEventListener("pointermove", e => {
    if (e.pointerType !== "mouse") return;
    const wrap = e.target.closest && e.target.closest(".trend-wrap");
    $$(".trend-wrap").forEach(w => { if (w !== wrap) hideTrendTip(w); });
    if (!wrap) return;
    const idx = trendPick(wrap, e.clientX, e.clientY, true);
    if (idx === null) hideTrendTip(wrap); else showTrendTip(wrap, idx);
  });
  document.addEventListener("scroll", () => $$(".trend-wrap").forEach(hideTrendTip), { passive: true, capture: true });

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------
  document.addEventListener("click", e => {
    const tw = e.target.closest(".trend-wrap");
    $$(".trend-wrap").forEach(w => { if (w !== tw) hideTrendTip(w); });
    if (tw && !e.target.closest(".water-card")) {
      // Tap (touch) or click on the big chart: show the nearest reading; tap the pop-up to close it.
      if (e.target.closest(".trend-tip")) { hideTrendTip(tw); return; }
      const idx = trendPick(tw, e.clientX, e.clientY, false);
      if (idx !== null) showTrendTip(tw, idx);
      return;
    }
    const el = e.target.closest("[data-act]");
    if (!el || !state.me) return;
    const act = el.dataset.act;
    const d = el.dataset;
    switch (act) {
      case "back":
        if (history.length > 1) history.back(); else location.hash = "#/home";
        break;
      case "refresh": refresh(false); break;
      // Previous / Next on a detail page: replace, so Back still returns to the list.
      case "step": if (d.href) location.replace(d.href); break;
      case "sign-out": signOut(); break;
      case "open-item":
        if (e.target.closest("button") && e.target.closest("button") !== el) return;
        location.hash = "#/item/" + d.type + "/" + encodeURIComponent(d.id);
        break;
      case "browse-type": state.browseType = d.type; state.query = ""; render(); break;
      case "home-browse": state.browseType = d.type; state.query = ""; break;   // the link then opens Browse
      case "toggle-removed": state.showRemoved = !state.showRemoved; render(); break;
      case "add-record": recordForm(d.type); break;
      case "edit-record": recordForm(d.type, d.id); break;
      case "retire": retireForm(d.type, d.id); break;
      case "add-photo": addPhotoForm(d.type, d.id); break;
      case "delete-record": deleteRecordForm(d.type, d.id); break;
      case "delete-receipt": deleteReceiptForm(d.id); break;
      case "item-to-tank": itemToTankForm(d.type, d.id); break;
      case "item-upload-receipt": uploadReceiptForm(d.id); break;
      case "item-link-receipt": itemLinkReceiptForm(d.type, d.id); break;
      case "open-photo": photoViewer(d.id); break;
      case "add-assignment": assignmentForm(d.tank); break;
      case "remove-assignment":
        e.stopPropagation();
        removeAssignmentForm(Number(d.row), d.tank, d.item);
        break;
      case "add-param": paramForm(d.tank); break;
      case "edit-param": paramForm(null, Number(d.row)); break;
      case "add-user": userForm(); break;
      case "log-water": logWaterForm(d.tank); break;
      case "log-wc": e.stopPropagation(); waterChangeForm(d.tank); break;
      case "edit-wc": waterChangeForm(null, d.id); break;
      case "water-session": sessionSheet(d.id); break;
      case "edit-reading": readingForm(d.id); break;
      case "add-testtype": testTypeForm(); break;
      case "edit-testtype": testTypeForm(d.id); break;
      case "upload-receipt": uploadReceiptForm(); break;
      case "receipt-filter": state.receiptFilter = d.f; render(); break;
      case "edit-receipt": editReceiptForm(d.id); break;
      case "link-receipt": linkReceiptForm(d.id); break;
      case "unlink-receipt": e.stopPropagation(); unlinkReceiptForm(Number(d.row), d.id, d.item); break;
      case "retire-receipt": retireReceiptForm(d.id, false); break;
      case "restore-receipt": retireReceiptForm(d.id, true); break;
      case "zoom-photo": zoomPhoto(d.id); break;
      case "go":
        if (e.target.closest("button") && e.target.closest("button") !== el) return;
        location.hash = d.href;
        break;
      case "edit-user": userForm(d.id); break;
      case "add-wish": addWishForm(d.tank); break;
      case "wish-filter": state.wishFilter = d.f; render(); break;
      case "edit-wish": editWishForm(d.id); break;
      case "close-wish": closeWishForm(d.id); break;
      case "purchase-wish": purchaseWishForm(d.id); break;
      case "check-wish": checkWishNow(d.id); break;
      // Price tracker
      case "price-filter": state.priceFilter = d.f; render(); break;
      case "add-price": addPriceForm(d.item || "", d.loc || ""); break;
      case "edit-price": editPriceForm(d.id); break;
      case "price-history": { const k = d.item + "|" + d.loc; state.priceOpen[k] = !state.priceOpen[k]; render(); break; }
      case "edit-price-item": editPriceItemForm(d.id); break;
      case "delete-price-item": deletePriceItemForm(d.id); break;
      case "price-picture": pricePictureForm(d.id); break;
      case "lookup-add": lookupAddForm(d.type); break;
      case "edit-receipt-lines": editReceiptLinesForm(d.id); break;
      // Treatments and stock
      case "add-treatment": treatmentForm(d.tank || "", ""); break;
      case "edit-treatment": treatmentForm("", d.id); break;
      case "log-dose": logDoseForm(d.id); break;
      case "edit-dose": editDoseForm(d.id); break;
      case "delete-treatment": deleteTreatmentForm(d.id); break;
      case "trt-status": write("setTreatmentStatus", { id: d.id, status: d.status }, d.status === "Active" ? "Treatment started again" : "Treatment stopped"); break;
      case "set-stock": {
        const key = d.priceItem ? { priceItemId: d.priceItem } : { recordId: d.id };
        const rec = d.priceItem ? findPriceItem(d.priceItem) : findRec("medications", d.id);
        if (rec) stockForm({ key: key, current: stockOf(rec), label: d.priceItem ? priceItemInfo(rec).name : d.id + " " + TYPES.medications.title(rec) });
        break;
      }
      case "lookup-edit": lookupEditForm(d.row); break;
      case "price-picture-remove": pricePictureRemoveForm(d.id); break;
    }
  });

  document.addEventListener("input", e => {
    if (e.target.matches("[data-act='search']")) {
      state.query = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const s = $("[data-act='search']");
      if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (err) { /* ignore */ } }
    }
  });
  document.addEventListener("input", e => {
    if (e.target.matches("[data-act='list-search']")) {
      state.listQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const s = $("[data-act='list-search']");
      if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (err) { /* ignore */ } }
    }
  });
  document.addEventListener("input", e => {
    if (e.target.matches("[data-act='price-search']")) {
      state.priceQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const s = $("[data-act='price-search']");
      if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (err) { /* ignore */ } }
    }
  });
  document.addEventListener("input", e => {
    if (e.target.matches("[data-act='receipt-search']")) {
      state.receiptQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const s = $("[data-act='receipt-search']");
      if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (err) { /* ignore */ } }
    }
  });
  document.addEventListener("change", e => {
    if (e.target.matches("[data-act='water-tank']")) {
      state.waterTank = e.target.value; try { localStorage.setItem("aa_water_tank", state.waterTank); } catch (err) { /* ignore */ }
      const base = (location.hash.split("/")[3] ? "/" + location.hash.split("/")[3] : "");
      location.hash = "#/water/" + encodeURIComponent(state.waterTank) + base;
    }
    if (e.target.matches("[data-act='water-days']")) {
      const n = Math.round(Number(e.target.value));
      if (n >= 1 && n <= 3650) { state.waterDays = n; try { localStorage.setItem("aa_water_days", String(n)); } catch (err) { /* ignore */ } }
      render();
    }
    if (e.target.matches("[data-act='maint-tank']")) {
      state.maintTank = e.target.value; try { localStorage.setItem("aa_maint_tank", state.maintTank); } catch (err) { /* ignore */ }
      location.hash = "#/maint/" + encodeURIComponent(state.maintTank);
    }
    if (e.target.matches("[data-act='toggle-past-trt']")) { state.showPastTrt = e.target.checked; render(); return; }
    if (e.target.matches("[data-act='toggle-retired-maint']")) { state.showRetiredMaint = e.target.checked; render(); }
    if (e.target.matches("[data-act='toggle-retired-receipts']")) { state.showRetiredReceipts = e.target.checked; render(); }
    if (e.target.matches("[data-act='toggle-retired']")) { state.showRetired = e.target.checked; render(); }
    if (e.target.matches("[data-act='wish-tank']")) { state.wishTank = e.target.value; render(); }
  });
  window.addEventListener("hashchange", () => { if (state.me) render(); });

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  window.AA = { gisLoaded: gisLoaded };

  // ---------- Updates: reload when a newer version is published ----------
  const APP_VERSION = "46";
  async function checkForUpdate() {
    try {
      const res = await fetch("version.json?x=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return;
      const v = (await res.json()).version;
      if (!v || v === APP_VERSION) return;
      if ($(".sheet-backdrop")) { toast("A new version is ready. It will load next time you open the app."); return; }
      // Reload once per new version; if the files haven't caught up yet, don't loop.
      let tried = "";
      try { tried = sessionStorage.getItem("aa_reloaded_for") || ""; } catch (e) { /* ignore */ }
      if (tried === v) return;
      try { sessionStorage.setItem("aa_reloaded_for", v); } catch (e) { /* ignore */ }
      if (navigator.serviceWorker) { try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch (e) { /* ignore */ } }
      location.reload();
    } catch (e) { /* offline: try again later */ }
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
  window.addEventListener("load", () => setTimeout(checkForUpdate, 1500));

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  try { state.token = localStorage.getItem(TOKEN_KEY); } catch (e) { state.token = null; }
  loadSession();
  if (state.session || (state.token && tokenValid(state.token))) boot();
  else { clearToken(); render(); }
  if (window.google && google.accounts && google.accounts.id) gisLoaded();
})();
