// ============================================================
// AYERS AQUARIUMS - WEB APP API
//
// The Ayers Aquariums mobile app (hosted on GitHub Pages) sends
// every request here. Each request carries a Google sign-in token,
// which is verified with Google; the email is then checked against
// the "App Users" tab to get the person's role and editable tanks.
//
// Deploy as: Web app, Execute as: Me, Who has access: Anyone.
// (The sign-in check below is what protects the data.)
//
// Uses SHEET_IDS from Entry Forms.gs.
// Nothing here ever deletes rows: records are retired (Status) or
// removed from tanks (Date Removed).
// ============================================================

const API_CONFIG = {
   // OAuth "Web application" client ID from Google Cloud Console.
   clientId: "53317218551-r9sk421q1ndrvb0hmivv20n4jt376to5.apps.googleusercontent.com",
   usersSheetName: "App Users",
   logSheetName: "Change Log",
   appName: "Ayers Aquariums"
};

const API_ROLES = ["Admin", "Editor", "Viewer"];

// Tables the app can read. "shared" tables are admin-only to change.
const API_TABLES = {
   tanks:           { sheetKey: "tank",            label: "Tank",            id: "Tank ID",      prefix: "TK-",  required: ["Tank Name"] },
   species:         { sheetKey: "species",         label: "Species",         id: "Species ID",   prefix: "FS-",  required: ["Common Name"],  shared: true },
   equipment:       { sheetKey: "equipment",       label: "Equipment",       id: "Equipment ID", prefix: "EQ-",  required: ["Category"],     shared: true },
   plants:          { sheetKey: "plants",          label: "Plants",          id: "Plant ID",     prefix: "PL-",  required: ["Common Name"],  shared: true },
   medications:     { sheetKey: "medications",     label: "Medication and Supplements", id: "Product ID", prefix: "MED-", required: ["Product Name"], shared: true },
   assignments:     { sheetKey: "tankAssignments", label: "Tank Assignments" },
   waterParameters: { sheetKey: "waterParameters", label: "Water Parameters", required: ["Tank ID", "Parameter"] }
};

// Columns filled by formulas: never written by the app.
const API_FORMULA_COLUMNS = ["Species Info", "Tank Info", "Equipment Info", "Plant Info"];

// Dropdown lists (from the DropDownOptions tab) per table field.
// strict = value must come from the list.
const API_FIELD_LISTS = {
   tanks:           { "Aquarium Type": ["Aquarium Type", true], "Manufacturer": ["Manufacturer", false],
                      "Status": ["Status", true], "Vendor": ["Vendor", false] },
   species:         { "Category": ["Fish Category", true], "Water Zone": ["Water Zone", true],
                      "Group Type": ["Group Type", true], "Difficulty": ["Difficulty", true],
                      "Status": ["Status", true] },
   equipment:       { "Category": ["Equipment Type", true], "Manufacturer": ["Manufacturer", false],
                      "Filter Model": ["Filter Model", false], "Vendor": ["Vendor", false],
                      "Status": ["Status", true] },
   plants:          { "Difficulty": ["Difficulty", true], "Status": ["Status", true] },
   waterParameters: { "Parameter": ["Water Parameter", true] }
};

const API_NUMBER_FIELDS = ["Volume (gal)", "Temp Min °F", "Temp Max °F", "Max Size (in)"];
const API_DATE_PATTERN = /(^| )Date($| )|Expires/;
const API_LONG_TEXT_PATTERN = /Notes|Options|Purpose|Issues|Keywords|Warnings|Requirements|Ingredients|Effect|Dose|Frequency|Stores|Recommended Group|Measurement/;
const API_URL_PATTERN = /URL$|Link$|Page$/;


// ============================================================
// ENTRY POINTS
// ============================================================

function doGet() {
   return apiJson_({ ok: true, app: API_CONFIG.appName });
}

