// ============================================================
// AYERS AQUARIUMS - SHEET ENTRY FORMS
// Add Species, Add Tank, Add Equipment, Add Plant, Add Medication,
// Add Water Parameter (run from the "Processing" menu, see OnOpen.gs).
//
// Each form works the same way: labels in column A of the form tab
// are matched to header names (row 1) on each destination tab, and
// the value in column B is written under that header.
//
// SHEET_IDS is also used by the web app (Api.gs) to find each tab.
// Sheet IDs are the numbers after #gid= in each tab's URL, so tabs
// can be renamed without breaking anything.
// ============================================================

// Tab IDs (the number after #gid= in the tab's URL) for the forms and data tabs.
const SHEET_IDS = {
   addSpecies:        554419465,
   addTank:           71532960,
   species:           526685297,
   tank:              1037277526,
   addEquipment:      1971958447,
   addPlant:          1460954477,
   addMedication:     963215836,
   addWaterParameter: 838445659,
   equipment:         1741790309,
   plants:            547150186,
   medications:       1839526114,
   waterParameters:   767978537,
   tankAssignments:   1509314986
};


// Menu: Add New Species. Saves the Add Species tab to Species and,
// when a tank is chosen, also adds it to that tank (Tank Assignments).
function addNewSpecies() {
   submitEntryForm_({
      entrySheetId: SHEET_IDS.addSpecies,
      destinations: [
         { sheetId: SHEET_IDS.species },
         { sheetId: SHEET_IDS.tankAssignments,
           requiredFields: ["Tank ID", "Item ID"] }
      ],
      clearFields: [
         "Tank", "Common Name", "Scientific Name", "Category",
         "Ideal Temperature", "Temp Min °F", "Temp Max °F", "Water Zone",
         "Group Type", "Recommended Group", "Primary Food Options",
         "Adult Size", "Max Size (in)", "Temperament", "Difficulty",
         "Phone Doc URL", "Thumbnail URL", "QR Code URL", "Print Doc URL"
      ],
      confirmationFields: ["Common Name"]
   });
}


// Menu: Add New Tank. Saves the Add Tank tab to the Tank tab.
function addNewTank() {
   submitEntryForm_({
      entrySheetId: SHEET_IDS.addTank,
      destinations: [
         { sheetId: SHEET_IDS.tank }
      ],
      clearFields: [
         "Tank Name", "Volume (gal)", "Tank Width", "Tank Height",
         "Tank Depth", "Lid Width", "Lid Depth", "Manufacturer", "Notes",
         "Purchase Date", "Vendor", "Cost", "Warranty Length",
         "Warranty Expires"
      ],
      confirmationFields: ["Tank Name"]
   });
}


// Menu: Add New Equipment. Saves the Add Equipment tab to Equipment and,
// when a tank is chosen, also adds it to that tank (Tank Assignments).
function addNewEquipment() {
   submitEntryForm_({
      entrySheetId: SHEET_IDS.addEquipment,
      requiredFields: ["Category"],
      destinations: [
         { sheetId: SHEET_IDS.equipment },
         { sheetId: SHEET_IDS.tankAssignments,
           requiredFields: ["Tank ID", "Item ID"],
           excludeFields: ["Notes"] }   // equipment notes stay on Equipment
      ],
      clearFields: [
         "Tank", "Category", "Manufacturer", "Filter Model", "Vendor",
         "Width", "Height", "Depth", "Measurement Notes", "Notes",
         "Purchase Date", "Serial Number", "Vendor Link",
         "Equipment Doc URL", "Thumbnail URL", "QR Code URL"
      ],
      confirmationFields: ["Equipment ID", "Category"]
   });
}


// Menu: Add New Plant. Saves the Add Plant tab to Plants and, when a
// tank is chosen, also adds it to that tank (Tank Assignments).
function addNewPlant() {
   submitEntryForm_({
      entrySheetId: SHEET_IDS.addPlant,
      requiredFields: ["Common Name"],
      destinations: [
         { sheetId: SHEET_IDS.plants },
         { sheetId: SHEET_IDS.tankAssignments,
           requiredFields: ["Tank ID", "Item ID"] }
      ],
      clearFields: [
         "Tank", "Common Name", "Scientific Name", "Placement", "Light",
         "CO2", "Primary Nutrient Source", "Difficulty", "Plant Doc URL",
         "Thumbnail URL", "QR Code URL"
      ],
      confirmationFields: ["Common Name"]
   });
}


