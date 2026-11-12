// ============================================================
// AYERS AQUARIUMS - WATER TESTING
//
// Tabs:
//   Test Types           master list of tests (Order sets app order;
//                         Status Retired hides a test from new entries)
//   Water Test Sessions  one row each time someone tests a tank
//                         (tank, time, method, notes, who)
//   Water Tests          one row per reading (value) in a session,
//                         linked to its session by Session ID
//   Water Parameters     (existing) each tank's target + acceptable
//                         min/max per test, linked by Test Type ID
//
// Who can log: admins (any tank) and anyone whose Assigned Tanks
// include the tank. Corrections: admins or the person who logged it.
// Nothing is deleted: readings and sessions are retired.
// ============================================================

// Tab names and the allowed test methods.
const WATER_CONFIG = {
   typesSheetName: "Test Types",
   sessionsSheetName: "Water Test Sessions",
   testsSheetName: "Water Tests",
   methods: ["Strip", "Liquid", "Digital"]
};

// Columns of the Test Types tab, in order.
const TEST_TYPE_HEADERS = ["Test Type ID", "Name", "Units", "Allowed Methods", "Order", "Status", "Notes"];
// A session is one test of one tank (one time, one method, one person).
const WATER_SESSION_HEADERS = ["Session ID", "Tank ID", "Tested At", "Method", "Notes", "Tested By", "Logged At", "Status"];
// A reading is one value in a session; tank/time/method/person live on the session.
const WATER_TEST_HEADERS = ["Test ID", "Session ID", "Test Type ID", "Test Type", "Value", "Units",
                            "Range Min", "Range Max", "Result", "Notes", "Status"];

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
   const sessions = make(WATER_CONFIG.sessionsSheetName, WATER_SESSION_HEADERS, apiFormatSessionsTab_);
   const tests = make(WATER_CONFIG.testsSheetName, WATER_TEST_HEADERS, apiFormatTestsTab_);
   return { types: types, sessions: sessions, tests: tests };
}

// Formats, dropdowns and widths for a new Water Test Sessions tab.
function apiFormatSessionsTab_(sh) {
   const rule = SpreadsheetApp.newDataValidation().requireValueInList(["Active", "Retired"], true).setAllowInvalid(false).build();
   sh.getRange("C2:C").setNumberFormat("m/d/yyyy h:mm am/pm");
   sh.getRange("G2:G").setNumberFormat("m/d/yyyy h:mm am/pm");
   sh.getRange("D2:D").setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(WATER_CONFIG.methods, true).setAllowInvalid(false).build());
   sh.getRange("H2:H").setDataValidation(rule);
   sh.setColumnWidth(5, 280);
}

// Status dropdown and widths for a new Water Tests tab.
function apiFormatTestsTab_(sh) {
   const rule = SpreadsheetApp.newDataValidation().requireValueInList(["Active", "Retired"], true).setAllowInvalid(false).build();
   sh.getRange("K2:K").setDataValidation(rule);
   sh.setColumnWidth(4, 170); sh.setColumnWidth(10, 240);
}

// All test types, sorted by their Order column (the order the app shows them).
function apiReadTestTypes_() {
   return apiReadSheetRows_(apiEnsureWaterTabs_().types, "Test Type ID")
      .sort((a, b) => (Number(a["Order"]) || 9999) - (Number(b["Order"]) || 9999));
}

// A test type's allowed methods (Strip / Liquid / Digital) as a list.
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

// Readings with their session's tank, time, method and tester added
// (a retired session makes its readings count as retired).
function apiReadWaterJoined_(tabs) {
   tabs = tabs || apiEnsureWaterTabs_();
   const sessions = apiReadSheetRows_(tabs.sessions, "Session ID");
   const byId = {};
   sessions.forEach(s => byId[s["Session ID"]] = s);
   const tests = apiReadSheetRows_(tabs.tests, "Test ID").map(r => {
      const s = byId[r["Session ID"]] || {};
      return Object.assign({}, r, {
         "Tank ID": s["Tank ID"] || "", "Tested At": s["Tested At"] || "", "Method": s["Method"] || "",
         "Tested By": s["Tested By"] || "",
         "Status": String(s["Status"]) === "Retired" ? "Retired" : (r["Status"] || "Active")
      });
   });
   return { sessions: sessions, tests: tests };
}

// Water testing data for the app's startup load (test types, sessions, readings).
function apiWaterBootstrap_(user) {
   const tabs = apiEnsureWaterTabs_();
   const types = apiReadTestTypes_();
   apiBackfillParamTypeIds_(types);
   const j = apiReadWaterJoined_(tabs);
   return { testTypes: types, waterSessions: j.sessions, waterTests: j.tests, methods: WATER_CONFIG.methods };
}

// Admins can log tests for any tank; everyone else for their assigned tanks.
function apiCanLogTank_(user, tankId) {
   return user.role === "Admin" || user.tanks.indexOf(tankId) !== -1;
}

