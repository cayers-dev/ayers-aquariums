// ============================================================
// AYERS AQUARIUMS - WISHLIST
//
// A wished-for species, plant or piece of equipment is a normal row in
// its own tab (Species / Plants / Equipment) with Status "Wishlist".
// Each tank it's wished for gets a Tank Assignments row that isn't
// active yet (Active unchecked, no Date Added) and carries the Wish ID.
// "Mark purchased" turns those rows into real, active assignments.
//
// Tabs:
//   Wishlist              one row per wish (priority, price, links...)
//   Compatibility Checks  AI verdict per wish + tank (latest = Current)
//
// Photos uploaded for wishlist items go to the "Item Photos" Drive
// folder (next to the Receipts folder) and are shown in the app through
// this script, so they stay private to app users.
//
// Nothing is deleted: wishes are closed ("Not getting") and their
// tank rows get a Date Removed.
// ============================================================

const WISH_CONFIG = {
   sheetName: "Wishlist",
   compatSheetName: "Compatibility Checks",
   prefix: "WL-",
   photosFolderName: "Item Photos",
   types: ["species", "plants", "equipment"],
   priorities: ["High", "Medium", "Low"],
   statuses: ["Researching", "Want", "Purchased", "Not getting"],
   verdicts: ["Good", "Caution", "Not recommended"]
};

const WISH_HEADERS = ["Wish ID", "Item ID", "Item Type", "New Item", "Priority", "Estimated Price", "Vendor", "Link",
                      "Wish Status", "Notes", "Purchase Date", "Price Paid", "Receipt ID", "Added By", "Added At", "Closed At"];
const COMPAT_HEADERS = ["Wish ID", "Item ID", "Tank ID", "Wished Tank", "Verdict", "Reasons", "Checked At", "Checked By", "Current"];


// Run once from the editor (safe to run again).
function wishlistSetup() {
   const tabs = apiEnsureWishTabs_();
   const col = apiEnsureWishColumn_();
   const added = apiEnsureWishlistStatus_();
   const folder = apiItemPhotosFolder_();
   Logger.log("Wishlist tabs: " + tabs.wishes.getName() + ", " + tabs.compat.getName() +
              ". Tank Assignments column " + col + " = Wish ID. Status option 'Wishlist' " + (added ? "added" : "already there") +
              ". Photos folder: " + folder.getName() + " (" + folder.getId() + ").");
}


// ------------------------------------------------------------
// Tabs, columns, folder
// ------------------------------------------------------------
function apiEnsureWishTabs_() {
   const ss = apiSs_();
   let wishes = ss.getSheetByName(WISH_CONFIG.sheetName);
   if (!wishes) {
      wishes = ss.insertSheet(WISH_CONFIG.sheetName);
      wishes.getRange(1, 1, 1, WISH_HEADERS.length).setValues([WISH_HEADERS]).setFontWeight("bold").setBackground("#d9d9d9");
      wishes.setFrozenRows(1);
      wishes.getRange("D2:D").insertCheckboxes();
      wishes.getRange("E2:E").setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(WISH_CONFIG.priorities, true).build());
      wishes.getRange("F2:F").setNumberFormat("$#,##0.00");
      wishes.getRange("I2:I").setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(WISH_CONFIG.statuses, true).build());
      wishes.getRange("K2:K").setNumberFormat("m/d/yyyy");
      wishes.getRange("L2:L").setNumberFormat("$#,##0.00");
      wishes.getRange("O2:P").setNumberFormat("m/d/yyyy h:mm am/pm");
      wishes.setColumnWidth(8, 220); wishes.setColumnWidth(10, 260);
   }
   let compat = ss.getSheetByName(WISH_CONFIG.compatSheetName);
   if (!compat) {
      compat = ss.insertSheet(WISH_CONFIG.compatSheetName);
      compat.getRange(1, 1, 1, COMPAT_HEADERS.length).setValues([COMPAT_HEADERS]).setFontWeight("bold").setBackground("#d9d9d9");
      compat.setFrozenRows(1);
      compat.getRange("D2:D").insertCheckboxes();
      compat.getRange("G2:G").setNumberFormat("m/d/yyyy h:mm am/pm");
      compat.getRange("I2:I").insertCheckboxes();
      compat.setColumnWidth(6, 520);
   }
   return { wishes: wishes, compat: compat };
}