function doPost(e) {
   try {
      const req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
      const user = apiVerifyUser_(req.idToken);
      const result = apiRoute_(req, user);
      return apiJson_(Object.assign({ ok: true }, result));
   } catch (err) {
      const out = { ok: false, code: err.apiCode || "ERROR", message: err.apiCode ? err.message : "Something went wrong: " + err.message };
      if (err.apiExtra) Object.assign(out, err.apiExtra);
      if (!err.apiCode) console.error(err && err.stack ? err.stack : err);
      return apiJson_(out);
   }
}

function apiRoute_(req, user) {
   switch (req.action) {
      case "bootstrap":         return apiBootstrap_(user);
      case "add":               return apiWrite_(() => apiAdd_(req, user));
      case "update":            return apiWrite_(() => apiUpdate_(req, user));
      case "retire":            return apiWrite_(() => apiRetire_(req, user));
      case "removeAssignment":  return apiWrite_(() => apiRemoveAssignment_(req, user));
      case "saveUser":          return apiWrite_(() => apiSaveUser_(req, user));
      // Receipts (Receipts.gs)
      case "uploadReceipt":     return apiWrite_(() => apiUploadReceipt_(req, user));
      case "receiptPhoto":      return apiReceiptPhoto_(req, user);
      case "updateReceipt":     return apiWrite_(() => apiUpdateReceipt_(req, user));
      case "retireReceipt":     return apiWrite_(() => apiRetireReceipt_(req, user));
      case "linkReceipt":       return apiWrite_(() => apiLinkReceipt_(req, user));
      case "unlinkReceipt":     return apiWrite_(() => apiUnlinkReceipt_(req, user));
      default: throw apiError_("BAD_REQUEST", "Unknown action.");
   }
}


// ============================================================
// ONE-TIME SETUP (run from the editor)
// Creates the App Users and Change Log tabs and asks for the
// permissions the web app needs.
// ============================================================

function apiSetup() {
   apiEnsureSupportTabs_();
   // Touch UrlFetchApp so the editor asks for the "external request"
   // permission used to verify Google sign-ins.
   UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=x", { muteHttpExceptions: true });
   Logger.log("Setup complete. Users tab: " + API_CONFIG.usersSheetName);
}


// ============================================================
// AUTH
// ============================================================

function apiVerifyUser_(idToken) {
   if (!idToken) throw apiError_("AUTH", "Please sign in.");
   if (API_CONFIG.clientId.indexOf("PASTE_") === 0) throw apiError_("SETUP", "The app's sign-in client ID hasn't been set yet.");

   const cache = CacheService.getScriptCache();
   const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken);
   const key = "tok_" + Utilities.base64EncodeWebSafe(digest).slice(0, 43);
   let email = cache.get(key);

   if (!email) {
      const res = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken),
                                    { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) throw apiError_("AUTH", "Your sign-in has expired. Please sign in again.");
      const info = JSON.parse(res.getContentText());
      if (info.aud !== API_CONFIG.clientId) throw apiError_("AUTH", "That sign-in was for a different app.");
      if (String(info.email_verified) !== "true") throw apiError_("AUTH", "Your Google email address isn't verified.");
      const secondsLeft = Number(info.exp) - Math.floor(Date.now() / 1000);
      if (!(secondsLeft > 0)) throw apiError_("AUTH", "Your sign-in has expired. Please sign in again.");
      email = String(info.email).trim().toLowerCase();
      cache.put(key, email, Math.max(30, Math.min(600, secondsLeft - 30)));
   }

   const user = apiGetUsers_().find(u => u.email === email);
   if (!user || !user.active) {
      throw apiError_("NOT_ALLOWED", email + " isn't on the " + API_CONFIG.appName + " user list.", { email: email });
   }
   return user;
}

function apiCanEditTank_(user, tankId) {
   return user.role === "Admin" || (user.role === "Editor" && user.tanks.indexOf(tankId) !== -1);
}

function apiRequireAdmin_(user) {
   if (user.role !== "Admin") throw apiError_("FORBIDDEN", "Only admins can do that.");
}


