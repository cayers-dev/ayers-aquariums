// ============================================================
// DROPDOWN LISTS (Admins)
// The dropdown lists live on the Lookups tab (Lookup Type, Value, Description, Inactive).
// DropDownOptions builds each list from Lookups with a formula, so the app only ever
// changes Lookups, never DropDownOptions.
//   - Admins can add, rename, turn off / on and describe values (Dropdown lists screen).
//   - Admins can also type a new value straight into a form's dropdown (apiCleanValues_).
//   - Renaming a value updates every record that uses it.
// ============================================================

function apiLookupsSheet_() {
   const sheet = apiSs_().getSheetByName("Lookups");
   if (!sheet) throw apiError_("SETUP", "The Lookups tab is missing.");
   return sheet;
}

// Every Lookups row as { row, type, value, description, inactive }.
function apiReadLookups_() {
   const values = apiGrid_(apiLookupsSheet_()).values;
   const out = [];
   for (let i = 1; i < values.length; i++) {
      const type = String(values[i][0] || "").trim(), value = String(values[i][1] || "").trim();
      if (!type || !value) continue;
      out.push({ row: i + 1, type: type, value: value, description: String(values[i][2] || "").trim(),
                 inactive: values[i][3] === true || String(values[i][3]).toUpperCase() === "TRUE" });
   }
   return out;
}

// Admins get the lists for the Dropdown lists screen.
function apiLookupsBootstrap_(user) {
   if (user.role !== "Admin") return {};
   const rows = apiReadLookups_();
   const types = [];
   rows.forEach(r => { if (types.indexOf(r.type) === -1) types.push(r.type); });
   return { lookups: rows, lookupTypes: types };
}

// req: { type, value, description }
function apiAddLookup_(req, user) {
   apiRequireAdmin_(user);
   const type = String(req.type || "").trim();
   const value = String(req.value || "").replace(/\s+/g, " ").trim();
   if (!type) throw apiError_("INVALID", "Choose a list.");
   if (!value) throw apiError_("INVALID", "Enter a value.");
   const rows = apiReadLookups_();
   if (!rows.some(r => r.type === type)) throw apiError_("INVALID", type + " isn't one of the dropdown lists.");
   const same = rows.find(r => r.type === type && r.value.toLowerCase() === value.toLowerCase());
   if (same) throw apiError_("INVALID", same.value + " is already on the " + type + " list" + (same.inactive ? " (turned off; edit it to turn it back on)." : "."));
   const sheet = apiLookupsSheet_();
   const values = sheet.getDataRange().getValues();
   let last = values.length;
   while (last > 1 && String(values[last - 1][0]).trim() === "") last--;
   if (last + 1 > sheet.getMaxRows()) sheet.insertRowAfter(sheet.getMaxRows());
   sheet.getRange(last + 1, 1, 1, 4).setValues([[type, value, String(req.description || "").trim(), false]]);
   apiLog_(user, "Add", "Lookups", type, "New value: " + value);
   return { added: value };
}