// Adds the "Wish ID" column to Tank Assignments (after the last header).
function apiEnsureWishColumn_() {
   const sheet = apiSheet_("tankAssignments");
   const hm = apiHeaderMap_(sheet);
   if (hm.map["wish id"]) return hm.map["wish id"];
   const headers = sheet.getRange(1, 1, 1, hm.lastCol).getValues()[0];
   let last = 0;
   headers.forEach((h, i) => { if (String(h).trim() !== "") last = i + 1; });
   const col = last + 1;
   if (col > sheet.getMaxColumns()) sheet.insertColumnAfter(sheet.getMaxColumns());
   sheet.getRange(1, last || 1, 1, 1).copyTo(sheet.getRange(1, col), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
   sheet.getRange(1, col).setValue("Wish ID");
   return col;
}

// Adds "Wishlist" to the Status list on DropDownOptions.
function apiEnsureWishlistStatus_() {
   const sheet = apiSs_().getSheetByName("DropDownOptions");
   if (!sheet) return false;
   const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
   const col = headers.indexOf("Status") + 1;
   if (!col) return false;
   const values = sheet.getRange(1, col, Math.max(sheet.getLastRow(), 1), 1).getValues().map(r => String(r[0]).trim());
   if (values.slice(1).some(v => v.toLowerCase() === "wishlist")) return false;
   let last = 0;
   values.forEach((v, i) => { if (i > 0 && v !== "") last = i; });
   const target = last + 2;
   if (target > sheet.getMaxRows()) sheet.insertRowAfter(sheet.getMaxRows());
   sheet.getRange(target, col).setValue("Wishlist");
   return true;
}

function apiItemPhotosFolder_() {
   const props = PropertiesService.getScriptProperties();
   const id = props.getProperty("ITEM_PHOTOS_FOLDER_ID");
   if (id) {
      try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ }
   }
   const receipts = DriveApp.getFolderById(RECEIPTS_CONFIG.folderId);
   const parents = receipts.getParents();
   const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
   const existing = parent.getFoldersByName(WISH_CONFIG.photosFolderName);
   const folder = existing.hasNext() ? existing.next() : parent.createFolder(WISH_CONFIG.photosFolderName);
   props.setProperty("ITEM_PHOTOS_FOLDER_ID", folder.getId());
   return folder;
}


// ------------------------------------------------------------
// Reading
// ------------------------------------------------------------
function apiReadWishes_() {
   return apiReadSheetRows_(apiEnsureWishTabs_().wishes, "Wish ID");
}

function apiReadCompat_(currentOnly) {
   return apiReadSheetRows_(apiEnsureWishTabs_().compat, "Wish ID")
      .filter(r => !currentOnly || r["Current"] === true);
}

function apiFindWish_(id) {
   const w = apiReadWishes_().find(r => r["Wish ID"] === id);
   if (!w) throw apiError_("NOT_FOUND", "That wish no longer exists.");
   return w;
}

const apiIsPendingWishRow_ = a => !!a["Wish ID"] && a["Active"] !== true && !a["Date Added"] && !a["Date Removed"];

function apiPendingWishRows_(wishId, assignments) {
   return (assignments || apiReadTable_("assignments").rows).filter(a => a["Wish ID"] === wishId && apiIsPendingWishRow_(a));
}

const apiWishIsOpen_ = w => ["Purchased", "Not getting"].indexOf(String(w["Wish Status"])) === -1;

// Added to the bootstrap. Non-admins see wishes they added or that are
// for one of their tanks, and only their tanks' compatibility results.
function apiWishBootstrap_(user, assignments) {
   let wishes = apiReadWishes_();
   let compat = apiReadCompat_(true);
   if (user.role !== "Admin") {
      const mine = {};
      user.tanks.forEach(t => mine[t] = true);
      const forMyTank = {};
      (assignments || []).forEach(a => { if (a["Wish ID"] && mine[a["Tank ID"]]) forMyTank[a["Wish ID"]] = true; });
      wishes = wishes.filter(w => w["Added By"] === apiWho_(user) || forMyTank[w["Wish ID"]]);
      const visible = {};
      wishes.forEach(w => visible[w["Wish ID"]] = true);
      compat = compat.filter(c => visible[c["Wish ID"]] && mine[c["Tank ID"]]);
   }
   return { wishes: wishes, compat: compat,
            wishOptions: { priorities: WISH_CONFIG.priorities, statuses: WISH_CONFIG.statuses } };
}


// ------------------------------------------------------------
// Permissions
// ------------------------------------------------------------
function apiRequireWishUser_(user) {
   if (user.role !== "Admin" && user.role !== "Editor") throw apiError_("FORBIDDEN", "Only admins and editors can change the wishlist.");
}

// Admins, the person who added the wish, or an editor of one of its tanks.
function apiCanManageWish_(user, wish, pendingTanks) {
   if (user.role === "Admin") return true;
   if (user.role !== "Editor") return false;
   if (wish["Added By"] === apiWho_(user)) return true;
   return pendingTanks.some(t => user.tanks.indexOf(t) !== -1);
}

// Editors can edit the details of a Wishlist item they added.
function apiCanEditWishItem_(user, table, record) {
   if (user.role === "Admin") return true;
   if (user.role !== "Editor" || WISH_CONFIG.types.indexOf(table) === -1) return false;
   if (String(record["Status"]) !== "Wishlist") return false;
   const id = record[API_TABLES[table].id];
   return apiReadWishes_().some(w => w["Item ID"] === id && w["New Item"] === true && w["Added By"] === apiWho_(user));
}

function apiCleanWishTanks_(list, user) {
   const tanks = apiReadTable_("tanks").rows;
   const out = [];
   (Array.isArray(list) ? list : []).map(s => String(s).trim()).filter(Boolean).forEach(id => {
      if (out.indexOf(id) !== -1) return;
      if (!tanks.some(t => t["Tank ID"] === id)) throw apiError_("INVALID", "Tank " + id + " doesn't exist.");
      if (!apiCanEditTank_(user, id)) throw apiError_("FORBIDDEN", "You can't add wishes for " + id + " " + apiTankName_(id) + ".");
      out.push(id);
   });
   return out;
}

