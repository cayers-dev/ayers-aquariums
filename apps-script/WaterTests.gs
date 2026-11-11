// ============================================================
// AYERS AQUARIUMS - WATER TESTING
//
// Tabs:
//   Test Types           master list of tests (Order sets app order;
//                         Status Retired hides a test from new entries)
//   Water Test Sessions  one row each time someone tests a tank
//   Water Tests          one row per reading (value) in a session
//   Water Parameters     (existing) each tank's target + acceptable
//                         min/max per test, linked by Test Type ID
//
// Who can log: admins (any tank) and anyone whose Assigned Tanks
// include the tank. Corrections: admins or the person who logged it.
// Nothing is deleted: readings and sessions are retired.
// ============================================================

const WATER_CONFIG = {
   typesSheetName: "Test Types",
   sessionsSheetName: "Water Test Sessions",
   testsSheetName: "Water Tests",
   methods: ["Strip", "Liquid", "Digital"]
};

const TEST_TYPE_HEADERS = ["Test Type ID", "Name", "Units", "Allowed Methods", "Order", "Status", "Notes"];
const WATER_SESSION_HEADERS = ["Session ID", "Tank ID", "Tested At", "Default Method", "Notes", "Tested By", "Logged At", "Status"];
const WATER_TEST_HEADERS = ["Test ID", "Session ID", "Tank ID", "Tested At", "Test Type ID", "Test Type", "Method", "Value", "Units",
                            "Range Min", "Range Max", "Result", "Notes", "Tested By", "Logged At", "Status"];

// Starting list (Order in steps of 10 so new tests can slot in between).
const TEST_TYPE_SEED = [
   ["Temperature", "°F", "Digital"],
   ["EC", "µS/cm", "Digital"],
   ["TDS", "ppm", "Digital"],
   ["Salinity", "ppt", "Digital"],
   ["ORP", "mV", "Digital"],
   ["Nitrate (NO3)", "ppm", "Strip, Liquid"],
   ["Nitrite (NO2)", "ppm", "Strip, Liquid"],
   ["Total Hardness (GH)", "ppm", "Strip, Liquid"],
   ["Chlorine", "ppm", "Strip, Liquid"],
   ["Alkalinity (KH)", "ppm", "Strip, Liquid"],
   ["pH", "", "Strip, Liquid, Digital"],
   ["Ammonia (NH3/NH4)", "ppm", "Strip, Liquid"]
];

// Old parameter names on Water Parameters -> new test type names.
const PARAMETER_RENAMES = {
   "ammonia": "Ammonia (NH3/NH4)", "nitrate": "Nitrate (NO3)", "nitrite": "Nitrite (NO2)",
   "ph": "pH", "temperature": "Temperature"
};


