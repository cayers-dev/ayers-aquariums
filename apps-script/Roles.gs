// ============================================================
// ROLES AND PERMISSIONS
// What a role may do lives on the Role Permissions tab: one row per role,
// one TRUE/FALSE column per capability. Admins edit it on the Roles screen.
//   - Admin is fixed: it always has every capability and can't be edited or deleted.
//   - Managing users, roles and the Change Log switch stay Admin-only and are
//     deliberately NOT capabilities, so nobody can grant themselves the keys.
//   - Tank scope still applies on top: a capability says whether a role may do
//     something at all, "All tanks" says whether it reaches past its own tanks.
// ============================================================

const ROLE_CONFIG = {
   sheetName: "Role Permissions",
   admin: "Admin",
   // Order here is the order of the columns and of the app's Roles screen.
   caps: [
      ["addRecords", "Add records", "Create species, plants, equipment, food and medications"],
      ["editRecords", "Edit records", "Change the details of an existing record"],
      ["retireRecords", "Retire records", "Mark a record retired so it drops out of the lists"],
      ["deleteRecords", "Delete records", "Permanently delete records, receipts, photos and wishes"],
      ["manageLists", "Dropdown lists", "Add and rename values on the Lookups lists, in the screen or by typing one into a form"],
      ["manageTestTypes", "Test types", "Add, change and retire water test types"],
      ["photos", "Photos", "Add, caption and remove item photos"],
      ["receipts", "Receipts", "Upload receipts, link them to records and edit their lines"],
      ["prices", "Prices", "Use the price tracker"],
      ["useAi", "AI lookups", "Fill in fields with the AI, read a label and check a wish"],
      ["wishlist", "Wishlist", "Add wishes and manage them"],
      ["logTests", "Log tests and maintenance", "Record water tests and maintenance in the tanks assigned to them"],
      ["workInTanks", "Work in their tanks", "Add, remove and change the items in the tanks assigned to them"],
      ["allTanks", "All tanks", "See and work in every tank, not only the ones assigned to them"]
   ],
   // Exactly what the app did before the tab existed.
   defaults: {
      Editor: ["receipts", "prices", "useAi", "wishlist", "logTests", "workInTanks"],
      Viewer: ["logTests"]
   }
};

const ROLE_CACHE_KEY = "role_permissions_v1";
let ROLE_ROWS = null;

function apiCapKeys_() {
   return ROLE_CONFIG.caps.map(function (c) { return c[0]; });
}

// The tab, made with its headers and the three starting roles the first time.
function apiEnsureRolesTab_() {
   const ss = apiSs_();
   let sheet = ss.getSheetByName(ROLE_CONFIG.sheetName);
   if (sheet) return sheet;
   sheet = ss.insertSheet(ROLE_CONFIG.sheetName);
   const headers = ["Role", "Description"].concat(ROLE_CONFIG.caps.map(function (c) { return c[1]; }));
   sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold").setBackground("#d9d9d9");
   sheet.setFrozenRows(1);
   const rows = [[ROLE_CONFIG.admin, "Everything. Fixed: an admin always has every permission."]
      .concat(ROLE_CONFIG.caps.map(function () { return true; }))];
   Object.keys(ROLE_CONFIG.defaults).forEach(function (name) {
      const has = ROLE_CONFIG.defaults[name];
      rows.push([name, ""].concat(apiCapKeys_().map(function (k) { return has.indexOf(k) !== -1; })));
   });
   sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
   sheet.setColumnWidth(1, 120);
   sheet.setColumnWidth(2, 320);
   return sheet;
}

