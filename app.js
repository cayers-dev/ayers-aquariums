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
    showRemoved: false
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
      default: view = viewTanks();
    }
    const tab = route.name === "tank" ? "tanks" : route.name === "item" ? "browse" : route.name;
    const tabs = [["tanks", "Tanks"], ["browse", "Browse"]].concat(isAdmin() ? [["users", "Users"]] : []).concat([["account", "Account"]]);

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
          (!isAdmin() && canEditTank(id) ? '<span class="pill edit">You can edit</span>' : "") +
        '</div></a>';
    }).join("");
    const addBtn = isAdmin() ? '<div class="actions" style="margin:0 0 12px"><button class="btn primary" data-act="add-record" data-type="tanks">' + ICONS.plus + 'Add tank</button></div>' : "";
    return { title: "Ayers Aquariums", html: addBtn + (cards || '<div class="empty">No tanks yet.</div>') };
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
      '<div class="section"><div class="section-head"><h3>Water parameters (' + params.length + ')</h3>' +
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
            paramsHtml + detailsSection("tanks", t, "Tank details") + removedHtml
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
      inTanks = '<div class="section"><div class="section-head"><h3>In tanks (' + rows.length + ')</h3></div><div class="card list">' +
        (rows.map(a => '<a class="list-item" href="#/tank/' + encodeURIComponent(a["Tank ID"]) + '"><div class="body"><div class="title">' + esc(tankName(a["Tank ID"])) + '</div>' +
          '<div class="sub">' + esc([a["Tank ID"], a["Date Added"] ? "Added " + fmtDate(a["Date Added"]) : ""].filter(Boolean).join(" · ")) + '</div></div></a>').join("") ||
          '<div class="empty">Not in any tank</div>') + '</div></div>';
    }
    const hero = '<div class="card">' +
      (img ? '<img class="big-img" alt="" src="' + esc(thumbUrl(img, 800)) + '">' : "") +
      '<div class="hero"><h2>' + esc(T.title(r)) + '</h2><div class="meta">' + esc([r[T.id], T.sub(r)].filter(Boolean).join(" · ")) + '</div>' +
      (isRetired(r) ? '<div class="counts"><span class="pill retired">Retired</span></div>' : "") +
      (isAdmin() ? '<div class="actions"><button class="btn" data-act="edit-record" data-type="' + type + '" data-id="' + esc(id) + '">Edit</button>' +
        (!isRetired(r) && "Status" in r ? '<button class="btn danger" data-act="retire" data-type="' + type + '" data-id="' + esc(id) + '">Retire</button>' : "") + '</div>' : "") +
      '</div></div>';
    return { title: T.title(r), back: true, html: hero + inTanks + detailsSection(type, r, "Details") };
  }

  // ---------- Users (admin) ----------
  function viewUsers() {
    const users = (state.users || []).slice().sort((a, b) => (b.active - a.active) || a.email.localeCompare(b.email));
    const rows = users.map(u =>
      '<div class="list-item user-row ' + (u.active ? "" : "dim") + '" data-act="edit-user" data-email="' + esc(u.email) + '">' +
      '<div class="body"><div class="title">' + esc(u.name || u.email) + '</div>' +
      '<div class="sub">' + esc(u.email) + '</div>' +
      (u.role === "Editor" ? '<div class="sub">Edits: ' + esc(u.tanks.map(tankName).join(", ") || "no tanks yet") + '</div>' : "") + '</div>' +
      '<span class="pill ' + (u.role === "Admin" ? "edit" : "") + '">' + esc(u.active ? u.role : "Inactive") + '</span></div>').join("");
    return {
      title: "Users",
      html: '<div class="actions" style="margin:0 0 12px"><button class="btn primary" data-act="add-user">' + ICONS.plus + 'Add user</button></div>' +
        '<div class="card list">' + (rows || '<div class="empty">No users.</div>') + '</div>' +
        '<p class="hint">Admins can change everything. Editors can change only the tanks you pick for them. Viewers can only look. Users sign in with the Google account email listed here.</p>'
    };
  }

  // ---------- Account ----------
  function viewAccount() {
    const me = state.me;
    const tankList = me.role === "Admin" ? "All tanks" : me.role === "Editor" ? (me.tanks.map(tankName).join(", ") || "None yet") : "None (view only)";
    return {
      title: "Account",
      html: '<div class="card kv">' +
        '<div class="k">Name</div><div>' + esc(me.name || "") + '</div>' +
        '<div class="k">Email</div><div>' + esc(me.email) + '</div>' +
        '<div class="k">Role</div><div>' + esc(me.role) + '</div>' +
        '<div class="k">Can edit</div><div>' + esc(tankList) + '</div></div>' +
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
        .map(el => { const l = el.id && $("label[for='" + el.id + "']", form); return l ? l.textContent.replace(/\s*\*\s*$/, "") : el.name; });
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

  function assignmentForm(tankId) {
    const inTank = new Set(tankAssignments(tankId, true).map(a => a["Item ID"]));
    const optgroups = ITEM_TYPES.map(ty => {
      const T = TYPES[ty];
      const opts = state.data[ty].filter(r => !isRetired(r) && !inTank.has(r[T.id]))
        .sort((a, b) => String(T.title(a)).localeCompare(String(T.title(b))))
        .map(r => '<option value="' + esc(r[T.id]) + '">' + esc(T.title(r) + " (" + r[T.id] + ")") + '</option>').join("");
      return opts ? '<optgroup label="' + esc(T.label) + '">' + opts + '</optgroup>' : "";
    }).join("");
    const filter = '<div class="field"><label for="f_filter">Find</label><input type="text" id="f_filter" placeholder="Type to narrow the list" autocomplete="off"></div>';
    openSheet({
      title: "Add to " + tankName(tankId),
      submitLabel: "Add",
      body: filter +
        fieldHtml({ name: "Item ID", label: "Item", type: "select", required: true, html: '<option value=""></option>' + optgroups }) +
        fieldHtml({ name: "Date Added", type: "date" }, today()) +
        fieldHtml({ name: "Notes", type: "longtext" }, "") +
        '<p class="hint">Only admins can add new species, equipment or plants to the lists. Ask Chris if something is missing.</p>',
      onReady: form => {
        const sel = $("select[name='Item ID']", form);
        const all = $$("option", sel).map(o => ({ o: o, text: o.textContent.toLowerCase() }));
        $("#f_filter", form).addEventListener("input", e => {
          const q = e.target.value.trim().toLowerCase();
          all.forEach(x => { if (x.o.value) x.o.hidden = !!q && x.text.indexOf(q) === -1; });
          $$("optgroup", sel).forEach(g => { g.hidden = !$$("option", g).some(o => !o.hidden); });
        });
      },
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
    const fields = state.schema.waterParameters.filter(f => f.name !== "Tank ID");
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

  function userForm(email) {
    const editing = !!email;
    const u = editing ? state.users.find(x => x.email === email) : { email: "", name: "", role: "Viewer", tanks: [], active: true };
    const tanks = state.data.tanks.slice().sort((a, b) => String(a["Tank Name"]).localeCompare(String(b["Tank Name"])));
    const tankBoxes = tanks.map(t => '<label class="check"><input type="checkbox" name="tank:' + esc(t["Tank ID"]) + '"' +
      (u.tanks.indexOf(t["Tank ID"]) !== -1 ? " checked" : "") + '> ' + esc(t["Tank Name"]) + ' <span class="meta">' + esc(t["Tank ID"]) + '</span></label>').join("");
    openSheet({
      title: editing ? "Edit user" : "Add user",
      body:
        '<div class="field"><label for="f_email">Google account email <span class="req">*</span></label><input type="email" id="f_email" name="email" value="' + esc(u.email) + '" required' + (editing ? " readonly" : "") + ' autocomplete="off"></div>' +
        '<div class="field"><label for="f_name">Name</label><input type="text" id="f_name" name="name" value="' + esc(u.name) + '"></div>' +
        '<div class="field"><label for="f_role">Role</label><select id="f_role" name="role">' +
          ["Admin", "Editor", "Viewer"].map(r => '<option' + (r === u.role ? " selected" : "") + '>' + r + '</option>').join("") + '</select>' +
          '<div class="hint">Admin: everything. Editor: only the tanks checked below. Viewer: look only.</div></div>' +
        '<div class="field" id="tank-picks"' + (u.role === "Editor" ? "" : " hidden") + '><label>Tanks this editor can change</label>' + tankBoxes + '</div>' +
        '<div class="field"><label class="check"><input type="checkbox" name="active"' + (u.active ? " checked" : "") + '> Active (can sign in)</label></div>',
      onReady: form => {
        $("#f_role", form).addEventListener("change", e => { $("#tank-picks", form).hidden = e.target.value !== "Editor"; });
      },
      onSubmit: async (vals, form) => {
        const picked = $$("input[name^='tank:']", form).filter(el => el.checked).map(el => el.name.slice(5));
        const payload = { email: editing ? u.email : vals.email, name: vals.name, role: vals.role, tanks: picked, active: vals.active };
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
  // Events
  // ------------------------------------------------------------------
  document.addEventListener("click", e => {
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
      case "edit-user": userForm(d.email); break;
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
  document.addEventListener("change", e => {
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
