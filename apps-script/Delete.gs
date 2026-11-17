// ============================================================
// AYERS AQUARIUMS - PERMANENT DELETE (admins only)
//
// Retire (Api.gs) and Remove (Photos.gs) keep everything and only hide
// it. The actions here delete for good, for an Admin who confirms in
// the app:
//   - a species, equipment, plant or medication, with everything that
//     refers to it: tank assignment history, receipt links, wishes and
//     their compatibility checks, photos and image credits
//   - a tank, with its history: assignments, target ranges, water test
//     sessions and readings, water changes, receipt links and
//     compatibility checks; it's also taken off users' tank lists
//   - a receipt, with its record links
//   - an item photo
// Drive files (receipt photos, item photos) are moved to the Drive
// trash, where Google keeps them for 30 days. Each delete is written
// to the Change Log with what went with it.
// ============================================================

// Deletes every row of a tab whose value in column `header` passes test(value).
// Rows are deleted from the bottom up so row numbers don't shift mid-way.
// Returns { count, rows } where rows are the deleted rows as { header: value }.
function apiDeleteRowsWhere_(sheet, header, test) {
   if (!sheet) return { count: 0, rows: [] };
   const last = apiLastDataRow_(sheet);
   if (last < 2) return { count: 0, rows: [] };
   const values = sheet.getRange(1, 1, last, sheet.getLastColumn()).getValues();
   const headers = values[0].map(h => String(h).trim());
   const c = headers.indexOf(header);
   if (c === -1) return { count: 0, rows: [] };
   const hits = [];
   for (let r = 1; r < values.length; r++) {
      if (test(values[r][c])) {
         const o = {};
         headers.forEach((h, i) => { if (h) o[h] = values[r][i]; });
         hits.push({ row: r + 1, data: o });
      }
   }
   for (let i = hits.length - 1; i >= 0; i--) sheet.deleteRow(hits[i].row);
   return { count: hits.length, rows: hits.map(h => h.data) };
}

// A tab by name, or null if it doesn't exist.
function apiTabOrNull_(name) {
   return apiSs_().getSheetByName(name);
}

// Moves a Drive file to the trash (Google keeps it 30 days). Returns true if it was trashed.
function apiTrashDriveFile_(fileId) {
   if (!fileId) return false;
   try { DriveApp.getFileById(fileId).setTrashed(true); return true; } catch (e) { return false; }
}

// The Drive file ID inside a drive.google.com/file/d/... link ("" if none).
function apiDriveFileId_(url) {
   const m = String(url || "").match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/);
   return m ? m[1] : "";
}

// True if the Drive file sits in the Item Photos folder (an uploaded item photo,
// not some other file a link happens to point at).
function apiIsItemPhotoFile_(fileId) {
   const folderId = PropertiesService.getScriptProperties().getProperty("ITEM_PHOTOS_FOLDER_ID");
   if (!fileId || !folderId) return false;
   try {
      const parents = DriveApp.getFileById(fileId).getParents();
      while (parents.hasNext()) if (parents.next().getId() === folderId) return true;
   } catch (e) { /* not found: nothing to trash */ }
   return false;
}

// "3 tank assignments, 1 receipt link" from { label: count } (zero counts left out).
function apiCountsText_(counts) {
   return Object.keys(counts).filter(k => counts[k]).map(k => counts[k] + " " + k).join(", ");
}


