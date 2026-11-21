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
// Nothing here ever deletes rows: records are retired (Status) or
// removed from tanks (Date Removed).
// ============================================================

// Tab IDs (the number after #gid= in the tab's URL), so tabs can be renamed
// without breaking anything. Tabs added later (Foods, Maintenance Notes,
// Item Photos and the rest) are found by name instead.
const SHEET_IDS = {
   species:           526685297,
   tank:              1037277526,
   equipment:         1741790309,
   plants:            547150186,
   medications:       1839526114,
   waterParameters:   767978537,
   tankAssignments:   1509314986
};

// Sign-in client, tab names and app name used throughout the API.
const API_CONFIG = {
   // OAuth "Web application" client ID from Google Cloud Console.
   clientId: "53317218551-r9sk421q1ndrvb0hmivv20n4jt376to5.apps.googleusercontent.com",
   usersSheetName: "App Users",
   logSheetName: "Change Log",
   appName: "Ayers Aquariums",
   // Signed out after this many minutes without using the app (each request renews it).
   sessionMinutes: 60
};

// Roles a person can have on the App Users tab.
const API_ROLES = ["Admin", "Editor", "Viewer"];

// Tables the app can read. "shared" tables are admin-only to change.
const API_TABLES = {
   tanks:           { sheetKey: "tank",            label: "Tank",            id: "Tank ID",      prefix: "TK-",  required: ["Tank Name"] },
   species:         { sheetKey: "species",         label: "Species",         id: "Species ID",   prefix: "FS-",  required: ["Common Name"],  shared: true },
   equipment:       { sheetKey: "equipment",       label: "Equipment",       id: "Equipment ID", prefix: "EQ-",  required: ["Category"],     shared: true },
   plants:          { sheetKey: "plants",          label: "Plants",          id: "Plant ID",     prefix: "PL-",  required: ["Common Name"],  shared: true },
   medications:     { sheetKey: "medications",     label: "Medication and Supplements", id: "Product ID", prefix: "MED-", required: ["Product Name"], shared: true },
   foods:           { sheetKey: "foods",           label: "Food",            id: "Food ID",      prefix: "FD-",  required: ["Product Name"], shared: true },
   assignments:     { sheetKey: "tankAssignments", label: "Tank Assignments" },
   waterParameters: { sheetKey: "waterParameters", label: "Water Parameters", required: ["Tank ID", "Parameter"] }
};

// The record types that are put in a tank (Tank Assignments).
const API_ASSIGN_TYPES = ["species", "equipment", "plants", "foods"];

// Columns filled by formulas: never written by the app.
const API_FORMULA_COLUMNS = ["Species Info", "Tank Info", "Equipment Info", "Plant Info"];

// Dropdown lists (from the DropDownOptions tab) per table field.
// strict = value must come from the list.
const API_FIELD_LISTS = {
   // Tanks have their own status list (Active, Storage, Retired); the shared Status list is the fallback.
   tanks:           { "Aquarium Type": ["Aquarium Type", true], "Manufacturer": ["Manufacturer", false],
                      "Status": ["Tank Status", true, "Status"], "Vendor": ["Vendor", false] },
   species:         { "Category": ["Fish Category", true], "Water Zone": ["Water Zone", true],
                      "Group Type": ["Group Type", true], "Difficulty": ["Difficulty", true],
                      "Status": ["Status", true] },
   equipment:       { "Category": ["Equipment Type", true], "Manufacturer": ["Manufacturer", false],
                      "Filter Model": ["Filter Model", false], "Status": ["Status", true] },
   plants:          { "Difficulty": ["Difficulty", true], "Status": ["Status", true] },
   medications:     { "Stock": ["Stock Status", true] },
   foods:           { "Food Type": ["Food Type", true], "Manufacturer": ["Manufacturer", false],
                      "Status": ["Status", true], "Stock": ["Stock Status", true] },
   // How often a food is fed, on the assignment that puts it in a tank (Foods.gs).
   assignments:     { "Feed Frequency": ["Feed Frequency", false] },
   waterParameters: { "Parameter": ["Water Parameter", true] }
};

// Field types the app's forms use, worked out from the column name.
const API_NUMBER_FIELDS = ["Volume (gal)", "Temp Min °F", "Temp Max °F", "Max Size (in)"];
const API_DATE_PATTERN = /(^| )Date($| )|Expires/;
const API_LONG_TEXT_PATTERN = /Notes|Options|Purpose|Issues|Keywords|Warnings|Requirements|Ingredients|Effect|Dose|Frequency|Stores|Recommended Group|Measurement/;
const API_URL_PATTERN = /URL$|Link$|Page$/;


// ============================================================
// ENTRY POINTS
// ============================================================

// GET request (e.g. opening the web app URL in a browser): just confirms the API is up.
function doGet() {
   return apiJson_({ ok: true, app: API_CONFIG.appName });
}

// Every app request arrives here: verify the sign-in, run the action, return JSON.
// Errors raised with apiError_ go back to the app as { ok: false, code, message }.
function doPost(e) {
   try {
      const req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
      // Signed in either with the app's session (normal) or a fresh Google sign-in (first time / after it lapsed).
      const user = req.session ? apiVerifySession_(req.session) : apiVerifyUser_(req.idToken);
      const result = apiRoute_(req, user);
      apiFlushLog_();   // anything logged outside a save (the one-time setups on load)
      // Every successful request renews the session for another hour of use.
      return apiJson_(Object.assign({ ok: true }, result, { session: apiIssueSession_(user) }));
   } catch (err) {
      const out = { ok: false, code: err.apiCode || "ERROR", message: err.apiCode ? err.message : "Something went wrong: " + err.message };
      if (err.apiExtra) Object.assign(out, err.apiExtra);
      if (!err.apiCode) console.error(err && err.stack ? err.stack : err);
      return apiJson_(out);
   }
}

