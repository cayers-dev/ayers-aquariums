// ============================================================
// TREATMENTS (medication courses) and STOCK
//   Treatments tab:       one row per course — tank, medication, dose, how often,
//                         how many doses (blank = ongoing), reason, water change, notes.
//   Treatment Doses tab:  one row per dose given.
//   Stock:                a manual "Stock" field (On hand / Need to order / Out of stock)
//                         on medications and on typed price-tracker items. Receipt lines
//                         set it to "On hand".
// Admins can change anything; Editors their own tanks. Everyone signed in can look.
// ============================================================

const TRT_CONFIG = {
   sheetName: "Treatments",
   prefix: "TRT-",
   headers: ["Treatment ID", "Tank ID", "Product ID", "Reason", "Dose Amount", "Dose Unit", "Every Days", "Total Doses",
             "Start Date", "Water Change", "Remove Carbon", "Notes", "Status", "Started By", "Started At", "Ended At"],
   dosesSheetName: "Treatment Doses",
   dosePrefix: "TD-",
   doseHeaders: ["Dose ID", "Treatment ID", "Tank ID", "Product ID", "Dose No", "Dose Amount", "Dose Unit", "Given At", "Given By", "Notes"],
   statuses: ["Active", "Completed", "Stopped"],
   unitList: "Dose Unit",
   stockList: "Stock Status"
};

function apiTreatmentsSheet_() {
   return apiPriceTab_(TRT_CONFIG.sheetName, TRT_CONFIG.headers, { 4: 200, 12: 240 },
                       { "I2:I": "m/d/yyyy", "O2:O": "m/d/yyyy h:mm am/pm", "P2:P": "m/d/yyyy h:mm am/pm" });
}
function apiTreatmentDosesSheet_() {
   return apiPriceTab_(TRT_CONFIG.dosesSheetName, TRT_CONFIG.doseHeaders, { 10: 240 }, { "H2:H": "m/d/yyyy h:mm am/pm" });
}
const apiReadTreatments_ = () => apiReadPriceTab_(TRT_CONFIG.sheetName, "Treatment ID");
const apiReadTreatmentDoses_ = () => apiReadPriceTab_(TRT_CONFIG.dosesSheetName, "Dose ID");

// `lists` comes from the caller (apiBootstrap_ has already read them).
function apiTreatmentsBootstrap_(lists) {
   const strip = r => { const o = Object.assign({}, r); delete o._row; return o; };
   lists = lists || apiReadLists_(apiSs_());
   return { treatments: apiReadTreatments_().map(strip), treatmentDoses: apiReadTreatmentDoses_().map(strip),
            doseUnits: lists[TRT_CONFIG.unitList] || [], stockOptions: lists[TRT_CONFIG.stockList] || [] };
}

function apiRequireTankEdit_(user, tankId) {
   if (!tankId) throw apiError_("INVALID", "Choose a tank.");
   if (!apiCanEditTank_(user, tankId)) throw apiError_("FORBIDDEN", "You can't change treatments for that tank.");
   if (!apiFindById_("tanks", tankId)) throw apiError_("INVALID", "Tank " + tankId + " doesn't exist.");
}

