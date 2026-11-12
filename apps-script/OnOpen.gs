// ============================================================
// AYERS AQUARIUMS - SHEET MENU
//
// Adds the "Processing" menu to the spreadsheet. Each item runs one
// of the entry forms in Entry Forms.gs: fill in the matching "Add ..."
// tab, then choose the menu item to save it.
// ============================================================

// Runs automatically every time the spreadsheet is opened.
function onOpen() {
   SpreadsheetApp.getUi()
      .createMenu("Processing")
      .addItem("Add New Species", "addNewSpecies")                    // Add Species tab
      .addItem("Add New Tank", "addNewTank")                          // Add Tank tab
      .addItem("Add New Equipment", "addNewEquipment")                // Add Equipment tab
      .addItem("Add New Plant", "addNewPlant")                        // Add Plant tab
      .addItem("Add New Medication / Supplement", "addNewMedication") // Add Medication tab
      .addItem("Add Water Parameter", "addWaterParameter")            // Add Water Parameter tab
      .addToUi();
}