// ------------------------------------------------------------
// Records: species, equipment, plants, medications, tanks
// req: { table, id }
// ------------------------------------------------------------
function apiDeleteRecord_(req, user) {
   apiRequireAdmin_(user);
   const table = req.table;
   const def = API_TABLES[table];
   if (!def || !def.id || ["tanks", "species", "equipment", "plants", "medications"].indexOf(table) === -1) {
      throw apiError_("BAD_REQUEST", "That record can't be deleted.");
   }
   const id = String(req.id || "");
   const rec = apiFindById_(table, id);
   if (!rec) throw apiError_("NOT_FOUND", "That record no longer exists.");
   const counts = {};
   const is = v => String(v).trim() === id;

   if (table === "tanks") {
      counts["tank assignment rows"] = apiDeleteRowsWhere_(apiSheet_("tankAssignments"), "Tank ID", is).count;
      counts["target ranges"] = apiDeleteRowsWhere_(apiSheet_("waterParameters"), "Tank ID", is).count;
      // Water test sessions, then the readings that belonged to them.
      const sessions = apiDeleteRowsWhere_(apiTabOrNull_(WATER_CONFIG.sessionsSheetName), "Tank ID", is);
      const sessionIds = {};
      sessions.rows.forEach(r => sessionIds[String(r["Session ID"]).trim()] = true);
      counts["water test sessions"] = sessions.count;
      counts["water test readings"] = apiDeleteRowsWhere_(apiTabOrNull_(WATER_CONFIG.testsSheetName), "Session ID", v => !!sessionIds[String(v).trim()]).count;
      counts["water changes"] = apiDeleteRowsWhere_(apiTabOrNull_(MAINT_CONFIG.waterChangesSheetName), "Tank ID", is).count;
      counts["receipt links"] = apiDeleteRowsWhere_(apiTabOrNull_(RECEIPTS_CONFIG.linksSheetName), "Item ID", is).count;
      counts["compatibility checks"] = apiDeleteRowsWhere_(apiTabOrNull_(WISH_CONFIG.compatSheetName), "Tank ID", is).count;
      counts["treatments (and their doses)"] = apiDeleteTreatmentsWhere_("Tank ID", id, user);
      counts["price tracker rows"] = apiDeletePricesForRecord_(id, user);
      counts["receipt item lines"] = apiRemoveReceiptLinesFor_("Record ID", id);
      // Take the tank off every user's Assigned Tanks list.
      const usersSheet = apiEnsureSupportTabs_().users;
      const col = apiHeaderMap_(usersSheet).map["assigned tanks"];
      let users = 0;
      if (col) {
         apiGetUsers_(true).forEach(u => {
            if (u.tanks.indexOf(id) === -1) return;
            usersSheet.getRange(u.row, col).setValue(u.tanks.filter(t => t !== id).join(", "));
            users++;
         });
      }
      counts["user tank lists updated"] = users;
      apiClearUsersCache_();
   } else {
      counts["tank assignment rows"] = apiDeleteRowsWhere_(apiSheet_("tankAssignments"), "Item ID", is).count;
      counts["receipt links"] = apiDeleteRowsWhere_(apiTabOrNull_(RECEIPTS_CONFIG.linksSheetName), "Item ID", is).count;
      // Wishes for the item, and the compatibility checks for those wishes.
      const wishes = apiDeleteRowsWhere_(apiTabOrNull_(WISH_CONFIG.sheetName), "Item ID", is);
      const wishIds = {};
      wishes.rows.forEach(r => wishIds[String(r["Wish ID"]).trim()] = true);
      counts["wishes"] = wishes.count;
      counts["compatibility checks"] = apiDeleteRowsWhere_(apiTabOrNull_(WISH_CONFIG.compatSheetName), "Wish ID", v => !!wishIds[String(v).trim()]).count +
                                       apiDeleteRowsWhere_(apiTabOrNull_(WISH_CONFIG.compatSheetName), "Item ID", is).count;
      // Photos: rows deleted, files to the Drive trash (the list picture too, if it was an uploaded photo).
      const photos = apiDeleteRowsWhere_(apiTabOrNull_(PHOTO_CONFIG.sheetName), "Item ID", is);
      const trashed = {};
      photos.rows.forEach(r => { const f = apiDriveFileId_(r["Photo URL"]); if (f && !trashed[f] && apiTrashDriveFile_(f)) trashed[f] = true; });
      const thumb = apiDriveFileId_(rec["Thumbnail URL"]);
      if (thumb && !trashed[thumb] && apiIsItemPhotoFile_(thumb) && apiTrashDriveFile_(thumb)) trashed[thumb] = true;
      counts["photos"] = photos.count;
      counts["photo files moved to Drive trash"] = Object.keys(trashed).length;
      counts["image credits"] = apiDeleteRowsWhere_(apiTabOrNull_("Image Credits"), "Species ID", is).count;
      // Price tracker (Prices.gs): its price item and every price gathered for it.
      counts["price tracker rows"] = apiDeletePricesForRecord_(id, user);
      if (table === "medications") counts["treatments (and their doses)"] = apiDeleteTreatmentsWhere_("Product ID", id, user);
      counts["receipt item lines"] = apiRemoveReceiptLinesFor_("Record ID", id);
   }

   // The record itself (found again by ID, since rows above may be on other tabs only).
   apiDeleteRowsWhere_(apiSheet_(def.sheetKey), def.id, is);
   const title = table === "tanks" ? rec["Tank Name"] : table === "medications" ? rec["Product Name"] : apiItemTitle_(table, rec);
   const also = apiCountsText_(counts);
   apiLog_(user, "Delete", def.label, id, (title ? title + ". " : "") + (also ? "Also deleted: " + also : "Nothing else referred to it."));
   CacheService.getScriptCache().remove("item_photo_ids");
   return { deleted: id, also: counts };
}


