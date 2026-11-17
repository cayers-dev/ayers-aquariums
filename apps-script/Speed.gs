// ============================================================
// AYERS AQUARIUMS - FASTER READS
//
// Loading the app (bootstrap) reads about 20 tabs. One at a time
// through SpreadsheetApp that took ~7.5 seconds, so bootstrap first
// reads every tab in ONE request through the Google Sheets API
// (Advanced Service "Sheets", enabled in Services). The readers in
// the other files (apiReadTable_, apiReadSheetRows_, apiGetUsers_,
// apiReadLists_, apiReadPhotos_) then take their values from that
// snapshot via apiGrid_.
//
// The snapshot is only used during bootstrap, which never writes.
// Requests that save something read each tab fresh, exactly as before.
// If the Sheets service is off or the batch read fails, every tab is
// simply read one by one (slower, same result).
//
// The App Users list is also kept in a 5-minute cache, since every
// request checks who is signed in. Saving or deleting users clears it.
// ============================================================

// Snapshot for this request: { sheetId: { values, shown } }, or null when not in use.
let API_GRID = null;

// A tab's used range as { values (like getValues), shown (like getDisplayValues) }.
// Comes from the bootstrap snapshot when there is one, otherwise read now.
function apiGrid_(sheet) {
   const id = sheet.getSheetId();
   if (API_GRID && API_GRID[id]) return API_GRID[id];
   const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
   if (lastRow < 1 || lastCol < 1) return { values: [], shown: [] };
   const range = sheet.getRange(1, 1, lastRow, lastCol);
   return { values: range.getValues(), shown: range.getDisplayValues() };
}