// Sends each request to the function for its action. Writes run inside apiWrite_ (one at a time).
function apiRoute_(req, user) {
   switch (req.action) {
      case "bootstrap":         return apiBootstrap_(user);
      case "add":               return apiWrite_(() => apiAdd_(req, user));
      case "addAssignments":    return apiWrite_(() => apiAddAssignments_(req, user));
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
      case "saveReceiptLines":  return apiWrite_(() => apiSaveReceiptLines_(req, user));
      case "unlinkReceipt":     return apiWrite_(() => apiUnlinkReceipt_(req, user));
      // Water testing (WaterTests.gs)
      case "waterHistory":        return apiWaterHistory_(req, user);
      case "logWaterTest":        return apiWrite_(() => apiLogWaterTest_(req, user));
      case "updateWaterReading":  return apiWrite_(() => apiUpdateWaterReading_(req, user));
      case "retireWaterReading":  return apiWrite_(() => apiRetireWaterReading_(req, user));
      case "updateWaterSession":  return apiWrite_(() => apiUpdateWaterSession_(req, user));
      case "saveTestType":        return apiWrite_(() => apiSaveTestType_(req, user));
      case "retireTestType":      return apiWrite_(() => apiRetireTestType_(req, user));
      // Maintenance (Maintenance.gs)
      case "logWaterChange":      return apiWrite_(() => apiLogWaterChange_(req, user));
      case "updateAssignment":    return apiWrite_(() => apiUpdateAssignment_(req, user));
      case "addMaintNote":        return apiWrite_(() => apiAddMaintNote_(req, user));
      case "updateMaintNote":     return apiWrite_(() => apiUpdateMaintNote_(req, user));
      case "retireMaintNote":     return apiWrite_(() => apiRetireMaintNote_(req, user));
      case "updateWaterChange":   return apiWrite_(() => apiUpdateWaterChange_(req, user));
      case "retireWaterChange":   return apiWrite_(() => apiRetireWaterChange_(req, user));
      // AI helper (Ai.gs)
      case "aiFill":              aiSetCancelId_(req); return apiAiFill_(req, user);
      case "aiIdentify":          aiSetCancelId_(req); return apiAiIdentify_(req, user);
      case "cancelAi":            return apiCancelAi_(req, user);
      // Wishlist (Wishlist.gs)
      case "addWish":             return apiAddWish_(req, user);
      case "updateWish":          return apiWrite_(() => apiUpdateWish_(req, user));
      case "closeWish":           return apiWrite_(() => apiCloseWish_(req, user));
      case "deleteWish":          return apiWrite_(() => apiDeleteWish_(req, user));
      case "purchaseWish":        return apiWrite_(() => apiPurchaseWish_(req, user));
      case "checkWish":           aiSetCancelId_(req); return apiCheckWish_(req, user);
      case "itemPhoto":           return apiItemPhoto_(req, user);
      // Item photos (Photos.gs)
      case "addItemPhoto":        return apiWrite_(() => apiAddItemPhoto_(req, user));
      case "updatePhoto":         return apiWrite_(() => apiUpdatePhoto_(req, user));
      case "setListPhoto":        return apiWrite_(() => apiSetListPhoto_(req, user));
      case "removeItemPhoto":     return apiWrite_(() => apiRemoveItemPhoto_(req, user));
      case "aiReadLabel":         aiSetCancelId_(req); return apiAiReadLabel_(req, user);
      // Permanent delete, admins only (Delete.gs)
      // Treatments and stock (Treatments.gs)
      case "addTreatment":        return apiWrite_(() => apiAddTreatment_(req, user));
      case "updateTreatment":     return apiWrite_(() => apiUpdateTreatment_(req, user));
      case "setTreatmentStatus":  return apiWrite_(() => apiSetTreatmentStatus_(req, user));
      case "deleteTreatment":     return apiWrite_(() => apiDeleteTreatment_(req, user));
      case "logDose":             return apiWrite_(() => apiLogDose_(req, user));
      case "updateDose":          return apiWrite_(() => apiUpdateDose_(req, user));
      case "deleteDose":          return apiWrite_(() => apiDeleteDose_(req, user));
      case "setStock":            return apiWrite_(() => apiSetStock_(req, user));
      case "setStockMany":        return apiWrite_(() => apiSetStockMany_(req, user));
      case "setChangeLog":        return apiWrite_(() => apiSetChangeLog_(req, user));
      // Dropdown lists (Lists.gs)
      case "addLookup":           return apiWrite_(() => apiAddLookup_(req, user));
      case "updateLookup":        return apiWrite_(() => apiUpdateLookup_(req, user));
      // Price tracker (Prices.gs)
      case "addPrice":            return apiWrite_(() => apiAddPrice_(req, user));
      case "updatePrice":         return apiWrite_(() => apiUpdatePrice_(req, user));
      case "deletePrice":         return apiWrite_(() => apiDeletePrice_(req, user));
      case "updatePriceItem":     return apiWrite_(() => apiUpdatePriceItem_(req, user));
      case "deletePriceItem":     return apiWrite_(() => apiDeletePriceItem_(req, user));
      case "setPriceItemPicture": return apiWrite_(() => apiSetPriceItemPicture_(req, user));
      case "deleteRecord":        return apiWrite_(() => apiDeleteRecord_(req, user));
      case "deleteReceipt":       return apiWrite_(() => apiDeleteReceipt_(req, user));
      case "deletePhoto":         return apiWrite_(() => apiDeletePhoto_(req, user));
      default: throw apiError_("BAD_REQUEST", "Unknown action.");
   }
}


// ============================================================
// AUTH
// ============================================================