// Cleans the wish fields that were sent (keys missing from raw are skipped).
function apiCleanWish_(raw, isNew) {
   raw = raw || {};
   const out = {};
   const has = k => isNew || Object.prototype.hasOwnProperty.call(raw, k);
   const money = (v, label) => {
      const t = String(v === undefined || v === null ? "" : v).replace(/[$,\s]/g, "");
      if (t === "") return "";
      if (isNaN(Number(t)) || Number(t) < 0) throw apiError_("INVALID", label + " must be an amount like 24.99.");
      return Math.round(Number(t) * 100) / 100;
   };
   if (has("priority")) {
      const p = String(raw.priority || "").trim();
      if (p && WISH_CONFIG.priorities.indexOf(p) === -1) throw apiError_("INVALID", "Priority must be High, Medium or Low.");
      out["Priority"] = p || (isNew ? "Medium" : "");
   }
   if (has("estimatedPrice")) out["Estimated Price"] = money(raw.estimatedPrice, "Estimated price");
   if (has("vendor")) out["Vendor"] = String(raw.vendor || "").replace(/\s+/g, " ").trim();
   if (has("link")) {
      const l = String(raw.link || "").trim();
      if (l && !/^https?:\/\/\S+$/i.test(l)) throw apiError_("INVALID", "The link must start with http:// or https://");
      out["Link"] = l;
   }
   if (has("status")) {
      const s = String(raw.status || "").trim() || (isNew ? "Want" : "");
      if (["Researching", "Want"].indexOf(s) === -1) throw apiError_("INVALID", "Wish status must be Researching or Want here.");
      out["Wish Status"] = s;
   }
   if (has("notes")) out["Notes"] = String(raw.notes || "").trim();
   return out;
}

function apiItemTitle_(type, r) {
   if (type === "equipment") return [r["Manufacturer"], r["Filter Model"]].filter(Boolean).join(" ") || r["Category"] || r["Equipment ID"];
   return r["Common Name"] || r[API_TABLES[type].id];
}


// ------------------------------------------------------------
// Photos
// ------------------------------------------------------------
function apiDrivePhotoUrl_(fileId) {
   return "https://drive.google.com/file/d/" + fileId + "/view";
}

function apiSaveItemPhoto_(photo, itemId, title, user) {
   const mimeType = /^image\/(jpeg|png|webp)$/.test(String(photo.mimeType)) ? photo.mimeType : "image/jpeg";
   const bytes = Utilities.base64Decode(String(photo.data || "").replace(/^data:[^,]*,/, ""));
   if (!bytes.length) throw apiError_("INVALID", "The photo is empty.");
   if (bytes.length > 12 * 1024 * 1024) throw apiError_("INVALID", "That photo is too large.");
   const ext = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" }[mimeType];
   const name = (itemId + " " + String(title || "")).replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140) + ext;
   const file = apiItemPhotosFolder_().createFile(Utilities.newBlob(bytes, mimeType, name));
   file.setDescription(itemId + " · uploaded by " + (user.name || user.email) + " (" + apiWho_(user) + ") via " + API_CONFIG.appName);
   CacheService.getScriptCache().remove("item_photo_ids");
   return file.getId();
}

function apiAddImageCredit_(itemId, name, photo) {
   const sheet = apiSs_().getSheetByName("Image Credits");
   if (!sheet) return;
   apiAppendRow_(sheet, {
      "Species ID": itemId, "Common Name": name, "Image File": photo.file, "Source Page URL": photo.page,
      "Direct Image URL": photo.url, "Author": photo.author, "License": photo.license,
      "Modifications": "Resized for thumbnail; no content changes.",
      "Notes": "Found automatically through Wikipedia when added to the wishlist."
   });
}

// Only a Commons "Special:FilePath" image found by Fill with AI is accepted from the app.
function apiCleanCommonsPhoto_(p) {
   if (!p || !/^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\/\S+$/.test(String(p.url || ""))) return null;
   const s = v => String(v || "").slice(0, 300);
   return { url: s(p.url), file: s(p.file), page: /^https:\/\/commons\.wikimedia\.org\//.test(String(p.page)) ? s(p.page) : "",
            author: s(p.author), license: s(p.license) };
}

// req: { fileId } -> the photo, only if some item uses it as its thumbnail.
function apiItemPhoto_(req, user) {
   const fileId = String(req.fileId || "");
   if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) throw apiError_("BAD_REQUEST", "Unknown photo.");
   const cache = CacheService.getScriptCache();
   let ids = cache.get("item_photo_ids");
   if (!ids) {
      const found = [];
      WISH_CONFIG.types.forEach(t => apiReadTable_(t).rows.forEach(r => {
         const m = String(r["Thumbnail URL"] || "").match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/);
         if (m) found.push(m[1]);
      }));
      ids = found.join(",");
      cache.put("item_photo_ids", ids, 300);
   }
   if (("," + ids + ",").indexOf("," + fileId + ",") === -1) throw apiError_("NOT_FOUND", "That photo isn't used by any item.");
   let blob;
   try { blob = DriveApp.getFileById(fileId).getBlob(); } catch (e) {
      throw apiError_("NOT_FOUND", "The photo couldn't be found in Drive (it may have been moved or deleted).");
   }
   return { image: { mimeType: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) } };
}


