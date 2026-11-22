// ============================================================
// AYERS AQUARIUMS - RECEIPTS
//
// Admins and Editors upload receipt photos from the app. Each photo
// is saved to the Receipts Drive folder and recorded on the
// "Receipts" tab. Admins later link a receipt to any number of
// tanks, species, equipment, plants or medications on the
// "Receipt Links" tab (one row per receipt + record pair).
//
// Nothing is deleted: receipts are retired (Status) and links are
// ended (Active unchecked + Date Unlinked).
// ============================================================

// Drive folder for receipt photos, tab names, ID prefix and photo size limit.
const RECEIPTS_CONFIG = {
   folderId: "13QTEGFAn5Nf-28d0K7Yl4QjwAso3vGpB",
   receiptsSheetName: "Receipts",
   linksSheetName: "Receipt Links",
   prefix: "RC-",
   maxImageBytes: 12 * 1024 * 1024,
   // PDF receipts (chosen from files) are stored as-is, up to this size.
   maxPdfBytes: 10 * 1024 * 1024
};

// Columns of the Receipts tab, in order.
const RECEIPT_HEADERS = ["Receipt ID", "File Name", "Vendor", "Purchase Date", "Total", "Notes",
                         "Photo Link", "Drive File ID", "Uploaded By", "Uploaded At", "Status"];
// Columns of the Receipt Links tab (one row per receipt + record pair).
const RECEIPT_LINK_HEADERS = ["Receipt ID", "Item ID", "Linked By", "Date Linked", "Date Unlinked", "Active"];

// Record types a receipt can be linked to.
const RECEIPT_LINK_TABLES = ["tanks", "species", "equipment", "plants", "medications"];


// Admins and editors can upload and view receipts.
function apiCanUseReceipts_(user) {
   return apiCan_(user, "receipts");
}

// Throws unless the person can use receipts.
function apiRequireReceipts_(user) {
   if (!apiCanUseReceipts_(user)) throw apiError_("FORBIDDEN", "Only admins and editors can use receipts.");
}


// ------------------------------------------------------------
// Tabs
// ------------------------------------------------------------
function apiEnsureReceiptTabs_() {
   const ss = apiSs_();
   // Receipts: one row per uploaded photo.
   let receipts = ss.getSheetByName(RECEIPTS_CONFIG.receiptsSheetName);
   if (!receipts) {
      receipts = ss.insertSheet(RECEIPTS_CONFIG.receiptsSheetName);
      receipts.getRange(1, 1, 1, RECEIPT_HEADERS.length).setValues([RECEIPT_HEADERS])
         .setFontWeight("bold").setBackground("#d9d9d9");
      receipts.setFrozenRows(1);
      receipts.getRange("D2:D").setNumberFormat("m/d/yyyy");
      receipts.getRange("E2:E").setNumberFormat("$#,##0.00");
      receipts.getRange("J2:J").setNumberFormat("m/d/yyyy h:mm am/pm");
      receipts.getRange("K2:K").setDataValidation(SpreadsheetApp.newDataValidation()
         .requireValueInList(["Active", "Retired"], true).setAllowInvalid(false).build());
      receipts.setColumnWidth(2, 260);
      receipts.setColumnWidth(6, 260);
      receipts.setColumnWidth(7, 220);
      receipts.setColumnWidth(9, 200);
   }
   // Receipt Links: which records each receipt belongs to.
   let links = ss.getSheetByName(RECEIPTS_CONFIG.linksSheetName);
   if (!links) {
      links = ss.insertSheet(RECEIPTS_CONFIG.linksSheetName);
      links.getRange(1, 1, 1, RECEIPT_LINK_HEADERS.length).setValues([RECEIPT_LINK_HEADERS])
         .setFontWeight("bold").setBackground("#d9d9d9");
      links.setFrozenRows(1);
      links.getRange("D2:E").setNumberFormat("m/d/yyyy");
      links.getRange("F2:F").insertCheckboxes();
      links.setColumnWidth(3, 200);
   }
   return { receipts: receipts, links: links };
}

