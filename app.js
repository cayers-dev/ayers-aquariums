/* Ayers Aquariums - mobile web app
 * Talks to the Apps Script API (config.js -> apiUrl) with a Google sign-in token.
 * Roles come from the App Users tab: Admin, Editor (specific tanks), Viewer.
 */
(function () {
  "use strict";

  const CFG = window.AA_CONFIG || {};
  const TOKEN_KEY = "aa_id_token";

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
    waterDays: (function () { try { return Number(localStorage.getItem("aa_water_days")) || 60; } catch (e) { return 60; } })()
  };

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------
  const esc = v => String(v === null || v === undefined ? "" : v)
    .replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  function fmtDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
    if (!m) return s || "";
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function today() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
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
  function busy(on) {
    let el = $(".busy");
    if (on && !el) {
      el = document.createElement("div");
      el.className = "busy";
      el.innerHTML = '<div class="spinner"></div>';
      document.body.appendChild(el);
    } else if (!on && el) el.remove();
  }
  function thumbUrl(url, width) {
    if (!url) return "";
    if (/commons\.wikimedia\.org\/wiki\/Special:FilePath\//.test(url) && url.indexOf("?") === -1) return url + "?width=" + (width || 160);
    return url;
  }
  function isUrl(v) { return /^https?:\/\//i.test(String(v || "")); }

  const ICONS = {
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
      sub: r => r["Category"],
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
  const tankAssignments = (tankId, active) => state.data.assignments
    .filter(a => a["Tank ID"] === tankId && (active ? isActiveAssignment(a) : !isActiveAssignment(a)));
  const tankName = id => { const t = findRec("tanks", id); return t ? t["Tank Name"] : id; };

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------
  async function api(action, payload) {
    if (!state.token || !tokenValid(state.token)) {
      const e = new Error("Your sign-in has expired. Please sign in again.");
      e.code = "AUTH";
      throw e;
    }
    let res;
    try {
      res = await fetch(CFG.apiUrl, {
        method: "POST",
        body: JSON.stringify(Object.assign({ action: action, idToken: state.token }, payload || {}))
      });
    } catch (err) {
      const e = new Error("Can't reach the server. Check your connection and try again.");
      e.code = "NETWORK";
      throw e;
    }
    let json;
    try { json = await res.json(); } catch (err) {
      const e = new Error("The server sent an unexpected response.");
      e.code = "ERROR";
      throw e;
    }
    if (!json.ok) {
      const e = new Error(json.message || "Something went wrong.");
      e.code = json.code;
      e.email = json.email;
      throw e;
    }
    return json;
  }

  function handleError(err) {
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
  async function write(action, payload, successMsg) {
    busy(true);
    try {
      await api(action, payload);
      applyBootstrap(await api("bootstrap"));
      render();
      toast(successMsg || "Saved");
      return true;
    } catch (err) {
      if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) { handleError(err); return true; }
      throw err;
    } finally {
      busy(false);
    }
  }

  // ------------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------------
  function setToken(t) { state.token = t; try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* storage off */ } }
  function clearToken() { state.token = null; try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } }

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
    return { name: parts[0] || "tanks", args: parts.slice(1) };
  }

  function renderShell() {
    const route = parseRoute();
    let view;
    switch (route.name) {
      case "tank": view = viewTank(route.args[0]); break;
      case "browse": view = viewBrowse(); break;
      case "item": view = viewItem(route.args[0], route.args[1]); break;
      case "users": view = isAdmin() ? viewUsers() : viewTanks(); break;
      case "account": view = viewAccount(); break;
      case "receipts": view = canReceipts() ? viewReceipts() : viewTanks(); break;
      case "water": view = route.args[1] ? viewWaterType(route.args[0], route.args[1]) : viewWater(route.args[0]); break;
      case "testtypes": view = isAdmin() ? viewTestTypes() : viewWater(); break;
      case "receipt": view = canReceipts() ? viewReceipt(route.args[0]) : viewTanks(); break;
      default: view = viewTanks();
    }
    const tab = route.name === "tank" ? "tanks" : route.name === "item" ? "browse" : route.name === "receipt" ? "receipts" : route.name === "testtypes" ? "water" : route.name;
    const tabs = [["tanks", "Tanks"], ["water", "Water"], ["browse", "Browse"]]
      .concat(canReceipts() ? [["receipts", "Receipts"]] : [])
      .concat(isAdmin() ? [["users", "Users"]] : [])
      .concat([["account", "Account"]]);

    $("#app").innerHTML =
      '<header class="topbar">' +
        (view.back ? '<button class="icon-btn" data-act="back" aria-label="Back">' + ICONS.back + '</button>' : '<span style="width:6px"></span>') +
        '<h1>' + esc(view.title) + '</h1>' +
        '<button class="icon-btn" data-act="refresh" aria-label="Refresh">' + ICONS.refresh + '</button>' +
      '</header>' +
      '<main class="view">' + view.html + '</main>' +
      '<nav class="tabbar">' +
        tabs.map(t => '<a href="#/' + t[0] + '" class="' + (tab === t[0] ? "active" : "") + '">' + ICONS[t[0]] + '<span>' + t[1] + '</span></a>').join("") +
      '</nav>';

    if (view.after) view.after();
    window.scrollTo(0, view.keepScroll ? window.scrollY : 0);
  }

  // ---------- Tanks (home) ----------
  function viewTanks() {
    const tanks = state.data.tanks.slice().sort((a, b) =>
      (isRetired(a) - isRetired(b)) || String(a["Tank Name"]).localeCompare(String(b["Tank Name"])));
    const cards = tanks.map(t => {
      const id = t["Tank ID"];
      const assigned = tankAssignments(id, true);
      const counts = { species: 0, equipment: 0, plants: 0 };
      assigned.forEach(a => { const ty = itemType(a["Item ID"]); if (ty) counts[ty]++; });
      return '<a class="card tank-card ' + (isRetired(t) ? "dim" : "") + '" href="#/tank/' + encodeURIComponent(id) + '">' +
        '<div class="row1"><h2>' + esc(t["Tank Name"]) + '</h2>' +
        (t["Volume (gal)"] ? '<span class="vol">' + esc(t["Volume (gal)"]) + ' gal</span>' : "") + '</div>' +
        '<div class="meta">' + esc([id, t["Aquarium Type"], t["Manufacturer"]].filter(Boolean).join(" · ")) + '</div>' +
        '<div class="counts">' +
          '<span class="pill">' + counts.species + ' livestock</span>' +
          '<span class="pill">' + counts.equipment + ' equipment</span>' +
          (counts.plants ? '<span class="pill">' + counts.plants + ' plants</span>' : "") +
          (isRetired(t) ? '<span class="pill retired">Retired</span>' : "") +
          "" +
        '</div></a>';
    }).join("");
    const addBtn = isAdmin() ? '<div class="actions" style="margin:0 0 12px"><button class="btn primary" data-act="add-record" data-type="tanks">' + ICONS.plus + 'Add tank</button></div>' : "";
    return { title: "Ayers Aquariums", html: addBtn + (cards || '<div class="empty">' + (isAdmin() ? "No tanks yet." : "No tanks are assigned to you yet. Ask Chris to add you to a tank.") + '</div>') };
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
        (img ? '<img class="thumb" loading="lazy" alt="" src="' + esc(thumbUrl(img)) + '">' : '<span class="thumb">' + esc(a["Item ID"].split("-")[0]) + '</span>') +
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
      '</div>' : "") + '</div>';

    return {
      title: t["Tank Name"], back: true,
      html: hero + group("species", "Livestock") + group("equipment", "Equipment") + group("plants", "Plants") +
            waterSection(id) + paramsHtml + receiptsSection(id) + detailsSection("tanks", t, "Tank details") + removedHtml
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
  function viewBrowse() {
    const type = state.browseType;
    const T = TYPES[type];
    const q = state.query.trim().toLowerCase();
    const rows = state.data[type]
      .filter(r => state.showRetired || !isRetired(r))
      .filter(r => !q || Object.keys(r).some(k => k !== "_row" && String(r[k]).toLowerCase().indexOf(q) !== -1))
      .sort((a, b) => String(T.title(a)).localeCompare(String(T.title(b))));
    const segs = ["species", "equipment", "plants", "medications"].map(t =>
      '<button class="' + (t === type ? "on" : "") + '" data-act="browse-type" data-type="' + t + '">' + TYPES[t].label + '</button>').join("");
    const list = rows.map(r => {
      const img = T.img(r);
      return '<div class="list-item ' + (isRetired(r) ? "dim" : "") + '" data-act="open-item" data-type="' + type + '" data-id="' + esc(r[T.id]) + '">' +
        (type !== "medications" ? (img ? '<img class="thumb" loading="lazy" alt="" src="' + esc(thumbUrl(img)) + '">' : '<span class="thumb">' + esc(String(r[T.id]).split("-")[0]) + '</span>') : "") +
        '<div class="body"><div class="title">' + esc(T.title(r)) + '</div><div class="sub">' + esc([r[T.id], T.sub(r)].filter(Boolean).join(" · ")) + '</div></div>' +
        (isRetired(r) ? '<span class="pill retired">Retired</span>' : "") + '</div>';
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
      inTanks = '<div class="section"><div class="section-head"><h3>In tanks (' + total + ')</h3></div><div class="card list">' +
        (rows.map(a => '<a class="list-item" href="#/tank/' + encodeURIComponent(a["Tank ID"]) + '"><div class="body"><div class="title">' + esc(tankName(a["Tank ID"])) + '</div>' +
          '<div class="sub">' + esc([a["Tank ID"], a["Date Added"] ? "Added " + fmtDate(a["Date Added"]) : ""].filter(Boolean).join(" · ")) + '</div></div></a>').join("") +
         others.slice().sort((x, y) => String(x["Tank Name"]).localeCompare(String(y["Tank Name"]))).map(a =>
          '<div class="list-item"><div class="body"><div class="title">' + esc(a["Tank Name"]) + '</div>' +
          '<div class="sub">' + esc([a["Tank ID"], a["Date Added"] ? "Added " + fmtDate(a["Date Added"]) : ""].filter(Boolean).join(" · ")) + '</div></div></div>').join("") ||
          '<div class="empty">Not in any tank</div>') + '</div></div>';
    }
    const hero = '<div class="card">' +
      (img ? '<img class="big-img" alt="" src="' + esc(thumbUrl(img, 800)) + '">' : "") +
      '<div class="hero"><h2>' + esc(T.title(r)) + '</h2><div class="meta">' + esc([r[T.id], T.sub(r)].filter(Boolean).join(" · ")) + '</div>' +
      (isRetired(r) ? '<div class="counts"><span class="pill retired">Retired</span></div>' : "") +
      (isAdmin() ? '<div class="actions"><button class="btn" data-act="edit-record" data-type="' + type + '" data-id="' + esc(id) + '">Edit</button>' +
        (!isRetired(r) && "Status" in r ? '<button class="btn danger" data-act="retire" data-type="' + type + '" data-id="' + esc(id) + '">Retire</button>' : "") + '</div>' : "") +
      '</div></div>';
    return { title: T.title(r), back: true, html: hero + inTanks + receiptsSection(id) + detailsSection(type, r, "Details") };
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
      title: "Users",
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
        '<div class="k">Can log tests</div><div>' + esc(testList) + '</div></div>' +
        '<div class="actions"><button class="btn" data-act="refresh">Refresh data</button><button class="btn danger" data-act="sign-out">Sign out</button></div>' +
        '<p class="hint" style="margin-top:16px"><b>Add to your home screen:</b> on iPhone, tap Share → Add to Home Screen. On Android, tap the ⋮ menu → Add to Home screen (or Install app).</p>'
    };
  }

  // ------------------------------------------------------------------
  // Forms
  // ------------------------------------------------------------------
  function fieldHtml(f, value, opts) {
    opts = opts || {};
    const id = "f_" + f.name.replace(/\W+/g, "_");
    const v = value === undefined || value === null ? "" : value;
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
        '<div class="sheet-foot"><button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="submit" class="btn ' + (opts.danger ? "danger" : "primary") + '">' + esc(opts.submitLabel || "Save") + '</button></div>' +
      '</form>';
    document.body.appendChild(back);
    document.body.style.overflow = "hidden";
    const form = $("form", back);
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

  function recordForm(type, id) {
    const T = TYPES[type];
    const editing = !!id;
    const rec = editing ? findRec(type, id) : {};
    const fields = state.schema[type].filter(f => editing || !f.readOnly);
    const values = {};
    fields.forEach(f => {
      values[f.name] = editing ? rec[f.name] : (f.name === "Status" ? "Active" : "");
    });
    openSheet({
      title: (editing ? "Edit " : "Add ") + T.one.toLowerCase(),
      submitLabel: editing ? "Save" : "Add",
      body: fields.map(f => fieldHtml(f, values[f.name])).join(""),
      onSubmit: async vals => {
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
      const thumb = f.noThumbs ? "" : (it.img ? '<img class="thumb" loading="lazy" alt="" src="' + esc(thumbUrl(it.img)) + '">' : '<span class="thumb">' + esc(String(it.value).split("-")[0]) + '</span>');
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

  function assignmentForm(tankId) {
    const inTank = new Set(tankAssignments(tankId, true).map(a => a["Item ID"]));
    const items = [];
    ITEM_TYPES.forEach(ty => {
      const T = TYPES[ty];
      // Items already in this tank stay in the list, greyed out and labelled, so nobody thinks they're missing.
      state.data[ty].filter(r => !isRetired(r) || inTank.has(r[T.id]))
        .sort((a, b) => String(T.title(a)).localeCompare(String(T.title(b))))
        .forEach(r => {
          const there = inTank.has(r[T.id]);
          items.push({ value: r[T.id], label: T.title(r), sub: T.sub(r), group: T.label, img: T.img(r),
                       disabled: there, note: there ? "In tank" : "" });
        });
    });
    openSheet({
      title: "Add to " + tankName(tankId),
      submitLabel: "Add",
      body:
        comboHtml({ name: "Item ID", label: "Item", required: true, placeholder: "Tap to choose, or type to search" }, items) +
        fieldHtml({ name: "Date Added", type: "date" }, today()) +
        fieldHtml({ name: "Notes", type: "longtext" }, "") +
        '<p class="hint">Only admins can add new species, equipment or plants to the lists. Ask Chris if something is missing.</p>',
      onReady: form => $$("[data-combo]", form).forEach(wireCombo),
      onSubmit: vals => write("add", { table: "assignments", values: { "Tank ID": tankId, "Item ID": vals["Item ID"], "Date Added": vals["Date Added"], "Notes": vals["Notes"] } }, "Added to tank")
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
      onSubmit: vals => {
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
          if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) { handleError(err); return true; }
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

  function receiptsSection(id) {
    if (!canReceipts()) return "";
    const list = receiptsForRecord(id).sort((x, y) => receiptSortKey(y).localeCompare(receiptSortKey(x)));
    return '<div class="section"><div class="section-head"><h3>Receipts (' + list.length + ')</h3></div>' +
      '<div class="card list">' + (list.map(receiptRow).join("") || '<div class="empty">None</div>') + '</div></div>';
  }

  function viewReceipts() {
    const q = state.receiptQuery.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const rows = state.receipts
      .filter(r => state.showRetiredReceipts || !isRetired(r))
      .filter(r => state.receiptFilter !== "unassigned" || receiptLinksFor(r["Receipt ID"]).length === 0)
      .filter(r => {
        if (!words.length) return true;
        const linked = receiptLinksFor(r["Receipt ID"]).map(l => { const x = recordOf(l["Item ID"]); return l["Item ID"] + " " + (x ? TYPES[x.type].title(x.rec) : ""); }).join(" ");
        const hay = [r["Receipt ID"], r["File Name"], r["Vendor"], r["Notes"], r["Uploaded By"], r["Purchase Date"], r["Total"], linked].join(" ").toLowerCase();
        return words.every(w => hay.indexOf(w) !== -1);
      })
      .sort((x, y) => receiptSortKey(y).localeCompare(receiptSortKey(x)));
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
    const photo = '<div class="card receipt-photo" data-photo="' + esc(id) + '">' +
      (cached && cached.url ? '<img alt="Receipt photo" src="' + cached.url + '" data-act="zoom-photo" data-id="' + esc(id) + '">' :
       cached && cached.error ? '<div class="empty">' + esc(cached.error) + '</div>' :
       '<div class="photo-loading"><div class="spinner"></div><span>Loading photo…</span></div>') + '</div>';
    const hero = '<div class="card hero"><h2>' + esc(receiptTitle(r)) + '</h2>' +
      '<div class="meta">' + esc([id, r["Vendor"], money(r["Total"])].filter(Boolean).join(" · ")) + '</div>' +
      (isRetired(r) ? '<div class="counts"><span class="pill retired">Retired</span></div>' : links.length ? "" : '<div class="counts"><span class="pill warn">Unassigned</span></div>') +
      (isAdmin() ? '<div class="actions">' +
        '<button class="btn primary" data-act="link-receipt" data-id="' + esc(id) + '">' + ICONS.plus + 'Assign to records</button>' +
        '<button class="btn" data-act="edit-receipt" data-id="' + esc(id) + '">Edit</button>' +
        (isRetired(r) ? '<button class="btn" data-act="restore-receipt" data-id="' + esc(id) + '">Restore</button>'
                      : '<button class="btn danger" data-act="retire-receipt" data-id="' + esc(id) + '">Retire</button>') +
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
    return { title: receiptTitle(r), back: true, html: photo + hero + linked + details, after: () => loadReceiptPhoto(id) };
  }

  async function loadReceiptPhoto(id) {
    if (state.photoCache[id]) return;
    state.photoCache[id] = { loading: true };
    try {
      const res = await api("receiptPhoto", { id: id });
      const bin = atob(res.image.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      state.photoCache[id] = { url: URL.createObjectURL(new Blob([bytes], { type: res.image.mimeType || "image/jpeg" })) };
    } catch (err) {
      if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) { delete state.photoCache[id]; handleError(err); return; }
      state.photoCache[id] = { error: err.message || "The photo couldn't be loaded." };
    }
    const box = $('[data-photo="' + CSS.escape(id) + '"]');
    if (box) {
      const c = state.photoCache[id];
      box.innerHTML = c.url ? '<img alt="Receipt photo" src="' + c.url + '" data-act="zoom-photo" data-id="' + esc(id) + '">' : '<div class="empty">' + esc(c.error) + '</div>';
    }
  }

  function zoomPhoto(id) {
    const c = state.photoCache[id];
    if (!c || !c.url) return;
    const v = document.createElement("div");
    v.className = "photo-viewer";
    v.innerHTML = '<button type="button" class="icon-btn" aria-label="Close">' + ICONS.close + '</button><div class="pv-scroll"><img alt="Receipt photo" src="' + c.url + '"></div>';
    document.body.appendChild(v);
    document.body.style.overflow = "hidden";
    const img = $("img", v);
    img.addEventListener("click", () => v.classList.toggle("full"));
    $("button", v).addEventListener("click", () => { v.remove(); document.body.style.overflow = ""; });
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

  function uploadReceiptForm() {
    let image = null;
    openSheet({
      title: "Upload receipt",
      submitLabel: "Upload",
      body:
        '<div class="field"><label>Photo <span class="req">*</span></label>' +
          '<input type="file" accept="image/*" id="f_photo" name="photo" data-label="Photo" required hidden>' +
          '<div class="photo-pick">' +
            '<img class="photo-preview" alt="" hidden>' +
            '<button type="button" class="btn block" data-pick-photo>' + ICONS.camera + '<span>Take or choose photo</span></button>' +
          '</div></div>' +
        '<div class="field"><label for="f_fileName">File name <span class="req">*</span></label>' +
          '<input type="text" id="f_fileName" name="fileName" required value="' + esc(defaultReceiptName(today(), "")) + '">' +
          '<div class="hint">.jpg is added automatically.</div></div>' +
        comboHtml({ name: "vendor", label: "Store / vendor", mode: "free", noThumbs: true, newLabel: "will be added to the vendor list",
                    placeholder: "Choose or type a new vendor" }, vendorItems()) +
        fieldHtml({ name: "purchaseDate", label: "Purchase date", type: "date" }, today()) +
        '<div class="field"><label for="f_total">Total</label><input type="text" inputmode="decimal" id="f_total" name="total" placeholder="0.00" autocomplete="off"></div>' +
        fieldHtml({ name: "notes", label: "Notes", type: "longtext" }, "") +
        (isAdmin() ? '<div class="form-section"><h3>Assign to records <span class="opt">optional</span></h3>' +
          comboHtml({ name: "itemIds", label: "Records on this receipt", mode: "multi",
                      placeholder: "Search tanks, species, equipment, plants, medications" }, linkableItems(new Set())) +
          '<p class="hint">Leave empty to assign later from the receipt’s page.</p></div>' : ""),
      onReady: form => {
        $$("[data-combo]", form).forEach(wireCombo);
        const file = $("#f_photo", form), btn = $("[data-pick-photo]", form), prev = $(".photo-preview", form);
        const nameEl = $("#f_fileName", form);
        let nameTouched = false;
        nameEl.addEventListener("input", () => { nameTouched = true; });
        const refreshName = () => {
          if (nameTouched) return;
          nameEl.value = defaultReceiptName($("[name=purchaseDate]", form).value, $("input[name=vendor]", form).value.trim());
        };
        $("input[name=vendor]", form).addEventListener("change", refreshName);
        $("[name=purchaseDate]", form).addEventListener("change", refreshName);
        const choose = () => file.click();
        btn.addEventListener("click", choose);
        prev.addEventListener("click", choose);
        file.addEventListener("change", async () => {
          const f = file.files && file.files[0];
          if (!f) return;
          $("span", btn).textContent = "Preparing photo…";
          try {
            image = await prepareImage(f);
            prev.src = image.preview; prev.hidden = false;
            $("span", btn).textContent = "Retake / choose another";
          } catch (err) {
            image = null; prev.hidden = true; file.value = "";
            $("span", btn).textContent = "Take or choose photo";
            toast(err.message, true);
          }
        });
      },
      onSubmit: async vals => {
        if (!image) throw new Error("Please add a photo of the receipt.");
        const total = String(vals.total || "").replace(/[$,\s]/g, "");
        if (total && isNaN(Number(total))) throw new Error("Total must be an amount like 24.99.");
        const itemIds = isAdmin() ? String(vals.itemIds || "").split(",").filter(Boolean) : [];
        return write("uploadReceipt", {
          receipt: { fileName: vals.fileName, vendor: vals.vendor, purchaseDate: vals.purchaseDate, total: total, notes: vals.notes },
          image: { data: image.data, mimeType: image.mimeType },
          itemIds: itemIds
        }, itemIds.length ? "Receipt uploaded and assigned" : "Receipt uploaded");
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
      onSubmit: vals => {
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
    const dataLo = Math.min.apply(null, vals), dataHi = Math.max.apply(null, vals);
    const ticks = (rg.min !== null || rg.max !== null) ? [rg.max, rg.min].filter(v => v !== null) : (dataLo === dataHi ? [dataHi] : [dataHi, dataLo]);
    ticks.filter((v, i, arr) => arr.indexOf(v) === i).forEach(v => {
      svg += '<text class="tick" x="' + (L - 4) + '" y="' + (y(v) + 3).toFixed(1) + '" text-anchor="end">' + esc(fmtNum(Math.round(v * 100) / 100)) + '</text>';
    });
    svg += '<text class="tick" x="' + L + '" y="' + (H - 4) + '">' + esc(cut.toLocaleDateString(undefined, { month: "short", day: "numeric" })) + '</text>';
    svg += '<text class="tick" x="' + (W - R) + '" y="' + (H - 4) + '" text-anchor="end">Today</text>';
    if (points.length > 1) {
      svg += '<path class="line" d="' + points.map((p, i) => (i ? "L" : "M") + x(p._t).toFixed(1) + " " + y(num(p["Value"])).toFixed(1)).join(" ") + '"/>';
    }
    points.forEach(p => {
      const off = p["Result"] === "High" || p["Result"] === "Low";
      svg += '<circle class="pt' + (off ? " off" : "") + '" cx="' + x(p._t).toFixed(1) + '" cy="' + y(num(p["Value"])).toFixed(1) + '" r="' + (off ? 4.5 : (big ? 3.5 : 2.8)) + '"/>';
    });
    svg += '</svg>';
    const data = points.map(p => [x(p._t) / W, fmtDT(p["Tested At"]), fmtNum(p["Value"]) + unitsOf(t), p["Result"]]);
    return '<div class="trend-wrap" data-points="' + esc(JSON.stringify(data)) + '">' + svg + '<div class="trend-tip" hidden></div></div>';
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
    if (!tankId) return { title: "Water", html: '<div class="empty">' + (isAdmin() ? "No tanks yet." : "No tanks are assigned to you yet.") + '</div>' };
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
        const off = rs.filter(r => r["Result"] === "High" || r["Result"] === "Low").length;
        return '<div class="list-item" data-act="water-session" data-id="' + esc(s["Session ID"]) + '"><div class="body">' +
          '<div class="title">' + esc(fmtDT(s["Tested At"])) + '</div>' +
          '<div class="sub">' + esc([rs.length + " reading" + (rs.length === 1 ? "" : "s"), personName(s["Tested By"]), s["Notes"]].filter(Boolean).join(" · ")) + '</div></div>' +
          (off ? '<span class="pill bad">' + off + ' out of range</span>' : rs.length ? '<span class="pill good">✓ All OK</span>' : "") + '</div>';
      }).join("") || '<div class="empty">No tests in the last ' + state.waterDays + ' days</div>') + '</div></div>';
    return {
      title: "Water · " + tankName(tankId),
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
          const res = await api("logWaterTest", { tankId: tank, testedAt: $("#f_wtime", form).value, defaultMethod: methodNow,
                                                   notes: $("#f_wnotes", form).value, readings: readingsOut });
          applyBootstrap(await api("bootstrap"));
          state.waterTank = tank; try { localStorage.setItem("aa_water_tank", tank); } catch (e) { /* ignore */ }
          render();
          if (res.outOfRange && res.outOfRange.length) setTimeout(() => waterAlertSheet(tank, res.outOfRange, readingsOut.length), 50);
          else toast(readingsOut.length + " reading" + (readingsOut.length === 1 ? "" : "s") + " saved · all in range");
          return true;
        } catch (err) {
          if (["AUTH", "NOT_ALLOWED", "SETUP"].indexOf(err.code) !== -1) { handleError(err); return true; }
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
    openSheet({
      title: tankName(s["Tank ID"]) + " · " + fmtDT(s["Tested At"]),
      submitLabel: editable ? "Save" : "Close",
      body: (editable
          ? '<div class="field"><label for="f_stime">Tested at</label><input type="datetime-local" id="f_stime" name="testedAt" value="' + esc(String(s["Tested At"]).replace(" ", "T")) + '"></div>' +
            '<div class="field"><label for="f_snotes">Test notes</label><textarea id="f_snotes" name="notes">' + esc(s["Notes"]) + '</textarea></div>'
          : (s["Notes"] ? '<p>' + esc(s["Notes"]) + '</p>' : "")) +
        '<p class="meta">' + esc([s["Session ID"], "Logged by " + personName(s["Tested By"])].join(" · ")) + '</p>' +
        '<div class="card list">' + rs.map(r => {
          const t = findType(r["Test Type ID"]) || { Name: r["Test Type"], Units: r["Units"] };
          return '<div class="list-item' + (isLive(r) ? "" : " dim") + '"' + (canCorrect(r) ? ' data-act="edit-reading" data-id="' + esc(r["Test ID"]) + '"' : "") + '><div class="body">' +
            '<div class="title">' + esc(t["Name"] + ": " + fmtNum(r["Value"]) + unitsOf(t)) + '</div>' +
            '<div class="sub">' + esc([r["Method"], r["Notes"], isLive(r) ? "" : "Retired"].filter(Boolean).join(" · ")) + '</div></div>' +
            (isLive(r) ? resultPill(r["Result"]) : "") + '</div>';
        }).join("") + '</div>' +
        (editable ? '<p class="hint">Tap a reading to correct or retire it.</p>' : ""),
      onSubmit: vals => {
        if (!editable) return true;
        const changed = {};
        if (vals.testedAt && vals.testedAt !== String(s["Tested At"]).replace(" ", "T")) changed.testedAt = vals.testedAt;
        if (String(vals.notes || "").trim() !== String(s["Notes"] || "").trim()) changed.notes = vals.notes;
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
    const ms = methodsOf(t).length ? methodsOf(t) : [r["Method"]];
    const rg = { min: num(r["Range Min"]), max: num(r["Range Max"]) };
    openSheet({
      title: "Edit " + t["Name"],
      body: '<p class="meta">' + esc([tankName(r["Tank ID"]), fmtDT(r["Tested At"]), r["Test ID"]].join(" · ")) + '</p>' +
        '<div class="field"><label for="f_rv">Value' + (t["Units"] ? " (" + esc(t["Units"]) + ")" : "") + ' <span class="req">*</span></label>' +
          '<input type="text" inputmode="decimal" id="f_rv" name="value" required value="' + esc(fmtNum(r["Value"])) + '">' +
          '<div class="hint">Range at the time: ' + esc(rangeText(rg, t)) + '</div></div>' +
        '<div class="field"><label for="f_rm">Method</label><select id="f_rm" name="method">' + ms.map(m => '<option' + (m === r["Method"] ? " selected" : "") + '>' + esc(m) + '</option>').join("") + '</select></div>' +
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
        if (vals.method !== r["Method"]) changed.method = vals.method;
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

  function showTrendTip(wrap, clientX) {
    const pts = JSON.parse(wrap.dataset.points || "[]");
    if (!pts.length) return;
    const rect = wrap.getBoundingClientRect();
    const fx = (clientX - rect.left) / rect.width;
    let best = pts[0];
    pts.forEach(p => { if (Math.abs(p[0] - fx) < Math.abs(best[0] - fx)) best = p; });
    const tip = $(".trend-tip", wrap);
    tip.textContent = best[1] + " · " + best[2] + (best[3] && best[3] !== "In range" ? " · " + best[3] : "");
    tip.hidden = false;
  }

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------
  document.addEventListener("click", e => {
    const tw = e.target.closest(".trend-wrap");
    if (tw && !e.target.closest(".water-card")) { showTrendTip(tw, e.clientX); return; }
    const el = e.target.closest("[data-act]");
    if (!el || !state.me) return;
    const act = el.dataset.act;
    const d = el.dataset;
    switch (act) {
      case "back":
        if (history.length > 1) history.back(); else location.hash = "#/tanks";
        break;
      case "refresh": refresh(false); break;
      case "sign-out": signOut(); break;
      case "open-item":
        if (e.target.closest("button") && e.target.closest("button") !== el) return;
        location.hash = "#/item/" + d.type + "/" + encodeURIComponent(d.id);
        break;
      case "browse-type": state.browseType = d.type; state.query = ""; render(); break;
      case "toggle-removed": state.showRemoved = !state.showRemoved; render(); break;
      case "add-record": recordForm(d.type); break;
      case "edit-record": recordForm(d.type, d.id); break;
      case "retire": retireForm(d.type, d.id); break;
      case "add-assignment": assignmentForm(d.tank); break;
      case "remove-assignment":
        e.stopPropagation();
        removeAssignmentForm(Number(d.row), d.tank, d.item);
        break;
      case "add-param": paramForm(d.tank); break;
      case "edit-param": paramForm(null, Number(d.row)); break;
      case "add-user": userForm(); break;
      case "log-water": logWaterForm(d.tank); break;
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
    if (e.target.matches("[data-act='toggle-retired-receipts']")) { state.showRetiredReceipts = e.target.checked; render(); }
    if (e.target.matches("[data-act='toggle-retired']")) { state.showRetired = e.target.checked; render(); }
  });
  window.addEventListener("hashchange", () => { if (state.me) render(); });

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  window.AA = { gisLoaded: gisLoaded };

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  try { state.token = localStorage.getItem(TOKEN_KEY); } catch (e) { state.token = null; }
  if (state.token && tokenValid(state.token)) boot();
  else { clearToken(); render(); }
  if (window.google && google.accounts && google.accounts.id) gisLoaded();
})();