// ------------------------------------------------------------
// Add a wish
// req: { itemType, itemId? (reuse an existing species/plant),
//        values: { item fields } (new item), tanks: [Tank IDs],
//        wish: { priority, estimatedPrice, vendor, link, status, notes },
//        photo?: { data, mimeType }, thumbnail?: { url, file, page, author, license } }
// ------------------------------------------------------------
function apiAddWish_(req, user) {
   apiRequireWishUser_(user);
   const type = req.itemType;
   if (WISH_CONFIG.types.indexOf(type) === -1) throw apiError_("INVALID", "Choose species, plant or equipment.");
   const values = req.values || {};
   // Look for a free photo before taking the write lock (it calls Wikipedia).
   let commons = null;
   if (!req.itemId && !(req.photo && req.photo.data) && !String(values["Thumbnail URL"] || "").trim()) {
      commons = apiCleanCommonsPhoto_(req.thumbnail) ||
                aiFindPhoto_(type, [values["Scientific Name"], values["Common Name"]]);
   }
   return apiWrite_(() => apiAddWishLocked_(req, user, type, commons));
}

function apiAddWishLocked_(req, user, type, commons) {
   apiEnsureWishColumn_();
   const tabs = apiEnsureWishTabs_();
   const def = API_TABLES[type];
   const sheet = apiSheet_(def.sheetKey);
   const tanks = apiCleanWishTanks_(req.tanks, user);
   if (user.role !== "Admin" && !tanks.length) throw apiError_("INVALID", "Check at least one of your tanks.");
   const wishVals = apiCleanWish_(req.wish, true);
   const assignments = apiReadTable_("assignments").rows;
   let itemId, rec, newItem = false;

   if (req.itemId) {
      if (type === "equipment") throw apiError_("INVALID", "An equipment wish always adds a new piece of equipment.");
      rec = apiFindById_(type, req.itemId);
      if (!rec) throw apiError_("NOT_FOUND", req.itemId + " doesn't exist.");
      itemId = req.itemId;
      const open = apiReadWishes_().find(w => w["Item ID"] === itemId && apiWishIsOpen_(w));
      if (open) throw apiError_("INVALID", itemId + " " + apiItemTitle_(type, rec) + " is already on the wishlist (" + open["Wish ID"] + "). Edit that wish to add tanks.");
   } else {
      const vals = apiCleanValues_(type, req.values || {});
      delete vals[def.id];
      apiCheckRequired_(def, vals);
      if (type !== "equipment") {
         const norm = s => String(s || "").trim().toLowerCase();
         const dupe = apiReadTable_(type).rows.find(r =>
            (vals["Common Name"] && norm(r["Common Name"]) === norm(vals["Common Name"])) ||
            (vals["Scientific Name"] && norm(r["Scientific Name"]) === norm(vals["Scientific Name"])));
         if (dupe) throw apiError_("DUPLICATE", dupe[def.id] + " " + apiItemTitle_(type, dupe) + " is already in your " + def.label +
                                   " list. Choose it instead of adding a new one.", { itemId: dupe[def.id] });
      }
      itemId = apiNextId_(type);
      vals[def.id] = itemId;
      vals["Status"] = "Wishlist";
      apiAppendRow_(sheet, vals);
      apiLog_(user, "Add (wishlist)", def.label, itemId, apiDescribe_(vals));
      rec = apiFindById_(type, itemId);
      newItem = true;
   }

   tanks.forEach(t => {
      if (assignments.some(a => a["Tank ID"] === t && a["Item ID"] === itemId && a["Active"] === true && !a["Date Removed"])) {
         throw apiError_("INVALID", itemId + " is already in " + t + " " + apiTankName_(t) + ".");
      }
   });

   // Photo: an uploaded one, else (new items) a free Wikipedia/Commons one.
   const title = apiItemTitle_(type, rec);
   if (req.photo && req.photo.data) {
      const fileId = apiSaveItemPhoto_(req.photo, itemId, title, user);
      if (!String(rec["Thumbnail URL"] || "").trim()) {
         apiWriteChanges_(sheet, rec._row, rec, { "Thumbnail URL": apiDrivePhotoUrl_(fileId) });
      }
   } else if (newItem && commons) {
      apiWriteChanges_(sheet, rec._row, rec, { "Thumbnail URL": commons.url });
      apiAddImageCredit_(itemId, title, commons);
   }

   if (wishVals["Vendor"]) wishVals["Vendor"] = apiEnsureVendor_(wishVals["Vendor"], user);
   const wishId = apiNextSeqId_(apiReadWishes_(), "Wish ID", WISH_CONFIG.prefix);
   apiAppendRow_(tabs.wishes, Object.assign({
      "Wish ID": wishId, "Item ID": itemId, "Item Type": type, "New Item": newItem,
      "Added By": apiWho_(user), "Added At": new Date()
   }, wishVals));

   const aSheet = apiSheet_("tankAssignments");
   tanks.forEach(t => apiAppendRow_(aSheet, { "Tank ID": t, "Item ID": itemId, "Active": false, "Wish ID": wishId }));
   apiLog_(user, "Add wish", "Wishlist", wishId + " / " + itemId,
           apiDescribe_(Object.assign({ "Tanks": tanks.join(", ") }, wishVals)));
   return { wishId: wishId, itemId: itemId };
}