// Reads a support tab into row objects (same shape as apiReadTable_).
function apiReadSheetRows_(sheet, keyField) {
   // apiGrid_ (Speed.gs) reads the tab, or takes it from bootstrap's one-request snapshot.
   const grid = apiGrid_(sheet);
   const values = grid.values, shown = grid.shown;
   if (values.length < 2) return [];
   const headers = values[0].map(h => String(h).trim());
   const tz = apiSs_().getSpreadsheetTimeZone();
   const rows = [];
   for (let r = 1; r < values.length; r++) {
      const obj = { _row: r + 1 };
      headers.forEach((h, c) => {
         if (!h || h in obj) return;
         const v = values[r][c];
         if (/ At$/.test(h) && v instanceof Date) obj[h] = Utilities.formatDate(v, tz, "yyyy-MM-dd HH:mm");
         else if (h === "Total" && typeof v === "number") obj[h] = v.toFixed(2);
         else obj[h] = v instanceof Date ? Utilities.formatDate(v, tz, "yyyy-MM-dd")
                     : (typeof v === "number" ? shown[r][c] : v);
      });
      if (String(obj[keyField] || "") !== "") rows.push(obj);
   }
   return rows;
}

// All rows of the Receipts tab.
function apiReadReceipts_() {
   return apiReadSheetRows_(apiEnsureReceiptTabs_().receipts, "Receipt ID");
}

// All rows of the Receipt Links tab.
function apiReadReceiptLinks_() {
   return apiReadSheetRows_(apiEnsureReceiptTabs_().links, "Receipt ID")
      .filter(r => r["Item ID"] !== "");
}

// Added to the bootstrap response for admins and editors.
function apiReceiptsBootstrap_(user, lists) {
   if (!apiCanUseReceipts_(user)) return {};
   return {
      receipts: apiReadReceipts_().map(r => { const o = Object.assign({}, r); delete o["Drive File ID"]; return o; }),
      receiptLinks: apiReadReceiptLinks_(),
      vendors: (lists && lists["Vendor"]) || []
   };
}


// ------------------------------------------------------------
// Upload (admins + editors)
// req: { receipt: { fileName, vendor, purchaseDate, total, notes },
//        image: { data: <base64>, mimeType } }
// ------------------------------------------------------------
function apiUploadReceipt_(req, user) {
   apiRequireReceipts_(user);
   const r = apiCleanReceipt_(req.receipt || {}, true);
   const img = req.image || {};
   if (!img.data) throw apiError_("INVALID", "Add a photo or PDF of the receipt.");
   // Check the file type and size: a photo, or a PDF (stored as-is).
   const isPdf = String(img.mimeType) === "application/pdf";
   const mimeType = isPdf ? "application/pdf" : /^image\/(jpeg|png|webp|gif|heic|heif)$/.test(String(img.mimeType)) ? img.mimeType : "image/jpeg";
   const bytes = Utilities.base64Decode(String(img.data).replace(/^data:[^,]*,/, ""));
   if (isPdf) {
      if (bytes.length > RECEIPTS_CONFIG.maxPdfBytes) throw apiError_("INVALID", "That PDF is larger than 10 MB.");
      if (String.fromCharCode.apply(null, bytes.slice(0, 5).map(b => b & 255)) !== "%PDF-") throw apiError_("INVALID", "That file isn't a PDF.");
   } else if (bytes.length > RECEIPTS_CONFIG.maxImageBytes) throw apiError_("INVALID", "That photo is too large.");

   // Item lines (optional, ReceiptLines.gs): checked before anything is saved.
   const lines = (req.lines || []).map(apiCleanReceiptLine_);
   lines.forEach(l => apiLineItemInfo_(l.item, user));   // every item is checked before anything is saved

   // Records can be assigned at upload time (optional): admins any record, editors items in their tanks.
   const itemIds = (req.itemIds || []).map(s => String(s).trim()).filter(Boolean);
   if (itemIds.length) {
      apiRequireLinkRights_(user, itemIds);
      apiCheckLinkTargets_(itemIds);
   }

   const ext = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
                 "image/heic": ".heic", "image/heif": ".heif", "application/pdf": ".pdf" }[mimeType];
   const fileName = apiFileNameWithExt_(r.fileName, ext);

   // Save the photo to the Receipts folder, then record it on the Receipts tab.
   const tabs = apiEnsureReceiptTabs_();
   const id = apiNextReceiptId_();
   const folder = DriveApp.getFolderById(RECEIPTS_CONFIG.folderId);
   const file = folder.createFile(Utilities.newBlob(bytes, mimeType, fileName));
   file.setDescription(id + " · uploaded by " + (user.name || user.email) + " (" + apiWho_(user) + ") via " + API_CONFIG.appName);

   if (r.vendor) r.vendor = apiEnsureVendor_(r.vendor, user);

   const values = {
      "Receipt ID": id, "File Name": fileName, "Vendor": r.vendor, "Purchase Date": r.purchaseDate,
      "Total": r.total, "Notes": r.notes, "Photo Link": file.getUrl(), "Drive File ID": file.getId(),
      "Uploaded By": apiWho_(user), "Uploaded At": new Date(), "Status": "Active"
   };
   apiAppendRow_(tabs.receipts, values);
   apiLog_(user, "Upload", "Receipts", id, apiDescribe_({ "File Name": fileName, "Vendor": r.vendor,
      "Purchase Date": r.purchaseDate, "Total": r.total, "Notes": r.notes }));
   const linked = itemIds.length ? apiAddReceiptLinks_(tabs, id, itemIds, user) : [];
   const lineResult = lines.length ? apiAddReceiptLines_(Object.assign({}, values, { "Purchase Date": r.purchaseDate ? Utilities.formatDate(r.purchaseDate instanceof Date ? r.purchaseDate : apiParseDate_(r.purchaseDate), apiSs_().getSpreadsheetTimeZone(), "yyyy-MM-dd") : "" }), lines, user) : null;
   return { added: { table: "receipts", id: id }, linked: linked.concat(lineResult ? lineResult.linked : []), notes: lineResult ? lineResult.notes : [] };
}