// Checks the fields shared by adding and editing a course.
function apiCleanTreatment_(raw, user) {
   const num = v => String(v === undefined || v === null ? "" : v).replace(/[,\s]/g, "");
   const amount = Number(num(raw.doseAmount));
   if (num(raw.doseAmount) === "" || isNaN(amount) || amount <= 0) throw apiError_("INVALID", "Enter the dose as a number above 0, like 5.");
   const unit = String(raw.doseUnit || "").replace(/\s+/g, " ").trim();
   if (!unit) throw apiError_("INVALID", "Choose or type a dose unit, like mL.");
   const every = Number(num(raw.everyDays));
   if (num(raw.everyDays) === "" || isNaN(every) || every < 1) throw apiError_("INVALID", "Enter how often as a whole number of days, like 2.");
   const total = num(raw.totalDoses) === "" ? "" : Number(num(raw.totalDoses));
   if (total !== "" && (isNaN(total) || total < 1)) throw apiError_("INVALID", "Leave the number of doses blank for an ongoing treatment, or enter 1 or more.");
   if (!raw.startDate) throw apiError_("INVALID", "Enter the start date.");
   return {
      "Product ID": String(raw.productId || "").trim(),
      "Reason": String(raw.reason || "").replace(/\s+/g, " ").trim(),
      "Dose Amount": Math.round(amount * 1000) / 1000,
      "Dose Unit": apiTreatmentUnit_(unit, user),
      "Every Days": Math.round(every),
      "Total Doses": total === "" ? "" : Math.round(total),
      "Start Date": apiParseDate_(String(raw.startDate).slice(0, 10)),
      "Water Change": String(raw.waterChange || "").replace(/\s+/g, " ").trim(),
      "Remove Carbon": raw.removeCarbon === true || String(raw.removeCarbon).toUpperCase() === "TRUE",
      "Notes": String(raw.notes || "").trim()
   };
}

// The dose unit as spelled on the Dose Unit list; an Admin's new unit is added to it.
function apiTreatmentUnit_(unit, user) {
   const list = apiReadLists_(apiSs_())[TRT_CONFIG.unitList] || [];
   const hit = list.find(o => String(o).toLowerCase() === unit.toLowerCase());
   if (hit !== undefined) return hit;
   if (user && user.role === "Admin") return apiEnsureLookupValue_(TRT_CONFIG.unitList, unit, user);
   if (list.length) throw apiError_("INVALID", "Dose unit must be one of: " + list.join(", ") + ".");
   return unit;
}

// req: { tankId, productId, reason, doseAmount, doseUnit, everyDays, totalDoses, startDate, waterChange, removeCarbon, notes }
function apiAddTreatment_(req, user) {
   apiRequireTankEdit_(user, String(req.tankId || "").trim());
   const values = apiCleanTreatment_(req, user);
   const med = apiFindById_("medications", values["Product ID"]);
   if (!med) throw apiError_("INVALID", "Choose a medication or supplement.");
   const sheet = apiTreatmentsSheet_();
   const id = apiNextPriceId_(apiReadTreatments_(), "Treatment ID", TRT_CONFIG.prefix);
   const row = Object.assign({ "Treatment ID": id, "Tank ID": req.tankId }, values,
                             { "Status": "Active", "Started By": apiWho_(user), "Started At": new Date(), "Ended At": "" });
   apiAppendRow_(sheet, row);
   apiLog_(user, "Add", TRT_CONFIG.sheetName, id, req.tankId + " / " + values["Product ID"] + " · " +
           values["Dose Amount"] + " " + values["Dose Unit"] + " every " + values["Every Days"] + " day(s)" +
           (values["Total Doses"] === "" ? " (ongoing)" : " × " + values["Total Doses"]));
   return { added: id };
}

// req: { id, ...the same fields }
function apiUpdateTreatment_(req, user) {
   const rec = apiReadTreatments_().find(r => r["Treatment ID"] === req.id);
   if (!rec) throw apiError_("NOT_FOUND", "That treatment no longer exists.");
   apiRequireTankEdit_(user, rec["Tank ID"]);
   const values = apiCleanTreatment_(Object.assign({ productId: rec["Product ID"] }, req), user);
   delete values["Product ID"];   // the medication is fixed once the course has started
   const changes = apiWriteChanges_(apiTreatmentsSheet_(), rec._row, rec, values);
   if (changes.length) apiLog_(user, "Edit", TRT_CONFIG.sheetName, rec["Treatment ID"], changes.join("; "));
   return { updated: changes.length };
}

