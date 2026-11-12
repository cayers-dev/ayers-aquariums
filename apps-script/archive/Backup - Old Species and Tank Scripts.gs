// ============================================================
// BACKUP of New Species.gs and New Tank.gs, saved 11/11/2026, 7:09:40 AM,
// before they were moved into Entry Forms.gs.
// Everything below is commented out, so none of it runs.
// To restore: create a new script file, paste the code, and remove the leading "// " from each line.
// Safe to delete once the new Add Species / Add Tank menu items have been tested.
// ============================================================

// ------------------------- New Species.gs -------------------------
// function addNewSpecies() {
//    const ss = SpreadsheetApp.getActiveSpreadsheet();
//    const ui = SpreadsheetApp.getUi();
// 
//    // ============================================================
//    // CONFIGURATION
//    // ============================================================
// 
//    const ENTRY_SHEET_ID = 554419465;  //The tab numbers are locatede at the end of the url following #gid=
// 
//    const DESTINATION_SHEET_IDS = [
//       526685297,  //Species
//       1509314986  //Tank Species
//    ];
// 
//    /*
//     * Fields that must have a value before a record is written to a
//     * destination sheet. If any are blank, that sheet is skipped.
//     * Keys are destination sheet IDs; values are Entry sheet labels.
//     */
//    const REQUIRED_FIELDS = {
//       1509314986: ["Tank ID", "Item ID"]  //Tank Assignments
//    };
// 
//    const LABEL_COLUMN = 1;          // Column A
//    const VALUE_COLUMN = 2;          // Column B
//    const ENTRY_START_ROW = 3;
// 
//    const DEST_HEADER_ROW = 1;
//    const DEST_FORMAT_ROW = 2;
// 
//    /*
//     * Entry fields to clear after all records are inserted.
//     * Values must match the labels in Column A of the Entry sheet.
//     */
//    const CLEAR_FIELDS = [
//         "Tank"
//       , "Common Name"
//       , "Scientific Name"
//       , "Category"
//       , "Ideal Temperature"
//       , "Temp Min °F"
//       , "Temp Max °F"
//       , "Water Zone"
//       , "Group Type"
//       , "Recommended Group"
//       , "Primary Food Options"
//       , "Adult Size"
//       , "Max Size (in)"
//       , "Temperament"
//       , "Difficulty"
//       , "Phone Doc URL"
//       , "Thumbnail URL"
//       , "QR Code URL"
//       , "Print Doc URL"
//       
//    ];
// 
//    /*
//     * Entry fields used for the confirmation message.
//     *
//     * Example:
//     * John Smith added to Employees and Assignments sheets.
//     */
//    const CONFIRMATION_FIELDS = [
//         "Common Name"
//    ];
// 
// 
//    // ============================================================
//    // GET ENTRY SHEET
//    // ============================================================
// 
//    const entrySheet = ss.getSheetById(ENTRY_SHEET_ID);
// 
//    if (!entrySheet) {
//       ui.alert(
//          "Entry Sheet Not Found",
//          `The sheet with ID ${ENTRY_SHEET_ID} could not be found.`,
//          ui.ButtonSet.OK
//       );
//       return;
//    }
// 
// 
//    // ============================================================
//    // GET ENTRY FORM DATA
//    // ============================================================
// 
//    const entryLastRow = entrySheet.getLastRow();
// 
//    if (entryLastRow < ENTRY_START_ROW) {
//       ui.alert(
//          "No Entry Data",
//          "No entry form fields were found.",
//          ui.ButtonSet.OK
//       );
//       return;
//    }
// 
//    const entryData = entrySheet
//       .getRange(
//          ENTRY_START_ROW,
//          LABEL_COLUMN,
//          entryLastRow - ENTRY_START_ROW + 1,
//          2
//       )
//       .getValues();
// 
// 
//    // ============================================================
//    // CREATE ENTRY FIELD LOOKUP
//    // ============================================================
// 
//    /*
//     * Example entryMap:
//     *
//     * {
//     *    "first name": "John",
//     *    "last name": "Smith",
//     *    "employee id": "12345"
//     * }
//     */
// 
//    const entryMap = {};
// 
//    entryData.forEach(row => {
//       const label = String(row[0]).trim();
// 
//       if (label !== "") {
//          entryMap[label.toLowerCase()] = row[1];
//       }
//    });
// 
// 
//    // ============================================================
//    // VALIDATE DESTINATION SHEETS
//    // ============================================================
// 
//    const destinationSheets = [];
// 
//    for (const sheetId of DESTINATION_SHEET_IDS) {
//       const sheet = ss.getSheetById(sheetId);
// 
//       if (!sheet) {
//          ui.alert(
//             "Destination Sheet Not Found",
//             `The destination sheet with ID ${sheetId} could not be found.`,
//             ui.ButtonSet.OK
//          );
//          return;
//       }
// 
//       destinationSheets.push(sheet);
//    }
// 
// 
//    // ============================================================
//    // WRITE TO EACH DESTINATION SHEET
//    // ============================================================
// 
//    const sheetsUpdated = [];
//    const sheetsSkipped = [];
// 
//    destinationSheets.forEach(destinationSheet => {
// 
//       // ----------------------------------------------------------
//       // SKIP IF REQUIRED FIELDS ARE BLANK
//       // ----------------------------------------------------------
// 
//       const requiredFields =
//          REQUIRED_FIELDS[destinationSheet.getSheetId()] || [];
// 
//       const missingFields = requiredFields.filter(field => {
//          const value = entryMap[field.toLowerCase()];
//          return value === "" || value === null || value === undefined;
//       });
// 
//       if (missingFields.length > 0) {
//          sheetsSkipped.push(
//             `${destinationSheet.getName()} (missing ${missingFields.join(", ")})`
//          );
//          return;
//       }
// 
//       const destinationLastColumn = destinationSheet.getLastColumn();
// 
//       if (destinationLastColumn < 1) {
//          return;
//       }
// 
// 
//       // ----------------------------------------------------------
//       // GET DESTINATION HEADERS
//       // ----------------------------------------------------------
// 
//       const headers = destinationSheet
//          .getRange(
//             DEST_HEADER_ROW,
//             1,
//             1,
//             destinationLastColumn
//          )
//          .getValues()[0];
// 
// 
//       // ----------------------------------------------------------
//       // CREATE HEADER LOOKUP
//       // ----------------------------------------------------------
// 
//       /*
//        * Example headerMap:
//        *
//        * {
//        *    "employee id": 0,
//        *    "first name": 1,
//        *    "last name": 2
//        * }
//        */
// 
//       const headerMap = {};
// 
//       headers.forEach((header, index) => {
//          const headerName = String(header).trim();
// 
//          if (headerName !== "") {
//             headerMap[headerName.toLowerCase()] = index;
//          }
//       });
// 
// 
//       // ----------------------------------------------------------
//       // BUILD NEW DESTINATION ROW
//       // ----------------------------------------------------------
// 
//       const newRowData =
//          new Array(destinationLastColumn).fill("");
// 
//       let fieldsMatched = 0;
// 
//       entryData.forEach(row => {
//          const label = String(row[0]).trim();
//          const value = row[1];
// 
//          if (label === "") {
//             return;
//          }
// 
//          const headerIndex =
//             headerMap[label.toLowerCase()];
// 
//          if (headerIndex !== undefined) {
//             newRowData[headerIndex] = value;
//             fieldsMatched++;
//          }
//       });
// 
// 
//       /*
//        * Do not add a blank record if this destination
//        * sheet has no headers matching the Entry form.
//        */
//       if (fieldsMatched === 0) {
//          return;
//       }
// 
// 
//       // ----------------------------------------------------------
//       // DETERMINE NEW ROW
//       // ----------------------------------------------------------
// 
//       let newRow =
//          destinationSheet.getLastRow() + 1;
// 
//       /*
//        * Ensure records are always placed below the
//        * header row and formatting/template row.
//        */
//       if (newRow <= DEST_FORMAT_ROW) {
//          newRow = DEST_FORMAT_ROW + 1;
//       }
// 
//       /*
//        * Add another physical sheet row if necessary.
//        */
//       if (newRow > destinationSheet.getMaxRows()) {
//          destinationSheet.insertRowAfter(
//             destinationSheet.getMaxRows()
//          );
//       }
// 
// 
//       // ----------------------------------------------------------
//       // COPY ROW 2 FORMATTING
//       // ----------------------------------------------------------
// 
//       const formatSource = destinationSheet.getRange(
//          DEST_FORMAT_ROW,
//          1,
//          1,
//          destinationLastColumn
//       );
// 
//       const newRowRange = destinationSheet.getRange(
//          newRow,
//          1,
//          1,
//          destinationLastColumn
//       );
// 
//       formatSource.copyTo(
//          newRowRange,
//          SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
//          false
//       );
// 
// 
//       // ----------------------------------------------------------
//       // WRITE RECORD
//       // ----------------------------------------------------------
// 
//       newRowRange.setValues([newRowData]);
// 
//       sheetsUpdated.push(
//          destinationSheet.getName()
//       );
//    });
// 
// 
//    // ============================================================
//    // VERIFY A RECORD WAS INSERTED
//    // ============================================================
// 
//    if (sheetsUpdated.length === 0) {
//       ui.alert(
//          "Record Not Inserted",
//          sheetsSkipped.length > 0
//             ? `Nothing was added. Skipped: ${sheetsSkipped.join("; ")}.`
//             : "No Entry sheet labels matched headers on any destination sheet.",
//          ui.ButtonSet.OK
//       );
//       return;
//    }
// 
//    SpreadsheetApp.flush();
// 
// 
//    // ============================================================
//    // BUILD CONFIRMATION MESSAGE
//    // ============================================================
// 
//    /*
//     * Build the confirmation value before clearing the form.
//     *
//     * CONFIRMATION_FIELDS:
//     * ["First Name", "Last Name"]
//     *
//     * Result:
//     * John Smith
//     */
// 
//    const confirmationValue = CONFIRMATION_FIELDS
//       .map(field => entryMap[field.toLowerCase()])
//       .filter(value =>
//          value !== "" &&
//          value !== null &&
//          value !== undefined
//       )
//       .join(" ");
// 
// 
//    // ------------------------------------------------------------
//    // BUILD DESTINATION SHEET LIST
//    // ------------------------------------------------------------
// 
//    let destinationMessage;
// 
//    if (sheetsUpdated.length === 1) {
//       destinationMessage =
//          `${sheetsUpdated[0]} sheet`;
// 
//    } else if (sheetsUpdated.length === 2) {
//       destinationMessage =
//          `${sheetsUpdated[0]} and ${sheetsUpdated[1]} sheets`;
// 
//    } else {
//       destinationMessage =
//          `${sheetsUpdated.slice(0, -1).join(", ")}, and ` +
//          `${sheetsUpdated[sheetsUpdated.length - 1]} sheets`;
//    }
// 
// 
//    // ------------------------------------------------------------
//    // FINAL CONFIRMATION MESSAGE
//    // ------------------------------------------------------------
// 
//    const confirmationMessage =
//       confirmationValue !== ""
//          ? `${confirmationValue} added to ${destinationMessage}.`
//          : `Record added to ${destinationMessage}.`;
// 
// 
//    // ============================================================
//    // CLEAR SELECTED ENTRY FIELDS
//    // ============================================================
// 
//    const clearFieldSet = new Set(
//       CLEAR_FIELDS.map(field =>
//          field.toLowerCase()
//       )
//    );
// 
//    entryData.forEach((row, index) => {
//       const label =
//          String(row[0]).trim().toLowerCase();
// 
//       if (clearFieldSet.has(label)) {
//          const sheetRow =
//             ENTRY_START_ROW + index;
// 
//          entrySheet
//             .getRange(sheetRow, VALUE_COLUMN)
//             .clearContent();
//       }
//    });
// 
// 
//    // ============================================================
//    // CONFIRMATION DIALOG
//    // ============================================================
// 
//    SpreadsheetApp.flush();
// 
//    const skippedMessage =
//       sheetsSkipped.length > 0
//          ? `\n\nNot added to: ${sheetsSkipped.join("; ")}.`
//          : "";
// 
//    ui.alert(
//       "Record Inserted",
//       confirmationMessage + skippedMessage,
//       ui.ButtonSet.OK
//    );
// }