// [{ row, role, description, caps: { key: true/false } }], Admin first.
function apiReadRoles_(fresh) {
   if (!fresh && ROLE_ROWS) return ROLE_ROWS;
   if (!fresh) {
      const hit = CacheService.getScriptCache().get(ROLE_CACHE_KEY);
      if (hit) { try { ROLE_ROWS = JSON.parse(hit); return ROLE_ROWS; } catch (e) { /* read the tab */ } }
   }
   const sheet = apiEnsureRolesTab_();
   const values = apiGrid_(sheet).values;
   const head = (values[0] || []).map(function (h) { return String(h).trim(); });
   const colFor = {};
   ROLE_CONFIG.caps.forEach(function (c) { colFor[c[0]] = head.indexOf(c[1]); });
   const out = [];
   for (let r = 1; r < values.length; r++) {
      const name = String(values[r][0] || "").trim();
      if (!name) continue;
      const caps = {};
      ROLE_CONFIG.caps.forEach(function (c) {
         const i = colFor[c[0]];
         const v = i === -1 ? false : values[r][i];
         caps[c[0]] = v === true || String(v).toUpperCase() === "TRUE";
      });
      out.push({ row: r + 1, role: name, description: String(values[r][1] || "").trim(), caps: caps });
   }
   // Admin is always present and always has everything, whatever the tab says.
   const admin = out.find(function (x) { return apiSameName_(x.role, ROLE_CONFIG.admin); });
   if (admin) { apiCapKeys_().forEach(function (k) { admin.caps[k] = true; }); }
   else {
      const caps = {};
      apiCapKeys_().forEach(function (k) { caps[k] = true; });
      out.unshift({ row: 0, role: ROLE_CONFIG.admin, description: "", caps: caps });
   }
   ROLE_ROWS = out;
   try { CacheService.getScriptCache().put(ROLE_CACHE_KEY, JSON.stringify(out), 300); } catch (e) { /* too big */ }
   return out;
}

function apiClearRolesCache_() {
   ROLE_ROWS = null;
   try { CacheService.getScriptCache().remove(ROLE_CACHE_KEY); } catch (e) { /* fine */ }
}

// Every role name, Admin first.
function apiRoleNames_() {
   return apiReadRoles_().map(function (r) { return r.role; });
}

function apiIsAdminRole_(role) {
   return apiSameName_(String(role || ""), ROLE_CONFIG.admin);
}

// What this user may do: { capability: true/false }.
function apiCapsFor_(user) {
   const caps = {};
   if (apiIsAdminRole_(user && user.role)) {
      apiCapKeys_().forEach(function (k) { caps[k] = true; });
      return caps;
   }
   const row = apiReadRoles_().find(function (r) { return apiSameName_(r.role, (user && user.role) || ""); });
   apiCapKeys_().forEach(function (k) { caps[k] = !!(row && row.caps[k]); });
   return caps;
}

function apiCan_(user, cap) {
   if (apiIsAdminRole_(user && user.role)) return true;
   const row = apiReadRoles_().find(function (r) { return apiSameName_(r.role, (user && user.role) || ""); });
   return !!(row && row.caps[cap]);
}

// Throws unless the user's role has the capability.
function apiRequireCan_(user, cap) {
   if (apiCan_(user, cap)) return;
   const def = ROLE_CONFIG.caps.find(function (c) { return c[0] === cap; });
   const what = def ? def[1].toLowerCase() : cap;
   const role = (user && user.role) || "Your role";
   throw apiError_("FORBIDDEN", role + " doesn't have the " + what + " permission. An admin can change that on the Roles screen.");
}

// The Roles screen (admins): every role with its capabilities, and how many people hold it.
function apiRolesBootstrap_(user) {
   // The labels go to everyone: the Account screen lists what their own role may do.
   const labels = ROLE_CONFIG.caps.map(function (c) { return { key: c[0], label: c[1], hint: c[2] }; });
   if (!apiIsAdminRole_(user && user.role)) return { roleCaps: labels };
   const counts = {};
   apiGetUsers_().forEach(function (u) {
      const k = String(u.role || "").toLowerCase();
      counts[k] = (counts[k] || 0) + 1;
   });
   return {
      roleCaps: labels,
      roles: apiReadRoles_().map(function (r) {
         return { role: r.role, description: r.description, caps: r.caps,
                  users: counts[r.role.toLowerCase()] || 0, fixed: apiIsAdminRole_(r.role) };
      })
   };
}

// Keeps the Role dropdown on the App Users tab in step with the roles that exist,
// so a custom role typed straight into the sheet isn't rejected.
function apiSyncUserRoleValidation_() {
   try {
      const users = apiEnsureSupportTabs_().users;
      users.getRange("D2:D").setDataValidation(SpreadsheetApp.newDataValidation()
         .requireValueInList(apiRoleNames_(), true).setAllowInvalid(false).build());
   } catch (e) { console.warn("Role validation not updated: " + e); }
}