// ============================================================
// READ
// ============================================================

function apiBootstrap_(user) {
   const ss = apiSs_();
   const data = {};
   Object.keys(API_TABLES).forEach(t => data[t] = apiReadTable_(t).rows);

   const lists = apiReadLists_(ss);
   const schema = {};
   Object.keys(API_TABLES).forEach(t => schema[t] = apiSchema_(t, lists));

   const out = {
      user: { email: user.email, name: user.name, role: user.role, tanks: user.tanks },
      appName: API_CONFIG.appName,
      schema: schema,
      data: data
   };
   if (user.role === "Admin") out.users = apiGetUsers_();
   Object.assign(out, apiReceiptsBootstrap_(user, lists));
   return out;
}

function apiReadTable_(table) {
   const def = API_TABLES[table];
   const sheet = apiSheet_(def.sheetKey);
   const lastRow = sheet.getLastRow();
   const lastCol = sheet.getLastColumn();
   if (lastRow < 1 || lastCol < 1) return { headers: [], rows: [] };

   const range = sheet.getRange(1, 1, lastRow, lastCol);
   const values = range.getValues();
   const shown = range.getDisplayValues();
   const headers = values[0].map(h => String(h).trim());
   const tz = apiSs_().getSpreadsheetTimeZone();
   const rows = [];

   for (let r = 1; r < values.length; r++) {
      const obj = { _row: r + 1 };
      headers.forEach((h, c) => {
         if (!h || h in obj) return;
         const v = values[r][c];
         obj[h] = v instanceof Date ? Utilities.formatDate(v, tz, "yyyy-MM-dd")
                : (typeof v === "number" ? shown[r][c] : v);
      });
      const keep = def.id ? obj[def.id] !== "" :
                   table === "assignments" ? (obj["Tank ID"] !== "" && obj["Item ID"] !== "") :
                   obj["Tank ID"] !== "";
      if (keep) rows.push(obj);
   }
   return { headers: headers.filter(Boolean), rows: rows };
}

function apiReadLists_(ss) {
   const sheet = ss.getSheetByName("DropDownOptions");
   const lists = {};
   if (!sheet) return lists;
   const values = sheet.getDataRange().getValues();
   const headers = values[0];
   headers.forEach((h, c) => {
      const name = String(h).trim();
      if (!name || lists[name]) return;
      lists[name] = values.slice(1).map(r => String(r[c]).trim()).filter(v => v !== "");
   });
   return lists;
}

// Describes each editable field so the app can build its forms.
function apiSchema_(table, lists) {
   const def = API_TABLES[table];
   const sheet = apiSheet_(def.sheetKey);
   const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => String(h).trim()).filter(Boolean);
   const listDefs = API_FIELD_LISTS[table] || {};
   const required = def.required || [];

   return headers
      .filter((h, i) => headers.indexOf(h) === i)
      .filter(h => API_FORMULA_COLUMNS.indexOf(h) === -1)
      .map(h => {
         const f = { name: h, type: "text" };
         if (h === def.id) f.readOnly = true;
         if (listDefs[h]) { f.type = "list"; f.options = lists[listDefs[h][0]] || []; f.strict = listDefs[h][1]; }
         else if (API_NUMBER_FIELDS.indexOf(h) !== -1) f.type = "number";
         else if (API_DATE_PATTERN.test(h)) f.type = "date";
         else if (API_URL_PATTERN.test(h)) f.type = "url";
         else if (API_LONG_TEXT_PATTERN.test(h)) f.type = "longtext";
         if (h === "Active") f.type = "boolean";
         if (required.indexOf(h) !== -1) f.required = true;
         return f;
      });
}


// ============================================================
// WRITE
// ============================================================

function apiWrite_(fn) {
   const lock = LockService.getScriptLock();
   lock.waitLock(20000);
   try {
      const result = fn();
      SpreadsheetApp.flush();
      return result;
   } finally {
      lock.releaseLock();
   }
}