// ------------------------------------------------------------
// Photo (admins + editors) - returned through the API so editors
// don't need access to the Drive folder.
// ------------------------------------------------------------
function apiReceiptPhoto_(req, user) {
   apiRequireReceipts_(user);
   const rec = apiReadReceipts_().find(r => r["Receipt ID"] === req.id);
   if (!rec) throw apiError_("NOT_FOUND", "That receipt no longer exists.");
   if (!rec["Drive File ID"]) throw apiError_("NOT_FOUND", "That receipt has no photo.");
   let blob;
   try {
      blob = DriveApp.getFileById(rec["Drive File ID"]).getBlob();
   } catch (e) {
      throw apiError_("NOT_FOUND", "The photo couldn't be found in Drive (it may have been moved or deleted).");
   }
   return { image: { mimeType: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) } };
}


// ------------------------------------------------------------
// Edit details (admins). Renames the Drive file when the name changes.
// ------------------------------------------------------------
function apiUpdateReceipt_(req, user) {
   apiRequireCan_(user, "receipts");
   const tabs = apiEnsureReceiptTabs_();
   const rec = apiReadReceipts_().find(r => r["Receipt ID"] === req.id);
   if (!rec) throw apiError_("NOT_FOUND", "That receipt no longer exists.");
   const raw = req.receipt || {};
   // Only the fields that were sent are updated.
   const r = apiCleanReceipt_(Object.assign({ fileName: rec["File Name"] }, raw), false);
   const values = {};

   if ("fileName" in raw) {
      const oldExt = (String(rec["File Name"]).match(/\.[A-Za-z0-9]{2,5}$/) || [".jpg"])[0];
      values["File Name"] = apiFileNameWithExt_(r.fileName, oldExt);
   }
   if ("vendor" in raw) values["Vendor"] = r.vendor ? apiEnsureVendor_(r.vendor, user) : "";
   if ("purchaseDate" in raw) values["Purchase Date"] = r.purchaseDate;
   if ("total" in raw) values["Total"] = r.total;
   if ("notes" in raw) values["Notes"] = r.notes;

   const before = Object.assign({}, rec);
   if (typeof before["Total"] === "string" && before["Total"] !== "") before["Total"] = Number(before["Total"]).toFixed(2);
   const after = Object.assign({}, values);
   if (typeof after["Total"] === "number") after["Total"] = after["Total"].toFixed(2);
   // Compare as text, but write the real values.
   const changed = Object.keys(values).filter(k => apiShowValue_(before[k]) !== apiShowValue_(after[k]));
   const toWrite = {};
   changed.forEach(k => toWrite[k] = values[k]);
   const changes = apiWriteChanges_(tabs.receipts, rec._row, before, toWrite);

   if (toWrite["File Name"] && rec["Drive File ID"]) {
      try { DriveApp.getFileById(rec["Drive File ID"]).setName(toWrite["File Name"]); } catch (e) { /* file missing */ }
   }
   if (changes.length) apiLog_(user, "Edit", "Receipts", rec["Receipt ID"], changes.join("; "));
   // A new vendor or purchase date moves the prices its item lines created (ReceiptLines.gs).
   if (toWrite["Vendor"] !== undefined || toWrite["Purchase Date"] !== undefined) {
      const after = apiReadReceipts_().find(x => x["Receipt ID"] === rec["Receipt ID"]);
      if (after) apiRedoReceiptLines_(rec, after, user);
   }
   return { updated: changes.length };
}