// Adds a role, renames one, or sets its capabilities (admins).
// req: { role, newName, description, caps: { key: bool } }
function apiSaveRole_(req, user) {
   apiRequireAdmin_(user);
   const sheet = apiEnsureRolesTab_();
   const name = String(req.role || "").replace(/\s+/g, " ").trim();
   if (!name) throw apiError_("INVALID", "Enter a role name.");
   const rows = apiReadRoles_(true);
   const existing = rows.find(function (r) { return apiSameName_(r.role, name); });
   const newName = req.newName === undefined ? "" : String(req.newName).replace(/\s+/g, " ").trim();

   if (existing && apiIsAdminRole_(existing.role) && (newName || req.caps)) {
      throw apiError_("INVALID", "The Admin role always has every permission and can't be changed.");
   }
   if (newName && apiIsAdminRole_(newName)) throw apiError_("INVALID", "Admin is taken.");
   if (newName && rows.some(function (r) { return apiSameName_(r.role, newName) && r !== existing; })) {
      throw apiError_("INVALID", newName + " is already a role.");
   }
   const head = apiGrid_(sheet).values[0].map(function (h) { return String(h).trim(); });
   const colFor = {};
   ROLE_CONFIG.caps.forEach(function (c) { colFor[c[0]] = head.indexOf(c[1]) + 1; });
   const notes = [];

   let row;
   if (existing) {
      row = existing.row;
      if (newName && !apiSameName_(newName, existing.role)) {
         sheet.getRange(row, 1).setValue(newName);
         notes.push("Renamed " + existing.role + " → " + newName);
         // Everyone holding the old name moves with it.
         const moved = apiRenameRoleOnUsers_(existing.role, newName, user);
         if (moved) notes.push("people updated: " + moved);
      }
   } else {
      if (rows.length >= 12) throw apiError_("INVALID", "That's as many roles as the app keeps track of.");
      row = apiLastDataRow_(sheet) + 1;
      if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), row - sheet.getMaxRows());
      sheet.getRange(row, 1).setValue(name);
      apiCapKeys_().forEach(function (k) { if (colFor[k]) sheet.getRange(row, colFor[k]).setValue(false); });
      notes.push("Added role " + name);
   }
   if (req.description !== undefined) sheet.getRange(row, 2).setValue(String(req.description).trim());
   if (req.caps) {
      const before = existing ? existing.caps : {};
      apiCapKeys_().forEach(function (k) {
         if (!(k in req.caps) || !colFor[k]) return;
         const want = !!req.caps[k];
         if (existing && !!before[k] === want) return;
         sheet.getRange(row, colFor[k]).setValue(want);
         const def = ROLE_CONFIG.caps.find(function (c) { return c[0] === k; });
         notes.push((want ? "+" : "−") + " " + (def ? def[1] : k));
      });
   }
   SpreadsheetApp.flush();
   apiClearRolesCache_();
   apiSyncUserRoleValidation_();
   if (notes.length) apiLog_(user, "Edit", ROLE_CONFIG.sheetName, newName || name, notes.join("; "));
   return apiRolesBootstrap_(user);
}

// Removes a role (admins). Refused while anyone still holds it.
function apiDeleteRole_(req, user) {
   apiRequireAdmin_(user);
   const name = String(req.role || "").trim();
   if (apiIsAdminRole_(name)) throw apiError_("INVALID", "The Admin role can't be removed.");
   const row = apiReadRoles_(true).find(function (r) { return apiSameName_(r.role, name); });
   if (!row) throw apiError_("NOT_FOUND", "That role no longer exists.");
   const holders = apiGetUsers_(true).filter(function (u) { return apiSameName_(String(u.role || ""), name); });
   if (holders.length) {
      throw apiError_("INVALID", holders.length + " " + (holders.length === 1 ? "person is" : "people are") +
                      " still set to " + row.role + ". Move them to another role first.");
   }
   apiEnsureRolesTab_().deleteRow(row.row);
   SpreadsheetApp.flush();
   apiClearRolesCache_();
   apiSyncUserRoleValidation_();
   apiLog_(user, "Delete", ROLE_CONFIG.sheetName, row.role, "Role removed");
   return apiRolesBootstrap_(user);
}

// Moves everyone on the old role name to the new one (used when a role is renamed).
function apiRenameRoleOnUsers_(oldName, newName, user) {
   const sheet = apiEnsureSupportTabs_().users;
   const col = apiHeaderMap_(sheet).map["role"];
   if (!col) return 0;
   let n = 0;
   apiGetUsers_(true).forEach(function (u) {
      if (!apiSameName_(String(u.role || ""), oldName)) return;
      sheet.getRange(u.row, col).setValue(newName);
      n++;
   });
   if (n) apiClearUsersCache_();
   return n;
}