function apiAdd_(req, user) {
   const table = req.table;
   const def = API_TABLES[table];
   if (!def) throw apiError_("BAD_REQUEST", "Unknown table.");
   const values = apiCleanValues_(table, req.values || {});

   if (table === "assignments") {
      const tankId = values["Tank ID"], itemId = values["Item ID"];
      if (!tankId || !itemId) throw apiError_("INVALID", "Choose a tank and an item.");
      if (!apiCanEditTank_(user, tankId)) throw apiError_("FORBIDDEN", "You can't change that tank.");
      if (!apiFindById_("tanks", tankId)) throw apiError_("INVALID", "Tank " + tankId + " doesn't exist.");
      if (!["species", "equipment", "plants"].some(t => apiFindById_(t, itemId))) {
         throw apiError_("INVALID", "Item " + itemId + " doesn't exist.");
      }
      const active = apiReadTable_("assignments").rows.find(r =>
         r["Tank ID"] === tankId && r["Item ID"] === itemId && r["Active"] === true && !r["Date Removed"]);
      if (active) throw apiError_("INVALID", itemId + " is already in this tank.");
      values["Active"] = true;
      if (!values["Date Added"]) values["Date Added"] = new Date();
      delete values["Date Removed"];
      const row = apiAppendRow_(apiSheet_(def.sheetKey), values);
      apiLog_(user, "Add", def.label, tankId + " / " + itemId, apiDescribe_(values));
      return { added: { table: table, row: row } };
   }

   if (table === "waterParameters") {
      const tankId = values["Tank ID"];
      apiCheckRequired_(def, values);
      if (!apiCanEditTank_(user, tankId)) throw apiError_("FORBIDDEN", "You can't change that tank.");
      const dupe = apiReadTable_("waterParameters").rows.find(r =>
         r["Tank ID"] === tankId && String(r["Parameter"]).toLowerCase() === String(values["Parameter"]).toLowerCase());
      if (dupe) throw apiError_("INVALID", tankId + " already has " + values["Parameter"] + ". Edit it instead.");
      const row = apiAppendRow_(apiSheet_(def.sheetKey), values);
      apiLog_(user, "Add", def.label, tankId + " / " + values["Parameter"], apiDescribe_(values));
      return { added: { table: table, row: row } };
   }

   // Tanks and shared records: admins only.
   apiRequireAdmin_(user);
   apiCheckRequired_(def, values);
   const sheet = apiSheet_(def.sheetKey);
   const id = apiNextId_(table);
   values[def.id] = id;
   if (!values["Status"] && apiHasHeader_(sheet, "Status")) values["Status"] = "Active";
   apiAppendRow_(sheet, values);
   apiLog_(user, "Add", def.label, id, apiDescribe_(values));
   return { added: { table: table, id: id } };
}

function apiUpdate_(req, user) {
   const table = req.table;
   const def = API_TABLES[table];
   if (!def) throw apiError_("BAD_REQUEST", "Unknown table.");
   const values = apiCleanValues_(table, req.values || {});
   let record, recordLabel;

   if (def.id) {
      record = apiFindById_(table, req.id);
      if (!record) throw apiError_("NOT_FOUND", "That record no longer exists.");
      if (table === "tanks") {
         if (!apiCanEditTank_(user, record[def.id])) throw apiError_("FORBIDDEN", "You can't change that tank.");
      } else {
         apiRequireAdmin_(user);
      }
      delete values[def.id];
      recordLabel = record[def.id];
   } else {
      record = apiFindRow_(table, req.key);
      if (!apiCanEditTank_(user, record["Tank ID"])) throw apiError_("FORBIDDEN", "You can't change that tank.");
      // The tank and the item/parameter identify the row; they can't be changed.
      delete values["Tank ID"];
      if (table === "assignments") delete values["Item ID"];
      if (table === "waterParameters") delete values["Parameter"];
      recordLabel = record["Tank ID"] + " / " + (record["Item ID"] || record["Parameter"]);
   }

   const merged = Object.assign({}, record, values);
   apiCheckRequired_(def, merged);
   const changes = apiWriteChanges_(apiSheet_(def.sheetKey), record._row, record, values);
   if (changes.length) apiLog_(user, "Edit", def.label, recordLabel, changes.join("; "));
   return { updated: changes.length };
}