// Menu: Add New Medication / Supplement. Saves the Add Medication tab
// to Medication and Supplements.
function addNewMedication() {
   submitEntryForm_({
      entrySheetId: SHEET_IDS.addMedication,
      requiredFields: ["Product Name"],
      destinations: [
         { sheetId: SHEET_IDS.medications }
      ],
      clearFields: [
         "Product Name", "Manufacturer", "Product Type", "Primary Purpose",
         "Conditions / Issues", "Search Keywords", "Water Type",
         "Standard Dose", "Frequency / Duration", "Initial / Special Dose",
         "Effect on Water Parameters", "Fish Safe", "Shrimp Safe",
         "Snail Safe", "Plant Safe", "Biofilter Safe",
         "Remove Carbon / Chemical Media", "UV Sterilizer",
         "Water Change Requirements", "Active / Key Ingredients",
         "Important Warnings / Notes", "Stores", "Product Page"
      ],
      confirmationFields: ["Product Name"]
   });
}


// Menu: Add Water Parameter. Saves a tank's target range from the Add
// Water Parameter tab to Water Parameters.
function addWaterParameter() {
   submitEntryForm_({
      entrySheetId: SHEET_IDS.addWaterParameter,
      requiredFields: ["Tank ID", "Parameter"],
      destinations: [
         { sheetId: SHEET_IDS.waterParameters }
      ],
      // Tank is kept so several parameters can be entered for one tank.
      clearFields: [
         "Parameter", "Target", "Acceptable Min", "Acceptable Max",
         "Units", "Notes"
      ],
      confirmationFields: ["Tank ID", "Parameter"]
   });
}


// ============================================================
// SHARED ENGINE
//
// cfg.entrySheetId      form tab ID
// cfg.requiredFields    form labels that must have a value, or
//                       nothing is written anywhere
// cfg.destinations      [{ sheetId, requiredFields?, excludeFields? }]
//                       requiredFields: skip only this destination
//                       if any are blank
//                       excludeFields: form labels not written to
//                       this destination even if a header matches
// cfg.clearFields       form labels cleared after a successful entry
// cfg.confirmationFields form labels shown in the confirmation
// ============================================================

