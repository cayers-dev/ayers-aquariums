// ============================================================
// CHANGE LOG READER
// Every add, edit, link, retire and delete the app makes is written to the
// "Change Log" tab by apiLog_/apiFlushLog_ (Api.gs). This reads it back for
// the app's Change log screen.
//
// Who: admins only, like the switch that turns logging on and off. The tab
// records what everyone did, so it isn't something a role can be given.
//
// The tab grows without limit, so this never sends the whole thing: it reads
// the newest rows first, a page at a time, and filters as it goes.
// ============================================================

const CLOG_CONFIG = {
   pageSize: 50,
   // Never scan more than this many rows for one page of matches, so a filter
   // that matches nothing can't run the request out of time.
   scanLimit: 4000
};

// One page of the Change Log, newest first.
// req: { before?: row number to continue from, record?: "FS-8", who?: "USR-2", kind?: "Delete", text?: "pleco" }
// The kind of change travels as "kind", not "action": "action" is the field that
// names the route itself, so a filter called that would overwrite it on the way out.
function apiChangeLog_(req, user) {
   apiRequireAdmin_(user);
   req = req || {};
   const sheet = apiEnsureSupportTabs_().log;
   const last = apiLastDataRow_(sheet);
   if (last < 2) return { entries: [], more: false, total: 0 };

   const wantRecord = String(req.record || "").trim().toLowerCase();
   const wantWho = String(req.who || "").trim().toLowerCase();
   const wantAction = String(req.kind || "").trim().toLowerCase();
   const wantText = String(req.text || "").trim().toLowerCase();
   const filtered = !!(wantRecord || wantWho || wantAction || wantText);

   // Start just below the last row read, or at the bottom of the tab.
   let row = req.before ? Math.min(Number(req.before) - 1, last) : last;
   const tz = apiSs_().getSpreadsheetTimeZone();
   const entries = [];
   let scanned = 0;

   // Read backwards in blocks rather than row by row: one getValues per block.
   while (row >= 2 && entries.length < CLOG_CONFIG.pageSize && scanned < CLOG_CONFIG.scanLimit) {
      const block = Math.min(200, row - 1);
      const start = row - block + 1;
      const values = sheet.getRange(start, 1, block, 6).getValues();
      for (let i = values.length - 1; i >= 0 && entries.length < CLOG_CONFIG.pageSize; i--) {
         scanned++;
         const v = values[i];
         if (!v[0] && !v[2] && !v[4]) continue;
         const when = v[0] instanceof Date ? Utilities.formatDate(v[0], tz, "yyyy-MM-dd HH:mm") : String(v[0] || "");
         const e = { row: start + i, when: when, who: String(v[1] || ""), action: String(v[2] || ""),
                     table: String(v[3] || ""), record: String(v[4] || ""), changes: String(v[5] || "") };
         if (wantRecord && e.record.toLowerCase().indexOf(wantRecord) === -1) continue;
         if (wantWho && e.who.toLowerCase() !== wantWho) continue;
         if (wantAction && e.action.toLowerCase() !== wantAction) continue;
         if (wantText && (e.record + " " + e.changes + " " + e.table).toLowerCase().indexOf(wantText) === -1) continue;
         entries.push(e);
      }
      row = start - 1;
   }

   return {
      entries: entries,
      // Where the next page starts, and whether there is one to ask for.
      before: entries.length ? entries[entries.length - 1].row : null,
      more: row >= 2,
      stoppedEarly: scanned >= CLOG_CONFIG.scanLimit && row >= 2,
      total: last - 1,
      filtered: filtered
   };
}

// The people and actions seen in the newest slice of the log, so the app can
// offer them as filters without reading the whole tab.
function apiChangeLogFilters_(user) {
   apiRequireAdmin_(user);
   const sheet = apiEnsureSupportTabs_().log;
   const last = apiLastDataRow_(sheet);
   if (last < 2) return { actions: [], people: [] };
   const take = Math.min(1000, last - 1);
   const values = sheet.getRange(last - take + 1, 2, take, 2).getValues();
   const actions = {}, people = {};
   values.forEach(function (v) {
      const who = String(v[0] || "").trim();
      const action = String(v[1] || "").trim();
      if (who) people[who] = true;
      if (action) actions[action] = true;
   });
   return {
      actions: Object.keys(actions).sort(),
      people: Object.keys(people).sort()
   };
}