// Retires (or, with req.restore, restores) a receipt (admins).
function apiRetireReceipt_(req, user) {
   apiRequireCan_(user, "retireRecords");
   const tabs = apiEnsureReceiptTabs_();
   const rec = apiReadReceipts_().find(r => r["Receipt ID"] === req.id);
   if (!rec) throw apiError_("NOT_FOUND", "That receipt no longer exists.");
   const status = req.restore ? "Active" : "Retired";
   const changes = apiWriteChanges_(tabs.receipts, rec._row, rec, { "Status": status });
   if (changes.length) apiLog_(user, req.restore ? "Restore" : "Retire", "Receipts", rec["Receipt ID"], changes.join("; "));
   return { updated: changes.length };
}


// ------------------------------------------------------------
// Links (admins; editors for items in their tanks, see apiRequireLinkRights_)
// ------------------------------------------------------------
function apiLinkReceipt_(req, user) {
   apiRequireReceipts_(user);
   const tabs = apiEnsureReceiptTabs_();
   const rec = apiReadReceipts_().find(r => r["Receipt ID"] === req.id);
   if (!rec) throw apiError_("NOT_FOUND", "That receipt no longer exists.");
   const itemIds = (req.itemIds || []).map(s => String(s).trim()).filter(Boolean);
   if (!itemIds.length) throw apiError_("INVALID", "Choose at least one record to link.");
   apiRequireLinkRights_(user, itemIds);
   apiCheckLinkTargets_(itemIds);
   return { linked: apiAddReceiptLinks_(tabs, rec["Receipt ID"], itemIds, user) };
}

// Who may link receipts to records: admins to any record; editors only to species,
// equipment or plants that are currently in one of their tanks (from the item's page).
function apiRequireLinkRights_(user, itemIds) {
   if (apiCan_(user, "allTanks")) return;
   if (!apiCan_(user, "receipts")) throw apiError_("FORBIDDEN", "Your role can't link receipts.");
   const inMyTanks = {};
   apiReadTable_("assignments").rows.forEach(a => {
      if (a["Active"] === true && !a["Date Removed"] && user.tanks.indexOf(a["Tank ID"]) !== -1) inMyTanks[a["Item ID"]] = true;
   });
   itemIds.forEach(id => {
      if (!inMyTanks[id]) throw apiError_("FORBIDDEN", id + " isn't in one of your tanks, so only an admin can link a receipt to it.");
   });
}

// Throws if any ID isn't a tank, species, equipment, plant or medication.
function apiCheckLinkTargets_(itemIds) {
   const known = {};
   RECEIPT_LINK_TABLES.forEach(t => apiReadTable_(t).rows.forEach(row => known[row[API_TABLES[t].id]] = true));
   itemIds.forEach(itemId => { if (!known[itemId]) throw apiError_("INVALID", itemId + " doesn't exist."); });
}

// Adds one Receipt Links row per new record; skips ones already linked.
function apiAddReceiptLinks_(tabs, receiptId, itemIds, user) {
   const active = {};
   apiReadReceiptLinks_().forEach(l => {
      if (l["Receipt ID"] === receiptId && l["Active"] === true && !l["Date Unlinked"]) active[l["Item ID"]] = true;
   });
   const added = [];
   itemIds.forEach(itemId => {
      if (active[itemId] || added.indexOf(itemId) !== -1) return;
      apiAppendRow_(tabs.links, { "Receipt ID": receiptId, "Item ID": itemId, "Linked By": apiWho_(user),
                                  "Date Linked": new Date(), "Active": true });
      added.push(itemId);
   });
   if (added.length) apiLog_(user, "Link receipt", "Receipt Links", receiptId, "Linked to: " + added.join(", "));
   return added;
}

