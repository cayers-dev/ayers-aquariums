// ============================================================
// PRICE TRACKER
// Compare what items cost at different stores.
//   Price Items tab: one row per item being priced. Record ID links it to a
//                    species, equipment, plant or medication; blank = a typed item.
//   Prices tab:      one row per price gathered (history is kept; the app
//                    shows the latest price per store).
// Everyone signed in can see prices; Admins and Editors add, edit and delete.
// ============================================================

const PRICE_CONFIG = {
   itemsSheet: "Price Items",
   itemPrefix: "PI-",
   itemHeaders: ["Price Item ID", "Record ID", "Item Name", "Added By", "Added At", "Picture URL"],
   pricesSheet: "Prices",
   pricePrefix: "PR-",
   priceHeaders: ["Price ID", "Price Item ID", "Location", "Price", "Size", "Unit", "Date Gathered", "Added By", "Added At"],
   // Units come from the Lookups tab, so they're managed on the Dropdown lists screen.
   // These are only the starting values, seeded the first time, and the fallback if
   // the list is ever emptied.
   unitList: "Price Unit",
   units: ["oz", "lb", "g", "kg", "mL", "L", "fl oz", "gal", "count", "each"]
};

// The units to offer and accept: the list's active values, or the starting values.
function apiPriceUnits_() {
   const list = apiReadLookups_().filter(r => r.type === PRICE_CONFIG.unitList && !r.inactive).map(r => r.value);
   return apiSortList_(list.length ? list : PRICE_CONFIG.units);
}

// Puts the starting units on Lookups the first time, so they can be managed in the app.
function apiSeedPriceUnits_() {
   if (apiReadLookups_().some(r => r.type === PRICE_CONFIG.unitList)) return;
   const system = { id: "", email: "", name: "Setup", role: "Admin", tanks: [] };
   PRICE_CONFIG.units.forEach(u => apiEnsureLookupValue_(PRICE_CONFIG.unitList, u, system));
}

function apiCanUsePrices_(user) {
   return user.role === "Admin" || user.role === "Editor";
}
function apiRequirePrices_(user) {
   if (!apiCanUsePrices_(user)) throw apiError_("FORBIDDEN", "Only admins and editors can change prices.");
}

// Creates a tab with bold, frozen headers the first time it's needed.
function apiPriceTab_(name, headers, widths, formats) {
   const ss = apiSs_();
   let sheet = ss.getSheetByName(name);
   if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold").setBackground("#d9d9d9");
      sheet.setFrozenRows(1);
      Object.keys(widths || {}).forEach(c => sheet.setColumnWidth(Number(c), widths[c]));
      Object.keys(formats || {}).forEach(a1 => sheet.getRange(a1).setNumberFormat(formats[a1]));
   }
   return sheet;
}
function apiPriceItemsSheet_() {
   const sheet = apiPriceTab_(PRICE_CONFIG.itemsSheet, PRICE_CONFIG.itemHeaders, { 3: 260, 6: 320 }, { "E2:E": "m/d/yyyy h:mm am/pm" });
   // Tabs made before a column existed get it added at the end.
   const have = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(h => String(h).trim());
   PRICE_CONFIG.itemHeaders.forEach(h => {
      if (have.indexOf(h) === -1) { sheet.getRange(1, have.length + 1).setValue(h).setFontWeight("bold").setBackground("#d9d9d9"); have.push(h); }
   });
   return sheet;
}
function apiPricesSheet_() {
   return apiPriceTab_(PRICE_CONFIG.pricesSheet, PRICE_CONFIG.priceHeaders, { 3: 160 },
                       { "D2:D": "$#,##0.00", "G2:G": "m/d/yyyy", "I2:I": "m/d/yyyy h:mm am/pm" });
}

