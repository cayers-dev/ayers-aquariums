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