// Reads one form tab, writes a new row to each destination tab, clears
// the form and shows a confirmation (or explains what was missing).
function submitEntryForm_(cfg) {
   const ss = SpreadsheetApp.getActiveSpreadsheet();
   const ui = SpreadsheetApp.getUi();

   const LABEL_COLUMN = 1;      // column A: field labels
   const VALUE_COLUMN = 2;      // column B: values typed in
   const ENTRY_START_ROW = 3;   // first form row under the tab's title
   const DEST_HEADER_ROW = 1;   // destination headers are in row 1
   const DEST_FORMAT_ROW = 2;   // row 2 is the formatting template

   const isBlank = v => v === "" || v === null || v === undefined;


   // ---------------- Entry form ----------------

   const entrySheet = ss.getSheetById(cfg.entrySheetId);

   if (!entrySheet) {
      ui.alert("Entry Sheet Not Found",
         "The form tab with ID " + cfg.entrySheetId + " could not be found.",
         ui.ButtonSet.OK);
      return;
   }

   const entryLastRow = entrySheet.getLastRow();

   if (entryLastRow < ENTRY_START_ROW) {
      ui.alert("No Entry Data", "No entry form fields were found.", ui.ButtonSet.OK);
      return;
   }

   const entryData = entrySheet
      .getRange(ENTRY_START_ROW, LABEL_COLUMN, entryLastRow - ENTRY_START_ROW + 1, 2)
      .getValues();

   // Label (lower case) -> value, for quick lookups.
   const entryMap = {};

   entryData.forEach(row => {
      const label = String(row[0]).trim();
      if (label !== "") entryMap[label.toLowerCase()] = row[1];
   });

   // Labels from the list that are blank on the form.
   const missing = fields =>
      (fields || []).filter(f => isBlank(entryMap[f.toLowerCase()]));


   // ---------------- Required for any write ----------------

   const missingRequired = missing(cfg.requiredFields);

   if (missingRequired.length > 0) {
      ui.alert("Record Not Inserted",
         "Please fill in: " + missingRequired.join(", ") + ".",
         ui.ButtonSet.OK);
      return;
   }


   // ---------------- Destination tabs ----------------

   const destinations = [];

   for (const d of cfg.destinations) {
      const sheet = ss.getSheetById(d.sheetId);

      if (!sheet) {
         ui.alert("Destination Sheet Not Found",
            "The destination tab with ID " + d.sheetId + " could not be found.",
            ui.ButtonSet.OK);
         return;
      }

      destinations.push({ sheet: sheet, requiredFields: d.requiredFields,
                          excludeFields: d.excludeFields });
   }


   // ---------------- Write records ----------------

   const sheetsUpdated = [];
   const sheetsSkipped = [];

   destinations.forEach(d => {
      const sheet = d.sheet;

      // Skip this tab only (e.g. no tank chosen -> no Tank Assignments row).
      const missingHere = missing(d.requiredFields);

      if (missingHere.length > 0) {
         sheetsSkipped.push(sheet.getName() + " (missing " + missingHere.join(", ") + ")");
         return;
      }

      const lastColumn = sheet.getLastColumn();
      if (lastColumn < 1) return;

      // Header name (lower case) -> column index.
      const headers = sheet.getRange(DEST_HEADER_ROW, 1, 1, lastColumn).getValues()[0];
      const headerMap = {};

      headers.forEach((header, index) => {
         const name = String(header).trim();
         if (name !== "") headerMap[name.toLowerCase()] = index;
      });

      // Build the new row from every form label that matches a header.
      const exclude = new Set((d.excludeFields || []).map(f => f.toLowerCase()));
      const newRowData = new Array(lastColumn).fill("");
      let fieldsMatched = 0;

      entryData.forEach(row => {
         const label = String(row[0]).trim().toLowerCase();
         if (label === "" || exclude.has(label)) return;

         const headerIndex = headerMap[label];

         if (headerIndex !== undefined) {
            newRowData[headerIndex] = row[1];
            fieldsMatched++;
         }
      });

      if (fieldsMatched === 0) return;

      // First data row is row 2; after that, append below the last row.
      const newRow = Math.max(sheet.getLastRow() + 1, DEST_HEADER_ROW + 1);

      if (newRow > sheet.getMaxRows()) {
         sheet.insertRowAfter(sheet.getMaxRows());
      }

      const newRowRange = sheet.getRange(newRow, 1, 1, lastColumn);

      // Copy row 2 formatting to new rows (row 2 is the template row).
      if (newRow > DEST_FORMAT_ROW) {
         sheet.getRange(DEST_FORMAT_ROW, 1, 1, lastColumn)
            .copyTo(newRowRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      }

      newRowRange.setValues([newRowData]);
      sheetsUpdated.push(sheet.getName());
   });


   // ---------------- Nothing written ----------------

   if (sheetsUpdated.length === 0) {
      ui.alert("Record Not Inserted",
         sheetsSkipped.length > 0
            ? "Nothing was added. Skipped: " + sheetsSkipped.join("; ") + "."
            : "No form labels matched headers on any destination tab.",
         ui.ButtonSet.OK);
      return;
   }

   SpreadsheetApp.flush();


   // ---------------- Confirmation text ----------------

   const recordName = (cfg.confirmationFields || [])
      .map(f => entryMap[f.toLowerCase()])
      .filter(v => !isBlank(v))
      .join(" ");

   const destinationText = sheetsUpdated.length === 1
      ? sheetsUpdated[0] + " sheet"
      : sheetsUpdated.slice(0, -1).join(", ") + " and " +
        sheetsUpdated[sheetsUpdated.length - 1] + " sheets";

   let message = (recordName !== "" ? recordName : "Record") +
      " added to " + destinationText + ".";

   if (sheetsSkipped.length > 0) {
      message += "\n\nNot added to: " + sheetsSkipped.join("; ") + ".";
   }


   // ---------------- Clear form ----------------

   const clearSet = new Set((cfg.clearFields || []).map(f => f.toLowerCase()));

   entryData.forEach((row, index) => {
      const label = String(row[0]).trim().toLowerCase();
      if (clearSet.has(label)) {
         entrySheet.getRange(ENTRY_START_ROW + index, VALUE_COLUMN).clearContent();
      }
   });

   SpreadsheetApp.flush();

   ui.alert("Record Inserted", message, ui.ButtonSet.OK);
}