// req: { id, status } — Stopped, Completed or back to Active.
function apiSetTreatmentStatus_(req, user) {
   const rec = apiReadTreatments_().find(r => r["Treatment ID"] === req.id);
   if (!rec) throw apiError_("NOT_FOUND", "That treatment no longer exists.");
   apiRequireTankEdit_(user, rec["Tank ID"]);
   const status = TRT_CONFIG.statuses.indexOf(String(req.status)) !== -1 ? String(req.status) : "";
   if (!status) throw apiError_("INVALID", "Status must be one of: " + TRT_CONFIG.statuses.join(", ") + ".");
   const changes = apiWriteChanges_(apiTreatmentsSheet_(), rec._row, rec,
                                    { "Status": status, "Ended At": status === "Active" ? "" : new Date() });
   if (changes.length) apiLog_(user, "Edit", TRT_CONFIG.sheetName, rec["Treatment ID"], changes.join("; "));
   return { updated: changes.length };
}

// req: { id } — the course and every dose logged on it (permanent).
function apiDeleteTreatment_(req, user) {
   const rec = apiReadTreatments_().find(r => r["Treatment ID"] === req.id);
   if (!rec) throw apiError_("NOT_FOUND", "That treatment no longer exists.");
   apiRequireTankEdit_(user, rec["Tank ID"]);
   const doses = apiDeleteRowsWhere_(apiTabOrNull_(TRT_CONFIG.dosesSheetName), "Treatment ID", v => String(v).trim() === rec["Treatment ID"]).count;
   apiDeleteRowsWhere_(apiTreatmentsSheet_(), "Treatment ID", v => String(v).trim() === rec["Treatment ID"]);
   apiLog_(user, "Delete", TRT_CONFIG.sheetName, rec["Treatment ID"],
           rec["Tank ID"] + " / " + rec["Product ID"] + " — also deleted " + doses + " dose" + (doses === 1 ? "" : "s"));
   return { deleted: rec["Treatment ID"], doses: doses };
}

// req: { treatmentId, givenAt, doseAmount?, doseUnit?, notes? }
function apiLogDose_(req, user) {
   const rec = apiReadTreatments_().find(r => r["Treatment ID"] === req.treatmentId);
   if (!rec) throw apiError_("NOT_FOUND", "That treatment no longer exists.");
   apiRequireTankEdit_(user, rec["Tank ID"]);
   if (String(rec["Status"]) !== "Active") throw apiError_("INVALID", "That treatment isn't running. Start it again to log more doses.");
   const given = req.givenAt ? apiParseDateTime_(req.givenAt) : new Date();
   const amount = String(req.doseAmount === undefined || req.doseAmount === "" ? rec["Dose Amount"] : req.doseAmount).replace(/[,\s]/g, "");
   if (isNaN(Number(amount)) || Number(amount) <= 0) throw apiError_("INVALID", "The dose must be a number above 0.");
   const doses = apiReadTreatmentDoses_().filter(d => d["Treatment ID"] === rec["Treatment ID"]);
   const no = doses.length + 1;
   const id = apiNextPriceId_(apiReadTreatmentDoses_(), "Dose ID", TRT_CONFIG.dosePrefix);
   apiAppendRow_(apiTreatmentDosesSheet_(), {
      "Dose ID": id, "Treatment ID": rec["Treatment ID"], "Tank ID": rec["Tank ID"], "Product ID": rec["Product ID"],
      "Dose No": no, "Dose Amount": Number(amount), "Dose Unit": req.doseUnit ? apiTreatmentUnit_(String(req.doseUnit).trim(), user) : rec["Dose Unit"],
      "Given At": given, "Given By": apiWho_(user), "Notes": String(req.notes || "").trim()
   });
   apiLog_(user, "Log dose", TRT_CONFIG.dosesSheetName, id, rec["Treatment ID"] + " · dose " + no + " · " + amount + " " + rec["Dose Unit"]);
   // The last dose of a course with a set number finishes it.
   let finished = false;
   if (rec["Total Doses"] !== "" && no >= Number(rec["Total Doses"])) {
      apiWriteChanges_(apiTreatmentsSheet_(), rec._row, rec, { "Status": "Completed", "Ended At": new Date() });
      apiLog_(user, "Edit", TRT_CONFIG.sheetName, rec["Treatment ID"], "Status: Active → Completed (last dose given)");
      finished = true;
   }
   return { doseId: id, doseNo: no, finished: finished };
}