// Checks the Google sign-in token (cached for up to 10 minutes) and returns the
// matching active person from App Users, or throws AUTH / NOT_ALLOWED.
function apiVerifyUser_(idToken) {
   if (!idToken) throw apiError_("AUTH", "Please sign in.");
   if (API_CONFIG.clientId.indexOf("PASTE_") === 0) throw apiError_("SETUP", "The app's sign-in client ID hasn't been set yet.");

   // Tokens already checked recently are cached (by a hash, never the token itself).
   const cache = CacheService.getScriptCache();
   const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken);
   const key = "tok_" + Utilities.base64EncodeWebSafe(digest).slice(0, 43);
   let email = cache.get(key);

   // Not cached: ask Google whether the token is genuine, for this app, and unexpired.
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

   // The email must be an active person on App Users.
   const user = apiGetUsers_().find(u => u.email === email);
   if (!user || !user.active) {
      throw apiError_("NOT_ALLOWED", email + " isn't on the " + API_CONFIG.appName + " user list.", { email: email });
   }
   return user;
}

// ------------------------------------------------------------
// App sessions. Google sign-in passes expire after an hour no matter
// what, so after signing in with Google the app gets its own signed
// session instead. It lasts API_CONFIG.sessionMinutes since the last
// request (each request renews it), and the person is still looked up
// on App Users every time, so removing or deactivating them takes
// effect at once. The signing key is the SESSION_SECRET script
// property (created automatically; delete it to sign everyone out).
// ------------------------------------------------------------

// The signing key for sessions (made the first time it's needed).
function apiSessionSecret_() {
   const props = PropertiesService.getScriptProperties();
   let secret = props.getProperty("SESSION_SECRET");
   if (!secret) {
      secret = Utilities.getUuid() + Utilities.getUuid();
      props.setProperty("SESSION_SECRET", secret);
   }
   return secret;
}

// HMAC signature of a session's contents.
function apiSessionSig_(payload) {
   return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, apiSessionSecret_())).replace(/=+$/, "");
}

// A new session for this person, valid for API_CONFIG.sessionMinutes: "<payload>.<signature>".
function apiIssueSession_(user) {
   const payload = Utilities.base64EncodeWebSafe(JSON.stringify({ e: user.email, x: Date.now() + API_CONFIG.sessionMinutes * 60000 }), Utilities.Charset.UTF_8).replace(/=+$/, "");
   return payload + "." + apiSessionSig_(payload);
}

// Checks a session and returns the matching active person from App Users, or throws AUTH / NOT_ALLOWED.
function apiVerifySession_(token) {
   const parts = String(token || "").split(".");
   if (parts.length !== 2 || apiSessionSig_(parts[0]) !== parts[1]) throw apiError_("AUTH", "Please sign in again.");
   let data;
   try { data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()); } catch (e) { throw apiError_("AUTH", "Please sign in again."); }
   if (!data || !data.e || !(Number(data.x) > Date.now())) throw apiError_("AUTH", "You were signed out after an hour without using the app. Please sign in again.");
   const email = String(data.e).toLowerCase();
   const user = apiGetUsers_().find(u => u.email === email);
   if (!user || !user.active) throw apiError_("NOT_ALLOWED", email + " isn't on the " + API_CONFIG.appName + " user list.", { email: email });
   return user;
}

// Admins can change every tank; editors only the tanks assigned to them.
function apiCanEditTank_(user, tankId) {
   return user.role === "Admin" || (user.role === "Editor" && user.tanks.indexOf(tankId) !== -1);
}

// Throws unless the person is an admin.
function apiRequireAdmin_(user) {
   if (user.role !== "Admin") throw apiError_("FORBIDDEN", "Only admins can do that.");
}


// ============================================================
// READ
// ============================================================

// Everything the app needs on load: the person, form layouts (schema), all tables,
// plus receipts, water tests, maintenance and wishlist data.
function apiBootstrap_(user) {
   // Anything a newer feature needs, before the snapshot is taken.
   apiEnsureMedThumbColumn_();          // Photos.gs
   apiEnsureFoodStockColumn_();         // Foods.gs
   apiSeedOrderedStatus_();             // Treatments.gs
   // Read every tab in one request first (Speed.gs); the readers below use that snapshot.
   apiPrefetchGrids_();
   const ss = apiSs_();
   const data = {};
   Object.keys(API_TABLES).forEach(t => data[t] = apiReadTable_(t).rows);

   const lists = apiReadLists_(ss);
   const schema = {};
   Object.keys(API_TABLES).forEach(t => schema[t] = apiSchema_(t, lists));

   const out = {
      user: { id: user.id, email: user.email, name: user.name, role: user.role, tanks: user.tanks },
      appName: API_CONFIG.appName,
      schema: schema,
      data: data
   };
   if (user.role === "Admin") { out.users = apiGetUsers_(); out.changeLog = apiLogOn_(); }
   // User ID -> name, so the app can show who uploaded or changed things.
   if (user.role === "Admin" || user.role === "Editor") {
      out.people = apiGetUsers_().map(u => ({ id: u.id, name: u.name || u.email }));
   }
   Object.assign(out, apiReceiptsBootstrap_(user, lists));
   Object.assign(out, apiWaterBootstrap_(user));
   Object.assign(out, apiMaintBootstrap_(user));
   Object.assign(out, apiMaintNotesBootstrap_(user));
   Object.assign(out, apiFoodsBootstrap_());
   Object.assign(out, apiWishBootstrap_(user, out.data.assignments));
   Object.assign(out, apiPhotosBootstrap_());
   Object.assign(out, apiPricesBootstrap_());
   Object.assign(out, apiLookupsBootstrap_(user));
   Object.assign(out, apiReceiptLinesBootstrap_(user));
   Object.assign(out, apiTreatmentsBootstrap_(lists));
   if (user.role !== "Admin") apiLimitToAssignedTanks_(out, user);
   API_GRID = null;
   return out;
}

