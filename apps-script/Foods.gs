// ============================================================
// AYERS AQUARIUMS - FOOD
//
// Foods are records like species, equipment and plants: each has its
// own page, picture, prices and receipts. A food is assigned to the
// tanks it's fed in (Tank Assignments), and each of those assignments
// carries how much and how often.
//
// Nothing here tracks how much food is left — only what goes where.
//
// Food Type and Feed Frequency come from the Lookups tab, so they're
// managed on the Dropdown lists screen like every other list.
// ============================================================
const FOOD_CONFIG = {
   sheetName: "Foods",
   typeList: "Food Type",
   frequencyList: "Feed Frequency",
   // Seeded into Lookups the first time the tab is made.
   defaultTypes: ["Flake", "Pellet", "Granule", "Wafer", "Frozen", "Freeze-dried", "Live", "Gel", "Vegetable", "Other"],
   defaultFrequencies: ["Twice daily", "Daily", "Every other day", "3x a week", "2x a week", "Weekly", "Occasionally"],
   // Added to Tank Assignments, for food assignments.
   assignmentColumns: ["Feed Amount", "Feed Frequency"]
};

// Columns of the Foods tab, in order.
const FOOD_HEADERS = ["Food ID", "Product Name", "Manufacturer", "Food Type", "Feeding Notes",
                      "Ingredients", "Vendor", "Notes", "Thumbnail URL", "Status"];


// The Foods tab, made the first time it's needed. Unlike the older data tabs
// this one is found by name, so it doesn't need an ID in SHEET_IDS.
function apiEnsureFoodsTab_() {
   const ss = apiSs_();
   let sh = ss.getSheetByName(FOOD_CONFIG.sheetName);
   if (!sh) {
      sh = ss.insertSheet(FOOD_CONFIG.sheetName);
      sh.getRange(1, 1, 1, FOOD_HEADERS.length).setValues([FOOD_HEADERS])
        .setFontWeight("bold").setBackground("#d9d9d9");
      sh.setFrozenRows(1);
      sh.getRange("J2:J").setDataValidation(SpreadsheetApp.newDataValidation()
         .requireValueInList(["Active", "Retired"], true).setAllowInvalid(false).build());
      sh.setColumnWidth(2, 240); sh.setColumnWidth(5, 280); sh.setColumnWidth(6, 280); sh.setColumnWidth(8, 240);
      apiSeedFoodLists_();
   }
   apiEnsureFeedColumns_();
   return sh;
}

// Starting values for the two lists, if they're not on Lookups yet.
function apiSeedFoodLists_() {
   const rows = apiReadLookups_();
   const system = { id: "", email: "", name: "Setup", role: "Admin", tanks: [] };
   const seed = (type, values) => {
      if (rows.some(r => r.type === type)) return;
      values.forEach(v => apiEnsureLookupValue_(type, v, system));
   };
   seed(FOOD_CONFIG.typeList, FOOD_CONFIG.defaultTypes);
   seed(FOOD_CONFIG.frequencyList, FOOD_CONFIG.defaultFrequencies);
}

// How much and how often live on the assignment, so the same food can be
// fed differently in each tank.
function apiEnsureFeedColumns_() {
   const sheet = apiSheet_("tankAssignments");
   FOOD_CONFIG.assignmentColumns.forEach(h => apiEnsureColumn_(sheet, h));
}

// req: { tankId, itemId, values: { amount, frequency, notes } }
// Changes the feeding details on an item that's already in a tank.
function apiUpdateAssignment_(req, user) {
   const tankId = String(req.tankId || "").trim();
   const itemId = String(req.itemId || "").trim();
   if (!apiCanEditTank_(user, tankId)) throw apiError_("FORBIDDEN", "You can't change that tank.");
   apiEnsureFeedColumns_();
   const sheet = apiSheet_("tankAssignments");
   const row = apiReadSheetRows_(sheet, "Tank ID")
      .find(r => r["Tank ID"] === tankId && r["Item ID"] === itemId && r["Active"] === true && !r["Date Removed"]);
   if (!row) throw apiError_("NOT_FOUND", itemId + " isn't in that tank.");
   const v = req.values || {};
   const values = {};
   if ("amount" in v) values["Feed Amount"] = String(v.amount || "").replace(/\s+/g, " ").trim().slice(0, 100);
   if ("notes" in v) values["Notes"] = String(v.notes || "").trim();
   if ("frequency" in v) {
      const want = String(v.frequency || "").replace(/\s+/g, " ").trim();
      let freq = "";
      if (want) {
         const known = apiFeedFrequencies_().find(f => f.toLowerCase() === want.toLowerCase());
         if (known) freq = known;
         else if (user.role === "Admin") freq = apiEnsureLookupValue_(FOOD_CONFIG.frequencyList, want, user);
         else throw apiError_("INVALID", "Choose how often from the list.");
      }
      values["Feed Frequency"] = freq;
   }
   const changes = apiWriteChanges_(sheet, row._row, row, values);
   if (changes.length) apiLog_(user, "Edit", "Tank Assignments", tankId + " / " + itemId, changes.join("; "));
   return { changes: changes.length };
}

// The active Lookups values for how often, with the defaults as a fallback.
function apiFeedFrequencies_() {
   const list = apiReadLookups_().filter(r => r.type === FOOD_CONFIG.frequencyList && !r.inactive).map(r => r.value);
   return list.length ? list : FOOD_CONFIG.defaultFrequencies.slice();
}

// Sent with the app's startup load, so the form can offer the two lists
// even though neither is a DropDownOptions column.
function apiFoodsBootstrap_() {
   const active = type => apiReadLookups_().filter(r => r.type === type && !r.inactive).map(r => r.value);
   return { feedFrequencies: apiFeedFrequencies_(), foodTypes: active(FOOD_CONFIG.typeList) };
}