// --------------------------- New Tank.gs ---------------------------
// function addNewTank() {
//    const ss = SpreadsheetApp.getActiveSpreadsheet();
//    const ui = SpreadsheetApp.getUi();
// 
//    // ============================================================
//    // CONFIGURATION
//    // ============================================================
// 
//    const ENTRY_SHEET_ID = 71532960;  //The tab numbers are locatede at the end of the url following #gid=
// 
//    const DESTINATION_SHEET_IDS = [
//       1037277526,  //Tank
//    ];
// 
//    const LABEL_COLUMN = 1;          // Column A
//    const VALUE_COLUMN = 2;          // Column B
//    const ENTRY_START_ROW = 3;
// 
//    const DEST_HEADER_ROW = 1;
//    const DEST_FORMAT_ROW = 2;
// 
//    /*
//     * Entry fields to clear after all records are inserted.
//     * Values must match the labels in Column A of the Entry sheet.
//     */
//    const CLEAR_FIELDS = [
//       'Tank Name'
//     , 'Volume (gal)'
//     , 'Tank Width'
//     , 'Tank Height'
//     , 'Tank Depth'
//     , 'Lid Width'
//     , 'Lid Depth'
//     , 'Manufacturer'
//     , 'Notes'
//     , 'Purchase Date'
//     , 'Vendor'
//     , 'Cost'
//     , 'Warranty Length'
//       
//    ];
// 
//    /*
//     * Entry fields used for the confirmation message.
//     *
//     * Example:
//     * John Smith added to Employees and Assignments sheets.
//     */
//    const CONFIRMATION_FIELDS = [
//         "Tank Name"
//    ];
// 
// 
//    // ============================================================
//    // GET ENTRY SHEET
//    // ============================================================
// 
//    const entrySheet = ss.getSheetById(ENTRY_SHEET_ID);
// 
//    if (!entrySheet) {
//       ui.alert(
//          "Entry Sheet Not Found",
//          `The sheet with ID ${ENTRY_SHEET_ID} could not be found.`,
//          ui.ButtonSet.OK
//       );
//       return;
//    }
// 
// 
//    // ============================================================
//    // GET ENTRY FORM DATA
//    // ============================================================
// 
//    const entryLastRow = entrySheet.getLastRow();
// 
//    if (entryLastRow < ENTRY_START_ROW) {
//       ui.alert(
//          "No Entry Data",
//          "No entry form fields were found.",
//          ui.ButtonSet.OK
//       );
//       return;
//    }
// 
//    const entryData = entrySheet
//       .getRange(
//          ENTRY_START_ROW,
//          LABEL_COLUMN,
//          entryLastRow - ENTRY_START_ROW + 1,
//          2
//       )
//       .getValues();
// 
// 
//    // ============================================================
//    // CREATE ENTRY FIELD LOOKUP
//    // ============================================================
// 
//    /*
//     * Example entryMap:
//     *
//     * {
//     *    "first name": "John",
//     *    "last name": "Smith",
//     *    "employee id": "12345"
//     * }
//     */
// 
//    const entryMap = {};
// 
//    entryData.forEach(row => {
//       const label = String(row[0]).trim();
// 
//       if (label !== "") {
//          entryMap[label.toLowerCase()] = row[1];
//       }
//    });
// 
// 
//    // ============================================================
//    // VALIDATE DESTINATION SHEETS
//    // ============================================================
// 
//    const destinationSheets = [];
// 
//    for (const sheetId of DESTINATION_SHEET_IDS) {
//       const sheet = ss.getSheetById(sheetId);
// 
//       if (!sheet) {
//          ui.alert(
//             "Destination Sheet Not Found",
//             `The destination sheet with ID ${sheetId} could not be found.`,
//             ui.ButtonSet.OK
//          );
//          return;
//       }
// 
//       destinationSheets.push(sheet);
//    }
// 
// 
//    // ============================================================
//    // WRITE TO EACH DESTINATION SHEET
//    // ============================================================
// 
//    const sheetsUpdated = [];
// 
//    destinationSheets.forEach(destinationSheet => {
//       const destinationLastColumn = destinationSheet.getLastColumn();
// 
//       if (destinationLastColumn < 1) {
//          return;
//       }
// 
// 
//       // ----------------------------------------------------------
//       // GET DESTINATION HEADERS
//       // ----------------------------------------------------------
// 
//       const headers = destinationSheet
//          .getRange(
//             DEST_HEADER_ROW,
//             1,
//             1,
//             destinationLastColumn
//          )
//          .getValues()[0];
// 
// 
//       // ----------------------------------------------------------
//       // CREATE HEADER LOOKUP
//       // ----------------------------------------------------------
// 
//       /*
//        * Example headerMap:
//        *
//        * {
//        *    "employee id": 0,
//        *    "first name": 1,
//        *    "last name": 2
//        * }
//        */
// 
//       const headerMap = {};
// 
//       headers.forEach((header, index) => {
//          const headerName = String(header).trim();
// 
//          if (headerName !== "") {
//             headerMap[headerName.toLowerCase()] = index;
//          }
//       });
// 
// 
//       // ----------------------------------------------------------
//       // BUILD NEW DESTINATION ROW
//       // ----------------------------------------------------------
// 
//       const newRowData =
//          new Array(destinationLastColumn).fill("");
// 
//       let fieldsMatched = 0;
// 
//       entryData.forEach(row => {
//          const label = String(row[0]).trim();
//          const value = row[1];
// 
//          if (label === "") {
//             return;
//          }
// 
//          const headerIndex =
//             headerMap[label.toLowerCase()];
// 
//          if (headerIndex !== undefined) {
//             newRowData[headerIndex] = value;
//             fieldsMatched++;
//          }
//       });
// 
// 
//       /*
//        * Do not add a blank record if this destination
//        * sheet has no headers matching the Entry form.
//        */
//       if (fieldsMatched === 0) {
//          return;
//       }
// 
// 
//       // ----------------------------------------------------------
//       // DETERMINE NEW ROW
//       // ----------------------------------------------------------
// 
//       let newRow =
//          destinationSheet.getLastRow() + 1;
// 
//       /*
//        * Ensure records are always placed below the
//        * header row and formatting/template row.
//        */
//       if (newRow <= DEST_FORMAT_ROW) {
//          newRow = DEST_FORMAT_ROW + 1;
//       }
// 
//       /*
//        * Add another physical sheet row if necessary.
//        */
//       if (newRow > destinationSheet.getMaxRows()) {
//          destinationSheet.insertRowAfter(
//             destinationSheet.getMaxRows()
//          );
//       }
// 
// 
//       // ----------------------------------------------------------
//       // COPY ROW 2 FORMATTING
//       // ----------------------------------------------------------
// 
//       const formatSource = destinationSheet.getRange(
//          DEST_FORMAT_ROW,
//          1,
//          1,
//          destinationLastColumn
//       );
// 
//       const newRowRange = destinationSheet.getRange(
//          newRow,
//          1,
//          1,
//          destinationLastColumn
//       );
// 
//       formatSource.copyTo(
//          newRowRange,
//          SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
//          false
//       );
// 
// 
//       // ----------------------------------------------------------
//       // WRITE RECORD
//       // ----------------------------------------------------------
// 
//       newRowRange.setValues([newRowData]);
// 
//       sheetsUpdated.push(
//          destinationSheet.getName()
//       );
//    });
// 
// 
//    // ============================================================
//    // VERIFY A RECORD WAS INSERTED
//    // ============================================================
// 
//    if (sheetsUpdated.length === 0) {
//       ui.alert(
//          "Record Not Inserted",
//          "No Entry sheet labels matched headers on any destination sheet.",
//          ui.ButtonSet.OK
//       );
//       return;
//    }
// 
//    SpreadsheetApp.flush();
// 
// 
//    // ============================================================
//    // BUILD CONFIRMATION MESSAGE
//    // ============================================================
// 
//    /*
//     * Build the confirmation value before clearing the form.
//     *
//     * CONFIRMATION_FIELDS:
//     * ["First Name", "Last Name"]
//     *
//     * Result:
//     * John Smith
//     */
// 
//    const confirmationValue = CONFIRMATION_FIELDS
//       .map(field => entryMap[field.toLowerCase()])
//       .filter(value =>
//          value !== "" &&
//          value !== null &&
//          value !== undefined
//       )
//       .join(" ");
// 
// 
//    // ------------------------------------------------------------
//    // BUILD DESTINATION SHEET LIST
//    // ------------------------------------------------------------
// 
//    let destinationMessage;
// 
//    if (sheetsUpdated.length === 1) {
//       destinationMessage =
//          `${sheetsUpdated[0]} sheet`;
// 
//    } else if (sheetsUpdated.length === 2) {
//       destinationMessage =
//          `${sheetsUpdated[0]} and ${sheetsUpdated[1]} sheets`;
// 
//    } else {
//       destinationMessage =
//          `${sheetsUpdated.slice(0, -1).join(", ")}, and ` +
//          `${sheetsUpdated[sheetsUpdated.length - 1]} sheets`;
//    }
// 
// 
//    // ------------------------------------------------------------
//    // FINAL CONFIRMATION MESSAGE
//    // ------------------------------------------------------------
// 
//    const confirmationMessage =
//       confirmationValue !== ""
//          ? `${confirmationValue} added to ${destinationMessage}.`
//          : `Record added to ${destinationMessage}.`;
// 
// 
//    // ============================================================
//    // CLEAR SELECTED ENTRY FIELDS
//    // ============================================================
// 
//    const clearFieldSet = new Set(
//       CLEAR_FIELDS.map(field =>
//          field.toLowerCase()
//       )
//    );
// 
//    entryData.forEach((row, index) => {
//       const label =
//          String(row[0]).trim().toLowerCase();
// 
//       if (clearFieldSet.has(label)) {
//          const sheetRow =
//             ENTRY_START_ROW + index;
// 
//          entrySheet
//             .getRange(sheetRow, VALUE_COLUMN)
//             .clearContent();
//       }
//    });
// 
// 
//    // ============================================================
//    // CONFIRMATION DIALOG
//    // ============================================================
// 
//    SpreadsheetApp.flush();
// 
//    ui.alert(
//       "Record Inserted",
//       confirmationMessage,
//       ui.ButtonSet.OK
//    );
// }
