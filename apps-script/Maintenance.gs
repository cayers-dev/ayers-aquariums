// ============================================================
// AYERS AQUARIUMS - MAINTENANCE
//
// One tab per maintenance type. Every type shares these columns:
//   <Type> ID, Tank ID, Performed At, ..type fields.., Notes,
//   Performed By, Logged At, Status
//
// Tabs so far:
//   Water Changes   Percentage, Gallons, Filters Cleaned (Equipment IDs
//                   of the tank's filters that were cleaned, comma
//                   separated)
//
// Who can log: admins (any tank) and anyone whose Assigned Tanks
// include the tank. Corrections: admins or the person who logged it.
// Nothing is deleted: entries are retired.
// ============================================================

// Tab name for each maintenance type.
const MAINT_CONFIG = {
   waterChangesSheetName: "Water Changes"
};

// Columns of the Water Changes tab, in order.
const WATER_CHANGE_HEADERS = ["Water Change ID", "Tank ID", "Performed At", "Percentage", "Gallons",
                              "Filters Cleaned", "Notes", "Performed By", "Logged At", "Status"];


// Returns the maintenance tabs, creating any that are missing.
function apiEnsureMaintTabs_() {
   const ss = apiSs_();
   let wc = ss.getSheetByName(MAINT_CONFIG.waterChangesSheetName);
   if (!wc) {
      wc = ss.insertSheet(MAINT_CONFIG.waterChangesSheetName);
      wc.getRange(1, 1, 1, WATER_CHANGE_HEADERS.length).setValues([WATER_CHANGE_HEADERS])
        .setFontWeight("bold").setBackground("#d9d9d9");
      wc.setFrozenRows(1);
      apiFormatWaterChangesTab_(wc);
   }
   return { waterChanges: wc };
}

// Date formats, Status dropdown and column widths for a new Water Changes tab.
function apiFormatWaterChangesTab_(sh) {
   sh.getRange("C2:C").setNumberFormat("m/d/yyyy h:mm am/pm");
   sh.getRange("I2:I").setNumberFormat("m/d/yyyy h:mm am/pm");
   sh.getRange("J2:J").setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(["Active", "Retired"], true).setAllowInvalid(false).build());
   sh.setColumnWidth(3, 150); sh.setColumnWidth(6, 140); sh.setColumnWidth(7, 280);
}

// Maintenance data for the app's startup load.
function apiMaintBootstrap_(user) {
   const tabs = apiEnsureMaintTabs_();
   return { waterChanges: apiReadSheetRows_(tabs.waterChanges, "Water Change ID") };
}

// Active filter equipment assigned to a tank (Category starting "Filter").
function apiTankFilters_(tankId) {
   const equipment = apiReadTable_("equipment").rows;
   const isFilter = id => {
      const e = equipment.find(r => r["Equipment ID"] === id);
      return e && /^filter/i.test(String(e["Category"] || "")) && String(e["Status"]) !== "Retired";
   };
   return apiReadTable_("assignments").rows
      .filter(a => a["Tank ID"] === tankId && a["Active"] === true && !a["Date Removed"] && isFilter(a["Item ID"]))
      .map(a => a["Item ID"]);
}

// Admins, or the person who logged the entry, can correct or retire it.
function apiCanCorrectBy_(user, who) {
   return apiCan_(user, "allTanks") || (!!who && who === apiWho_(user));
}

// Percentage and gallons: either may be given; the other is filled in
// from the tank's Volume (gal) when it's known.
function apiWaterChangeAmounts_(tank, pctIn, galIn) {
   const blank = v => v === undefined || v === null || String(v).trim() === "";
   let pct = blank(pctIn) ? "" : apiNumber_(pctIn, "Percentage");
   let gal = blank(galIn) ? "" : apiNumber_(galIn, "Gallons");
   if (pct !== "" && (pct <= 0 || pct > 100)) throw apiError_("INVALID", "Percentage must be between 0 and 100.");
   if (gal !== "" && gal <= 0) throw apiError_("INVALID", "Gallons must be more than 0.");
   const vol = Number(String(tank["Volume (gal)"] || "").replace(/,/g, ""));
   if (vol > 0) {
      if (pct !== "" && gal === "") gal = Math.round(vol * pct / 10) / 10;
      else if (gal !== "" && pct === "") pct = Math.round(gal / vol * 1000) / 10;
   }
   return { pct: pct, gal: gal };
}