// Editors and Viewers only receive the tanks assigned to them (and the
// assignments, ranges, water tests and receipt links for those tanks).
function apiLimitToAssignedTanks_(out, user) {
   const mine = {};
   user.tanks.forEach(t => mine[t] = true);
   const allTankIds = {};
   out.data.tanks.forEach(t => allTankIds[t["Tank ID"]] = true);
   const visible = id => !!mine[id];
   // An item's "In tanks" list still shows every tank it's in: for tanks
   // this person isn't assigned to, send only the tank's ID and name.
   const names = {};
   out.data.tanks.forEach(t => names[t["Tank ID"]] = t["Tank Name"]);
   out.otherAssignments = out.data.assignments
      .filter(r => !visible(r["Tank ID"]) && r["Active"] === true && !r["Date Removed"])
      .map(r => ({ "Item ID": r["Item ID"], "Tank ID": r["Tank ID"], "Tank Name": names[r["Tank ID"]] || r["Tank ID"], "Date Added": r["Date Added"] }));
   out.data.tanks = out.data.tanks.filter(t => visible(t["Tank ID"]));
   out.data.assignments = out.data.assignments.filter(r => visible(r["Tank ID"]));
   out.data.waterParameters = out.data.waterParameters.filter(r => visible(r["Tank ID"]));
   if (out.waterSessions) out.waterSessions = out.waterSessions.filter(r => visible(r["Tank ID"]));
   if (out.waterTests) out.waterTests = out.waterTests.filter(r => visible(r["Tank ID"]));
   if (out.waterChanges) out.waterChanges = out.waterChanges.filter(r => visible(r["Tank ID"]));
   if (out.maintNotes) out.maintNotes = out.maintNotes.filter(r => visible(r["Tank ID"]));
   if (out.receiptLinks) out.receiptLinks = out.receiptLinks.filter(l => !allTankIds[l["Item ID"]] || visible(l["Item ID"]));
   if (out.treatments) out.treatments = out.treatments.filter(r => visible(r["Tank ID"]));
   if (out.treatmentDoses) out.treatmentDoses = out.treatmentDoses.filter(r => visible(r["Tank ID"]));
}

// Reads a whole data tab into row objects ({ header: value, _row: sheet row }).
// Dates become yyyy-MM-dd; numbers keep their sheet formatting.
function apiReadTable_(table) {
   const def = API_TABLES[table];
   const sheet = apiSheet_(def.sheetKey);
   // Raw values plus displayed text (so numbers keep formatting like $ or decimals).
   // apiGrid_ (Speed.gs) reads them, or takes them from bootstrap's one-request snapshot.
   const grid = apiGrid_(sheet);
   const values = grid.values, shown = grid.shown;
   if (!values.length) return { headers: [], rows: [] };
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
      // Skip blank rows (no ID; for assignments no tank or item).
      const keep = def.id ? obj[def.id] !== "" :
                   table === "assignments" ? (obj["Tank ID"] !== "" && obj["Item ID"] !== "") :
                   obj["Tank ID"] !== "";
      if (keep) rows.push(obj);
   }
   return { headers: headers.filter(Boolean), rows: rows };
}

// Reads every dropdown list on DropDownOptions: { column header: [values] }.
function apiReadLists_(ss) {
   const sheet = ss.getSheetByName("DropDownOptions");
   const lists = {};
   if (sheet) {
      const values = apiGrid_(sheet).values;
      if (values.length) {
         values[0].forEach((h, c) => {
            const name = String(h).trim();
            if (!name || lists[name]) return;
            lists[name] = values.slice(1).map(r => String(r[c]).trim()).filter(v => v !== "");
         });
      }
   }
   // Newer lists (Food Type, Feed Frequency, Maintenance Type) live on Lookups only,
   // with no DropDownOptions column of their own: take those straight from Lookups,
   // in the order they're listed there, skipping any turned off.
   apiReadLookups_().forEach(r => {
      if (r.inactive || lists[r.type]) return;
      (lists["_lk_" + r.type] = lists["_lk_" + r.type] || []).push(r.value);
   });
   Object.keys(lists).forEach(k => {
      if (k.indexOf("_lk_") !== 0) return;
      const name = k.slice(4);
      if (!lists[name]) lists[name] = lists[k];
      delete lists[k];
   });
   // Every dropdown reads in alphabetical order, wherever its values came from.
   Object.keys(lists).forEach(k => lists[k] = apiSortList_(lists[k]));
   return lists;
}

// A dropdown's values in alphabetical order (capitals ignored), duplicates dropped.
function apiSortList_(values) {
   const seen = {}, out = [];
   (values || []).forEach(v => { const k = String(v).toLowerCase(); if (!seen[k]) { seen[k] = true; out.push(v); } });
   return out.sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base" }));
}