// ------------------------------------------------------------
// Run from the editor (safe to run again): creates/updates tabs.
// ------------------------------------------------------------
function waterSetup() {
   const ss = apiSs_();
   const me = apiGetUsers_().find(u => u.email === Session.getEffectiveUser().getEmail().toLowerCase()) ||
              { email: Session.getEffectiveUser().getEmail() };
   const notes = [];

   // 1. Test Types
   const tabs = apiEnsureWaterTabs_();
   if (tabs.types.getLastRow() < 2) {
      const rows = TEST_TYPE_SEED.map((t, i) => ["TT-" + (i + 1), t[0], t[1], t[2], (i + 1) * 10, "Active", ""]);
      tabs.types.getRange(2, 1, rows.length, TEST_TYPE_HEADERS.length).setValues(rows);
      notes.push("Added " + rows.length + " test types");
   }
   const types = apiReadTestTypes_();
   const byName = {};
   types.forEach(t => byName[String(t["Name"]).toLowerCase()] = t);

   // 2. Water Parameters: rename to the new names, add + fill Test Type ID.
   const wp = apiSheet_("waterParameters");
   let wh = wp.getRange(1, 1, 1, wp.getLastColumn()).getValues()[0].map(h => String(h).trim());
   if (wh.indexOf("Test Type ID") === -1) {
      const c = wh.length + 1;
      wp.getRange(1, c).setValue("Test Type ID");
      wp.getRange(1, 1).copyFormatToRange(wp, c, c, 1, 1);
      wh.push("Test Type ID");
      notes.push("Added Test Type ID column to Water Parameters");
   }
   const pCol = wh.indexOf("Parameter"), idCol = wh.indexOf("Test Type ID"), uCol = wh.indexOf("Units");
   // 2b. DropDownOptions "Water Parameter" list follows the active test types (in Order).
   const dd = ss.getSheetByName("DropDownOptions");
   if (dd) {
      const dh = dd.getRange(1, 1, 1, dd.getLastColumn()).getValues()[0].map(h => String(h).trim());
      const col = dh.indexOf("Water Parameter") + 1;
      if (col) {
         dd.getRange(2, col, Math.max(dd.getMaxRows() - 1, 1), 1).clearContent();
         dd.getRange(2, col).setFormula(
            "=IFERROR(SORT(FILTER('Test Types'!B2:B,'Test Types'!F2:F=\"Active\",'Test Types'!B2:B<>\"\")," +
            "FILTER('Test Types'!E2:E,'Test Types'!F2:F=\"Active\",'Test Types'!B2:B<>\"\"),TRUE),\"\")");
         const colA1 = dd.getRange(2, col, dd.getMaxRows() - 1, 1).getA1Notation();
         const rule = SpreadsheetApp.newDataValidation()
            .requireValueInRange(dd.getRange(colA1), true).setAllowInvalid(false).build();
         wp.getRange(2, pCol + 1, wp.getMaxRows() - 1, 1).setDataValidation(rule);
         notes.push("Water Parameter dropdowns now list the active test types");
      }
   }

   // 3. Rename parameters (after the dropdown lists the new names).
   SpreadsheetApp.flush();
   const last = apiLastDataRow_(wp);
   if (last >= 2) {
      const rng = wp.getRange(2, 1, last - 1, wh.length);
      const v = rng.getValues();
      let renamed = 0;
      v.forEach(r => {
         const name = String(r[pCol]).trim();
         if (!name) return;
         const newName = PARAMETER_RENAMES[name.toLowerCase()] || name;
         if (newName !== name) { r[pCol] = newName; renamed++; }
         const t = byName[newName.toLowerCase()];
         if (t) {
            r[idCol] = t["Test Type ID"];
            if (uCol !== -1 && String(r[uCol]).trim() !== String(t["Units"]).trim()) r[uCol] = t["Units"];
         }
      });
      rng.setValues(v);
      notes.push("Water Parameters: renamed " + renamed + " parameter(s), linked Test Type IDs");
   }

   // 4. App Users: "Editable Tanks" -> "Assigned Tanks".
   const users = apiEnsureSupportTabs_().users;
   const uh = users.getRange(1, 1, 1, users.getLastColumn()).getValues()[0].map(h => String(h).trim());
   const ec = uh.indexOf("Editable Tanks");
   if (ec !== -1) {
      users.getRange(1, ec + 1).setValue("Assigned Tanks");
      const nc = uh.indexOf("Notes");
      if (nc !== -1) {
         const nr = users.getRange(2, nc + 1, Math.max(users.getLastRow() - 1, 1), 1);
         nr.setValues(nr.getValues().map(r => [String(r[0]).replace(
            "Editable Tanks: comma-separated Tank IDs (Editors only).",
            "Assigned Tanks: comma-separated Tank IDs (Editors edit them + log tests; Viewers log tests).")]));
      }
      notes.push("App Users: Editable Tanks renamed to Assigned Tanks");
   }

   apiLog_(me, "Setup", "Water testing", "", notes.join("; "));
   Logger.log(notes.join("\n"));
}


