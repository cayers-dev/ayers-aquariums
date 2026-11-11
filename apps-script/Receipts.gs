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

const RECEIPTS_CONFIG = {
   folderId: "13QTEGFAn5Nf-28d0K7Yl4QjwAso3vGpB",
   receiptsSheetName: "Receipts",
   linksSheetName: "Receipt Links",
   prefix: "RC-",
   maxImageBytes: 12 * 1024 * 1024
};

const RECEIPT_HEADERS = ["Receipt ID", "File Name", "Vendor", "Purchase Date", "Total", "Notes",
                         "Photo Link", "Drive File ID", "Uploaded By", "Uploaded At", "Status"];
const RECEIPT_LINK_HEADERS = ["Receipt ID", "Item ID", "Linked By", "Date Linked", "Date Unlinked", "Active"];

// Record types a receipt can be linked to.
const RECEIPT_LINK_TABLES = ["tanks", "species", "equipment", "plants", "medications"];


// ------------------------------------------------------------
// Run once from the editor: creates the two tabs and asks for
// the Google Drive permission.
// ------------------------------------------------------------
function receiptsSetup() {
   apiEnsureReceiptTabs_();
   const folder = DriveApp.getFolderById(RECEIPTS_CONFIG.folderId);
   Logger.log("Receipts setup complete. Uploads go to: " + folder.getName());
}


function apiCanUseReceipts_(user) {
   return user.role === "Admin" || user.role === "Editor";
}

function apiRequireReceipts_(user) {
   if (!apiCanUseReceipts_(user)) throw apiError_("FORBIDDEN", "Only admins and editors can use receipts.");
}


// ------------------------------------------------------------
// Tabs
// ------------------------------------------------------------
function apiEnsureReceiptTabs_() {
   const ss = apiSs_();
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
   const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
   if (lastRow < 2 || lastCol < 1) return [];
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
         if (h === "Uploaded At" && v instanceof Date) obj[h] = Utilities.formatDate(v, tz, "yyyy-MM-dd HH:mm");
         else if (h === "Total" && typeof v === "number") obj[h] = v.toFixed(2);
         else obj[h] = v instanceof Date ? Utilities.formatDate(v, tz, "yyyy-MM-dd")
                     : (typeof v === "number" ? shown[r][c] : v);
      });
      if (String(obj[keyField] || "") !== "") rows.push(obj);
   }
   return rows;
}

function apiReadReceipts_() {
   return apiReadSheetRows_(apiEnsureReceiptTabs_().receipts, "Receipt ID");
}

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
   if (!img.data) throw apiError_("INVALID", "Add a photo of the receipt.");
   const mimeType = /^image\/(jpeg|png|webp|gif|heic|heif)$/.test(String(img.mimeType)) ? img.mimeType : "image/jpeg";
   const bytes = Utilities.base64Decode(String(img.data).replace(/^data:[^,]*,/, ""));
   if (bytes.length > RECEIPTS_CONFIG.maxImageBytes) throw apiError_("INVALID", "That photo is too large.");

   const ext = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
                 "image/heic": ".heic", "image/heif": ".heif" }[mimeType];
   const fileName = apiFileNameWithExt_(r.fileName, ext);

   const tabs = apiEnsureReceiptTabs_();
   const id = apiNextReceiptId_();
   const folder = DriveApp.getFolderById(RECEIPTS_CONFIG.folderId);
   const file = folder.createFile(Utilities.newBlob(bytes, mimeType, fileName));
   file.setDescription(id + " · uploaded by " + user.email + " via " + API_CONFIG.appName);

   if (r.vendor) r.vendor = apiEnsureVendor_(r.vendor, user);

   const values = {
      "Receipt ID": id, "File Name": fileName, "Vendor": r.vendor, "Purchase Date": r.purchaseDate,
      "Total": r.total, "Notes": r.notes, "Photo Link": file.getUrl(), "Drive File ID": file.getId(),
      "Uploaded By": user.email, "Uploaded At": new Date(), "Status": "Active"
   };
   apiAppendRow_(tabs.receipts, values);
   apiLog_(user, "Upload", "Receipts", id, apiDescribe_({ "File Name": fileName, "Vendor": r.vendor,
      "Purchase Date": r.purchaseDate, "Total": r.total, "Notes": r.notes }));
   return { added: { table: "receipts", id: id } };
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
   apiRequireAdmin_(user);
   const tabs = apiEnsureReceiptTabs_();
   const rec = apiReadReceipts_().find(r => r["Receipt ID"] === req.id);
   if (!rec) throw apiError_("NOT_FOUND", "That receipt no longer exists.");
   const raw = req.receipt || {};
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
   return { updated: changes.length };
}