// Describes each editable field so the app can build its forms.
function apiSchema_(table, lists) {
   const def = API_TABLES[table];
   const sheet = apiSheet_(def.sheetKey);
   // From the load's one-request snapshot where there is one (Speed.gs).
   const headers = apiHeaderValues_(sheet).map(h => String(h).trim()).filter(Boolean);
   const listDefs = API_FIELD_LISTS[table] || {};
   const required = def.required || [];

   // One entry per column: its type (list, number, date, url, long text, checkbox), options and rules.
   return headers
      .filter((h, i) => headers.indexOf(h) === i)
      .filter(h => API_FORMULA_COLUMNS.indexOf(h) === -1)
      .map(h => {
         const f = { name: h, type: "text" };
         if (h === def.id || h === "Test Type ID") f.readOnly = true;
         if (listDefs[h]) {
            f.type = "list"; f.options = lists[listDefs[h][0]] || (listDefs[h][2] && lists[listDefs[h][2]]) || []; f.strict = listDefs[h][1];
            // The Lookups list this field draws from (Admins can add to it from the form).
            f.lookup = lists[listDefs[h][0]] || !listDefs[h][2] ? listDefs[h][0] : listDefs[h][2];
            // "Wishlist" is only for species, plants and equipment.
            if (h === "Status" && ["species", "plants", "equipment"].indexOf(table) === -1) f.options = f.options.filter(o => o !== "Wishlist");
         }
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

// Runs a change while holding the script lock, so two people saving at once can't
// collide (e.g. both getting the same new ID).
function apiWrite_(fn) {
   const lock = LockService.getScriptLock();
   lock.waitLock(20000);
   try {
      const result = fn();
      apiFlushLog_();            // the save's log rows, in one write
      SpreadsheetApp.flush();
      return result;
   } finally {
      // Changes already written deserve their log rows even if the save threw.
      apiFlushLog_();
      lock.releaseLock();
   }
}

// Adds a record: a tank assignment, a water parameter, or (admins) a new tank,
// species, equipment, plant or medication with the next ID.
function apiAdd_(req, user) {
   const table = req.table;
   const def = API_TABLES[table];
   if (!def) throw apiError_("BAD_REQUEST", "Unknown table.");
   const values = apiCleanValues_(table, req.values || {}, user);

   if (table === "assignments") {
      const tankId = values["Tank ID"], itemId = values["Item ID"];
      if (!tankId || !itemId) throw apiError_("INVALID", "Choose a tank and an item.");
      if (!apiCanEditTank_(user, tankId)) throw apiError_("FORBIDDEN", "You can't change that tank.");
      if (!apiFindById_("tanks", tankId)) throw apiError_("INVALID", "Tank " + tankId + " doesn't exist.");
      const itemRec = API_ASSIGN_TYPES.map(t => apiFindById_(t, itemId)).find(Boolean);
      if (!itemRec) throw apiError_("INVALID", "Item " + itemId + " doesn't exist.");
      if (String(itemRec["Status"]) === "Wishlist") {
         throw apiError_("INVALID", itemId + " is on the wishlist. Use Mark purchased on its wish to add it to a tank.");
      }
      const active = apiReadTable_("assignments").rows.find(r =>
         r["Tank ID"] === tankId && r["Item ID"] === itemId && r["Active"] === true && !r["Date Removed"]);
      if (active) throw apiError_("INVALID", itemId + " is already in this tank.");
      values["Active"] = true;
      if (!values["Date Added"]) values["Date Added"] = new Date();
      delete values["Date Removed"];
      // Equipment can only be in one tank at a time: moving it ends the
      // other assignment (after the person confirms in the app).
      apiMoveEquipmentIfNeeded_(req, user, tankId, itemId, values["Date Added"]);
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
      const tt = apiReadTestTypes_().find(t => String(t["Name"]).toLowerCase() === String(values["Parameter"]).toLowerCase());
      if (tt) { values["Test Type ID"] = tt["Test Type ID"]; if (!values["Units"]) values["Units"] = tt["Units"]; }
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

// Adds several items to one tank with the same Date Added and Notes.
// Every item is checked first; if any can't be added, nothing is saved and
// all the problems are listed. Equipment in another tank needs req.confirmMove.
function apiAddAssignments_(req, user) {
   const tankId = String(req.tankId || "").trim();
   const itemIds = (Array.isArray(req.itemIds) ? req.itemIds : []).map(x => String(x).trim()).filter(Boolean)
      .filter((x, i, a) => a.indexOf(x) === i);
   if (!tankId) throw apiError_("INVALID", "Choose a tank.");
   if (!itemIds.length) throw apiError_("INVALID", "Choose at least one item.");
   if (!apiCanEditTank_(user, tankId)) throw apiError_("FORBIDDEN", "You can't change that tank.");
   if (!apiFindById_("tanks", tankId)) throw apiError_("INVALID", "Tank " + tankId + " doesn't exist.");
   const shared = apiCleanValues_("assignments", { "Date Added": req.dateAdded || "", "Notes": req.notes || "" });
   const dateAdded = shared["Date Added"] || new Date();

   // Read each list once.
   const recs = {};
   API_ASSIGN_TYPES.forEach(t => {
      const idCol = API_TABLES[t].id;
      apiReadTable_(t).rows.forEach(r => { if (r[idCol]) recs[r[idCol]] = { table: t, rec: r }; });
   });
   const assignments = apiReadTable_("assignments").rows;
   const isActive = r => r["Active"] === true && !r["Date Removed"];
   const label = id => {
      const h = recs[id];
      if (!h) return id;
      const r = h.rec;
      const name = h.table === "equipment" ? ([r["Manufacturer"], r["Filter Model"]].filter(Boolean).join(" ") || r["Category"])
                 : h.table === "foods" ? r["Product Name"] : r["Common Name"];
      return id + (name ? " " + name : "");
   };

   const problems = [], moves = [], needConfirm = [];
   itemIds.forEach(id => {
      const hit = recs[id];
      if (!hit) { problems.push(id + " doesn't exist."); return; }
      if (String(hit.rec["Status"]) === "Wishlist") { problems.push(label(id) + " is on the wishlist. Use Mark purchased on its wish."); return; }
      if (assignments.some(r => r["Tank ID"] === tankId && r["Item ID"] === id && isActive(r))) { problems.push(label(id) + " is already in this tank."); return; }
      if (hit.table !== "equipment") return;
      const others = assignments.filter(r => r["Item ID"] === id && r["Tank ID"] !== tankId && isActive(r));
      if (!others.length) return;
      const where = others.map(r => r["Tank ID"] + " " + apiTankName_(r["Tank ID"])).join(", ");
      if (!others.every(r => apiCanEditTank_(user, r["Tank ID"]))) {
         problems.push(label(id) + " is in " + where + ", which you don't manage. Ask an admin to move it.");
         return;
      }
      needConfirm.push(label(id) + " (in " + where + ")");
      others.forEach(r => moves.push({ row: r, itemId: id }));
   });
   if (problems.length) throw apiError_("INVALID", "Nothing was added. " + problems.join(" "));
   if (needConfirm.length && req.confirmMove !== true) {
      throw apiError_("IN_OTHER_TANK", "These are in another tank: " + needConfirm.join(", ") + ".");
   }

   // All checks passed: take moved equipment out of its old tank, then add every item.
   const sheet = apiSheet_("tankAssignments");
   moves.forEach(m => {
      const changes = apiWriteChanges_(sheet, m.row._row, m.row, { "Date Removed": dateAdded, "Active": false });
      apiLog_(user, "Move (removed from tank)", "Tank Assignments", m.row["Tank ID"] + " / " + m.itemId,
              changes.join("; ") + " — moved to " + tankId + " " + apiTankName_(tankId));
   });
   itemIds.forEach(id => {
      const values = { "Tank ID": tankId, "Item ID": id, "Date Added": dateAdded, "Notes": shared["Notes"] || "", "Active": true };
      apiAppendRow_(sheet, values);
      apiLog_(user, "Add", "Tank Assignments", tankId + " / " + id, apiDescribe_(values));
   });
   return { added: itemIds.length, moved: moves.length };
}

// Edits a record. Only the fields that changed are written, and each change is logged.
function apiUpdate_(req, user) {
   const table = req.table;
   const def = API_TABLES[table];
   if (!def) throw apiError_("BAD_REQUEST", "Unknown table.");
   const values = apiCleanValues_(table, req.values || {}, user);
   let record, recordLabel;

   // Records with an ID: tanks need tank rights; other lists are admin-only (or a wishlist item's creator).
   if (def.id) {
      record = apiFindById_(table, req.id);
      if (!record) throw apiError_("NOT_FOUND", "That record no longer exists.");
      if (table === "tanks") {
         if (!apiCanEditTank_(user, record[def.id])) throw apiError_("FORBIDDEN", "You can't change that tank.");
      } else if (!apiCanEditWishItem_(user, table, record)) {
         apiRequireAdmin_(user);
      } else if (user.role !== "Admin") {
         delete values["Status"];   // editors fix a wishlist item's details, not its status
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

   // Re-activating an equipment assignment is refused while it's active in another tank.
   const merged = Object.assign({}, record, values);
   apiCheckRequired_(def, merged);
   if (table === "assignments" && merged["Active"] === true && !merged["Date Removed"] &&
       !(record["Active"] === true && !record["Date Removed"]) && apiFindById_("equipment", record["Item ID"])) {
      const other = apiActiveEquipmentElsewhere_(record["Item ID"], record["Tank ID"])[0];
      if (other) throw apiError_("INVALID", record["Item ID"] + " is already in " + other["Tank ID"] + " " + apiTankName_(other["Tank ID"]) +
                                 ". Remove it from there first.");
   }
   const changes = apiWriteChanges_(apiSheet_(def.sheetKey), record._row, record, values);
   if (changes.length) apiLog_(user, "Edit", def.label, recordLabel, changes.join("; "));
   return { updated: changes.length };
}

// Marks a tank, species, equipment, plant or medication as Retired (admins). Nothing is deleted.
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

// A tank's name from its ID (blank if not found).
function apiTankName_(tankId) {
   const t = apiFindById_("tanks", tankId);
   return t ? t["Tank Name"] : "";
}

// Active Tank Assignments rows for this item in tanks other than tankId.
function apiActiveEquipmentElsewhere_(itemId, tankId) {
   return apiReadTable_("assignments").rows.filter(r =>
      r["Item ID"] === itemId && r["Tank ID"] !== tankId && r["Active"] === true && !r["Date Removed"]);
}

// req.confirmMove must be true to take equipment out of another tank.
function apiMoveEquipmentIfNeeded_(req, user, tankId, itemId, dateAdded) {
   if (!apiFindById_("equipment", itemId)) return;
   const others = apiActiveEquipmentElsewhere_(itemId, tankId);
   if (!others.length) return;
   const where = others.map(r => r["Tank ID"] + " " + apiTankName_(r["Tank ID"])).join(", ");
   others.forEach(r => {
      if (!apiCanEditTank_(user, r["Tank ID"])) {
         throw apiError_("FORBIDDEN", itemId + " is in " + where + ", which you don't manage. Ask an admin to move it.");
      }
   });
   if (req.confirmMove !== true) {
      throw apiError_("IN_OTHER_TANK", itemId + " is currently in " + where + ". Remove it from there first.");
   }
   const sheet = apiSheet_("tankAssignments");
   const date = dateAdded instanceof Date ? dateAdded : (dateAdded ? apiParseDate_(dateAdded) : new Date());
   others.forEach(r => {
      const changes = apiWriteChanges_(sheet, r._row, r, { "Date Removed": date, "Active": false });
      apiLog_(user, "Move (removed from tank)", "Tank Assignments", r["Tank ID"] + " / " + itemId,
              changes.join("; ") + " — moved to " + tankId + " " + apiTankName_(tankId));
   });
}

// Takes an item out of a tank: sets Date Removed and unchecks Active.
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

// Reads the App Users tab into { id, email, name, role, tanks, active }.
// Kept in a 5-minute cache (Speed.gs) because every request checks who is signed in;
// pass fresh = true when the result is used to change the tab (row numbers must be current).
function apiGetUsers_(fresh) {
   const cache = CacheService.getScriptCache();
   if (!fresh) {
      const hit = cache.get(API_USERS_CACHE_KEY);
      if (hit) { try { return JSON.parse(hit); } catch (e) { /* read the tab */ } }
   }
   const sheet = apiEnsureSupportTabs_().users;
   const values = apiGrid_(sheet).values;
   const h = values[0].map(x => String(x).trim());
   const col = name => h.indexOf(name);
   const tanksCol = col("Assigned Tanks");
   // Row numbers are worked out before skipping blank rows, so an empty
   // row in the middle of the tab can't shift edits onto the wrong person.
   const users = values.map((r, i) => ({ r: r, row: i + 1 })).slice(1)
      .filter(x => String(x.r[col("Email")]).trim() !== "")
      .map(({ r, row }) => ({
         row: row,
         id: col("User ID") === -1 ? "" : String(r[col("User ID")]).trim(),
         email: String(r[col("Email")]).trim().toLowerCase(),
         name: String(r[col("Name")] || "").trim(),
         role: API_ROLES.indexOf(String(r[col("Role")]).trim()) !== -1 ? String(r[col("Role")]).trim() : "Viewer",
         tanks: String(r[tanksCol] || "").split(",").map(s => s.trim()).filter(Boolean),
         active: r[col("Active")] === true || String(r[col("Active")]).toUpperCase() === "TRUE"
      }));
   // Anyone typed straight into the sheet without a User ID gets one.
   if (col("User ID") !== -1 && users.some(u => !u.id)) {
      let next = apiMaxUserNumber_(users);
      users.forEach(u => {
         if (u.id) return;
         u.id = "USR-" + (++next);
         sheet.getRange(u.row, col("User ID") + 1).setValue(u.id);
      });
   }
   try { cache.put(API_USERS_CACHE_KEY, JSON.stringify(users), 300); } catch (e) { /* too big to cache */ }
   return users;
}

// Highest number used in a User ID (USR-n), for numbering new people.
function apiMaxUserNumber_(users) {
   return users.reduce((m, u) => {
      const n = Number(String(u.id).replace(/^\D+/, ""));
      return isNaN(n) ? m : Math.max(m, n);
   }, 0);
}

// Who did something, as stored in the sheet: the User ID.
function apiWho_(user) {
   return user.id || user.email;
}

// Adds or edits a person on App Users (admins). Guards against duplicate emails and
// against an admin removing their own admin access.
function apiSaveUser_(req, user) {
   apiRequireAdmin_(user);
   const u = req.user || {};
   const email = String(u.email || "").trim().toLowerCase();
   if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw apiError_("INVALID", "Enter a valid email address.");
   const role = API_ROLES.indexOf(u.role) !== -1 ? u.role : null;
   if (!role) throw apiError_("INVALID", "Choose a role.");
   const active = u.active !== false;

   const all = apiGetUsers_(true);
   // Existing users are matched by User ID (so their email can be changed).
   const existing = u.id ? all.find(x => x.id === u.id) : null;
   if (u.id && !existing) throw apiError_("STALE", "That user no longer exists. Refresh and try again.");
   const clash = all.find(x => x.email === email && (!existing || x.id !== existing.id));
   if (clash) throw apiError_("INVALID", email + " is already on the list (" + clash.id + ").");
   if (existing && existing.id === user.id) {
      if (role !== "Admin" || !active) throw apiError_("INVALID", "You can't remove your own admin access.");
      if (email !== existing.email) throw apiError_("INVALID", "You can't change your own email here. Edit it in the App Users tab if you need to.");
   }

   // Keep only real tank IDs, then write the row (new people get the next User ID).
   const tankIds = apiReadTable_("tanks").rows.map(t => t["Tank ID"]);
   const tanks = (u.tanks || []).filter(t => tankIds.indexOf(t) !== -1);
   const sheet = apiEnsureSupportTabs_().users;
   // Admins see and change every tank, so they have no assigned tanks.
   const tanksHeader = "Assigned Tanks";
   const record = { "Email": email, "Name": String(u.name || "").trim(), "Role": role, "Active": active };
   record[tanksHeader] = role === "Admin" ? "" : tanks.join(", ");

   if (existing) {
      const before = { "Email": existing.email, "Name": existing.name, "Role": existing.role, "Active": existing.active };
      before[tanksHeader] = existing.tanks.join(", ");
      const changes = apiWriteChanges_(sheet, existing.row, before, record);
      if (changes.length) apiLog_(user, "Edit", "App Users", existing.id, changes.join("; "));
   } else {
      record["User ID"] = "USR-" + (apiMaxUserNumber_(all) + 1);
      record["Added"] = new Date();
      apiAppendRow_(sheet, record);
      apiLog_(user, "Add", "App Users", record["User ID"], apiDescribe_(record));
   }
   apiClearUsersCache_();
   return { users: apiGetUsers_(true) };
}


// ============================================================
// SHEET HELPERS
// ============================================================

// The spreadsheet this script is bound to.
let API_SS = null;
function apiSs_() {
   return API_SS || (API_SS = SpreadsheetApp.getActiveSpreadsheet());
}

// A data tab by its key in SHEET_IDS (Entry Forms.gs), found by tab ID so renaming is safe.
function apiSheet_(sheetKey) {
   // Foods came later and has no ID in SHEET_IDS: it's made and found by name (Foods.gs).
   if (sheetKey === "foods") return apiEnsureFoodsTab_();
   const sheet = apiSs_().getSheetById(SHEET_IDS[sheetKey]);
   if (!sheet) throw apiError_("SETUP", "A data tab is missing (" + sheetKey + ").");
   return sheet;
}

// Header name (lower case) -> column number for a tab.
function apiHeaderMap_(sheet) {
   const snap = API_GRID && API_GRID[sheet.getSheetId()];
   const headers = apiHeaderValues_(sheet);
   const lastCol = snap && snap.values && snap.values.length ? headers.length : sheet.getLastColumn();
   const map = {};
   headers.forEach((h, i) => {
      const name = String(h).trim().toLowerCase();
      if (name && !(name in map)) map[name] = i + 1;
   });
   return { map: map, lastCol: lastCol };
}

// True if the tab has a column with this header.
function apiHasHeader_(sheet, name) {
   return name.toLowerCase() in apiHeaderMap_(sheet).map;
}

// Last row that has real content. Unchecked checkboxes (FALSE) and blank
// cells don't count, so a column of empty checkboxes doesn't push new
// rows to the bottom of the tab.
function apiLastDataRow_(sheet) {
   // apiGrid_ hands back the load's snapshot when there is one, and reads the tab otherwise.
   const values = apiGrid_(sheet).values;
   if (values.length < 2) return 1;
   for (let r = values.length - 1; r >= 1; r--) {
      if (values[r].some(c => c !== "" && c !== false && c !== null)) return r + 1;
   }
   return 1;
}

// Adds a row below the last real data row, copying row 2's formatting, and writes the
// given values under their headers (formula columns are never written).
function apiAppendRow_(sheet, values) {
   const hm = apiHeaderMap_(sheet);
   const row = apiLastDataRow_(sheet) + 1;
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

// The record with this ID in a table, or null.
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

// Next ID for a table, e.g. FS-37 after FS-36.
function apiNextId_(table) {
   const def = API_TABLES[table];
   const max = apiReadTable_(table).rows.reduce((m, r) => {
      const n = Number(String(r[def.id]).replace(/^\D+/, ""));
      return isNaN(n) ? m : Math.max(m, n);
   }, 0);
   return def.prefix + (max + 1);
}

// Validates and converts values sent by the app using the table's schema
// (numbers, dates, checkboxes, strict dropdown lists). Unknown fields are dropped.
function apiCleanValues_(table, raw, user) {
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
      // List values: the list's spelling; a new value is added for Admins, refused on strict lists otherwise (Lists.gs).
      if (v !== "" && f.type === "list" && f.options.indexOf(v) === -1) v = apiLookupValueFor_(f, v, user);
      out[name] = v;
   });
   return out;
}

// Throws if any of the table's required fields are blank.
function apiCheckRequired_(def, values) {
   const missing = (def.required || []).filter(f => values[f] === "" || values[f] === undefined || values[f] === null);
   if (missing.length) throw apiError_("INVALID", "Please fill in: " + missing.join(", ") + ".");
}

// Converts yyyy-MM-dd from the app to a Date.
function apiParseDate_(v) {
   if (v instanceof Date) return v;
   const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
   if (!m) throw apiError_("INVALID", "Dates must look like 2026-11-11.");
   return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Field: value list for the Change Log.
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

// Returns the App Users and Change Log tabs, creating them if they're missing.
function apiEnsureSupportTabs_() {
   const ss = apiSs_();
   // App Users: who can sign in, their role and assigned tanks (first row is the owner).
   let users = ss.getSheetByName(API_CONFIG.usersSheetName);
   if (!users) {
      users = ss.insertSheet(API_CONFIG.usersSheetName);
      users.getRange(1, 1, 1, 8).setValues([["User ID", "Email", "Name", "Role", "Assigned Tanks", "Active", "Added", "Notes"]])
         .setFontWeight("bold").setBackground("#d9d9d9");
      users.appendRow(["USR-1", Session.getEffectiveUser().getEmail().toLowerCase(), "Chris Ayers", "Admin", "", true, new Date(),
                       "Owner. Assigned Tanks: comma-separated Tank IDs (Editors edit them + log tests; Viewers log tests)."]);
      users.setFrozenRows(1);
      users.getRange("F2:F").insertCheckboxes();
      users.getRange("D2:D").setDataValidation(SpreadsheetApp.newDataValidation()
         .requireValueInList(API_ROLES, true).setAllowInvalid(false).build());
      users.getRange("G2:G").setNumberFormat("m/d/yyyy");
      users.setColumnWidths(2, 1, 220);
      users.setColumnWidths(5, 1, 200);
      users.setColumnWidths(8, 1, 320);
   }
   // Change Log: one row per change made through the app.
   let log = ss.getSheetByName(API_CONFIG.logSheetName);
   if (!log) {
      log = ss.insertSheet(API_CONFIG.logSheetName);
      log.getRange(1, 1, 1, 6).setValues([["Timestamp", "User ID", "Action", "Table", "Record", "Changes"]])
         .setFontWeight("bold").setBackground("#d9d9d9");
      log.setFrozenRows(1);
      log.getRange("A2:A").setNumberFormat("m/d/yyyy h:mm am/pm");
      log.setColumnWidths(1, 1, 150);
      log.setColumnWidths(2, 1, 200);
      log.setColumnWidths(6, 1, 500);
   }
   return { users: users, log: log };
}

// Change Log entries wait here until the end of the save, so a save that changes
// several things writes once instead of once per change (one write is ~0.4s).
let API_LOG_QUEUE = [];

// Admins can turn routine logging off (Home > My account). Permanent deletes are
// recorded whatever the setting, so there is always a trail of what was destroyed.
function apiLogOn_() {
   return PropertiesService.getScriptProperties().getProperty("changeLogOff") !== "1";
}

// req: { on } -> turns the Change Log on or off (admins).
function apiSetChangeLog_(req, user) {
   apiRequireAdmin_(user);
   const on = !!req.on;
   // The switch itself is always recorded, so the log says who stopped it and when.
   apiLog_(user, "Edit", API_CONFIG.logSheetName, "Logging", on ? "Turned on" : "Turned off", true);
   PropertiesService.getScriptProperties().setProperty("changeLogOff", on ? "" : "1");
   apiFlushLog_();
   return { changeLog: on };
}

// Queues a Change Log row: when, who, what action, which tab and record, what changed.
// Permanent deletes, and the switch itself (always), are recorded even while logging is off.
function apiLog_(user, action, table, record, changes, always) {
   if (!always && action !== "Delete" && !apiLogOn_()) return;
   API_LOG_QUEUE.push([new Date(), apiWho_(user), action, table, record, changes || ""]);
}

// Writes everything queued, in one go. Called at the end of each save (apiWrite_),
// while the script lock is still held, so two saves can't pick the same row.
function apiFlushLog_() {
   if (!API_LOG_QUEUE.length) return;
   const rows = API_LOG_QUEUE.splice(0, API_LOG_QUEUE.length);
   try {
      const log = apiEnsureSupportTabs_().log;
      const start = apiLastDataRow_(log) + 1;
      const need = start + rows.length - 1;
      if (need > log.getMaxRows()) log.insertRowsAfter(log.getMaxRows(), need - log.getMaxRows());
      log.getRange(start, 1, rows.length, 6).setValues(rows);
   } catch (e) {
      // The log is a record of the save, never the point of it: never fail a save over it.
      console.warn("Change Log write failed: " + e);
   }
}


// ============================================================
// UTIL
// ============================================================

// Wraps a result as a JSON response.
function apiJson_(obj) {
   return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// An error the app shows as-is: code (e.g. INVALID, FORBIDDEN) plus a plain-language message.
function apiError_(code, message, extra) {
   const e = new Error(message);
   e.apiCode = code;
   if (extra) e.apiExtra = extra;
   return e;
}
