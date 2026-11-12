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
   return user.role === "Admin" || (!!who && who === apiWho_(user));
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
