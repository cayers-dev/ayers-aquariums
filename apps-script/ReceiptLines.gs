// ============================================================
// RECEIPT LINES
// Optional item lines on a receipt: item, qty, line price, size + unit.
//   - A line with a price, size and unit adds the price per item (line price ÷ qty) to the
//     price tracker for the receipt's vendor, dated the receipt's purchase date.
//   - Same price and size as the latest for that store: the latest price's date moves to the
//     receipt date instead (if the receipt is newer). An older receipt adds history only.
//   - Lines for a species, equipment, plant or medication link the receipt to that record
//     (Editors: only items in their tanks; otherwise the link is skipped).
//   - Editing or deleting a line undoes the price it created (or puts the old date back).
// ============================================================

// Categories a receipt line can create a record in. Tanks and equipment are one record
// per unit bought (they have their own serial numbers); the rest are one record whatever the qty.
const RLINE_NEW_TYPES = ["tanks", "species", "equipment", "plants", "medications"];
const RLINE_UNIQUE_TYPES = ["tanks", "equipment"];

const RLINE_CONFIG = {
   sheetName: "Receipt Lines",
   prefix: "RL-",
   headers: ["Line ID", "Receipt ID", "Line No", "Record ID", "Price Item ID", "Item Name", "Qty", "Line Price",
             "Size", "Unit", "Price ID", "Price Action", "Previous Date", "Added By", "Added At"]
};

function apiReceiptLinesSheet_() {
   return apiPriceTab_(RLINE_CONFIG.sheetName, RLINE_CONFIG.headers, { 6: 240 },
                       { "H2:H": "$#,##0.00", "M2:M": "m/d/yyyy", "O2:O": "m/d/yyyy h:mm am/pm" });
}
const apiReadReceiptLines_ = () => apiReadPriceTab_(RLINE_CONFIG.sheetName, "Line ID");

function apiReceiptLinesBootstrap_(user) {
   if (!apiCanUseReceipts_(user)) return {};
   return { receiptLines: apiReadReceiptLines_().map(r => { const o = Object.assign({}, r); delete o._row; return o; }) };
}

// Checks one line from the app: { item: { priceItemId | recordId | name }, qty, price, size, unit }.
function apiCleanReceiptLine_(raw) {
   raw = raw || {};
   const item = raw.item || {};
   const num = v => String(v === undefined || v === null ? "" : v).replace(/[$,\s]/g, "");
   const qtyText = num(raw.qty), priceText = num(raw.price), sizeText = num(raw.size);
   const qty = qtyText === "" ? 1 : Number(qtyText);
   if (isNaN(qty) || qty <= 0) throw apiError_("INVALID", "Qty must be a number above 0.");
   const price = priceText === "" ? "" : Number(priceText);
   if (price !== "" && (isNaN(price) || price < 0)) throw apiError_("INVALID", "Line prices must be amounts like 24.99.");
   const size = sizeText === "" ? "" : Number(sizeText);
   if (size !== "" && (isNaN(size) || size <= 0)) throw apiError_("INVALID", "Sizes must be numbers like 250.");
   const unit = String(raw.unit || "").trim() ? PRICE_CONFIG.units.find(u => u.toLowerCase() === String(raw.unit).trim().toLowerCase()) : "";
   if (unit === undefined) throw apiError_("INVALID", "Choose a unit: " + PRICE_CONFIG.units.join(", ") + ".");
   if (!item.priceItemId && !item.recordId && !String(item.name || "").trim()) throw apiError_("INVALID", "Every line needs an item.");
   if (item.newType && RLINE_NEW_TYPES.indexOf(String(item.newType)) === -1) throw apiError_("INVALID", "Choose what kind of record to add the new item as.");
   return { item: item, qty: qty, price: price === "" ? "" : Math.round(price * 100) / 100, size: size, unit: unit || "" };
}

