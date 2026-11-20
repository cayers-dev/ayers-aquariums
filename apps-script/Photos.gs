// ============================================================
// AYERS AQUARIUMS - ITEM PHOTOS
//
// Several photos per species, equipment, plant, medication or food:
// for example the whole filter, its serial/model label, the box, the
// dosing panel on the back of a bottle, or a tub's feeding chart.
//
// Files go to the private "Item Photos" Drive folder (see Wishlist.gs)
// and are shown in the app through this script (apiItemPhoto_), so
// they stay private to app users. Each photo is one row on the
// "Item Photos" tab (created the first time a photo is added).
//
// Who: Admins add, caption and remove photos and choose which one is
// the item's list picture (its Thumbnail URL). Everyone signed in can
// view them.
//
// Nothing is deleted: a removed photo is marked Removed on the tab and
// hidden in the app; its Drive file stays.
// ============================================================

// Tab name, ID prefix, item types and columns of the Item Photos tab.
const PHOTO_CONFIG = {
   sheetName: "Item Photos",
   prefix: "PH-",
   types: ["species", "equipment", "plants", "medications", "foods"],
   headers: ["Photo ID", "Item ID", "Item Type", "Caption", "Photo URL", "Added By", "Added At", "Status", "Removed By", "Removed At"]
};

// The Item Photos tab (created with its headers the first time).
function apiPhotosSheet_() {
   const ss = apiSs_();
   let sheet = ss.getSheetByName(PHOTO_CONFIG.sheetName);
   if (!sheet) {
      sheet = ss.insertSheet(PHOTO_CONFIG.sheetName);
      const n = PHOTO_CONFIG.headers.length;
      sheet.getRange(1, 1, 1, n).setValues([PHOTO_CONFIG.headers]).setFontWeight("bold").setBackground("#d9d9d9");
      sheet.setFrozenRows(1);
      sheet.getRange("G2:G").setNumberFormat("m/d/yyyy h:mm am/pm");
      sheet.getRange("J2:J").setNumberFormat("m/d/yyyy h:mm am/pm");
      sheet.setColumnWidth(4, 220);
      sheet.setColumnWidth(5, 320);
   }
   return sheet;
}

// Every row of the Item Photos tab as { header: value, _row } (empty list if the tab doesn't exist yet).
function apiReadPhotos_() {
   const sheet = apiSs_().getSheetByName(PHOTO_CONFIG.sheetName);
   if (!sheet) return [];
   const values = apiGrid_(sheet).values;
   if (values.length < 2) return [];
   const headers = values[0].map(h => String(h).trim());
   const tz = apiSs_().getSpreadsheetTimeZone();
   return values.slice(1).map((row, i) => {
      const o = { _row: i + 2 };
      headers.forEach((h, c) => {
         if (!h) return;
         const v = row[c];
         o[h] = v instanceof Date ? Utilities.formatDate(v, tz, "yyyy-MM-dd HH:mm") : v;
      });
      return o;
   }).filter(r => r["Photo ID"]);
}

// Photos still in use (not removed).
function apiActivePhotos_() {
   return apiReadPhotos_().filter(r => String(r["Status"] || "Active") !== "Removed");
}

// For the app at startup: the active photos (everyone signed in may view them).
function apiPhotosBootstrap_() {
   return {
      photos: apiActivePhotos_().map(r => ({
         "Photo ID": r["Photo ID"], "Item ID": r["Item ID"], "Item Type": r["Item Type"],
         "Caption": r["Caption"], "Photo URL": r["Photo URL"], "Added At": r["Added At"]
      }))
   };
}

// The record a photo belongs to (PHOTO_CONFIG.types): { type, rec } or throws.
function apiPhotoItem_(itemId) {
   for (let i = 0; i < PHOTO_CONFIG.types.length; i++) {
      const rec = apiFindById_(PHOTO_CONFIG.types[i], itemId);
      if (rec) return { type: PHOTO_CONFIG.types[i], rec: rec };
   }
   throw apiError_("INVALID", "Item " + itemId + " doesn't exist.");
}

// An active photo row by ID, or throws.
function apiFindPhoto_(photoId) {
   const p = apiActivePhotos_().find(r => r["Photo ID"] === photoId);
   if (!p) throw apiError_("NOT_FOUND", "That photo no longer exists. Pull down to refresh.");
   return p;
}

// Next photo ID, e.g. PH-8 after PH-7 (removed photos count, so IDs are never reused).
function apiNextPhotoId_() {
   const max = apiReadPhotos_().reduce((m, r) => {
      const n = Number(String(r["Photo ID"]).replace(/^\D+/, ""));
      return isNaN(n) ? m : Math.max(m, n);
   }, 0);
   return PHOTO_CONFIG.prefix + (max + 1);
}

// Medications came to pictures after the tab was built, so their Thumbnail URL
// column is made the first time the app loads after this change (once, ever).
function apiEnsureMedThumbColumn_() {
   const props = PropertiesService.getScriptProperties();
   if (props.getProperty("medThumbColumn") === "done") return;
   apiEnsureColumn_(apiSheet_(API_TABLES.medications.sheetKey), "Thumbnail URL");
   props.setProperty("medThumbColumn", "done");
}