// ------------------------------------------------------------
// Tabs + reading
// ------------------------------------------------------------
function apiEnsureWaterTabs_() {
   const ss = apiSs_();
   const make = (name, headers, setup) => {
      let sh = ss.getSheetByName(name);
      if (!sh) {
         sh = ss.insertSheet(name);
         sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold").setBackground("#d9d9d9");
         sh.setFrozenRows(1);
         if (setup) setup(sh);
      }
      return sh;
   };
   const statusRule = list => SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build();
   const types = make(WATER_CONFIG.typesSheetName, TEST_TYPE_HEADERS, sh => {
      sh.getRange("F2:F").setDataValidation(statusRule(["Active", "Retired"]));
      sh.setColumnWidth(2, 180); sh.setColumnWidth(4, 160); sh.setColumnWidth(7, 260);
   });
   const sessions = make(WATER_CONFIG.sessionsSheetName, WATER_SESSION_HEADERS, sh => {
      sh.getRange("C2:C").setNumberFormat("m/d/yyyy h:mm am/pm");
      sh.getRange("G2:G").setNumberFormat("m/d/yyyy h:mm am/pm");
      sh.getRange("H2:H").setDataValidation(statusRule(["Active", "Retired"]));
      sh.setColumnWidth(5, 280);
   });
   const tests = make(WATER_CONFIG.testsSheetName, WATER_TEST_HEADERS, sh => {
      sh.getRange("D2:D").setNumberFormat("m/d/yyyy h:mm am/pm");
      sh.getRange("O2:O").setNumberFormat("m/d/yyyy h:mm am/pm");
      sh.getRange("P2:P").setDataValidation(statusRule(["Active", "Retired"]));
      sh.setColumnWidth(6, 170); sh.setColumnWidth(13, 240);
   });
   return { types: types, sessions: sessions, tests: tests };
}

function apiReadTestTypes_() {
   return apiReadSheetRows_(apiEnsureWaterTabs_().types, "Test Type ID")
      .sort((a, b) => (Number(a["Order"]) || 9999) - (Number(b["Order"]) || 9999));
}

function apiMethodsOf_(t) {
   return String(t["Allowed Methods"] || "").split(",").map(s => s.trim())
      .filter(m => WATER_CONFIG.methods.indexOf(m) !== -1);
}

// Fills in Test Type ID on Water Parameters rows added without one
// (e.g. from the sheet's Add Water Parameter form).
function apiBackfillParamTypeIds_(types) {
   const wp = apiSheet_("waterParameters");
   const wh = wp.getRange(1, 1, 1, wp.getLastColumn()).getValues()[0].map(h => String(h).trim());
   const pCol = wh.indexOf("Parameter"), idCol = wh.indexOf("Test Type ID");
   if (pCol === -1 || idCol === -1) return;
   const last = apiLastDataRow_(wp);
   if (last < 2) return;
   const v = wp.getRange(2, 1, last - 1, wh.length).getValues();
   const byName = {};
   types.forEach(t => byName[String(t["Name"]).toLowerCase()] = t["Test Type ID"]);
   v.forEach((r, i) => {
      if (String(r[idCol]).trim() || !String(r[pCol]).trim()) return;
      const id = byName[String(r[pCol]).trim().toLowerCase()];
      if (id) wp.getRange(i + 2, idCol + 1).setValue(id);
   });
}

function apiWaterBootstrap_(user) {
   const tabs = apiEnsureWaterTabs_();
   const types = apiReadTestTypes_();
   apiBackfillParamTypeIds_(types);
   return {
      testTypes: types,
      waterSessions: apiReadSheetRows_(tabs.sessions, "Session ID"),
      waterTests: apiReadSheetRows_(tabs.tests, "Test ID"),
      methods: WATER_CONFIG.methods
   };
}

function apiCanLogTank_(user, tankId) {
   return user.role === "Admin" || user.tanks.indexOf(tankId) !== -1;
}

function apiCanCorrect_(user, row) {
   return user.role === "Admin" || (row["Tested By"] && row["Tested By"] === apiWho_(user));
}

// Range for a tank + test type from Water Parameters.
function apiRangeFor_(tankId, type) {
   const rows = apiReadTable_("waterParameters").rows.filter(r => r["Tank ID"] === tankId);
   const r = rows.find(x => x["Test Type ID"] === type["Test Type ID"]) ||
             rows.find(x => String(x["Parameter"]).toLowerCase() === String(type["Name"]).toLowerCase());
   if (!r) return { min: "", max: "" };
   const num = v => (v === "" || v === null || isNaN(Number(v))) ? "" : Number(v);
   return { min: num(r["Acceptable Min"]), max: num(r["Acceptable Max"]) };
}

function apiResultFor_(value, min, max) {
   if (min === "" && max === "") return "No range";
   if (min !== "" && value < min) return "Low";
   if (max !== "" && value > max) return "High";
   return "In range";
}