// Checks that each filter ID is a filter assigned to the tank (keep: IDs already on the
// entry, allowed even if since moved) and returns them comma-separated.
function apiCleanFilters_(tankId, list, keep) {
   const allowed = apiTankFilters_(tankId).concat(keep || []);
   const out = [];
   (Array.isArray(list) ? list : String(list || "").split(",")).map(s => String(s).trim()).filter(Boolean).forEach(id => {
      if (allowed.indexOf(id) === -1) throw apiError_("INVALID", id + " isn't a filter assigned to this tank.");
      if (out.indexOf(id) === -1) out.push(id);
   });
   return out.join(", ");
}


// ------------------------------------------------------------
// Water changes
// req: { tankId, performedAt, percentage, gallons, filters: [EQ-..], notes }
// ------------------------------------------------------------
function apiLogWaterChange_(req, user) {
   const tankId = String(req.tankId || "");
   const tank = apiFindById_("tanks", tankId);
   if (!tank) throw apiError_("INVALID", "Choose a tank.");
   if (!apiCanLogTank_(user, tankId)) throw apiError_("FORBIDDEN", "You can't log maintenance for that tank.");
   const amt = apiWaterChangeAmounts_(tank, req.percentage, req.gallons);
   const filters = apiCleanFilters_(tankId, req.filters);
   const tabs = apiEnsureMaintTabs_();
   const id = apiNextSeqId_(apiReadSheetRows_(tabs.waterChanges, "Water Change ID"), "Water Change ID", "WC-");
   apiAppendRow_(tabs.waterChanges, {
      "Water Change ID": id, "Tank ID": tankId, "Performed At": apiParseDateTime_(req.performedAt),
      "Percentage": amt.pct, "Gallons": amt.gal, "Filters Cleaned": filters,
      "Notes": String(req.notes || "").trim(), "Performed By": apiWho_(user), "Logged At": new Date(), "Status": "Active"
   });
   apiLog_(user, "Log water change", "Water Changes", id + " / " + tankId,
      [amt.pct !== "" ? amt.pct + "%" : "", amt.gal !== "" ? amt.gal + " gal" : "", filters ? "filters cleaned: " + filters : ""].filter(Boolean).join(", "));
   return { id: id };
}

// A Water Changes row by ID, or NOT_FOUND.
function apiFindWaterChange_(tabs, id) {
   const row = apiReadSheetRows_(tabs.waterChanges, "Water Change ID").find(r => r["Water Change ID"] === id);
   if (!row) throw apiError_("NOT_FOUND", "That water change no longer exists.");
   return row;
}

// req: { id, values: { performedAt?, percentage?, gallons?, filters?, notes? } }
function apiUpdateWaterChange_(req, user) {
   const tabs = apiEnsureMaintTabs_();
   const row = apiFindWaterChange_(tabs, req.id);
   if (!apiCanCorrectBy_(user, row["Performed By"])) throw apiError_("FORBIDDEN", "Only an admin or the person who logged it can change this.");
   const v = req.values || {};
   const values = {};
   if ("performedAt" in v) values["Performed At"] = apiParseDateTime_(v.performedAt);
   if ("percentage" in v || "gallons" in v) {
      const tank = apiFindById_("tanks", row["Tank ID"]) || {};
      const amt = apiWaterChangeAmounts_(tank, "percentage" in v ? v.percentage : row["Percentage"], "gallons" in v ? v.gallons : row["Gallons"]);
      values["Percentage"] = amt.pct; values["Gallons"] = amt.gal;
   }
   if ("filters" in v) {
      const had = String(row["Filters Cleaned"] || "").split(",").map(s => s.trim()).filter(Boolean);
      values["Filters Cleaned"] = apiCleanFilters_(row["Tank ID"], v.filters, had);
   }
   if ("notes" in v) values["Notes"] = String(v.notes || "").trim();
   const changes = apiWriteChanges_(tabs.waterChanges, row._row, row, values);
   if (changes.length) apiLog_(user, "Edit", "Water Changes", row["Water Change ID"], changes.join("; "));
   return { updated: changes.length };
}

// Retires (or, with req.restore, restores) a water change entry.
function apiRetireWaterChange_(req, user) {
   const tabs = apiEnsureMaintTabs_();
   const row = apiFindWaterChange_(tabs, req.id);
   if (!apiCanCorrectBy_(user, row["Performed By"])) throw apiError_("FORBIDDEN", "Only an admin or the person who logged it can change this.");
   const changes = apiWriteChanges_(tabs.waterChanges, row._row, row, { "Status": req.restore ? "Active" : "Retired" });
   if (changes.length) apiLog_(user, req.restore ? "Restore" : "Retire", "Water Changes", row["Water Change ID"], changes.join("; "));
   return { updated: changes.length };
}