// req: { doseId, givenAt?, doseAmount?, notes? }
function apiUpdateDose_(req, user) {
   const d = apiReadTreatmentDoses_().find(x => x["Dose ID"] === req.doseId);
   if (!d) throw apiError_("NOT_FOUND", "That dose no longer exists.");
   apiRequireTankEdit_(user, d["Tank ID"]);
   const values = {};
   if (req.givenAt) values["Given At"] = apiParseDateTime_(req.givenAt);
   if (req.doseAmount !== undefined && req.doseAmount !== "") {
      const a = String(req.doseAmount).replace(/[,\s]/g, "");
      if (isNaN(Number(a)) || Number(a) <= 0) throw apiError_("INVALID", "The dose must be a number above 0.");
      values["Dose Amount"] = Number(a);
   }
   if (req.notes !== undefined) values["Notes"] = String(req.notes || "").trim();
   const changes = apiWriteChanges_(apiTreatmentDosesSheet_(), d._row, d, values);
   if (changes.length) apiLog_(user, "Edit", TRT_CONFIG.dosesSheetName, d["Dose ID"], changes.join("; "));
   return { updated: changes.length };
}

// req: { doseId } — removes the dose and renumbers the ones after it.
function apiDeleteDose_(req, user) {
   const all = apiReadTreatmentDoses_();
   const d = all.find(x => x["Dose ID"] === req.doseId);
   if (!d) throw apiError_("NOT_FOUND", "That dose no longer exists.");
   apiRequireTankEdit_(user, d["Tank ID"]);
   const sheet = apiTreatmentDosesSheet_();
   apiDeleteRowsWhere_(sheet, "Dose ID", v => String(v).trim() === d["Dose ID"]);
   apiReadTreatmentDoses_().filter(x => x["Treatment ID"] === d["Treatment ID"])
      .sort((a, b) => Number(a["Dose No"]) - Number(b["Dose No"]))
      .forEach((x, i) => { if (Number(x["Dose No"]) !== i + 1) apiWriteChanges_(sheet, x._row, x, { "Dose No": i + 1 }); });
   apiLog_(user, "Delete", TRT_CONFIG.dosesSheetName, d["Dose ID"], d["Treatment ID"] + " · dose " + d["Dose No"]);
   // A finished course with a dose removed is running again.
   const rec = apiReadTreatments_().find(r => r["Treatment ID"] === d["Treatment ID"]);
   if (rec && String(rec["Status"]) === "Completed" && rec["Total Doses"] !== "" &&
       apiReadTreatmentDoses_().filter(x => x["Treatment ID"] === rec["Treatment ID"]).length < Number(rec["Total Doses"])) {
      apiWriteChanges_(apiTreatmentsSheet_(), rec._row, rec, { "Status": "Active", "Ended At": "" });
      apiLog_(user, "Edit", TRT_CONFIG.sheetName, rec["Treatment ID"], "Status: Completed → Active (a dose was removed)");
   }
   return { deleted: d["Dose ID"] };
}

// Removes every treatment and dose for a tank or medication (used when one is deleted).
function apiDeleteTreatmentsWhere_(header, id, user) {
   const is = v => String(v).trim() === id;
   const rows = apiReadTreatments_().filter(r => is(r[header]));
   const doseIds = {};
   rows.forEach(r => doseIds[r["Treatment ID"]] = true);
   const doses = apiDeleteRowsWhere_(apiTabOrNull_(TRT_CONFIG.dosesSheetName), "Treatment ID", v => !!doseIds[String(v).trim()]).count +
                 apiDeleteRowsWhere_(apiTabOrNull_(TRT_CONFIG.dosesSheetName), header, is).count;
   const gone = apiDeleteRowsWhere_(apiTabOrNull_(TRT_CONFIG.sheetName), header, is).count;
   return gone + doses;
}