// The record ID and display name for a line's item (without creating anything).
function apiLineItemInfo_(item, user, receiptId) {
   // A brand-new record: tank, species, equipment, plant or medication.
   if (item.newType) {
      const type = String(item.newType);
      if (RLINE_NEW_TYPES.indexOf(type) === -1) throw apiError_("INVALID", "Choose what kind of record to add the new item as.");
      const name = String(item.name || "").replace(/\s+/g, " ").trim();
      if (!name) throw apiError_("INVALID", "A new " + API_TABLES[type].label.toLowerCase() + " needs a name.");
      // Only admins add records to the shared lists.
      if (user.role !== "Admin") throw apiError_("FORBIDDEN", "Only admins can add new records, so “" + name + "” can't be added as a " +
         API_TABLES[type].label.toLowerCase() + " here. Leave it as a price-tracker item, or ask an admin to add the record.");
      if (!receiptId) return { recordId: "", priceItemId: "", name: name, newType: type };   // checking only
      // Tanks and equipment are one record per unit, so two of the same name are expected.
      // For the rest, a record of that name already there is used instead of a second one.
      const same = RLINE_UNIQUE_TYPES.indexOf(type) === -1
         ? apiReadTable_(type).rows.find(r => apiLineRecordName_({ table: type, rec: r }).replace(/\s+/g, " ").trim().toLowerCase() === name.toLowerCase())
         : null;
      if (same) return apiLineItemInfo_({ recordId: same[API_TABLES[type].id] }, user, receiptId);
      const rid = apiCreateLineRecord_(type, name, user, receiptId);
      // Prices saved earlier against a typed item of the same name move onto the new record.
      const moved = apiMergeTypedPriceItem_(name, rid, user);
      const pi = apiReadPriceItems_().find(r => r["Record ID"] === rid);
      return { recordId: rid, priceItemId: pi ? pi["Price Item ID"] : "", name: name, created: rid, movedPrices: moved };
   }
   if (item.priceItemId) {
      const pi = apiReadPriceItems_().find(r => r["Price Item ID"] === item.priceItemId);
      if (!pi) throw apiError_("NOT_FOUND", "An item on this receipt is no longer in the price tracker.");
      const rid = String(pi["Record ID"] || "");
      const rec = rid ? apiPriceRecord_(rid) : null;
      return { recordId: rid, priceItemId: pi["Price Item ID"], name: rec ? apiLineRecordName_(rec) : String(pi["Item Name"] || "") };
   }
   if (item.recordId) {
      const rid = String(item.recordId).trim();
      const rec = apiPriceRecord_(rid);
      if (!rec) throw apiError_("INVALID", rid + " doesn't exist.");
      const pi = apiReadPriceItems_().find(r => r["Record ID"] === rid);
      return { recordId: rid, priceItemId: pi ? pi["Price Item ID"] : "", name: apiLineRecordName_(rec) };
   }
   const name = String(item.name || "").replace(/\s+/g, " ").trim();
   const pi = apiReadPriceItems_().find(r => !r["Record ID"] && String(r["Item Name"]).trim().toLowerCase() === name.toLowerCase());
   return { recordId: "", priceItemId: pi ? pi["Price Item ID"] : "", name: pi ? String(pi["Item Name"]) : name };
}

const apiLineRecordName_ = rec => rec.table === "medications" ? String(rec.rec["Product Name"] || rec.rec["Product ID"]) : apiItemTitle_(rec.table, rec.rec);

// Puts one line's price into the price tracker. Returns { priceId, action, previousDate, note }.
function apiApplyLinePrice_(receipt, line, info, user) {
   // Every line gets an entry in the price tracker, so an item bought without a price
   // is still there to price later.
   const item = apiPriceItemFor_(info.priceItemId ? { priceItemId: info.priceItemId } : info.recordId ? { recordId: info.recordId } : { name: info.name }, user);
   info.priceItemId = item.id;
   if (line.price === "") return { action: "none", note: "no price" };
   if (!line.size || !line.unit) return { action: "none", note: "no size" };
   const vendor = String(receipt["Vendor"] || "").trim();
   const dateText = String(receipt["Purchase Date"] || "").trim();
   if (!vendor) return { action: "none", note: "receipt has no vendor" };
   if (!dateText) return { action: "none", note: "receipt has no purchase date" };
   const each = Math.round(line.price / line.qty * 100) / 100;
   return apiRecordObservedPrice_(info.priceItemId, vendor, each, line.size, line.unit, dateText,
                                  "receipt " + receipt["Receipt ID"], user);
}