// ============================================================
// MAINTENANCE NOTES
//
// One row per thing done to a tank that isn't a water change:
// light settings changed, filter intake moved, UV bulb replaced.
// Each note belongs to a tank, can point at a piece of equipment
// (or any record), and can carry a date it's due again.
// Types come from the Lookups tab, so they're managed on the
// Dropdown lists screen like every other list.
// ============================================================
const MNOTE_CONFIG = {
   sheetName: "Maintenance Notes",
   prefix: "MN-",
   typeList: "Maintenance Type",
   // Seeded into Lookups the first time the tab is made.
   defaultTypes: ["Light settings", "Equipment moved", "Part replaced", "Cleaning", "Repair", "Other"]
};

const MAINT_NOTE_HEADERS = ["Note ID", "Tank ID", "Item ID", "Maintenance Type", "Summary", "Notes",
                            "Done At", "Due Date", "Logged By", "Logged At", "Status"];

function apiEnsureNotesTab_() {
   const ss = apiSs_();
   let sh = ss.getSheetByName(MNOTE_CONFIG.sheetName);
   if (!sh) {
      sh = ss.insertSheet(MNOTE_CONFIG.sheetName);
      sh.getRange(1, 1, 1, MAINT_NOTE_HEADERS.length).setValues([MAINT_NOTE_HEADERS])
        .setFontWeight("bold").setBackground("#d9d9d9");
      sh.setFrozenRows(1);
      sh.getRange("G2:H").setNumberFormat("m/d/yyyy");
      sh.getRange("J2:J").setNumberFormat("m/d/yyyy h:mm am/pm");
      sh.getRange("K2:K").setDataValidation(SpreadsheetApp.newDataValidation()
         .requireValueInList(["Active", "Retired"], true).setAllowInvalid(false).build());
      sh.setColumnWidth(5, 260); sh.setColumnWidth(6, 300);
      apiSeedNoteTypes_();
   }
   return sh;
}

// Puts the starting types on the Lookups tab, if that list is empty.
function apiSeedNoteTypes_() {
   const have = apiReadLookups_().some(r => r.type === MNOTE_CONFIG.typeList);
   if (have) return;
   const system = { id: "", email: "", name: "Setup", role: "Admin", tanks: [] };
   MNOTE_CONFIG.defaultTypes.forEach(v => apiEnsureLookupValue_(MNOTE_CONFIG.typeList, v, system));
}

function apiReadMaintNotes_() {
   return apiReadSheetRows_(apiEnsureNotesTab_(), "Note ID");
}

// The types to offer in the form: the active Lookups values for this list.
function apiMaintNoteTypes_() {
   const types = apiReadLookups_().filter(r => r.type === MNOTE_CONFIG.typeList && !r.inactive).map(r => r.value);
   return apiSortList_(types.length ? types : MNOTE_CONFIG.defaultTypes);
}

function apiMaintNotesBootstrap_(user) {
   const strip = r => { const o = Object.assign({}, r); delete o._row; return o; };
   return { maintNotes: apiReadMaintNotes_().map(strip), maintNoteTypes: apiMaintNoteTypes_() };
}

// Checks and tidies what the form sent. isNew requires a tank, a type and a summary.
function apiCleanMaintNote_(req, user, isNew, current) {
   const out = {};
   const has = k => k in req && req[k] !== undefined;
   if (isNew || has("tankId")) {
      const tankId = String(req.tankId || "").trim();
      if (!apiFindById_("tanks", tankId)) throw apiError_("INVALID", "Choose a tank.");
      if (!apiCanLogTank_(user, tankId)) throw apiError_("FORBIDDEN", "You can't log maintenance for that tank.");
      out["Tank ID"] = tankId;
   }
   if (isNew || has("itemId")) {
      const itemId = String(req.itemId || "").trim();
      if (itemId && !apiPriceRecord_(itemId)) throw apiError_("INVALID", itemId + " doesn't exist.");
      out["Item ID"] = itemId;
   }
   if (isNew || has("type")) {
      let type = String(req.type || "").replace(/\s+/g, " ").trim();
      if (!type) throw apiError_("INVALID", "Choose what kind of maintenance this was.");
      const known = apiMaintNoteTypes_().find(t => t.toLowerCase() === type.toLowerCase());
      // A new kind is added to the list, for admins only (same rule as the other lists).
      if (known) type = known;
      else if (apiCan_(user, "manageLists")) type = apiEnsureLookupValue_(MNOTE_CONFIG.typeList, type, user);
      else throw apiError_("INVALID", "Choose a kind from the list.");
      out["Maintenance Type"] = type;
   }
   if (isNew || has("summary")) {
      const summary = String(req.summary || "").replace(/\s+/g, " ").trim();
      if (!summary) throw apiError_("INVALID", "Say what was done.");
      out["Summary"] = summary.slice(0, 200);
   }
   if (isNew || has("notes")) out["Notes"] = String(req.notes || "").trim();
   if (isNew || has("doneAt")) out["Done At"] = req.doneAt ? apiParseDate_(String(req.doneAt).slice(0, 10)) : new Date();
   if (isNew || has("dueDate")) {
      const due = String(req.dueDate || "").slice(0, 10);
      if (due) {
         const doneText = out["Done At"] instanceof Date ? Utilities.formatDate(out["Done At"], apiSs_().getSpreadsheetTimeZone(), "yyyy-MM-dd")
                        : String((current || {})["Done At"] || "").slice(0, 10);
         if (doneText && due < doneText) throw apiError_("INVALID", "The due date can't be before the date it was done.");
      }
      out["Due Date"] = due ? apiParseDate_(due) : "";
   }
   return out;
}