// ------------------------------------------------------------
// Stock (medications and typed price-tracker items)
// ------------------------------------------------------------

// req: { recordId } or { priceItemId }, plus { stock }
function apiSetStock_(req, user) {
   apiRequirePrices_(user);   // admins and editors
   const stock = String(req.stock || "").replace(/\s+/g, " ").trim();
   const list = apiReadLists_(apiSs_())[TRT_CONFIG.stockList] || [];
   const value = stock === "" ? "" : (list.find(o => String(o).toLowerCase() === stock.toLowerCase()) ||
      (user.role === "Admin" ? apiEnsureLookupValue_(TRT_CONFIG.stockList, stock, user) : null));
   if (value === null) throw apiError_("INVALID", "Stock must be one of: " + list.join(", ") + ".");
   if (req.priceItemId) {
      const rec = apiReadPriceItems_().find(r => r["Price Item ID"] === req.priceItemId);
      if (!rec) throw apiError_("NOT_FOUND", "That item is no longer in the price tracker.");
      if (rec["Record ID"]) return apiSetStock_({ recordId: rec["Record ID"], stock: value }, user);
      const changes = apiWriteChanges_(apiPriceItemsSheet_(), rec._row, rec, { "Stock": value });
      if (changes.length) apiLog_(user, "Edit", PRICE_CONFIG.itemsSheet, rec["Price Item ID"], changes.join("; "));
      return { updated: changes.length };
   }
   const id = String(req.recordId || "").trim();
   const med = apiFindById_("medications", id);
   if (!med) throw apiError_("INVALID", "Stock is kept for medications and typed price-tracker items.");
   const sheet = apiSheet_(API_TABLES.medications.sheetKey);
   apiEnsureColumn_(sheet, "Stock");
   const changes = apiWriteChanges_(sheet, med._row, med, { "Stock": value });
   if (changes.length) apiLog_(user, "Edit", API_TABLES.medications.label, id, changes.join("; "));
   return { updated: changes.length };
}

// Adds a column to the end of a tab if it isn't there yet.
function apiEnsureColumn_(sheet, header) {
   const last = Math.max(sheet.getLastColumn(), 1);
   const have = sheet.getRange(1, 1, 1, last).getValues()[0].map(h => String(h).trim());
   if (have.indexOf(header) !== -1) return have.indexOf(header) + 1;
   // A tab trimmed to exactly its columns has no spare one to write in.
   if (sheet.getMaxColumns() <= last) sheet.insertColumnAfter(last);
   sheet.getRange(1, last + 1).setValue(header).setFontWeight("bold").setBackground("#d9d9d9");
   return last + 1;
}

// A receipt line for a medication or a typed price item marks it as on hand (ReceiptLines.gs).
function apiStockOnHandFromReceipt_(info, user) {
   const list = apiReadLists_(apiSs_())[TRT_CONFIG.stockList] || [];
   const onHand = list.find(o => /on hand/i.test(String(o)));
   if (!onHand) return "";
   try {
      if (info.recordId) {
         const med = apiFindById_("medications", info.recordId);
         if (!med || String(med["Stock"] || "") === onHand) return "";
         apiSetStock_({ recordId: info.recordId, stock: onHand }, user);
         return info.name || info.recordId;
      }
      if (info.priceItemId) {
         const rec = apiReadPriceItems_().find(r => r["Price Item ID"] === info.priceItemId);
         if (!rec || rec["Record ID"] || String(rec["Stock"] || "") === onHand) return "";
         apiSetStock_({ priceItemId: info.priceItemId, stock: onHand }, user);
         return info.name || info.priceItemId;
      }
   } catch (e) { /* stock is a convenience: never block the receipt */ }
   return "";
}