function apiRetireReceipt_(req, user) {
   apiRequireAdmin_(user);
   const tabs = apiEnsureReceiptTabs_();
   const rec = apiReadReceipts_().find(r => r["Receipt ID"] === req.id);
   if (!rec) throw apiError_("NOT_FOUND", "That receipt no longer exists.");
   const status = req.restore ? "Active" : "Retired";
   const changes = apiWriteChanges_(tabs.receipts, rec._row, rec, { "Status": status });
   if (changes.length) apiLog_(user, req.restore ? "Restore" : "Retire", "Receipts", rec["Receipt ID"], changes.join("; "));
   return { updated: changes.length };
}


// ------------------------------------------------------------
// Links (admins)
// ------------------------------------------------------------
function apiLinkReceipt_(req, user) {
   apiRequireAdmin_(user);
   const tabs = apiEnsureReceiptTabs_();
   const rec = apiReadReceipts_().find(r => r["Receipt ID"] === req.id);
   if (!rec) throw apiError_("NOT_FOUND", "That receipt no longer exists.");
   const itemIds = (req.itemIds || []).map(s => String(s).trim()).filter(Boolean);
   if (!itemIds.length) throw apiError_("INVALID", "Choose at least one record to link.");

   const known = {};
   RECEIPT_LINK_TABLES.forEach(t => apiReadTable_(t).rows.forEach(row => known[row[API_TABLES[t].id]] = true));
   const active = {};
   apiReadReceiptLinks_().forEach(l => {
      if (l["Receipt ID"] === rec["Receipt ID"] && l["Active"] === true && !l["Date Unlinked"]) active[l["Item ID"]] = true;
   });

   const added = [];
   itemIds.forEach(itemId => {
      if (!known[itemId]) throw apiError_("INVALID", itemId + " doesn't exist.");
      if (active[itemId] || added.indexOf(itemId) !== -1) return;
      apiAppendRow_(tabs.links, { "Receipt ID": rec["Receipt ID"], "Item ID": itemId, "Linked By": user.email,
                                  "Date Linked": new Date(), "Active": true });
      added.push(itemId);
   });
   if (added.length) apiLog_(user, "Link receipt", "Receipt Links", rec["Receipt ID"], "Linked to: " + added.join(", "));
   return { linked: added };
}

function apiUnlinkReceipt_(req, user) {
   apiRequireAdmin_(user);
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

function apiFileNameWithExt_(name, ext) {
   const base = String(name).replace(/\.(jpe?g|png|webp|gif|heic|heif)$/i, "").trim();
   return base + ext;
}

function apiShowValue_(v) {
   const tz = apiSs_().getSpreadsheetTimeZone();
   return v instanceof Date ? Utilities.formatDate(v, tz, "yyyy-MM-dd") : (v === undefined || v === null ? "" : String(v));
}

function apiNextReceiptId_() {
   const max = apiReadReceipts_().reduce((m, r) => {
      const n = Number(String(r["Receipt ID"]).replace(/^\D+/, ""));
      return isNaN(n) ? m : Math.max(m, n);
   }, 0);
   return RECEIPTS_CONFIG.prefix + (max + 1);
}

// Returns the vendor as spelled on the Vendor list, adding it to the
// list (DropDownOptions, "Vendor" column) if it's new.
function apiEnsureVendor_(vendor, user) {
   const sheet = apiSs_().getSheetByName("DropDownOptions");
   if (!sheet) return vendor;
   const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
   const col = headers.indexOf("Vendor") + 1;
   if (!col) return vendor;
   const lastRow = Math.max(sheet.getLastRow(), 1);
   const values = sheet.getRange(1, col, lastRow, 1).getValues().map(r => String(r[0]).trim());
   for (let i = 1; i < values.length; i++) {
      if (values[i].toLowerCase() === vendor.toLowerCase()) return values[i];
   }
   let last = 0;
   values.forEach((v, i) => { if (i > 0 && v !== "") last = i; });
   const target = last + 2;
   if (target > sheet.getMaxRows()) sheet.insertRowAfter(sheet.getMaxRows());
   sheet.getRange(target, col).setValue(vendor);
   apiLog_(user, "Add", "DropDownOptions", "Vendor", "New vendor: " + vendor);
   return vendor;
}