// Ends one receipt-to-record link (admins): unchecks Active and sets Date Unlinked.
function apiUnlinkReceipt_(req, user) {
   apiRequireCan_(user, "receipts");
   const tabs = apiEnsureReceiptTabs_();
   const key = req.key || {};
   const link = apiReadReceiptLinks_().find(l => l._row === Number(key.row));
   if (!link || link["Receipt ID"] !== key.receiptId || link["Item ID"] !== key.itemId) {
      throw apiError_("STALE", "That link changed since you loaded it. Refresh and try again.");
   }
   if (link["Active"] !== true || link["Date Unlinked"]) throw apiError_("INVALID", "That link was already removed.");
   const changes = apiWriteChanges_(tabs.links, link._row, link, { "Date Unlinked": new Date(), "Active": false });
   apiLog_(user, "Unlink receipt", "Receipt Links", link["Receipt ID"] + " / " + link["Item ID"], changes.join("; "));
   return { updated: changes.length };
}


// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function apiCleanReceipt_(raw, isNew) {
   const out = {};
   out.fileName = String(raw.fileName || "").replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
   if (!out.fileName) throw apiError_("INVALID", "Please fill in: File name.");
   if (out.fileName.length > 150) throw apiError_("INVALID", "The file name is too long.");
   out.vendor = String(raw.vendor || "").replace(/\s+/g, " ").trim();
   out.notes = String(raw.notes || "").trim();
   out.purchaseDate = raw.purchaseDate ? apiParseDate_(raw.purchaseDate) : (isNew ? new Date() : "");
   const t = String(raw.total === undefined || raw.total === null ? "" : raw.total).replace(/[$,\s]/g, "");
   if (t !== "" && (isNaN(Number(t)) || Number(t) < 0)) throw apiError_("INVALID", "Total must be an amount like 24.99.");
   out.total = t === "" ? "" : Math.round(Number(t) * 100) / 100;
   return out;
}

// The file name with the photo's extension (any old image extension replaced).
function apiFileNameWithExt_(name, ext) {
   const base = String(name).replace(/\.(jpe?g|png|webp|gif|heic|heif|pdf)$/i, "").trim();
   return base + ext;
}

// A value as text for comparing old and new (dates as yyyy-MM-dd).
function apiShowValue_(v) {
   const tz = apiSs_().getSpreadsheetTimeZone();
   return v instanceof Date ? Utilities.formatDate(v, tz, "yyyy-MM-dd") : (v === undefined || v === null ? "" : String(v));
}

// Next receipt ID, e.g. RC-12.
function apiNextReceiptId_() {
   const max = apiReadReceipts_().reduce((m, r) => {
      const n = Number(String(r["Receipt ID"]).replace(/^\D+/, ""));
      return isNaN(n) ? m : Math.max(m, n);
   }, 0);
   return RECEIPTS_CONFIG.prefix + (max + 1);
}

// Returns the vendor as spelled on the Vendor list, adding it if it's new.
// Used by every place a vendor can be typed: receipts (upload and edit), wishlist (add,
// edit, Mark purchased) and the price tracker (add and edit a price).
// The Vendor list on DropDownOptions is built by a formula from the Lookups tab, so new
// vendors always go into Lookups. Nothing is ever written into DropDownOptions itself:
// a value typed under the formula blocks it and the whole list shows #REF!.
function apiEnsureVendor_(vendor, user) {
   vendor = String(vendor || "").replace(/\s+/g, " ").trim();
   if (!vendor) return vendor;
   if (apiSs_().getSheetByName("Lookups")) return apiEnsureLookupValue_("Vendor", vendor, user);
   // No Lookups tab: leave the list alone rather than risk breaking it.
   return vendor;
}

// Adds a value to a Lookups-tab list (Lookup Type, Value, Description, Inactive) unless it's there;
// a matching inactive value is switched back on. Returns the value as stored.
function apiEnsureLookupValue_(type, value, user) {
   const lk = apiSs_().getSheetByName("Lookups");
   if (!lk) return value;
   const values = lk.getDataRange().getValues();
   for (let i = 1; i < values.length; i++) {
      if (String(values[i][0]).trim() === type && String(values[i][1]).trim().toLowerCase() === value.toLowerCase()) {
         if (values[i][3] === true) { lk.getRange(i + 1, 4).setValue(false); apiLog_(user, "Edit", "Lookups", type, "Turned back on: " + values[i][1]); }
         return String(values[i][1]).trim();
      }
   }
   let last = values.length;
   while (last > 1 && String(values[last - 1][0]).trim() === "") last--;
   if (last + 1 > lk.getMaxRows()) lk.insertRowAfter(lk.getMaxRows());
   lk.getRange(last + 1, 1, 1, 4).setValues([[type, value, "", false]]);
   apiLog_(user, "Add", "Lookups", type, "New " + type.toLowerCase() + ": " + value);
   return value;
}