// Rows of a price tab as { header: value, _row }. Numbers stay numbers; dates become text.
function apiReadPriceTab_(name, keyField) {
   const sheet = apiSs_().getSheetByName(name);
   if (!sheet) return [];
   const values = apiGrid_(sheet).values;
   if (values.length < 2) return [];
   const headers = values[0].map(h => String(h).trim());
   const tz = apiSs_().getSpreadsheetTimeZone();
   const out = [];
   for (let r = 1; r < values.length; r++) {
      const o = { _row: r + 1 };
      headers.forEach((h, c) => {
         if (!h || h in o) return;
         const v = values[r][c];
         o[h] = v instanceof Date ? Utilities.formatDate(v, tz, / At$/.test(h) ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd") : v;
      });
      if (String(o[keyField] || "") !== "") out.push(o);
   }
   return out;
}
const apiReadPriceItems_ = () => apiReadPriceTab_(PRICE_CONFIG.itemsSheet, "Price Item ID");
const apiReadPrices_ = () => apiReadPriceTab_(PRICE_CONFIG.pricesSheet, "Price ID");

function apiPricesBootstrap_() {
   const strip = r => { const o = Object.assign({}, r); delete o._row; return o; };
   apiSeedPriceUnits_();
   return { priceItems: apiReadPriceItems_().map(strip), prices: apiReadPrices_().map(strip), priceUnits: apiPriceUnits_() };
}

function apiNextPriceId_(rows, field, prefix) {
   const max = rows.reduce((m, r) => {
      const n = Number(String(r[field]).replace(/^\D+/, ""));
      return isNaN(n) ? m : Math.max(m, n);
   }, 0);
   return prefix + (max + 1);
}

// The record (species, equipment, plant, medication) with this ID, or null.
function apiPriceRecord_(id) {
   for (const t of ["species", "equipment", "plants", "medications", "foods", "tanks"]) {
      const r = apiFindById_(t, id);
      if (r) return { table: t, rec: r };
   }
   return null;
}

// Checks and tidies the price fields shared by add and edit.
function apiCleanPrice_(req) {
   const location = String(req.location || "").replace(/\s+/g, " ").trim();
   if (!location) throw apiError_("INVALID", "Choose or type a location.");
   const price = Number(String(req.price === undefined ? "" : req.price).replace(/[$,\s]/g, ""));
   if (String(req.price || "").trim() === "" || isNaN(price) || price < 0) throw apiError_("INVALID", "Enter the price as a number, like 12.99.");
   const size = Number(String(req.size === undefined ? "" : req.size).replace(/[,\s]/g, ""));
   if (String(req.size || "").trim() === "" || isNaN(size) || size <= 0) throw apiError_("INVALID", "Enter the size as a number, like 250.");
   const units = apiPriceUnits_();
   const unit = units.find(u => u.toLowerCase() === String(req.unit || "").trim().toLowerCase());
   if (!unit) throw apiError_("INVALID", "Choose a unit: " + units.join(", ") + ".");
   if (!req.date) throw apiError_("INVALID", "Enter the date the price was gathered.");
   const date = apiParseDate_(req.date);
   return { location: location, price: Math.round(price * 100) / 100, size: size, unit: unit, date: date };
}

// Finds or creates the Price Item for req.item: { priceItemId } | { recordId } | { name }.
function apiPriceItemFor_(item, user) {
   item = item || {};
   const items = apiReadPriceItems_();
   if (item.priceItemId) {
      const hit = items.find(r => r["Price Item ID"] === item.priceItemId);
      if (!hit) throw apiError_("NOT_FOUND", "That item is no longer in the price tracker.");
      return { id: hit["Price Item ID"], created: false };
   }
   const sheet = apiPriceItemsSheet_();
   if (item.recordId) {
      const rid = String(item.recordId).trim();
      const hit = items.find(r => r["Record ID"] === rid);
      if (hit) return { id: hit["Price Item ID"], created: false };
      const rec = apiPriceRecord_(rid);
      if (!rec) throw apiError_("INVALID", rid + " doesn't exist.");
      const id = apiNextPriceId_(items, "Price Item ID", PRICE_CONFIG.itemPrefix);
      apiAppendRow_(sheet, { "Price Item ID": id, "Record ID": rid, "Item Name": "", "Added By": apiWho_(user), "Added At": new Date() });
      apiLog_(user, "Add", "Price Items", id, "Linked to " + rid);
      return { id: id, created: true };
   }
   const name = String(item.name || "").replace(/\s+/g, " ").trim();
   if (!name) throw apiError_("INVALID", "Choose or type an item.");
   const hit = items.find(r => !r["Record ID"] && String(r["Item Name"]).trim().toLowerCase() === name.toLowerCase());
   if (hit) return { id: hit["Price Item ID"], created: false };
   const id = apiNextPriceId_(items, "Price Item ID", PRICE_CONFIG.itemPrefix);
   apiAppendRow_(sheet, { "Price Item ID": id, "Record ID": "", "Item Name": name, "Added By": apiWho_(user), "Added At": new Date() });
   apiLog_(user, "Add", "Price Items", id, "Item Name: " + name);
   return { id: id, created: true };
}

function apiPriceValues_(p) {
   return { "Location": p.location, "Price": p.price, "Size": p.size, "Unit": p.unit, "Date Gathered": p.date };
}

// req: { item, location, price, size, unit, date }
function apiAddPrice_(req, user) {
   apiRequirePrices_(user);
   const p = apiCleanPrice_(req);
   p.location = apiEnsureVendor_(p.location, user);
   const item = apiPriceItemFor_(req.item, user);
   const sheet = apiPricesSheet_();
   const id = apiNextPriceId_(apiReadPrices_(), "Price ID", PRICE_CONFIG.pricePrefix);
   const values = Object.assign({ "Price ID": id, "Price Item ID": item.id }, apiPriceValues_(p), { "Added By": apiWho_(user), "Added At": new Date() });
   apiAppendRow_(sheet, values);
   apiLog_(user, "Add", "Prices", id + " / " + item.id, apiDescribe_(values));
   return { priceId: id, priceItemId: item.id };
}

// req: { priceId, location, price, size, unit, date }
function apiUpdatePrice_(req, user) {
   apiRequirePrices_(user);
   const rec = apiReadPrices_().find(r => r["Price ID"] === req.priceId);
   if (!rec) throw apiError_("NOT_FOUND", "That price no longer exists.");
   const p = apiCleanPrice_(req);
   p.location = apiEnsureVendor_(p.location, user);
   const changes = apiWriteChanges_(apiPricesSheet_(), rec._row, rec, apiPriceValues_(p));
   if (changes.length) apiLog_(user, "Edit", "Prices", rec["Price ID"] + " / " + rec["Price Item ID"], changes.join("; "));
   return { updated: changes.length };
}

// req: { priceId }  (permanent)
function apiDeletePrice_(req, user) {
   apiRequirePrices_(user);
   const rec = apiReadPrices_().find(r => r["Price ID"] === req.priceId);
   if (!rec) throw apiError_("NOT_FOUND", "That price no longer exists.");
   apiPricesSheet_().deleteRow(rec._row);
   apiLog_(user, "Delete", "Prices", rec["Price ID"] + " / " + rec["Price Item ID"],
           [rec["Location"], "$" + rec["Price"], rec["Size"] + " " + rec["Unit"], rec["Date Gathered"]].join(" · "));
   return { deleted: 1 };
}

// req: { priceItemId, name }  (typed items only; linked items take the record's name)
function apiUpdatePriceItem_(req, user) {
   apiRequirePrices_(user);
   const items = apiReadPriceItems_();
   const rec = items.find(r => r["Price Item ID"] === req.priceItemId);
   if (!rec) throw apiError_("NOT_FOUND", "That item is no longer in the price tracker.");
   if (rec["Record ID"]) throw apiError_("INVALID", "This item is linked to " + rec["Record ID"] + "; change its name on that record.");
   const name = String(req.name || "").replace(/\s+/g, " ").trim();
   if (!name) throw apiError_("INVALID", "Enter a name.");
   if (items.some(r => r !== rec && !r["Record ID"] && String(r["Item Name"]).trim().toLowerCase() === name.toLowerCase())) {
      throw apiError_("INVALID", "Another item is already called " + name + ".");
   }
   const changes = apiWriteChanges_(apiPriceItemsSheet_(), rec._row, rec, { "Item Name": name });
   if (changes.length) apiLog_(user, "Edit", "Price Items", rec["Price Item ID"], changes.join("; "));
   return { updated: changes.length };
}

// req: { priceItemId }  (permanent: the item and all its prices)
function apiDeletePriceItem_(req, user) {
   apiRequirePrices_(user);
   const rec = apiReadPriceItems_().find(r => r["Price Item ID"] === req.priceItemId);
   if (!rec) throw apiError_("NOT_FOUND", "That item is no longer in the price tracker.");
   const gone = apiDeleteRowsWhere_(apiSs_().getSheetByName(PRICE_CONFIG.pricesSheet), "Price Item ID", v => String(v) === rec["Price Item ID"]);
   // Receipt lines that pointed at this item would be left dangling (ReceiptLines.gs).
   const lines = apiRemoveReceiptLinesFor_("Price Item ID", rec["Price Item ID"]);
   apiPriceItemsSheet_().deleteRow(rec._row);
   apiTrashPricePicture_(rec, rec["Picture URL"]);
   apiLog_(user, "Delete", "Price Items", rec["Price Item ID"],
           (rec["Record ID"] || rec["Item Name"]) + " — also deleted " + gone.count + " price" + (gone.count === 1 ? "" : "s") +
           (lines ? " and " + lines + " receipt line" + (lines === 1 ? "" : "s") : ""));
   return { deleted: 1, prices: gone.count, lines: lines };
}

// Picture for a typed price item (linked items use their record's list picture).
// req: { priceItemId, photo: { data, mimeType } } to add or replace, or { priceItemId, remove: true }.
// A replaced or removed picture's file goes to the Drive trash.
function apiSetPriceItemPicture_(req, user) {
   apiRequirePrices_(user);
   const sheet = apiPriceItemsSheet_();
   const rec = apiReadPriceItems_().find(r => r["Price Item ID"] === req.priceItemId);
   if (!rec) throw apiError_("NOT_FOUND", "That item is no longer in the price tracker.");
   if (rec["Record ID"]) throw apiError_("INVALID", "This item uses the picture of " + rec["Record ID"] + "; change it on that record.");
   const old = String(rec["Picture URL"] || "");
   let url = "";
   if (!req.remove) {
      const fileId = apiSaveItemPhoto_(req.photo || {}, rec["Price Item ID"], rec["Item Name"], user);
      url = apiDrivePhotoUrl_(fileId);
   } else if (!old) {
      return { updated: 0 };
   }
   const changes = apiWriteChanges_(sheet, rec._row, rec, { "Picture URL": url });
   const trashed = apiTrashPricePicture_(rec, old);
   apiLog_(user, req.remove ? "Remove picture" : (old ? "Replace picture" : "Add picture"), "Price Items", rec["Price Item ID"],
           (rec["Item Name"] || "") + (trashed ? " — old picture moved to Drive trash" : ""));
   CacheService.getScriptCache().remove("item_photo_ids");
   return { url: url, updated: changes.length };
}

// Moves a price item's old picture file to the Drive trash, but only when it's safe:
// the item is a typed item (never one linked to a record), the file is in the Item Photos
// folder, and no record's list picture, record photo or other price item still uses it.
function apiTrashPricePicture_(rec, url) {
   if (rec["Record ID"]) return false;
   const fileId = apiDriveFileId_(url);
   if (!fileId || !apiIsItemPhotoFile_(fileId)) return false;
   const uses = u => apiDriveFileId_(u) === fileId;
   for (const t of ["species", "equipment", "plants", "medications"]) {
      if (apiReadTable_(t).rows.some(r => uses(r["Thumbnail URL"]))) return false;
   }
   if (apiActivePhotos_().some(r => uses(r["Photo URL"]))) return false;
   if (apiReadPriceItems_().some(r => r["Price Item ID"] !== rec["Price Item ID"] && uses(r["Picture URL"]))) return false;
   return apiTrashDriveFile_(fileId);
}

// When a species, equipment, plant or medication is permanently deleted, its price item goes too.
function apiDeletePricesForRecord_(recordId, user) {
   const rec = apiReadPriceItems_().find(r => r["Record ID"] === recordId);
   if (!rec) return 0;
   return apiDeletePriceItem_({ priceItemId: rec["Price Item ID"] }, user).prices + 1;
}