// ------------------------------------------------------------
// Receipts
// req: { id }
// ------------------------------------------------------------
function apiDeleteReceipt_(req, user) {
   apiRequireAdmin_(user);
   const tabs = apiEnsureReceiptTabs_();
   const id = String(req.id || "");
   const rec = apiReadReceipts_().find(r => r["Receipt ID"] === id);
   if (!rec) throw apiError_("NOT_FOUND", "That receipt no longer exists.");
   const is = v => String(v).trim() === id;
   const counts = {};
   counts["record links"] = apiDeleteRowsWhere_(tabs.links, "Receipt ID", is).count;
   // Item lines: their prices are undone (ReceiptLines.gs), then the lines go.
   counts["item lines (and the prices they added)"] = apiRemoveReceiptLines_(rec, user);
   counts["photo moved to Drive trash"] = apiTrashDriveFile_(String(rec["Drive File ID"] || "") || apiDriveFileId_(rec["Photo Link"])) ? 1 : 0;
   // Wishes that pointed at this receipt keep everything else; only the receipt reference is cleared.
   const wishSheet = apiTabOrNull_(WISH_CONFIG.sheetName);
   let wishes = 0;
   if (wishSheet) {
      const col = apiHeaderMap_(wishSheet).map["receipt id"];
      const last = apiLastDataRow_(wishSheet);
      if (col && last >= 2) {
         const vals = wishSheet.getRange(2, col, last - 1, 1).getValues();
         vals.forEach((v, i) => { if (is(v[0])) { wishSheet.getRange(i + 2, col).setValue(""); wishes++; } });
      }
   }
   counts["wish receipt references cleared"] = wishes;
   apiDeleteRowsWhere_(tabs.receipts, "Receipt ID", is);
   const also = apiCountsText_(counts);
   apiLog_(user, "Delete", "Receipts", id, (rec["File Name"] ? rec["File Name"] + ". " : "") + (also ? "Also: " + also : ""));
   return { deleted: id, also: counts };
}


// ------------------------------------------------------------
// Item photos
// req: { photoId }
// ------------------------------------------------------------
function apiDeletePhoto_(req, user) {
   apiRequireAdmin_(user);
   const p = apiFindPhoto_(String(req.photoId || ""));
   const trashed = apiTrashDriveFile_(apiDriveFileId_(p["Photo URL"]));
   apiDeleteRowsWhere_(apiPhotosSheet_(), "Photo ID", v => String(v).trim() === p["Photo ID"]);
   let item = null;
   try { item = apiPhotoItem_(p["Item ID"]); } catch (e) { item = null; }
   if (item && String(item.rec["Thumbnail URL"] || "") === String(p["Photo URL"])) apiSetThumbnail_(user, item.type, item.rec, "");
   apiLog_(user, "Delete", PHOTO_CONFIG.sheetName, p["Photo ID"], p["Item ID"] + (p["Caption"] ? " · " + p["Caption"] : "") +
           (trashed ? ". File moved to Drive trash." : ". The Drive file couldn't be found to trash."));
   CacheService.getScriptCache().remove("item_photo_ids");
   return { deleted: p["Photo ID"] };
}