function apiParseDateTime_(v) {
   if (!v) return new Date();
   const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
   if (!m) throw apiError_("INVALID", "Test time must look like 2026-11-11 15:30.");
   const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
   if (d.getTime() > Date.now() + 10 * 60 * 1000) throw apiError_("INVALID", "The test time can't be in the future.");
   return d;
}

function apiNumber_(v, label) {
   const s = String(v === undefined || v === null ? "" : v).trim();
   if (s === "" || isNaN(Number(s))) throw apiError_("INVALID", label + " must be a number.");
   return Number(s);
}

function apiNextSeqId_(rows, field, prefix) {
   const max = rows.reduce((m, r) => {
      const n = Number(String(r[field]).replace(/^\D+/, ""));
      return isNaN(n) ? m : Math.max(m, n);
   }, 0);
   return prefix + (max + 1);
}


// ------------------------------------------------------------
// Log a session of readings
// req: { tankId, testedAt, defaultMethod, notes,
//        readings: [{ testTypeId, method, value, notes }] }
// ------------------------------------------------------------
function apiLogWaterTest_(req, user) {
   const tankId = String(req.tankId || "");
   if (!apiFindById_("tanks", tankId)) throw apiError_("INVALID", "Choose a tank.");
   if (!apiCanLogTank_(user, tankId)) throw apiError_("FORBIDDEN", "You can't log tests for that tank.");
   const readings = (req.readings || []).filter(r => String(r.value === undefined || r.value === null ? "" : r.value).trim() !== "");
   if (!readings.length) throw apiError_("INVALID", "Enter at least one reading.");

   const types = apiReadTestTypes_();
   const testedAt = apiParseDateTime_(req.testedAt);
   const defaultMethod = WATER_CONFIG.methods.indexOf(req.defaultMethod) !== -1 ? req.defaultMethod : "";
   const seen = {};
   const rows = readings.map(r => {
      const t = types.find(x => x["Test Type ID"] === r.testTypeId);
      if (!t) throw apiError_("INVALID", "Unknown test type " + r.testTypeId + ".");
      if (String(t["Status"]) === "Retired") throw apiError_("INVALID", t["Name"] + " has been retired.");
      if (seen[t["Test Type ID"]]) throw apiError_("INVALID", t["Name"] + " was entered twice.");
      seen[t["Test Type ID"]] = true;
      const allowed = apiMethodsOf_(t);
      const method = r.method || (allowed.indexOf(defaultMethod) !== -1 ? defaultMethod : allowed[0]);
      if (allowed.length && allowed.indexOf(method) === -1) {
         throw apiError_("INVALID", t["Name"] + " can only be tested by " + allowed.join(" or ") + ".");
      }
      const value = apiNumber_(r.value, t["Name"]);
      const range = apiRangeFor_(tankId, t);
      return { type: t, method: method, value: value, range: range,
               result: apiResultFor_(value, range.min, range.max), notes: String(r.notes || "").trim() };
   });

   const tabs = apiEnsureWaterTabs_();
   const sessionId = apiNextSeqId_(apiReadSheetRows_(tabs.sessions, "Session ID"), "Session ID", "WS-");
   const now = new Date();
   const who = apiWho_(user);
   apiAppendRow_(tabs.sessions, { "Session ID": sessionId, "Tank ID": tankId, "Tested At": testedAt,
      "Default Method": defaultMethod, "Notes": String(req.notes || "").trim(), "Tested By": who,
      "Logged At": now, "Status": "Active" });

   // Readings are written as one block.
   const existing = apiReadSheetRows_(tabs.tests, "Test ID");
   let next = Number(apiNextSeqId_(existing, "Test ID", "WT-").slice(3));
   const hm = apiHeaderMap_(tabs.tests);
   const start = apiLastDataRow_(tabs.tests) + 1;
   const block = rows.map(x => {
      const rec = { "Test ID": "WT-" + (next++), "Session ID": sessionId, "Tank ID": tankId, "Tested At": testedAt,
         "Test Type ID": x.type["Test Type ID"], "Test Type": x.type["Name"], "Method": x.method, "Value": x.value,
         "Units": x.type["Units"], "Range Min": x.range.min, "Range Max": x.range.max, "Result": x.result,
         "Notes": x.notes, "Tested By": who, "Logged At": now, "Status": "Active" };
      const line = new Array(hm.lastCol).fill("");
      Object.keys(rec).forEach(k => { const c = hm.map[k.toLowerCase()]; if (c) line[c - 1] = rec[k]; });
      return line;
   });
   const needRows = start + block.length - 1 - tabs.tests.getMaxRows();
   if (needRows > 0) tabs.tests.insertRowsAfter(tabs.tests.getMaxRows(), needRows);
   tabs.tests.getRange(start, 1, block.length, hm.lastCol).setValues(block);

   const off = rows.filter(x => x.result === "Low" || x.result === "High");
   apiLog_(user, "Log water test", "Water Tests", sessionId + " / " + tankId,
      rows.map(x => x.type["Name"] + " " + x.value + (x.type["Units"] ? " " + x.type["Units"] : "") + " (" + x.method + ", " + x.result + ")").join("; "));
   return {
      sessionId: sessionId,
      outOfRange: off.map(x => ({ name: x.type["Name"], value: x.value, units: x.type["Units"], result: x.result,
                                  min: x.range.min, max: x.range.max }))
   };
}