// ------------------------------------------------------------
// Edit a wish: req { wishId, wish: {...}, tanks?: [Tank IDs] }
// ------------------------------------------------------------
function apiUpdateWish_(req, user) {
   apiRequireWishUser_(user);
   apiEnsureWishColumn_();
   const tabs = apiEnsureWishTabs_();
   const wish = apiFindWish_(req.wishId);
   const pending = apiPendingWishRows_(wish["Wish ID"]);
   const pendingTanks = pending.map(a => a["Tank ID"]);
   if (!apiCanManageWish_(user, wish, pendingTanks)) throw apiError_("FORBIDDEN", "You can't change this wish.");
   const vals = apiCleanWish_(req.wish, false);
   if ("Wish Status" in vals && !apiWishIsOpen_(wish)) delete vals["Wish Status"];
   if (vals["Vendor"]) vals["Vendor"] = apiEnsureVendor_(vals["Vendor"], user);
   const changes = apiWriteChanges_(tabs.wishes, wish._row, wish, vals);

   if (Array.isArray(req.tanks)) {
      if (!apiWishIsOpen_(wish)) throw apiError_("INVALID", "This wish is closed, so its tanks can't change.");
      const want = [];
      req.tanks.map(s => String(s).trim()).filter(Boolean).forEach(t => { if (want.indexOf(t) === -1) want.push(t); });
      const added = want.filter(t => pendingTanks.indexOf(t) === -1);
      const removed = pending.filter(a => want.indexOf(a["Tank ID"]) === -1);
      const tankRows = apiReadTable_("tanks").rows;
      const assignments = apiReadTable_("assignments").rows;
      added.forEach(t => {
         if (!tankRows.some(r => r["Tank ID"] === t)) throw apiError_("INVALID", "Tank " + t + " doesn't exist.");
         if (!apiCanEditTank_(user, t)) throw apiError_("FORBIDDEN", "You can't add wishes for " + t + " " + apiTankName_(t) + ".");
         if (assignments.some(a => a["Tank ID"] === t && a["Item ID"] === wish["Item ID"] && a["Active"] === true && !a["Date Removed"])) {
            throw apiError_("INVALID", wish["Item ID"] + " is already in " + t + " " + apiTankName_(t) + ".");
         }
      });
      removed.forEach(a => {
         if (!apiCanEditTank_(user, a["Tank ID"])) throw apiError_("FORBIDDEN", "You can't change wishes for " + a["Tank ID"] + " " + apiTankName_(a["Tank ID"]) + ".");
      });
      const aSheet = apiSheet_("tankAssignments");
      removed.forEach(a => apiWriteChanges_(aSheet, a._row, a, { "Date Removed": new Date() }));
      added.forEach(t => apiAppendRow_(aSheet, { "Tank ID": t, "Item ID": wish["Item ID"], "Active": false, "Wish ID": wish["Wish ID"] }));
      if (added.length) changes.push("Tanks added: " + added.join(", "));
      if (removed.length) changes.push("Tanks removed: " + removed.map(a => a["Tank ID"]).join(", "));
   }
   if (changes.length) apiLog_(user, "Edit wish", "Wishlist", wish["Wish ID"], changes.join("; "));
   return { updated: changes.length };
}


// ------------------------------------------------------------
// Not getting: req { wishId }
// ------------------------------------------------------------
function apiCloseWish_(req, user) {
   apiRequireWishUser_(user);
   const tabs = apiEnsureWishTabs_();
   const wish = apiFindWish_(req.wishId);
   if (!apiWishIsOpen_(wish)) throw apiError_("INVALID", "This wish is already closed.");
   const pending = apiPendingWishRows_(wish["Wish ID"]);
   const pendingTanks = pending.map(a => a["Tank ID"]);
   const ok = user.role === "Admin" || wish["Added By"] === apiWho_(user) ||
              (user.role === "Editor" && pendingTanks.length && pendingTanks.every(t => user.tanks.indexOf(t) !== -1));
   if (!ok) throw apiError_("FORBIDDEN", "Only an admin, the person who added it, or an editor of all its tanks can close this wish.");
   const now = new Date();
   const changes = apiWriteChanges_(tabs.wishes, wish._row, wish, { "Wish Status": "Not getting", "Closed At": now });
   const aSheet = apiSheet_("tankAssignments");
   pending.forEach(a => apiWriteChanges_(aSheet, a._row, a, { "Date Removed": now }));
   const type = wish["Item Type"];
   if (wish["New Item"] === true && API_TABLES[type]) {
      const rec = apiFindById_(type, wish["Item ID"]);
      if (rec && String(rec["Status"]) === "Wishlist") {
         apiWriteChanges_(apiSheet_(API_TABLES[type].sheetKey), rec._row, rec, { "Status": "Retired" });
         changes.push(wish["Item ID"] + " Status: Wishlist → Retired");
      }
   }
   apiLog_(user, "Close wish (not getting)", "Wishlist", wish["Wish ID"] + " / " + wish["Item ID"],
           changes.concat(pendingTanks.length ? ["Tank rows closed: " + pendingTanks.join(", ")] : []).join("; "));
   return { updated: changes.length };
}