// Records a price seen somewhere (a receipt line, a wishlist purchase) against a
// price item. The same price as that store's latest only moves its date forward;
// an older date, or a different price or size, adds to the history.
// Returns { action: "added" | "date" | "same" | "none", priceId, previousDate, note }.
function apiRecordObservedPrice_(priceItemId, vendor, each, size, unit, dateText, source, user) {
   if (!priceItemId) return { action: "none", note: "no price item" };
   if (each === "" || each === null || each === undefined || isNaN(Number(each))) return { action: "none", note: "no price" };
   if (!size || !unit) return { action: "none", note: "no size" };
   if (!String(vendor || "").trim()) return { action: "none", note: "no vendor" };
   if (!(dateText instanceof Date) && !String(dateText || "").trim()) return { action: "none", note: "no date" };
   vendor = String(vendor).trim();
   each = Math.round(Number(each) * 100) / 100;
   // The caller may hand over a date or its text ("2026-11-16").
   const date = dateText instanceof Date ? dateText : apiParseDate_(String(dateText).slice(0, 10));
   const dkey = Utilities.formatDate(date, apiSs_().getSpreadsheetTimeZone(), "yyyy-MM-dd");
   const key = p => String(p["Date Gathered"] || "") + " " + String(p["Added At"] || "");
   const latest = apiReadPrices_().filter(p => p["Price Item ID"] === priceItemId && String(p["Location"]).trim().toLowerCase() === vendor.toLowerCase())
      .sort((a, b) => key(b).localeCompare(key(a)))[0];
   const same = latest && Math.abs(Number(latest["Price"]) - each) < 0.005 && Number(latest["Size"]) === Number(size) && latest["Unit"] === unit;
   if (same) {
      const old = String(latest["Date Gathered"] || "");
      if (dkey > old) {
         const changes = apiWriteChanges_(apiPricesSheet_(), latest._row, latest, { "Date Gathered": date });
         apiLog_(user, "Edit", "Prices", latest["Price ID"] + " / " + priceItemId, changes.join("; ") + " — same price on " + source);
         return { priceId: latest["Price ID"], action: "date", previousDate: old };
      }
      return { priceId: latest["Price ID"], action: "same" };
   }
   const added = apiAddPrice_({ item: { priceItemId: priceItemId }, location: vendor, price: each, size: size, unit: unit, date: dkey }, user);
   return { priceId: added.priceId, action: "added" };
}

// Undoes what a saved line did to the price tracker.
function apiUndoLinePrice_(line, receipt, user) {
   const action = String(line["Price Action"] || "");
   const priceId = String(line["Price ID"] || "");
   if (!priceId || (action !== "added" && action !== "date")) return;
   const p = apiReadPrices_().find(r => r["Price ID"] === priceId);
   if (!p) return;   // already deleted in the price tracker
   if (action === "added") {
      apiDeletePrice_({ priceId: priceId }, user);
   } else {
      // Only put the old date back if the price still carries the receipt's date.
      const recDate = String((receipt && receipt["Purchase Date"]) || "").slice(0, 10);
      const prev = String(line["Previous Date"] || "").slice(0, 10);
      if (prev && String(p["Date Gathered"]).slice(0, 10) === recDate) {
         const changes = apiWriteChanges_(apiPricesSheet_(), p._row, p, { "Date Gathered": apiParseDate_(prev) });
         apiLog_(user, "Edit", "Prices", priceId, changes.join("; ") + " — receipt line removed/changed, previous date restored");
      }
   }
}