// ------------------------------------------------------------
// Corrections (admins or whoever logged it)
// ------------------------------------------------------------
function apiUpdateWaterReading_(req, user) {
   const tabs = apiEnsureWaterTabs_();
   const row = apiReadSheetRows_(tabs.tests, "Test ID").find(r => r["Test ID"] === req.id);
   if (!row) throw apiError_("NOT_FOUND", "That reading no longer exists.");
   if (!apiCanCorrect_(user, row)) throw apiError_("FORBIDDEN", "Only an admin or the person who logged it can change this reading.");
   const v = req.values || {};
   const values = {};
   const t = apiReadTestTypes_().find(x => x["Test Type ID"] === row["Test Type ID"]);
   if ("value" in v) values["Value"] = apiNumber_(v.value, row["Test Type"]);
   if ("method" in v) {
      const allowed = t ? apiMethodsOf_(t) : WATER_CONFIG.methods;
      if (allowed.indexOf(v.method) === -1) throw apiError_("INVALID", row["Test Type"] + " can only be tested by " + allowed.join(" or ") + ".");
      values["Method"] = v.method;
   }
   if ("notes" in v) values["Notes"] = String(v.notes || "").trim();
   if ("Value" in values) {
      const num = x => (x === "" || x === null || isNaN(Number(x))) ? "" : Number(x);
      values["Result"] = apiResultFor_(values["Value"], num(row["Range Min"]), num(row["Range Max"]));
   }
   const changes = apiWriteChanges_(tabs.tests, row._row, row, values);
   if (changes.length) apiLog_(user, "Edit", "Water Tests", row["Test ID"], changes.join("; "));
   return { updated: changes.length };
}

function apiRetireWaterReading_(req, user) {
   const tabs = apiEnsureWaterTabs_();
   const row = apiReadSheetRows_(tabs.tests, "Test ID").find(r => r["Test ID"] === req.id);
   if (!row) throw apiError_("NOT_FOUND", "That reading no longer exists.");
   if (!apiCanCorrect_(user, row)) throw apiError_("FORBIDDEN", "Only an admin or the person who logged it can change this reading.");
   const status = req.restore ? "Active" : "Retired";
   const changes = apiWriteChanges_(tabs.tests, row._row, row, { "Status": status });
   if (changes.length) apiLog_(user, req.restore ? "Restore" : "Retire", "Water Tests", row["Test ID"], changes.join("; "));
   return { updated: changes.length };
}