// Admins, or the person who logged the reading, can correct or retire it.
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

// In range / Low / High for a reading against its tank's acceptable min and max.
function apiResultFor_(value, min, max) {
   if (min === "" && max === "") return "No range";
   if (min !== "" && value < min) return "Low";
   if (max !== "" && value > max) return "High";
   return "In range";
}

// Converts yyyy-MM-dd HH:mm (or the date alone) to a Date; blank means now.
// Times more than 10 minutes in the future are refused.
function apiParseDateTime_(v) {
   if (!v) return new Date();
   const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
   if (!m) throw apiError_("INVALID", "Date/time must look like 2026-11-11 15:30.");
   const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
   if (d.getTime() > Date.now() + 10 * 60 * 1000) throw apiError_("INVALID", "The date/time can't be in the future.");
   return d;
}

// A required number field, or an INVALID error naming the field.
function apiNumber_(v, label) {
   const s = String(v === undefined || v === null ? "" : v).trim();
   if (s === "" || isNaN(Number(s))) throw apiError_("INVALID", label + " must be a number.");
   return Number(s);
}

// Next ID in a list of rows, e.g. WS-15 after WS-14.
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
// req: { tankId, testedAt, method, notes, readings: [{ testTypeId, value, notes }] }
function apiLogWaterTest_(req, user) {
   const tankId = String(req.tankId || "");
   if (!apiFindById_("tanks", tankId)) throw apiError_("INVALID", "Choose a tank.");
   if (!apiCanLogTank_(user, tankId)) throw apiError_("FORBIDDEN", "You can't log tests for that tank.");
   const method = String(req.method || req.defaultMethod || "");
   if (WATER_CONFIG.methods.indexOf(method) === -1) throw apiError_("INVALID", "Choose a method: " + WATER_CONFIG.methods.join(", ") + ".");
   const readings = (req.readings || []).filter(r => String(r.value === undefined || r.value === null ? "" : r.value).trim() !== "");
   if (!readings.length) throw apiError_("INVALID", "Enter at least one reading.");

   // Check each reading and work out its result against the tank's range.
   const types = apiReadTestTypes_();
   const testedAt = apiParseDateTime_(req.testedAt);
   const seen = {};
   const rows = readings.map(r => {
      const t = types.find(x => x["Test Type ID"] === r.testTypeId);
      if (!t) throw apiError_("INVALID", "Unknown test type " + r.testTypeId + ".");
      if (String(t["Status"]) === "Retired") throw apiError_("INVALID", t["Name"] + " has been retired.");
      if (seen[t["Test Type ID"]]) throw apiError_("INVALID", t["Name"] + " was entered twice.");
      seen[t["Test Type ID"]] = true;
      if (apiMethodsOf_(t).indexOf(method) === -1) throw apiError_("INVALID", t["Name"] + " isn't tested by " + method + ".");
      const value = apiNumber_(r.value, t["Name"]);
      const range = apiRangeFor_(tankId, t);
      return { type: t, value: value, range: range, result: apiResultFor_(value, range.min, range.max), notes: String(r.notes || "").trim() };
   });

   // One session row for the whole test.
   const tabs = apiEnsureWaterTabs_();
   const sessionId = apiNextSeqId_(apiReadSheetRows_(tabs.sessions, "Session ID"), "Session ID", "WS-");
   apiAppendRow_(tabs.sessions, { "Session ID": sessionId, "Tank ID": tankId, "Tested At": testedAt, "Method": method,
      "Notes": String(req.notes || "").trim(), "Tested By": apiWho_(user), "Logged At": new Date(), "Status": "Active" });

   // Readings are written as one block.
   let next = Number(apiNextSeqId_(apiReadSheetRows_(tabs.tests, "Test ID"), "Test ID", "WT-").slice(3));
   const hm = apiHeaderMap_(tabs.tests);
   const start = apiLastDataRow_(tabs.tests) + 1;
   const block = rows.map(x => {
      const rec = { "Test ID": "WT-" + (next++), "Session ID": sessionId, "Test Type ID": x.type["Test Type ID"], "Test Type": x.type["Name"],
         "Value": x.value, "Units": x.type["Units"], "Range Min": x.range.min, "Range Max": x.range.max, "Result": x.result,
         "Notes": x.notes, "Status": "Active" };
      const line = new Array(hm.lastCol).fill("");
      Object.keys(rec).forEach(k => { const c = hm.map[k.toLowerCase()]; if (c) line[c - 1] = rec[k]; });
      return line;
   });
   const needRows = start + block.length - 1 - tabs.tests.getMaxRows();
   if (needRows > 0) tabs.tests.insertRowsAfter(tabs.tests.getMaxRows(), needRows);
   tabs.tests.getRange(start, 1, block.length, hm.lastCol).setValues(block);

   // Log it, and return any out-of-range readings so the app can warn.
   const off = rows.filter(x => x.result === "Low" || x.result === "High");
   apiLog_(user, "Log water test", "Water Tests", sessionId + " / " + tankId,
      method + ": " + rows.map(x => x.type["Name"] + " " + x.value + (x.type["Units"] ? " " + x.type["Units"] : "") + " (" + x.result + ")").join("; "));
   return {
      sessionId: sessionId,
      outOfRange: off.map(x => ({ name: x.type["Name"], value: x.value, units: x.type["Units"], result: x.result,
                                  min: x.range.min, max: x.range.max }))
   };
}