// Applies lines to a receipt: prices, links, and rows on Receipt Lines. Returns notes for the app.
function apiAddReceiptLines_(receipt, lines, user) {
   const sheet = apiReceiptLinesSheet_();
   const existing = apiReadReceiptLines_();
   let next = existing.reduce((m, r) => { const n = Number(String(r["Line ID"]).replace(/^\D+/, "")); return isNaN(n) ? m : Math.max(m, n); }, 0);
   const toLink = [], skipped = [], notes = [], onHand = [], created = [];
   // Two of the same new tank or piece of equipment become one line (and one record) each,
   // with the line's price split between them.
   const rows = [];
   lines.forEach(line => {
      const n = Math.round(Number(line.qty) || 1);
      if (line.item && line.item.newType && RLINE_UNIQUE_TYPES.indexOf(String(line.item.newType)) !== -1 && n > 1) {
         for (let k = 0; k < n; k++) {
            rows.push(Object.assign({}, line, { qty: 1, price: line.price === "" ? "" : Math.round(line.price / n * 100) / 100 }));
         }
      } else rows.push(line);
   });
   rows.forEach((line, i) => {
      const info = apiLineItemInfo_(line.item, user, receipt["Receipt ID"]);
      if (info.created) created.push(info.created + " " + info.name + (info.movedPrices ? " (" + info.movedPrices + " saved price" + (info.movedPrices === 1 ? "" : "s") + " moved over)" : ""));
      const res = apiApplyLinePrice_(receipt, line, info, user);
      const id = RLINE_CONFIG.prefix + (++next);
      apiAppendRow_(sheet, {
         "Line ID": id, "Receipt ID": receipt["Receipt ID"], "Line No": i + 1, "Record ID": info.recordId, "Price Item ID": info.priceItemId,
         "Item Name": info.name, "Qty": line.qty, "Line Price": line.price, "Size": line.size, "Unit": line.unit,
         "Price ID": res.priceId || "", "Price Action": res.action, "Previous Date": res.previousDate ? apiParseDate_(res.previousDate.slice(0, 10)) : "",
         "Added By": apiWho_(user), "Added At": new Date()
      });
      if (res.note && line.price !== "") notes.push((info.name || "Line " + (i + 1)) + ": not added to prices (" + res.note + ")");
      // Buying it means it's on hand (Treatments.gs).
      const stocked = apiStockOnHandFromReceipt_(info, user);
      if (stocked) onHand.push(stocked);
      // An open wish for this item is now bought (Wishlist.gs).
      const wished = apiWishPurchasedFromLine_(receipt, line, info, user);
      if (wished) notes.push(wished);
      if (info.recordId) toLink.push(info.recordId);
   });
   if (created.length) notes.push("Added to your records: " + created.join(", "));
   // Link records the person may link; skip the rest.
   let linked = [];
   const allowed = toLink.filter((id, i) => toLink.indexOf(id) === i).filter(id => {
      try { apiRequireLinkRights_(user, [id]); return true; } catch (e) { skipped.push(id); return false; }
   });
   if (allowed.length) linked = apiAddReceiptLinks_(apiEnsureReceiptTabs_(), receipt["Receipt ID"], allowed, user);
   if (skipped.length) notes.push("Not linked (not in your tanks; an admin can link them): " + skipped.join(", "));
   if (onHand.length) notes.push("Marked on hand: " + onHand.filter((x, i, a) => a.indexOf(x) === i).join(", "));
   apiLog_(user, "Add lines", "Receipt Lines", receipt["Receipt ID"], rows.length + " line" + (rows.length === 1 ? "" : "s"));
   return { lines: rows.length, linked: linked, notes: notes, created: created };
}

// Removes a receipt's lines, undoing their prices (newest first).
function apiRemoveReceiptLines_(receipt, user) {
   const rows = apiReadReceiptLines_().filter(r => r["Receipt ID"] === receipt["Receipt ID"]);
   rows.slice().reverse().forEach(r => apiUndoLinePrice_(r, receipt, user));
   const sheet = apiSs_().getSheetByName(RLINE_CONFIG.sheetName);
   const gone = sheet ? apiDeleteRowsWhere_(sheet, "Receipt ID", v => String(v).trim() === receipt["Receipt ID"]).count : 0;
   return gone;
}

// req: { id, lines: [...] } — replaces the receipt's lines (Admins).
function apiSaveReceiptLines_(req, user) {
   apiRequireReceipts_(user);
   const receipt = apiReadReceipts_().find(r => r["Receipt ID"] === req.id);
   if (!receipt) throw apiError_("NOT_FOUND", "That receipt no longer exists.");
   const lines = (req.lines || []).map(apiCleanReceiptLine_);
   lines.forEach(l => apiLineItemInfo_(l.item, user));   // check every item before changing anything
   const removed = apiRemoveReceiptLines_(receipt, user);
   const out = lines.length ? apiAddReceiptLines_(receipt, lines, user) : { lines: 0, linked: [], notes: [] };
   if (removed && !lines.length) apiLog_(user, "Delete lines", "Receipt Lines", receipt["Receipt ID"], removed + " line" + (removed === 1 ? "" : "s"));
   return out;
}

// After a receipt's vendor or purchase date changes, its lines' prices are redone.
function apiRedoReceiptLines_(before, after, user) {
   const rows = apiReadReceiptLines_().filter(r => r["Receipt ID"] === before["Receipt ID"]).sort((a, b) => Number(a["Line No"]) - Number(b["Line No"]));
   if (!rows.length) return;
   const lines = rows.map(r => ({
      item: r["Price Item ID"] ? { priceItemId: r["Price Item ID"] } : r["Record ID"] ? { recordId: r["Record ID"] } : { name: r["Item Name"] },
      qty: Number(r["Qty"]) || 1, price: r["Line Price"] === "" ? "" : Number(r["Line Price"]), size: r["Size"] === "" ? "" : Number(r["Size"]), unit: r["Unit"] || ""
   }));
   apiRemoveReceiptLines_(before, user);
   apiAddReceiptLines_(after, lines, user);
}