// ------------------------------------------------------------
// Mark purchased
// req: { wishId, purchaseDate, vendor, pricePaid, receiptId,
//        tanks: [{ tankId, dateAdded, notes }] }
// ------------------------------------------------------------
function apiPurchaseWish_(req, user) {
   apiRequireWishUser_(user);
   apiEnsureWishColumn_();
   const tabs = apiEnsureWishTabs_();
   const wish = apiFindWish_(req.wishId);
   if (!apiWishIsOpen_(wish)) throw apiError_("INVALID", "This wish is already closed.");
   const type = wish["Item Type"];
   const def = API_TABLES[type];
   if (!def || WISH_CONFIG.types.indexOf(type) === -1) throw apiError_("INVALID", "Unknown item type on this wish.");
   const itemSheet = apiSheet_(def.sheetKey);
   let rec = apiFindById_(type, wish["Item ID"]);
   if (!rec) throw apiError_("NOT_FOUND", wish["Item ID"] + " no longer exists.");

   const tankRows = apiReadTable_("tanks").rows;
   const picks = [];
   (Array.isArray(req.tanks) ? req.tanks : []).forEach(p => {
      const t = String((p && p.tankId) || "").trim();
      if (!t || picks.some(x => x.tankId === t)) return;
      if (!tankRows.some(r => r["Tank ID"] === t)) throw apiError_("INVALID", "Tank " + t + " doesn't exist.");
      if (!apiCanEditTank_(user, t)) throw apiError_("FORBIDDEN", "You can't add items to " + t + " " + apiTankName_(t) + ".");
      picks.push({ tankId: t, dateAdded: p.dateAdded ? apiParseDate_(p.dateAdded) : null, notes: String(p.notes || "").trim() });
   });
   if (!picks.length) throw apiError_("INVALID", "Choose at least one tank to add it to.");

   const purchaseDate = req.purchaseDate ? apiParseDate_(req.purchaseDate) : new Date();
   picks.forEach(p => { if (!p.dateAdded) p.dateAdded = purchaseDate; });
   const priceTxt = String(req.pricePaid === undefined || req.pricePaid === null ? "" : req.pricePaid).replace(/[$,\s]/g, "");
   if (priceTxt !== "" && (isNaN(Number(priceTxt)) || Number(priceTxt) < 0)) throw apiError_("INVALID", "Price paid must be an amount like 24.99.");
   const price = priceTxt === "" ? "" : Math.round(Number(priceTxt) * 100) / 100;
   const receiptId = String(req.receiptId || "").trim();
   if (receiptId) {
      apiRequireReceipts_(user);
      if (!apiReadReceipts_().some(r => r["Receipt ID"] === receiptId)) throw apiError_("INVALID", "Receipt " + receiptId + " doesn't exist.");
   }
   const vendor = String(req.vendor || "").replace(/\s+/g, " ").trim() ? apiEnsureVendor_(String(req.vendor).replace(/\s+/g, " ").trim(), user) : "";

   const assignments = apiReadTable_("assignments").rows;
   const pending = apiPendingWishRows_(wish["Wish ID"], assignments);
   if (type !== "equipment") {
      picks.forEach(p => {
         if (assignments.some(a => a["Tank ID"] === p.tankId && a["Item ID"] === rec[def.id] && a["Active"] === true && !a["Date Removed"])) {
            throw apiError_("INVALID", rec[def.id] + " is already in " + p.tankId + " " + apiTankName_(p.tankId) + ".");
         }
      });
   }

   const aSheet = apiSheet_("tankAssignments");
   const itemIds = [];
   const notes = [];
   let useOriginal = String(rec["Status"]) === "Wishlist" || String(rec["Status"]) === "Retired";

   picks.forEach(p => {
      let itemId;
      if (type === "equipment" && !useOriginal) {
         // Another physical piece: copy the details into a new Equipment row.
         const copy = {};
         apiSchema_(type, apiReadLists_(apiSs_())).forEach(f => {
            if (f.readOnly || ["Status", "Purchase Date", "Vendor", "Serial Number", "QR Code URL"].indexOf(f.name) !== -1) return;
            if (rec[f.name] !== "" && rec[f.name] !== undefined) copy[f.name] = rec[f.name];
         });
         itemId = apiNextId_(type);
         copy[def.id] = itemId;
         copy["Status"] = "Active";
         copy["Purchase Date"] = purchaseDate;
         if (vendor || rec["Vendor"]) copy["Vendor"] = vendor || rec["Vendor"];
         apiAppendRow_(itemSheet, copy);
         apiLog_(user, "Add (purchased from wishlist)", def.label, itemId, "Copy of " + rec[def.id] + " for " + p.tankId + "; " + apiDescribe_(copy));
         notes.push(itemId + " (new piece)");
      } else {
         itemId = rec[def.id];
         const upd = {};
         if (String(rec["Status"]) !== "Active") upd["Status"] = "Active";
         if (type === "equipment") {
            if (!rec["Purchase Date"]) upd["Purchase Date"] = purchaseDate;
            if (vendor && !rec["Vendor"]) upd["Vendor"] = vendor;
         }
         const ch = apiWriteChanges_(itemSheet, rec._row, rec, upd);
         if (ch.length) apiLog_(user, "Edit (purchased from wishlist)", def.label, itemId, ch.join("; "));
         rec = apiFindById_(type, itemId);
         useOriginal = false;
      }
      itemIds.push(itemId);
      const row = pending.find(a => a["Tank ID"] === p.tankId);
      const values = { "Item ID": itemId, "Active": true, "Date Added": p.dateAdded, "Notes": p.notes };
      if (row) {
         apiWriteChanges_(aSheet, row._row, row, values);
         pending.splice(pending.indexOf(row), 1);
      } else {
         apiAppendRow_(aSheet, Object.assign({ "Tank ID": p.tankId, "Wish ID": wish["Wish ID"] }, values));
      }
   });

   if (receiptId) apiAddReceiptLinks_(apiEnsureReceiptTabs_(), receiptId, itemIds.filter((v, i, a) => a.indexOf(v) === i), user);

   const wUpd = { "Purchase Date": purchaseDate };
   if (price !== "") {
      const before = Number(String(wish["Price Paid"] || "").replace(/[$,]/g, "")) || 0;
      wUpd["Price Paid"] = Math.round((before + price) * 100) / 100;
   }
   if (vendor) wUpd["Vendor"] = vendor;
   if (receiptId) {
      const had = String(wish["Receipt ID"] || "").split(",").map(s => s.trim()).filter(Boolean);
      if (had.indexOf(receiptId) === -1) had.push(receiptId);
      wUpd["Receipt ID"] = had.join(", ");
   }
   if (!pending.length) { wUpd["Wish Status"] = "Purchased"; wUpd["Closed At"] = new Date(); }
   const wChanges = apiWriteChanges_(tabs.wishes, wish._row, wish, wUpd);
   apiLog_(user, "Purchase (wishlist)", "Wishlist", wish["Wish ID"],
           "Added to " + picks.map(p => p.tankId).join(", ") + " as " + itemIds.join(", ") +
           (notes.length ? " (" + notes.join(", ") + ")" : "") + (wChanges.length ? "; " + wChanges.join("; ") : ""));
   return { itemIds: itemIds, purchased: !pending.length };
}