// Sets an item's list picture (Thumbnail URL) and logs the change.
function apiSetThumbnail_(user, type, rec, url) {
   const def = API_TABLES[type];
   const sheet = apiSheet_(def.sheetKey);
   // Medications came late to pictures: make the column if the tab hasn't got one.
   apiEnsureColumn_(sheet, "Thumbnail URL");
   const changes = apiWriteChanges_(sheet, rec._row, rec, { "Thumbnail URL": url });
   if (changes.length) apiLog_(user, "Edit", def.label, rec[def.id], changes.join("; "));
   CacheService.getScriptCache().remove("item_photo_ids");
}


// ------------------------------------------------------------
// Changes (admins only)
// ------------------------------------------------------------

// req: { itemId, photo: { data, mimeType }, caption?, useAsListPicture? }
function apiAddItemPhoto_(req, user) {
   apiRequireAdmin_(user);
   const item = apiPhotoItem_(String(req.itemId || ""));
   const def = API_TABLES[item.type];
   const itemId = item.rec[def.id];
   const caption = String(req.caption || "").replace(/\s+/g, " ").trim().slice(0, 100);
   const title = caption || apiItemTitle_(item.type, item.rec);
   const fileId = apiSaveItemPhoto_(req.photo || {}, itemId, title, user);
   const url = apiDrivePhotoUrl_(fileId);
   const id = apiNextPhotoId_();
   apiAppendRow_(apiPhotosSheet_(), {
      "Photo ID": id, "Item ID": itemId, "Item Type": item.type, "Caption": caption, "Photo URL": url,
      "Added By": apiWho_(user), "Added At": new Date(), "Status": "Active"
   });
   apiLog_(user, "Add", PHOTO_CONFIG.sheetName, id, itemId + (caption ? " · " + caption : ""));
   if (req.useAsListPicture) apiSetThumbnail_(user, item.type, item.rec, url);
   CacheService.getScriptCache().remove("item_photo_ids");
   return { photoId: id, url: url };
}

// req: { photoId, caption }
function apiUpdatePhoto_(req, user) {
   apiRequireAdmin_(user);
   const p = apiFindPhoto_(String(req.photoId || ""));
   const caption = String(req.caption || "").replace(/\s+/g, " ").trim().slice(0, 100);
   const changes = apiWriteChanges_(apiPhotosSheet_(), p._row, p, { "Caption": caption });
   if (changes.length) apiLog_(user, "Edit", PHOTO_CONFIG.sheetName, p["Photo ID"], changes.join("; "));
   return { updated: changes.length };
}

// req: { photoId } -> the photo becomes its item's list picture.
function apiSetListPhoto_(req, user) {
   apiRequireAdmin_(user);
   const p = apiFindPhoto_(String(req.photoId || ""));
   const item = apiPhotoItem_(p["Item ID"]);
   apiSetThumbnail_(user, item.type, item.rec, p["Photo URL"]);
   return { ok: true };
}

// req: { photoId } -> marked Removed (hidden in the app; the Drive file stays).
// If it was the item's list picture, the item's Thumbnail URL is cleared.
function apiRemoveItemPhoto_(req, user) {
   apiRequireAdmin_(user);
   const p = apiFindPhoto_(String(req.photoId || ""));
   apiWriteChanges_(apiPhotosSheet_(), p._row, p, { "Status": "Removed", "Removed By": apiWho_(user), "Removed At": new Date() });
   apiLog_(user, "Remove", PHOTO_CONFIG.sheetName, p["Photo ID"], p["Item ID"] + (p["Caption"] ? " · " + p["Caption"] : ""));
   let item = null;
   try { item = apiPhotoItem_(p["Item ID"]); } catch (e) { item = null; }
   if (item && String(item.rec["Thumbnail URL"] || "") === String(p["Photo URL"])) apiSetThumbnail_(user, item.type, item.rec, "");
   CacheService.getScriptCache().remove("item_photo_ids");
   return { ok: true };
}

// The photo's bytes for the AI (Read label): { mimeType, data (base64) }.
function apiPhotoBytes_(p) {
   const m = String(p["Photo URL"] || "").match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/);
   if (!m) throw apiError_("INVALID", "That photo isn't stored in Drive.");
   let blob;
   try { blob = DriveApp.getFileById(m[1]).getBlob(); } catch (e) {
      throw apiError_("NOT_FOUND", "The photo couldn't be found in Drive (it may have been moved or deleted).");
   }
   return { mimeType: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}


// One-off (Nov 2026): the sheet's old menu forms and the Tank Lookup report
// are not part of the app, so their tabs go. Run once, then delete.
function zzRemoveUnusedTabs() {
   const ss = apiSs_();
   const names = ["Add Species", "Add Tank", "Add Equipment", "Add Plant",
                  "Add Medication", "Add Water Parameter", "Tank Lookup"];
   const log = [];
   names.forEach(n => {
      const sh = ss.getSheetByName(n);
      if (!sh) return log.push("no tab named " + n);
      ss.deleteSheet(sh);
      log.push("deleted " + n);
   });
   SpreadsheetApp.flush();
   const left = ss.getSheets().map(s => s.getName());
   const out = log.join("\n") + "\n\n" + left.length + " tabs left: " + left.join(", ");
   Logger.log(out);
   return out;
}