// Session: change time or notes (time change is copied to its readings).
function apiUpdateWaterSession_(req, user) {
   const tabs = apiEnsureWaterTabs_();
   const s = apiReadSheetRows_(tabs.sessions, "Session ID").find(r => r["Session ID"] === req.id);
   if (!s) throw apiError_("NOT_FOUND", "That test session no longer exists.");
   if (!apiCanCorrect_(user, s)) throw apiError_("FORBIDDEN", "Only an admin or the person who logged it can change this test.");
   const v = req.values || {};
   const values = {};
   if ("testedAt" in v) values["Tested At"] = apiParseDateTime_(v.testedAt);
   if ("notes" in v) values["Notes"] = String(v.notes || "").trim();
   const before = Object.assign({}, s);
   const changes = apiWriteChanges_(tabs.sessions, s._row, before, values);
   if (values["Tested At"]) {
      apiReadSheetRows_(tabs.tests, "Test ID").filter(r => r["Session ID"] === s["Session ID"]).forEach(r => {
         apiWriteChanges_(tabs.tests, r._row, r, { "Tested At": values["Tested At"] });
      });
   }
   if (changes.length) apiLog_(user, "Edit", "Water Test Sessions", s["Session ID"], changes.join("; "));
   return { updated: changes.length };
}


// ------------------------------------------------------------
// Test types (admins)
// req: { id?, values: { name, units, methods: [..], order, notes } }
// ------------------------------------------------------------
function apiSaveTestType_(req, user) {
   apiRequireAdmin_(user);
   const tabs = apiEnsureWaterTabs_();
   const types = apiReadTestTypes_();
   const v = req.values || {};
   const name = String(v.name || "").replace(/\s+/g, " ").trim();
   if (!name) throw apiError_("INVALID", "Please fill in: Name.");
   const methods = (v.methods || []).filter(m => WATER_CONFIG.methods.indexOf(m) !== -1);
   if (!methods.length) throw apiError_("INVALID", "Choose at least one testing method.");
   const order = String(v.order === undefined ? "" : v.order).trim();
   if (order !== "" && isNaN(Number(order))) throw apiError_("INVALID", "Order must be a number.");
   const existing = req.id ? types.find(t => t["Test Type ID"] === req.id) : null;
   if (req.id && !existing) throw apiError_("STALE", "That test type no longer exists. Refresh and try again.");
   const clash = types.find(t => String(t["Name"]).toLowerCase() === name.toLowerCase() && (!existing || t["Test Type ID"] !== existing["Test Type ID"]));
   if (clash) throw apiError_("INVALID", "There's already a test called " + clash["Name"] + " (" + clash["Test Type ID"] + ").");

   const record = { "Name": name, "Units": String(v.units || "").trim(), "Allowed Methods": methods.join(", "),
                    "Order": order === "" ? (types.reduce((m, t) => Math.max(m, Number(t["Order"]) || 0), 0) + 10) : Number(order),
                    "Notes": String(v.notes || "").trim() };
   if (existing) {
      const before = Object.assign({}, existing, { "Order": String(existing["Order"]) });
      const after = Object.assign({}, record, { "Order": record["Order"] });
      const changes = apiWriteChanges_(tabs.types, existing._row, before, after);
      if (record["Name"] !== existing["Name"]) apiRenameParameterRows_(existing["Test Type ID"], record["Name"]);
      if (changes.length) apiLog_(user, "Edit", "Test Types", existing["Test Type ID"], changes.join("; "));
      return { updated: changes.length };
   }
   record["Test Type ID"] = apiNextSeqId_(types, "Test Type ID", "TT-");
   record["Status"] = "Active";
   apiAppendRow_(tabs.types, record);
   apiLog_(user, "Add", "Test Types", record["Test Type ID"], apiDescribe_(record));
   return { added: record["Test Type ID"] };
}

function apiRetireTestType_(req, user) {
   apiRequireAdmin_(user);
   const tabs = apiEnsureWaterTabs_();
   const t = apiReadTestTypes_().find(x => x["Test Type ID"] === req.id);
   if (!t) throw apiError_("NOT_FOUND", "That test type no longer exists.");
   const status = req.restore ? "Active" : "Retired";
   const changes = apiWriteChanges_(tabs.types, t._row, t, { "Status": status });
   if (changes.length) apiLog_(user, req.restore ? "Restore" : "Retire", "Test Types", t["Test Type ID"], changes.join("; "));
   return { updated: changes.length };
}

// Keeps the readable Parameter name on Water Parameters in step with a renamed test type.
function apiRenameParameterRows_(typeId, newName) {
   const wp = apiSheet_("waterParameters");
   apiReadTable_("waterParameters").rows.filter(r => r["Test Type ID"] === typeId).forEach(r => {
      apiWriteChanges_(wp, r._row, r, { "Parameter": newName });
   });
}