// req: { tankId, itemId?, type, summary, notes?, doneAt?, dueDate?, replacesId? }
// replacesId: doing a due job again — the old note's due date is cleared.
function apiAddMaintNote_(req, user) {
   const sheet = apiEnsureNotesTab_();
   const values = apiCleanMaintNote_(req, user, true);
   const rows = apiReadSheetRows_(sheet, "Note ID");
   const id = apiNextSeqId_(rows, "Note ID", MNOTE_CONFIG.prefix);
   apiAppendRow_(sheet, Object.assign({ "Note ID": id }, values,
      { "Logged By": apiWho_(user), "Logged At": new Date(), "Status": "Active" }));
   let replaced = "";
   if (req.replacesId) {
      const old = rows.find(r => r["Note ID"] === String(req.replacesId).trim());
      if (old && old["Due Date"]) {
         apiWriteChanges_(sheet, old._row, old, { "Due Date": "" });
         replaced = old["Note ID"];
      }
   }
   apiLog_(user, "Add", "Maintenance Notes", id + " / " + values["Tank ID"],
           values["Maintenance Type"] + ": " + values["Summary"] +
           (values["Item ID"] ? " (" + values["Item ID"] + ")" : "") +
           (replaced ? "; done again, " + replaced + " no longer due" : ""));
   return { id: id, replaced: replaced };
}

// req: { id, values: { ...same fields... } }
function apiUpdateMaintNote_(req, user) {
   const sheet = apiEnsureNotesTab_();
   const row = apiFindMaintNote_(sheet, req.id);
   if (!apiCanCorrectBy_(user, row["Logged By"])) throw apiError_("FORBIDDEN", "Only an admin or the person who logged it can change this.");
   const values = apiCleanMaintNote_(req.values || {}, user, false, row);
   const changes = apiWriteChanges_(sheet, row._row, row, values);
   if (changes.length) apiLog_(user, "Edit", "Maintenance Notes", row["Note ID"], changes.join("; "));
   return { id: row["Note ID"], changes: changes.length };
}

// Retired, not deleted, like every other maintenance entry.
function apiRetireMaintNote_(req, user) {
   const sheet = apiEnsureNotesTab_();
   const row = apiFindMaintNote_(sheet, req.id);
   if (!apiCanCorrectBy_(user, row["Logged By"])) throw apiError_("FORBIDDEN", "Only an admin or the person who logged it can remove this.");
   apiWriteChanges_(sheet, row._row, row, { "Status": "Retired" });
   apiLog_(user, "Retire", "Maintenance Notes", row["Note ID"], row["Summary"]);
   return { id: row["Note ID"] };
}

function apiFindMaintNote_(sheet, id) {
   const row = apiReadSheetRows_(sheet, "Note ID").find(r => r["Note ID"] === String(id || "").trim());
   if (!row) throw apiError_("NOT_FOUND", "That note no longer exists.");
   return row;
}

// Used when a tank or a record is deleted (Delete.gs).
function apiDeleteMaintNotesWhere_(header, id) {
   const sheet = apiSs_().getSheetByName(MNOTE_CONFIG.sheetName);
   if (!sheet) return 0;
   if (header === "Item ID") {
      // The note still describes work on the tank: just unlink the item.
      let n = 0;
      apiReadSheetRows_(sheet, "Note ID").forEach(r => {
         if (String(r["Item ID"]).trim() === String(id).trim()) { apiWriteChanges_(sheet, r._row, r, { "Item ID": "" }); n++; }
      });
      return n;
   }
   return apiDeleteRowsWhere_(sheet, header, v => String(v).trim() === String(id).trim()).count;
}