// ------------------------------------------------------------
// Compatibility check (AI): req { wishId }
// Checks the wished tanks plus the other tanks this person can see, and
// saves verdicts for the wished tanks and the best-fit suggestions.
// ------------------------------------------------------------
function apiCheckWish_(req, user) {
   aiRequireUser_(user);
   const wish = apiFindWish_(req.wishId);
   const type = wish["Item Type"];
   const def = API_TABLES[type];
   const rec = def ? apiFindById_(type, wish["Item ID"]) : null;
   if (!rec) throw apiError_("NOT_FOUND", wish["Item ID"] + " no longer exists.");

   const assignments = apiReadTable_("assignments").rows;
   const wished = apiPendingWishRows_(wish["Wish ID"], assignments).map(a => a["Tank ID"]);
   const tanks = apiReadTable_("tanks").rows.filter(t => String(t["Status"]) !== "Retired" &&
      (user.role === "Admin" || user.tanks.indexOf(t["Tank ID"]) !== -1 || wished.indexOf(t["Tank ID"]) !== -1));
   if (!tanks.length) throw apiError_("INVALID", "There are no tanks to check against.");

   const species = apiReadTable_("species").rows, plants = apiReadTable_("plants").rows, equipment = apiReadTable_("equipment").rows;
   const params = apiReadTable_("waterParameters").rows;
   const byId = (rows, field, id) => rows.find(r => r[field] === id);
   const ctx = tanks.map(t => {
      const id = t["Tank ID"];
      const active = assignments.filter(a => a["Tank ID"] === id && a["Active"] === true && !a["Date Removed"]);
      const live = [], pl = [], eq = [];
      active.forEach(a => {
         let r;
         if ((r = byId(species, "Species ID", a["Item ID"]))) {
            live.push({ name: r["Common Name"], scientific: r["Scientific Name"], category: r["Category"],
                        tempF: [r["Temp Min °F"], r["Temp Max °F"]].filter(v => v !== "").join("-"),
                        adultSize: r["Adult Size"] || r["Max Size (in)"], temperament: r["Temperament"],
                        group: r["Group Type"], zone: r["Water Zone"] });
         } else if ((r = byId(plants, "Plant ID", a["Item ID"]))) {
            pl.push(r["Common Name"] + (r["Scientific Name"] ? " (" + r["Scientific Name"] + ")" : ""));
         } else if ((r = byId(equipment, "Equipment ID", a["Item ID"]))) {
            eq.push([r["Category"], r["Manufacturer"], r["Filter Model"]].filter(Boolean).join(" "));
         }
      });
      return {
         tankId: id, name: t["Tank Name"], gallons: t["Volume (gal)"], type: t["Aquarium Type"], wished: wished.indexOf(id) !== -1,
         waterRanges: params.filter(p => p["Tank ID"] === id && (p["Acceptable Min"] !== "" || p["Acceptable Max"] !== "" || p["Target"] !== ""))
            .map(p => ({ parameter: p["Parameter"], min: p["Acceptable Min"], max: p["Acceptable Max"], target: p["Target"], units: p["Units"] })),
         livestock: live, plants: pl, equipment: eq
      };
   });

   const item = {};
   apiSchema_(type, apiReadLists_(apiSs_())).forEach(f => {
      if (f.type === "url" || f.readOnly || ["Status", "Serial Number", "Purchase Date", "Vendor"].indexOf(f.name) !== -1) return;
      if (rec[f.name] !== "" && rec[f.name] !== undefined) item[f.name] = rec[f.name];
   });

   const factors = type === "equipment"
      ? "- Fit for the tank: filter flow/rated tank size or heater wattage vs the tank's gallons, physical size vs the tank, and duplicates of equipment the tank already has.\n"
      : "- Water ranges: compare the item's needs with the tank's target ranges (temperature, pH, GH, KH and others listed).\n" +
        "- Current livestock: temperament, adult size, predator/prey (e.g. fish that eat shrimp or snails), fin-nippers, territory.\n" +
        "- Tank size and stocking: is the tank big enough for this item's adult size and group needs, given what's already there? Quantities aren't tracked, only which species are present.\n" +
        "- Plants: plant-eating livestock; for a plant, whether current livestock would eat or uproot it, and its light/CO2 needs.\n";
   const prompt =
      "You are checking whether a wished-for " + (type === "equipment" ? "piece of aquarium equipment" : type === "plants" ? "aquarium plant" : "aquarium animal") +
      " suits each of the user's freshwater aquariums.\n\nNEW ITEM (" + wish["Item ID"] + "):\n" + JSON.stringify(item, null, 1) +
      "\n\nTANKS (wished = the user picked this tank for it):\n" + JSON.stringify(ctx, null, 1) +
      "\n\nFor EVERY tank give a verdict: \"Good\", \"Caution\" or \"Not recommended\", with 1-4 short, specific reasons (name the conflicting species or parameter). Consider:\n" + factors +
      "- If information is missing, say so in a reason rather than guessing, and lean to \"Caution\".\n" +
      "Then list up to 3 best-fit tanks among those NOT wished (only tanks with verdict Good, best first).\n" +
      "Reply with JSON only: {\"tanks\": [{\"tankId\": \"TK-1\", \"verdict\": \"Good\", \"reasons\": [\"...\"]}], \"bestFit\": [\"TK-2\"], \"summary\": \"one sentence\"}";

   const ai = aiGenerateJson_([{ text: prompt }]);
   const verdictOf = v => /not/i.test(String(v)) ? "Not recommended" : /good/i.test(String(v)) ? "Good" : "Caution";
   const results = {};
   (Array.isArray(ai.tanks) ? ai.tanks : []).forEach(r => {
      const id = String(r && r.tankId || "").trim();
      if (!tanks.some(t => t["Tank ID"] === id)) return;
      const reasons = (Array.isArray(r.reasons) ? r.reasons : [r.reasons]).map(s => String(s || "").trim()).filter(Boolean);
      results[id] = { verdict: verdictOf(r.verdict), reasons: reasons.join("; ").slice(0, 900) };
   });
   const bestFit = (Array.isArray(ai.bestFit) ? ai.bestFit : []).map(s => String(s).trim())
      .filter(id => results[id] && wished.indexOf(id) === -1 && results[id].verdict === "Good").slice(0, 3);
   const keep = wished.concat(bestFit).filter(id => results[id]);
   const missing = wished.filter(id => !results[id]);

   return apiWrite_(() => {
      const tabs = apiEnsureWishTabs_();
      const old = apiReadCompat_(true).filter(c => c["Wish ID"] === wish["Wish ID"]);
      old.forEach(c => apiWriteChanges_(tabs.compat, c._row, c, { "Current": false }));
      const now = new Date();
      keep.forEach(id => apiAppendRow_(tabs.compat, {
         "Wish ID": wish["Wish ID"], "Item ID": wish["Item ID"], "Tank ID": id, "Wished Tank": wished.indexOf(id) !== -1,
         "Verdict": results[id].verdict, "Reasons": results[id].reasons, "Checked At": now, "Checked By": apiWho_(user), "Current": true
      }));
      apiLog_(user, "Compatibility check", "Compatibility Checks", wish["Wish ID"] + " / " + wish["Item ID"],
              keep.map(id => id + ": " + results[id].verdict).join("; ") || "No tanks");
      return { checked: keep.length, bestFit: bestFit, missing: missing, summary: String(ai.summary || "").slice(0, 400) };
   });
}