// Creates the record a receipt line asked for, with just its name; the rest is filled in later.
function apiCreateLineRecord_(type, name, user, receiptId) {
   const def = API_TABLES[type];
   const sheet = apiSheet_(def.sheetKey);
   const id = apiNextId_(type);
   const raw = {};
   if (type === "tanks") raw["Tank Name"] = name;
   else if (type === "medications") raw["Product Name"] = name;
   else if (type === "equipment") {
      // "Fluval M150" becomes Manufacturer "Fluval" + Filter Model "M150" when the name
      // starts with a manufacturer already on the list. Anything else is named by its
      // Category, the way the other gear is ("Stand, Aquarium") — Filter Model is for
      // filters, and its dropdown shouldn't fill up with specimen containers.
      const mans = (apiReadLists_(apiSs_())["Manufacturer"] || []).slice().sort((a, b) => String(b).length - String(a).length);
      const hit = mans.find(m => String(m) && name.toLowerCase().indexOf(String(m).toLowerCase() + " ") === 0);
      if (hit) { raw["Manufacturer"] = hit; raw["Filter Model"] = name.slice(String(hit).length).trim(); }
      else raw["Category"] = name;
   } else raw["Common Name"] = name;
   if (apiHasHeader_(sheet, "Status")) raw["Status"] = "Active";
   // The same checks the Add form runs: a value that's new to a dropdown is added to
   // its list first (Lists.gs), so the sheet's own validation accepts it.
   const values = apiCleanValues_(type, raw, user);
   values[def.id] = id;
   apiAppendRow_(sheet, values);
   apiLog_(user, "Add", def.label, id, apiDescribe_(values) + " — from receipt " + receiptId);
   return id;
}

// Moves a typed price item's prices onto a record's price item, then removes the typed one.
// Returns how many prices moved.
function apiMergeTypedPriceItem_(name, recordId, user) {
   const typed = apiReadPriceItems_().find(r => !r["Record ID"] && String(r["Item Name"]).trim().toLowerCase() === name.toLowerCase());
   if (!typed) return 0;
   const target = apiPriceItemFor_({ recordId: recordId }, user);
   if (target.id === typed["Price Item ID"]) return 0;
   const prices = apiPricesSheet_();
   let moved = 0;
   apiReadPrices_().filter(p => p["Price Item ID"] === typed["Price Item ID"]).forEach(p => {
      apiWriteChanges_(prices, p._row, p, { "Price Item ID": target.id });
      moved++;
   });
   const lineSheet = apiSs_().getSheetByName(RLINE_CONFIG.sheetName);
   if (lineSheet) {
      apiReadReceiptLines_().filter(l => l["Price Item ID"] === typed["Price Item ID"])
         .forEach(l => apiWriteChanges_(lineSheet, l._row, l, { "Price Item ID": target.id, "Record ID": recordId }));
   }
   // The typed item's picture becomes the record's list picture if it hasn't got one.
   const rec = apiPriceRecord_(recordId);
   if (typed["Picture URL"] && rec && apiHasHeader_(apiSheet_(API_TABLES[rec.table].sheetKey), "Thumbnail URL") && !String(rec.rec["Thumbnail URL"] || "")) {
      apiSetThumbnail_(user, rec.table, rec.rec, typed["Picture URL"]);
   }
   apiDeleteRowsWhere_(apiPriceItemsSheet_(), "Price Item ID", v => String(v).trim() === typed["Price Item ID"]);
   apiLog_(user, "Merge", PRICE_CONFIG.itemsSheet, typed["Price Item ID"],
           "“" + name + "” merged into " + recordId + " (" + target.id + "); " + moved + " price" + (moved === 1 ? "" : "s") + " moved");
   return moved;
}


// Removes receipt lines that point at a record or price item that no longer exists.
// Their prices are already gone with the record, so nothing is undone here.
function apiRemoveReceiptLinesFor_(header, id) {
   const sheet = apiTabOrNull_(RLINE_CONFIG.sheetName);
   if (!sheet) return 0;
   return apiDeleteRowsWhere_(sheet, header, v => String(v).trim() === String(id).trim()).count;
}