function apiRetire_(req, user) {
   const table = req.table;
   const def = API_TABLES[table];
   if (!def || !def.id) throw apiError_("BAD_REQUEST", "That record can't be retired.");
   apiRequireAdmin_(user);
   const record = apiFindById_(table, req.id);
   if (!record) throw apiError_("NOT_FOUND", "That record no longer exists.");
   const changes = apiWriteChanges_(apiSheet_(def.sheetKey), record._row, record, { "Status": "Retired" });
   if (changes.length) apiLog_(user, "Retire", def.label, record[def.id], changes.join("; "));
   return { updated: changes.length };
}

function apiRemoveAssignment_(req, user) {
   const record = apiFindRow_("assignments", req.key);
   if (!apiCanEditTank_(user, record["Tank ID"])) throw apiError_("FORBIDDEN", "You can't change that tank.");
   if (record["Date Removed"]) throw apiError_("INVALID", "That item was already removed.");
   const date = req.date ? apiParseDate_(req.date) : new Date();
   const changes = apiWriteChanges_(apiSheet_("tankAssignments"), record._row, record,
                                    { "Date Removed": date, "Active": false });
   apiLog_(user, "Remove from tank", "Tank Assignments", record["Tank ID"] + " / " + record["Item ID"], changes.join("; "));
   return { updated: changes.length };
}


// ============================================================
// USERS
// ============================================================

function apiGetUsers_() {
   const sheet = apiEnsureSupportTabs_().users;
   const values = sheet.getDataRange().getValues();
   const h = values[0].map(x => String(x).trim());
   const col = name => h.indexOf(name);
   return values.slice(1)
      .filter(r => String(r[col("Email")]).trim() !== "")
      .map((r, i) => ({
         row: i + 2,
         email: String(r[col("Email")]).trim().toLowerCase(),
         name: String(r[col("Name")] || "").trim(),
         role: API_ROLES.indexOf(String(r[col("Role")]).trim()) !== -1 ? String(r[col("Role")]).trim() : "Viewer",
         tanks: String(r[col("Editable Tanks")] || "").split(",").map(s => s.trim()).filter(Boolean),
         active: r[col("Active")] === true || String(r[col("Active")]).toUpperCase() === "TRUE"
      }));
}

function apiSaveUser_(req, user) {
   apiRequireAdmin_(user);
   const u = req.user || {};
   const email = String(u.email || "").trim().toLowerCase();
   if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw apiError_("INVALID", "Enter a valid email address.");
   const role = API_ROLES.indexOf(u.role) !== -1 ? u.role : null;
   if (!role) throw apiError_("INVALID", "Choose a role.");
   const active = u.active !== false;
   if (email === user.email && (role !== "Admin" || !active)) {
      throw apiError_("INVALID", "You can't remove your own admin access.");
   }
   const tankIds = apiReadTable_("tanks").rows.map(t => t["Tank ID"]);
   const tanks = (u.tanks || []).filter(t => tankIds.indexOf(t) !== -1);

   const sheet = apiEnsureSupportTabs_().users;
   const existing = apiGetUsers_().find(x => x.email === email);
   const record = { "Email": email, "Name": String(u.name || "").trim(), "Role": role,
                    "Editable Tanks": role === "Editor" ? tanks.join(", ") : "", "Active": active };

   if (existing) {
      const before = { "Email": existing.email, "Name": existing.name, "Role": existing.role,
                       "Editable Tanks": existing.tanks.join(", "), "Active": existing.active };
      const changes = apiWriteChanges_(sheet, existing.row, before, record);
      if (changes.length) apiLog_(user, "Edit", "App Users", email, changes.join("; "));
   } else {
      record["Added"] = new Date();
      apiAppendRow_(sheet, record);
      apiLog_(user, "Add", "App Users", email, apiDescribe_(record));
   }
   return { users: apiGetUsers_() };
}