// A tab's header row. During a load this comes from the one-request snapshot;
// outside one it's a single-row read, as before.
function apiHeaderValues_(sheet) {
   const snap = API_GRID && API_GRID[sheet.getSheetId()];
   if (snap && snap.values && snap.values.length) return snap.values[0];
   const lastCol = sheet.getLastColumn();
   return lastCol < 1 ? [] : sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

// Reads every tab the app uses in one Sheets API request (two passes: raw values and
// displayed text) into API_GRID. Entry-form tabs ("Add ...") and the Change Log are skipped.
function apiPrefetchGrids_() {
   if (typeof Sheets === "undefined") return;   // Sheets service not enabled: read one by one
   try {
      const ss = apiSs_();
      const sheets = ss.getSheets().filter(sh => !/^Add /.test(sh.getName()) && sh.getName() !== API_CONFIG.logSheetName);
      const ranges = sheets.map(sh => "'" + sh.getName().replace(/'/g, "''") + "'");
      const raw = Sheets.Spreadsheets.Values.batchGet(ss.getId(), { ranges: ranges, valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" }).valueRanges || [];
      const fmt = Sheets.Spreadsheets.Values.batchGet(ss.getId(), { ranges: ranges, valueRenderOption: "FORMATTED_VALUE" }).valueRanges || [];
      const tz = ss.getSpreadsheetTimeZone();
      const grid = {};
      sheets.forEach((sh, i) => {
         const r = (raw[i] && raw[i].values) || [], f = (fmt[i] && fmt[i].values) || [];
         const rows = Math.max(r.length, f.length);
         let width = 0;
         r.concat(f).forEach(row => { width = Math.max(width, row.length); });
         const values = [], shown = [];
         for (let y = 0; y < rows; y++) {
            const rv = r[y] || [], fv = f[y] || [];
            const vr = [], sr = [];
            for (let x = 0; x < width; x++) {
               let v = rv[x] === undefined ? "" : rv[x];
               const s = fv[x] === undefined ? "" : String(fv[x]);
               // Dates arrive as day numbers: turn them back into Dates, like getValues does.
               if (typeof v === "number" && apiLooksLikeDate_(s)) v = apiSerialToDate_(v, tz);
               vr.push(v); sr.push(s);
            }
            values.push(vr); shown.push(sr);
         }
         grid[sh.getSheetId()] = { values: values, shown: shown };
      });
      API_GRID = grid;
   } catch (e) {
      console.warn("Batch read failed, reading tabs one by one: " + e);
      API_GRID = null;
   }
}

// True if a cell's displayed text is a date or time (11/14/2026, 2026-11-14, 3:22 PM, Nov 14, 2026).
function apiLooksLikeDate_(s) {
   return /^\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}(\s|$)/.test(s) || /^\d{1,2}:\d{2}/.test(s) ||
          /^[A-Za-z]{3,9}\.? \d{1,2},? \d{4}/.test(s) || /^\d{1,2} [A-Za-z]{3,9}\.? \d{4}/.test(s);
}

// A spreadsheet day number (days since 1899-12-30, in the sheet's time zone) as a Date.
function apiSerialToDate_(serial, tz) {
   const wall = Utilities.formatDate(new Date(Math.round((serial - 25569) * 86400000)), "UTC", "yyyy-MM-dd HH:mm:ss");
   return Utilities.parseDate(wall, tz, "yyyy-MM-dd HH:mm:ss");
}


// ------------------------------------------------------------
// App Users cache (5 minutes)
// ------------------------------------------------------------
const API_USERS_CACHE_KEY = "app_users_v1";

// Clears the cached user list (after users are saved, or a tank is removed from their lists).
function apiClearUsersCache_() {
   CacheService.getScriptCache().remove(API_USERS_CACHE_KEY);
}

// ------------------------------------------------------------
// Trimming empty rows
// A tab with thousands of blank rows is still read in full on every load, which
// slows the app down. Checkboxes and dropdowns set down a whole column make rows
// look used, so a row counts as empty when its ID column is blank and every other
// cell is blank or an unticked checkbox.
// Run trimEmptyRowsDryRun() from the editor to see what would go, then
// trimEmptyRows() to delete it. Both leave 20 spare rows under the last record.
// ------------------------------------------------------------
const TRIM_SPARE_ROWS = 20;
// DropDownOptions is one formula per column spilling down the sheet, so it needs
// its spare rows to grow into: it's never trimmed.
const TRIM_SKIP_TABS = ["DropDownOptions"];

function apiRowIsEmpty_(row) {
   return row.every(v => v === "" || v === null || v === false);
}

// For each tab: its last used row, and how many rows could be deleted.
function apiTrimPlan_() {
   return apiSs_().getSheets().map(sheet => {
      const last = sheet.getLastRow(), cols = sheet.getLastColumn();
      const name = sheet.getName();
      if (last < 2 || cols < 1 || TRIM_SKIP_TABS.indexOf(name) !== -1) return { name: name, rows: last, used: last, cut: 0 };
      const values = sheet.getRange(1, 1, last, cols).getValues();
      let used = 1;
      for (let r = 1; r < values.length; r++) {
         if (String(values[r][0]).trim() !== "" || !apiRowIsEmpty_(values[r])) used = r + 1;
      }
      const keep = Math.min(last, used + TRIM_SPARE_ROWS);
      return { name: name, rows: last, used: used, cut: Math.max(0, last - keep), from: keep + 1 };
   });
}

function trimEmptyRowsDryRun() {
   const plan = apiTrimPlan_();
   const lines = plan.map(p => p.name + ": " + p.rows + " rows, " + (p.used - 1) + " records" +
      (p.cut ? " — would delete rows " + p.from + "-" + p.rows + " (" + p.cut + ")" : " — nothing to trim"));
   Logger.log(lines.join("\n"));
   return lines;
}

function trimEmptyRows() {
   const ss = apiSs_();
   const done = [];
   apiTrimPlan_().forEach(p => {
      if (!p.cut) return;
      const sheet = ss.getSheetByName(p.name);
      sheet.deleteRows(p.from, p.cut);
      done.push(p.name + ": removed " + p.cut + " empty rows (now " + sheet.getLastRow() + ")");
   });
   Logger.log(done.join("\n") || "Nothing to trim.");
   return done;
}
