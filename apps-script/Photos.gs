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

// TEMPORARY: one-off. Target parameters for the Brittany tanks, from current stocking.
function zzBrittanyParams() {
   var user = { id: "audit", email: "audit", role: "Admin" };
   var P = function (tank, param, target, lo, hi, units, notes) {
      return { tank: tank, param: param, target: target, lo: lo, hi: hi, units: units, notes: notes };
   };
   var FIX = function (tank, who) {
      return [
         P(tank, "Ammonia (NH3/NH4)", "0", "0", "0", "ppm", "Required target for all livestock."),
         P(tank, "Nitrite (NO2)", "0", "0", "0", "ppm", "Required target for all livestock."),
         P(tank, "Nitrate (NO3)", "<20", "0", "30", "ppm", "Keep low for " + who + "."),
         P(tank, "Chlorine", "0", "0", "0", "ppm", "Required target for all livestock.")
      ];
   };
   var rows = [].concat(
      // TK-5 Brittany Glow: Cherry Red Shrimp, Endler, GloFish Danio
      [P("TK-5", "Temperature", "75", "73", "77", "°F",
         "Species overlap 72-78F (FS-9 Cherry Red Shrimp 68-78, FS-15 Endler 72-82, FS-18 GloFish Danio 64-78)."),
       P("TK-5", "pH", "7", "6.8", "7.4", "",
         "FS-18 GloFish Danio (zebra danio) 6.5-7.2; FS-15 Endler prefers 7.0+; FS-9 Cherry Red Shrimp 6.5-8.0. Neutral suits all three."),
       P("TK-5", "Total Hardness (GH)", "160", "145", "180", "ppm",
         "8-10 dGH. FS-15 Endler wants 8+ (hard-water livebearer); FS-18 GloFish Danio up to about 12; FS-9 Cherry Red Shrimp 6-10."),
       P("TK-5", "Alkalinity (KH)", "90", "70", "105", "ppm",
         "4-6 dKH. FS-9 Cherry Red Shrimp 2-8 for stable moulting; buffers the pH for the other two.")],
      FIX("TK-5", "FS-9 Cherry Red Shrimp"),
      // TK-6 Brittany Cichlid: Convict, Electric Yellow, Peacock, Cuckoo catfish
      [P("TK-6", "Temperature", "77", "75", "79", "°F",
         "Species overlap 75-79F (FS-11 Convict Cichlid 74-82, FS-13 Electric Yellow Cichlid 73-79, FS-38 Peacock Cichlid 75-82, FS-39 Cuckoo catfish 75-82)."),
       P("TK-6", "pH", "8", "7.6", "8.4", "",
         "Hard alkaline Rift Lake water. FS-13 Electric Yellow 7.5-8.5; FS-38 Peacock 7.4-9.0; FS-39 Cuckoo catfish same lake. FS-11 Convict Cichlid is Central American and sits at the lower end."),
       P("TK-6", "Total Hardness (GH)", "215", "180", "270", "ppm",
         "10-15 dGH. Malawi guidance is 12-18 dGH, though the fish do well lower if it stays stable. FS-11 Convict Cichlid is comfortable anywhere in this band."),
       P("TK-6", "Alkalinity (KH)", "145", "105", "215", "ppm",
         "6-12 dKH. Rift Lake fish need the buffer; at pH 8+ keep ammonia at zero, since more of it is in the toxic form.")],
      FIX("TK-6", "FS-39 Cuckoo catfish and the cichlids"),
      // TK-7 Brittany Betta: Betta, Otocinclus, Pea Puffer
      [P("TK-7", "Temperature", "77", "76", "79", "°F",
         "Species overlap 76-79F (FS-2 Betta Fish 76-82, FS-24 Otocinclus 72-79, FS-26 Pea Puffer 72-82). FS-2 sets the floor, FS-24 the ceiling."),
       P("TK-7", "pH", "7.2", "6.8", "7.5", "",
         "FS-26 Pea Puffer 6.8-8.0 (prefers neutral to medium-hard); FS-24 Otocinclus 6.0-7.5; FS-2 Betta Fish 6.0-8.0."),
       P("TK-7", "Total Hardness (GH)", "180", "145", "215", "ppm",
         "8-12 dGH. FS-26 Pea Puffer 5-25, FS-2 Betta Fish 5-20, FS-24 Otocinclus 4-15. Moderate suits all three."),
       P("TK-7", "Alkalinity (KH)", "105", "70", "145", "ppm",
         "4-8 dKH. Enough buffer to hold the pH steady, which matters more to the puffer than the exact figure.")],
      FIX("TK-7", "FS-24 Otocinclus and FS-26 Pea Puffer"),
      // TK-9 Brittany Shrimp: Blue Dream, Cherry Red, Mystery Snail
      [P("TK-9", "Temperature", "75", "72", "77", "°F",
         "Species overlap 68-78F (FS-5 Shrimp Blue Dream 68-78, FS-9 Cherry Red Shrimp 68-78, FS-21 Mystery Snail 68-82). Target set mid-range; both shrimp do best 72-76."),
       P("TK-9", "pH", "7.4", "7", "7.8", "",
         "FS-21 Mystery Snail needs 7.0+ or its shell erodes (ideally 7.2-8.2); FS-5 and FS-9 Neocaridina shrimp 6.5-8.0."),
       P("TK-9", "Total Hardness (GH)", "160", "145", "180", "ppm",
         "8-10 dGH. FS-21 Mystery Snail wants 8+ for shell growth; FS-5 and FS-9 shrimp 6-10 for clean moults. Narrow but real overlap."),
       P("TK-9", "Alkalinity (KH)", "90", "70", "105", "ppm",
         "4-6 dKH. FS-21 Mystery Snail 4-8; shrimp 2-8. Keeps the pH from dropping into shell-dissolving territory.")],
      FIX("TK-9", "the shrimp and FS-21 Mystery Snail"),
      // TK-10 Brittany Tetra: Cardinal, Mystery Snail, Neon, Nerite, ADF, Red Eye Tetra
      [P("TK-10", "Temperature", "76", "74", "78", "°F",
         "Species overlap 73-78F (FS-6 Tetra Cardinal 73-81, FS-21 Mystery Snail 68-82, FS-22 Neon Tetra 70-78, FS-23 Nerite Snail 72-78, FS-44 African Dwarf Frog 72-78, FS-45 Red Eye Tetra 73-82). The snail, frog and neons set the 78 ceiling."),
       P("TK-10", "pH", "7.2", "7", "7.5", "",
         "Compromise. FS-21 Mystery Snail and FS-23 Nerite Snail need 7.0+ to keep their shells; FS-22 Neon Tetra and FS-6 Tetra Cardinal prefer softer, more acidic water and tolerate up to about 7.5."),
       P("TK-10", "Total Hardness (GH)", "180", "145", "215", "ppm",
         "8-12 dGH. The two snails want 8+ for shell health; FS-22 Neon Tetra and FS-6 Tetra Cardinal tolerate up to about 12."),
       P("TK-10", "Alkalinity (KH)", "90", "70", "105", "ppm",
         "4-6 dKH. Snails 4+; the tetras prefer it no higher than this.")],
      FIX("TK-10", "FS-23 Nerite Snail and the tetras")
   );

   var existing = apiReadTable_("waterParameters").rows;
   var added = 0, updated = 0, same = 0;
   rows.forEach(function (r) {
      var cur = existing.find(function (x) {
         return String(x["Tank ID"]).trim() === r.tank && String(x["Parameter"]).trim() === r.param;
      });
      var values = {
         "Target": r.target, "Acceptable Min": r.lo, "Acceptable Max": r.hi,
         "Units": r.units, "Notes": r.notes
      };
      if (cur) {
         var res = apiUpdate_({ table: "waterParameters", key: { row: cur._row, tankId: r.tank, parameter: r.param }, values: values }, user);
         if (res.updated) { updated++; } else { same++; }
      } else {
         values["Tank ID"] = r.tank;
         values["Parameter"] = r.param;
         apiAdd_({ table: "waterParameters", values: values }, user);
         added++;
      }
   });
   apiFlushLog_();
   SpreadsheetApp.flush();
   console.log("rows in spec: " + rows.length + " | added: " + added + " | updated: " + updated + " | already matching: " + same);
}