// ============================================================
// SHEET HELPERS
// ============================================================

function apiSs_() {
   return SpreadsheetApp.getActiveSpreadsheet();
}

function apiSheet_(sheetKey) {
   const sheet = apiSs_().getSheetById(SHEET_IDS[sheetKey]);
   if (!sheet) throw apiError_("SETUP", "A data tab is missing (" + sheetKey + ").");
   return sheet;
}

function apiHeaderMap_(sheet) {
   const lastCol = sheet.getLastColumn();
   const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
   const map = {};
   headers.forEach((h, i) => {
      const name = String(h).trim().toLowerCase();
      if (name && !(name in map)) map[name] = i + 1;
   });
   return { map: map, lastCol: lastCol };
}

function apiHasHeader_(sheet, name) {
   return name.toLowerCase() in apiHeaderMap_(sheet).map;
}

function apiAppendRow_(sheet, values) {
   const hm = apiHeaderMap_(sheet);
   const row = Math.max(sheet.getLastRow() + 1, 2);
   if (row > sheet.getMaxRows()) sheet.insertRowAfter(sheet.getMaxRows());
   if (row > 2) {
      sheet.getRange(2, 1, 1, hm.lastCol)
         .copyTo(sheet.getRange(row, 1, 1, hm.lastCol), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
   }
   Object.keys(values).forEach(h => {
      const c = hm.map[h.toLowerCase()];
      if (c && API_FORMULA_COLUMNS.indexOf(h) === -1 && values[h] !== "" && values[h] !== undefined) {
         sheet.getRange(row, c).setValue(values[h]);
      }
   });
   return row;
}

// Writes only the fields whose value changed; returns "Field: old → new" notes.
function apiWriteChanges_(sheet, row, before, values) {
   const hm = apiHeaderMap_(sheet);
   const tz = apiSs_().getSpreadsheetTimeZone();
   const show = v => v instanceof Date ? Utilities.formatDate(v, tz, "yyyy-MM-dd") : (v === undefined || v === null ? "" : String(v));
   const changes = [];
   Object.keys(values).forEach(h => {
      const c = hm.map[h.toLowerCase()];
      if (!c || API_FORMULA_COLUMNS.indexOf(h) !== -1) return;
      const oldV = show(before[h]), newV = show(values[h]);
      if (oldV === newV) return;
      sheet.getRange(row, c).setValue(values[h] === "" ? "" : values[h]);
      changes.push(h + ": " + (oldV || "(blank)") + " → " + (newV || "(blank)"));
   });
   return changes;
}

function apiFindById_(table, id) {
   const def = API_TABLES[table];
   return apiReadTable_(table).rows.find(r => r[def.id] === id) || null;
}

// Rows without an ID column are found by row number, then double-checked.
function apiFindRow_(table, key) {
   key = key || {};
   const record = apiReadTable_(table).rows.find(r => r._row === Number(key.row));
   const matches = record && record["Tank ID"] === key.tankId &&
      (table === "assignments" ? record["Item ID"] === key.itemId : record["Parameter"] === key.parameter);
   if (!matches) throw apiError_("STALE", "That row changed since you loaded it. Pull down to refresh and try again.");
   return record;
}

function apiNextId_(table) {
   const def = API_TABLES[table];
   const max = apiReadTable_(table).rows.reduce((m, r) => {
      const n = Number(String(r[def.id]).replace(/^\D+/, ""));
      return isNaN(n) ? m : Math.max(m, n);
   }, 0);
   return def.prefix + (max + 1);
}

function apiCleanValues_(table, raw) {
   const schema = apiSchema_(table, apiReadLists_(apiSs_()));
   const byName = {};
   schema.forEach(f => byName[f.name] = f);
   const out = {};
   Object.keys(raw).forEach(name => {
      const f = byName[name];
      if (!f) return;
      let v = raw[name];
      if (v === null || v === undefined) v = "";
      if (f.type === "boolean") v = v === true || String(v).toUpperCase() === "TRUE";
      else if (typeof v === "string") v = v.trim();
      if (v !== "" && f.type === "number") {
         if (isNaN(Number(v))) throw apiError_("INVALID", name + " must be a number.");
         v = Number(v);
      }
      if (v !== "" && f.type === "date") v = apiParseDate_(v);
      if (v !== "" && f.type === "list" && f.strict && f.options.indexOf(v) === -1) {
         throw apiError_("INVALID", name + " must be one of: " + f.options.join(", "));
      }
      out[name] = v;
   });
   return out;
}

function apiCheckRequired_(def, values) {
   const missing = (def.required || []).filter(f => values[f] === "" || values[f] === undefined || values[f] === null);
   if (missing.length) throw apiError_("INVALID", "Please fill in: " + missing.join(", ") + ".");
}

function apiParseDate_(v) {
   if (v instanceof Date) return v;
   const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
   if (!m) throw apiError_("INVALID", "Dates must look like 2026-11-11.");
   return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function apiDescribe_(values) {
   const tz = apiSs_().getSpreadsheetTimeZone();
   return Object.keys(values)
      .filter(k => values[k] !== "" && values[k] !== undefined)
      .map(k => k + ": " + (values[k] instanceof Date ? Utilities.formatDate(values[k], tz, "yyyy-MM-dd") : values[k]))
      .join("; ");
}


// ============================================================
// SUPPORT TABS + CHANGE LOG
// ============================================================

function apiEnsureSupportTabs_() {
   const ss = apiSs_();
   let users = ss.getSheetByName(API_CONFIG.usersSheetName);
   if (!users) {
      users = ss.insertSheet(API_CONFIG.usersSheetName);
      users.getRange(1, 1, 1, 7).setValues([["Email", "Name", "Role", "Editable Tanks", "Active", "Added", "Notes"]])
         .setFontWeight("bold").setBackground("#d9d9d9");
      users.appendRow([Session.getEffectiveUser().getEmail().toLowerCase(), "Chris Ayers", "Admin", "", true, new Date(),
                       "Owner. Editable Tanks: comma-separated Tank IDs (Editors only)."]);
      users.setFrozenRows(1);
      users.getRange("E2:E").insertCheckboxes();
      users.getRange("C2:C").setDataValidation(SpreadsheetApp.newDataValidation()
         .requireValueInList(API_ROLES, true).setAllowInvalid(false).build());
      users.getRange("F2:F").setNumberFormat("m/d/yyyy");
      users.setColumnWidths(1, 1, 220);
      users.setColumnWidths(4, 1, 200);
      users.setColumnWidths(7, 1, 320);
   }
   let log = ss.getSheetByName(API_CONFIG.logSheetName);
   if (!log) {
      log = ss.insertSheet(API_CONFIG.logSheetName);
      log.getRange(1, 1, 1, 6).setValues([["Timestamp", "User", "Action", "Table", "Record", "Changes"]])
         .setFontWeight("bold").setBackground("#d9d9d9");
      log.setFrozenRows(1);
      log.getRange("A2:A").setNumberFormat("m/d/yyyy h:mm am/pm");
      log.setColumnWidths(1, 1, 150);
      log.setColumnWidths(2, 1, 200);
      log.setColumnWidths(6, 1, 500);
   }
   return { users: users, log: log };
}

function apiLog_(user, action, table, record, changes) {
   apiEnsureSupportTabs_().log.appendRow([new Date(), user.email, action, table, record, changes || ""]);
}


// ============================================================
// UTIL
// ============================================================

function apiJson_(obj) {
   return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function apiError_(code, message, extra) {
   const e = new Error(message);
   e.apiCode = code;
   if (extra) e.apiExtra = extra;
   return e;
}