// req: { row, type, value (current), newValue?, description?, inactive? }
function apiUpdateLookup_(req, user) {
   apiRequireAdmin_(user);
   const rows = apiReadLookups_();
   const rec = rows.find(r => r.row === Number(req.row));
   if (!rec || rec.type !== req.type || rec.value !== req.value) throw apiError_("NOT_FOUND", "That value changed. Refresh and try again.");
   const sheet = apiLookupsSheet_();
   const notes = [];
   let renamed = null;
   const newValue = req.newValue === undefined ? rec.value : String(req.newValue).replace(/\s+/g, " ").trim();
   if (!newValue) throw apiError_("INVALID", "Enter a value.");
   if (newValue !== rec.value) {
      const clash = rows.find(r => r.type === rec.type && r.row !== rec.row && r.value.toLowerCase() === newValue.toLowerCase());
      if (clash) throw apiError_("INVALID", clash.value + " is already on the " + rec.type + " list.");
      sheet.getRange(rec.row, 2).setValue(newValue);
      notes.push("Value: " + rec.value + " → " + newValue);
      renamed = apiRenameLookupUses_(rec.type, rec.value, newValue, user);
   }
   if (req.description !== undefined && String(req.description).trim() !== rec.description) {
      sheet.getRange(rec.row, 3).setValue(String(req.description).trim());
      notes.push("Description: " + (rec.description || "(blank)") + " → " + (String(req.description).trim() || "(blank)"));
   }
   if (req.inactive !== undefined && !!req.inactive !== rec.inactive) {
      sheet.getRange(rec.row, 4).setValue(!!req.inactive);
      notes.push(req.inactive ? "Turned off" : "Turned back on");
   }
   if (notes.length) apiLog_(user, "Edit", "Lookups", rec.type, rec.value + ": " + notes.join("; ") +
                             (renamed && renamed.total ? " — records updated: " + renamed.text : ""));
   return { updated: notes.length, recordsUpdated: renamed ? renamed.total : 0 };
}

// Where each list's values are used: [tab, column] pairs, from the app's field lists
// plus the vendor columns on Receipts, Wishlist and Prices.
function apiLookupUses_(type) {
   const uses = [];
   Object.keys(API_FIELD_LISTS).forEach(table => {
      const defs = API_FIELD_LISTS[table];
      Object.keys(defs).forEach(field => {
         if (defs[field][0] === type || (defs[field][0] === "Tank Status" && type === "Tank Status")) {
            uses.push({ sheet: apiSheet_(API_TABLES[table].sheetKey), column: field, label: API_TABLES[table].label });
         }
      });
   });
   if (type === "Vendor") {
      [[RECEIPTS_CONFIG.receiptsSheetName, "Vendor"], [WISH_CONFIG.sheetName, "Vendor"], [PRICE_CONFIG.pricesSheet, "Location"]].forEach(p => {
         const sh = apiSs_().getSheetByName(p[0]);
         if (sh) uses.push({ sheet: sh, column: p[1], label: p[0] });
      });
   }
   return uses;
}

// Changes every cell holding the old value (ignoring capitals and spaces) to the new one.
function apiRenameLookupUses_(type, oldValue, newValue, user) {
   const key = s => String(s === undefined || s === null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
   const parts = [];
   let total = 0;
   apiLookupUses_(type).forEach(u => {
      const last = apiLastDataRow_(u.sheet);
      if (last < 2) return;
      const headers = u.sheet.getRange(1, 1, 1, u.sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
      const c = headers.indexOf(u.column);
      if (c === -1) return;
      const range = u.sheet.getRange(2, c + 1, last - 1, 1);
      const vals = range.getValues();
      let n = 0;
      vals.forEach(r => { if (key(r[0]) === key(oldValue)) { r[0] = newValue; n++; } });
      if (n) { range.setValues(vals); total += n; parts.push(u.label + " " + u.column + ": " + n); }
   });
   if (total) apiLog_(user, "Rename", "Lookups", type, oldValue + " → " + newValue + " in " + parts.join(", "));
   return { total: total, text: parts.join(", ") };
}

// A list value typed into a form. Existing values (ignoring capitals) keep the list's spelling;
// a new value is added to Lookups when an Admin typed it (never for Status lists).
function apiLookupValueFor_(f, v, user) {
   const hit = (f.options || []).find(o => String(o).toLowerCase() === String(v).toLowerCase());
   if (hit !== undefined) return hit;
   if (user && user.role === "Admin" && f.lookup && f.name !== "Status") {
      return f.lookup === "Vendor" ? apiEnsureVendor_(v, user) : apiEnsureLookupValue_(f.lookup, v, user);
   }
   if (f.strict) throw apiError_("INVALID", f.name + " must be one of: " + f.options.join(", "));
   return v;
}