// ------------------------------------------------------------
// Corrections (admins or whoever logged it)
// ------------------------------------------------------------
function apiFindReading_(tabs, id) {
   const row = apiReadWaterJoined_(tabs).tests.find(r => r["Test ID"] === id);
   if (!row) throw apiError_("NOT_FOUND", "That reading no longer exists.");
   return row;
}

// Value and note of one reading (method belongs to the session).
function apiUpdateWaterReading_(req, user) {
   const tabs = apiEnsureWaterTabs_();
   const row = apiFindReading_(tabs, req.id);
   if (!apiCanCorrect_(user, row)) throw apiError_("FORBIDDEN", "Only an admin or the person who logged it can change this reading.");
   const v = req.values || {};
   const values = {};
   if ("value" in v) {
      values["Value"] = apiNumber_(v.value, row["Test Type"]);
      const num = x => (x === "" || x === null || isNaN(Number(x))) ? "" : Number(x);
      values["Result"] = apiResultFor_(values["Value"], num(row["Range Min"]), num(row["Range Max"]));
   }
   if ("notes" in v) values["Notes"] = String(v.notes || "").trim();
   const raw = apiReadSheetRows_(tabs.tests, "Test ID").find(r => r["Test ID"] === req.id);
   const changes = apiWriteChanges_(tabs.tests, raw._row, raw, values);
   if (changes.length) apiLog_(user, "Edit", "Water Tests", row["Test ID"], changes.join("; "));
   return { updated: changes.length };
}

// Retires (or, with req.restore, restores) one reading.
function apiRetireWaterReading_(req, user) {
   const tabs = apiEnsureWaterTabs_();
   const row = apiFindReading_(tabs, req.id);
   if (!apiCanCorrect_(user, row)) throw apiError_("FORBIDDEN", "Only an admin or the person who logged it can change this reading.");
   const raw = apiReadSheetRows_(tabs.tests, "Test ID").find(r => r["Test ID"] === req.id);
   const status = req.restore ? "Active" : "Retired";
   const changes = apiWriteChanges_(tabs.tests, raw._row, raw, { "Status": status });
   if (changes.length) apiLog_(user, req.restore ? "Restore" : "Retire", "Water Tests", row["Test ID"], changes.join("; "));
   return { updated: changes.length };
}

// A test (session): time, method or notes.
function apiUpdateWaterSession_(req, user) {
   const tabs = apiEnsureWaterTabs_();
   const j = apiReadWaterJoined_(tabs);
   const s = j.sessions.find(r => r["Session ID"] === req.id);
   if (!s) throw apiError_("NOT_FOUND", "That test no longer exists.");
   if (!apiCanCorrect_(user, s)) throw apiError_("FORBIDDEN", "Only an admin or the person who logged it can change this test.");
   const v = req.values || {};
   const values = {};
   if ("testedAt" in v) values["Tested At"] = apiParseDateTime_(v.testedAt);
   if ("notes" in v) values["Notes"] = String(v.notes || "").trim();
   if ("method" in v) {
      if (WATER_CONFIG.methods.indexOf(v.method) === -1) throw apiError_("INVALID", "Choose a method.");
      const types = apiReadTestTypes_();
      j.tests.filter(r => r["Session ID"] === s["Session ID"] && r["Status"] !== "Retired").forEach(r => {
         const t = types.find(x => x["Test Type ID"] === r["Test Type ID"]);
         if (t && apiMethodsOf_(t).indexOf(v.method) === -1) throw apiError_("INVALID", t["Name"] + " isn't tested by " + v.method + ".");
      });
      values["Method"] = v.method;
   }
   const changes = apiWriteChanges_(tabs.sessions, s._row, s, values);
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
   // Validate name, methods and order; names must be unique.
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

   // Blank Order puts the new test at the end of the list.
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
   // New test type.
   record["Test Type ID"] = apiNextSeqId_(types, "Test Type ID", "TT-");
   record["Status"] = "Active";
   apiAppendRow_(tabs.types, record);
   apiLog_(user, "Add", "Test Types", record["Test Type ID"], apiDescribe_(record));
   return { added: record["Test Type ID"] };
}

// Retires (or restores) a test type (admins). Retired tests stop appearing for new entries.
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
