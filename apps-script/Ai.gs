// ============================================================
// AYERS AQUARIUMS - AI HELPER (Google Gemini, free tier)
//
// Used by the app's "Fill with AI" button and by the wishlist
// (photo identification + compatibility checks).
//
// Setup: in the Apps Script editor open Project Settings (gear) ->
// Script Properties and add:
//   GEMINI_API_KEY   the key from aistudio.google.com
//   GEMINI_MODEL     (optional) model to use; default below
// To check the key later, run aiTest() from the editor.
//
// Free tier notes: Google Search isn't available to these models on
// the free tier, so answers come from the model's own knowledge plus
// reference text this script fetches itself (the Wikipedia article for
// species and plants, or a product page link you provide). Google may
// use free-tier requests to improve its products.
//
// Nothing here writes to the sheet: suggestions go back to the app,
// and you review them before saving.
// ============================================================

// Model choice and limits for the Gemini calls.
const AI_CONFIG = {
   // gemini-3.5-flash answers reliably on the free tier; the newer Flash models
   // are often "busy" there. Set GEMINI_MODEL to try another one.
   defaultModel: "gemini-3.5-flash",
   // Tried in order when the model above is busy (503) or out of free quota (429).
   fallbackModels: ["gemini-flash-latest", "gemini-3.8-flash"],
   apiBase: "https://generativelanguage.googleapis.com/v1beta/models/",
   maxRefChars: 12000,
   userAgent: "AyersAquariums/1.0 (Google Apps Script; personal aquarium database)"
};

// Fields the AI never fills (links, IDs, dates, purchase details, status).
const AI_SKIP_FIELDS = ["Status", "Vendor", "Purchase Date", "Serial Number", "Stores"];

// Tables "Fill with AI" works on, and the field that names the item.
const AI_TABLES = {
   species:     { name: "Common Name",  kind: "aquarium livestock (fish, shrimp, snail or other aquatic animal)" },
   plants:      { name: "Common Name",  kind: "aquarium plant" },
   equipment:   { name: "Filter Model", kind: "aquarium equipment (filter, heater, light, pump, stand, etc.)" },
   medications: { name: "Product Name", kind: "aquarium medication, water treatment or supplement" }
};

// Run from the editor after adding GEMINI_API_KEY: checks the key and
// lists the models it can use.
function aiTest() {
   const key = aiKey_();
   const res = UrlFetchApp.fetch(AI_CONFIG.apiBase + "?pageSize=200", { headers: { "x-goog-api-key": key }, muteHttpExceptions: true });
   Logger.log("List models: HTTP " + res.getResponseCode());
   if (res.getResponseCode() === 200) {
      const names = (JSON.parse(res.getContentText()).models || [])
         .filter(m => (m.supportedGenerationMethods || []).indexOf("generateContent") !== -1)
         .map(m => m.name.replace(/^models\//, ""));
      Logger.log("Models: " + names.join(", "));
   } else {
      Logger.log(res.getContentText().slice(0, 500));
   }
   const out = aiGenerateJson_([{ text: 'Reply with this JSON exactly: {"ok": true}' }]);
   Logger.log("Model " + AI_LAST_MODEL + " replied: " + JSON.stringify(out));
}


// ------------------------------------------------------------
// Gemini
// ------------------------------------------------------------
function aiKey_() {
   const key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
   if (!key) throw apiError_("AI_SETUP", "The AI isn't set up yet. Add GEMINI_API_KEY in the script's Project Settings.");
   return key.trim();
}

// The model to use: GEMINI_MODEL from Script Properties, else the default above.
function aiModel_() {
   return (PropertiesService.getScriptProperties().getProperty("GEMINI_MODEL") || AI_CONFIG.defaultModel).trim();
}

// The model that answered the most recent request (shown in the app's AI notes).
let AI_LAST_MODEL = "";

// Sends parts ([{text}|{inline_data}]) and returns the parsed JSON reply.
// Falls back to other Flash models when one is busy or out of free quota.
function aiGenerateJson_(parts) {
   const cache = CacheService.getScriptCache();
   const all = [aiModel_()].concat(AI_CONFIG.fallbackModels.filter(m => m !== aiModel_()));
   // A model that was just busy is skipped for a while (busy calls can take ~40 seconds to fail).
   const ready = all.filter(m => !cache.get("ai_busy_" + m));
   const models = ready.length ? ready : all;
   let lastErr = null;
   for (let i = 0; i < models.length; i++) {
      try {
         const out = aiGenerateOnce_(parts, models[i]);
         AI_LAST_MODEL = models[i];
         return out;
      } catch (e) {
         lastErr = e;
         if (!e.aiRetry) throw e;
         cache.put("ai_busy_" + models[i], "1", 900);
      }
   }
   throw lastErr;
}

// One request to one model. Busy/out-of-quota errors are marked so the caller can try the next model.
// noThinking: resend without the thinking setting if a model doesn't support it.
function aiGenerateOnce_(parts, model, noThinking) {
   const key = aiKey_();
   // Ask for JSON back; low thinking keeps answers quick.
   const body = {
      contents: [{ role: "user", parts: parts }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "low" } }
   };
   if (noThinking) delete body.generationConfig.thinkingConfig;
   let res;
   try {
      res = UrlFetchApp.fetch(AI_CONFIG.apiBase + encodeURIComponent(model) + ":generateContent", {
         method: "post", contentType: "application/json", headers: { "x-goog-api-key": key },
         payload: JSON.stringify(body), muteHttpExceptions: true
      });
   } catch (e) {
      throw apiError_("AI_ERROR", "Couldn't reach the AI service. Try again.");
   }
   // Turn Google's error codes into messages the app can show.
   const code = res.getResponseCode();
   const text = res.getContentText();
   if (code !== 200) {
      let msg = "";
      try { msg = (JSON.parse(text).error || {}).message || ""; } catch (e) { /* not JSON */ }
      console.error("Gemini HTTP " + code + ": " + text.slice(0, 800));
      const retry = err => { err.aiRetry = true; return err; };
      if (code === 429) throw retry(apiError_("AI_BUSY", "The free AI limit has been reached for now. Try again in a minute (if the daily limit is used up, tomorrow)."));
      if (code === 503) throw retry(apiError_("AI_BUSY", "Google's AI is very busy right now. Try again in a few minutes."));
      if (code === 404) throw retry(apiError_("AI_SETUP", "The AI model \"" + model + "\" isn't available. Set GEMINI_MODEL in the script's Project Settings."));
      if (code === 400 && !noThinking && /thinking/i.test(msg)) return aiGenerateOnce_(parts, model, true);
      if (code === 400 && /api key/i.test(msg)) throw apiError_("AI_SETUP", "The Gemini API key isn't valid. Check GEMINI_API_KEY in the script's Project Settings.");
      if (code === 403) throw apiError_("AI_SETUP", "The Gemini API key was refused (" + (msg || "permission denied") + ").");
      if (code >= 500) throw apiError_("AI_ERROR", "The AI service had a problem. Try again in a moment.");
      throw apiError_("AI_ERROR", "The AI couldn't answer: " + (msg || "HTTP " + code));
   }
   // The answer text is in the first candidate (thinking parts are skipped).
   const json = JSON.parse(text);
   const cand = (json.candidates || [])[0];
   if (!cand || !cand.content) {
      const why = (json.promptFeedback && json.promptFeedback.blockReason) || (cand && cand.finishReason) || "no answer";
      throw apiError_("AI_ERROR", "The AI didn't give an answer (" + why + "). Try different wording.");
   }
   const out = (cand.content.parts || []).filter(p => typeof p.text === "string" && !p.thought).map(p => p.text).join("");
   return aiParseJson_(out);
}

// Reads the model's reply as JSON (tolerates ``` fences or text around the object).
function aiParseJson_(s) {
   s = String(s || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
   try { return JSON.parse(s); } catch (e) { /* try the outermost object */ }
   const a = s.indexOf("{"), b = s.lastIndexOf("}");
   if (a !== -1 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* fall through */ }
   }
   throw apiError_("AI_ERROR", "The AI's answer couldn't be read. Try again.");
}

// Only admins and editors may use the AI (viewers can't add or edit records).
function aiRequireUser_(user) {
   if (user.role !== "Admin" && user.role !== "Editor") throw apiError_("FORBIDDEN", "Only admins and editors can use the AI.");
}


// ------------------------------------------------------------
// Reference text (fetched by this script, so the AI has a source)
// ------------------------------------------------------------
function aiFetchJson_(url) {
   let res;
   try {
      res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { "Api-User-Agent": AI_CONFIG.userAgent } });
   } catch (e) {
      console.error("Fetch failed: " + url + " " + e);
      return null;
   }
   if (res.getResponseCode() !== 200) return null;
   try { return JSON.parse(res.getContentText()); } catch (e) { return null; }
}

// Best Wikipedia article for a species or plant: { title, url, text, imageFile }
function aiWikipedia_(names, kind) {
   const tried = {};
   for (let i = 0; i < names.length; i++) {
      const q = String(names[i] || "").trim();
      if (!q || tried[q.toLowerCase()]) continue;
      tried[q.toLowerCase()] = true;
      const hint = kind === "plants" ? " aquatic plant" : " aquarium";
      const search = aiFetchJson_("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=" +
                                  encodeURIComponent(q + hint));
      const hit = search && search.query && search.query.search && search.query.search[0];
      if (!hit) continue;
      const page = aiFetchJson_("https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=extracts%7Cpageimages%7Cinfo" +
                                "&explaintext=1&piprop=original&inprop=url&titles=" + encodeURIComponent(hit.title));
      const pages = page && page.query && page.query.pages;
      const p = pages && pages[Object.keys(pages)[0]];
      if (!p || !p.extract) continue;
      const imageFile = p.original && p.original.source ? decodeURIComponent(String(p.original.source).split("?")[0].split("/").pop()) : "";
      return { title: p.title, url: p.fullurl || ("https://en.wikipedia.org/wiki/" + encodeURIComponent(p.title.replace(/ /g, "_"))),
               text: String(p.extract).slice(0, AI_CONFIG.maxRefChars), imageFile: imageFile };
   }
   return null;
}

// Free-licensed Commons image for an article image file name (null if the
// file isn't on Wikimedia Commons or its license is unknown).
function aiCommonsImage_(fileName) {
   if (!fileName) return null;
   const info = aiFetchJson_("https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=extmetadata%7Curl&titles=" +
                             encodeURIComponent("File:" + fileName));
   const pages = info && info.query && info.query.pages;
   const p = pages && pages[Object.keys(pages)[0]];
   const ii = p && p.imageinfo && p.imageinfo[0];
   if (!ii || Number(Object.keys(pages)[0]) < 0) return null;
   const meta = ii.extmetadata || {};
   const strip = v => String((v && v.value) || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
   const license = strip(meta.LicenseShortName);
   if (!license) return null;
   const name = String(p.title || "").replace(/^File:/, "");
   return {
      file: name,
      url: "https://commons.wikimedia.org/wiki/Special:FilePath/" + encodeURIComponent(name).replace(/%2F/g, "/"),
      page: ii.descriptionurl || ("https://commons.wikimedia.org/wiki/File:" + encodeURIComponent(name.replace(/ /g, "_"))),
      author: strip(meta.Artist).slice(0, 200),
      license: license
   };
}

// A free-licensed photo for a species or plant, found through Wikipedia.
function aiFindPhoto_(type, names) {
   if (type !== "species" && type !== "plants") return null;
   try {
      const wiki = aiWikipedia_(names, type);
      return wiki ? aiCommonsImage_(wiki.imageFile) : null;
   } catch (e) {
      return null;
   }
}

// Visible text of a product or info page the user linked.
function aiPageText_(url) {
   if (!/^https?:\/\/[^\s]+$/i.test(String(url || ""))) return null;
   let res;
   try {
      res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { "User-Agent": "Mozilla/5.0 (compatible; " + AI_CONFIG.userAgent + ")" } });
   } catch (e) { return null; }
   if (res.getResponseCode() !== 200) return null;
   const html = res.getContentText();
   const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || url).replace(/\s+/g, " ").trim();
   const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, " ").trim();
   if (text.length < 200) return null;
   return { title: title.slice(0, 120), url: url, text: text.slice(0, AI_CONFIG.maxRefChars) };
}


// ------------------------------------------------------------
// Fill with AI
// req: { table, values: { field: current value }, link?, findPhoto? }
// Returns suggestions for the blank fields only.
// ------------------------------------------------------------
function apiAiFill_(req, user) {
   aiRequireUser_(user);
   const table = req.table;
   const cfg = AI_TABLES[table];
   if (!cfg) throw apiError_("BAD_REQUEST", "Fill with AI doesn't work for that list.");
   const lists = apiReadLists_(apiSs_());
   const schema = apiSchema_(table, lists);
   const current = req.values || {};
   const isBlank = v => v === undefined || v === null || String(v).trim() === "";

   // Fields the AI may fill: not IDs, links, dates, checkboxes or purchase details.
   const fillable = schema.filter(f => !f.readOnly && f.type !== "url" && f.type !== "date" && f.type !== "boolean" &&
                                       AI_SKIP_FIELDS.indexOf(f.name) === -1 && !/URL$|Link$|Page$/.test(f.name));
   const blanks = fillable.filter(f => isBlank(current[f.name]));
   const known = {};
   schema.forEach(f => { if (!isBlank(current[f.name])) known[f.name] = String(current[f.name]).trim(); });
   const name = table === "equipment" ? [known["Manufacturer"], known["Filter Model"]].filter(Boolean).join(" ")
              : (known[cfg.name] || known["Common Name"] || known["Scientific Name"] || known["Product Name"]);
   if (!name) throw apiError_("INVALID", "Type a name first" + (table === "equipment" ? " (brand and model)" : "") + ".");
   if (!blanks.length) return { suggestions: {}, sources: [], notes: "Every field already has a value.", filled: 0 };

   // Reference text.
   const sources = [];
   let refs = "";
   if (req.link) {
      const pg = aiPageText_(req.link);
      if (pg) { refs += "\n\nREFERENCE (product/info page \"" + pg.title + "\"):\n" + pg.text; sources.push({ title: pg.title, url: pg.url }); }
   }
   let wiki = null;
   if (table === "species" || table === "plants") {
      wiki = aiWikipedia_([known["Scientific Name"], known["Common Name"]], table);
      if (wiki) { refs += "\n\nREFERENCE (Wikipedia: " + wiki.title + "):\n" + wiki.text; sources.push({ title: "Wikipedia: " + wiki.title, url: wiki.url }); }
   }

   // Existing rows show the AI the expected style; list fields get their allowed values.
   const examples = aiExampleRows_(table, fillable.map(f => f.name));
   const fieldLines = blanks.map(f => {
      let line = "- \"" + f.name + "\"";
      if (f.type === "number") line += " (number only)";
      if (f.type === "list" && f.options && f.options.length) {
         line += f.strict ? " MUST be exactly one of: " + JSON.stringify(f.options) : " (prefer one of these spellings if it applies: " + JSON.stringify(f.options.slice(0, 40)) + ")";
      }
      return line;
   }).join("\n");

   // The instructions sent to the AI, followed by any reference text.
   const prompt =
      "You fill in records for a home aquarium database. Item type: " + cfg.kind + ".\n" +
      "What the user has entered so far:\n" + JSON.stringify(known, null, 1) + "\n\n" +
      "Fill in ONLY these blank fields:\n" + fieldLines + "\n\n" +
      (examples.length ? "Match the style, wording length and units of these existing records from the same list:\n" + JSON.stringify(examples, null, 1) + "\n\n" : "") +
      "Rules:\n" +
      "- Use typical, widely accepted aquarium-hobby values (temperatures in °F, sizes in inches).\n" +
      "- If a value isn't reasonably certain, use null. Never invent model numbers, measurements or links.\n" +
      "- Prefer the reference text below when it covers a field; otherwise use well-established knowledge.\n" +
      "- Keep text fields short, like the examples.\n" +
      "Reply with JSON only: {\"identified\": \"the exact item you filled in for (name, scientific name or brand + model)\", " +
      "\"confidence\": \"High\" | \"Medium\" | \"Low\", \"fields\": {\"<field name>\": value or null}, \"notes\": \"one or two short caveats, or empty\"}" +
      refs;

   // Ask, then keep only valid suggestions for fields that were blank.
   const ai = aiGenerateJson_([{ text: prompt }]);
   const suggestions = aiCleanSuggestions_(blanks, ai.fields || {});
   const out = {
      suggestions: suggestions,
      filled: Object.keys(suggestions).length,
      identified: String(ai.identified || "").slice(0, 200),
      confidence: /^(High|Medium|Low)$/i.test(String(ai.confidence)) ? String(ai.confidence).replace(/^./, c => c.toUpperCase()) : "",
      notes: String(ai.notes || "").slice(0, 500),
      sources: sources,
      model: AI_LAST_MODEL
   };
   // A free-licensed photo when the item has no thumbnail yet.
   if (req.findPhoto && isBlank(current["Thumbnail URL"]) && wiki) {
      const photo = aiCommonsImage_(wiki.imageFile);
      if (photo) out.photo = photo;
   }
   return out;
}

// Up to 2 well-filled existing rows, as style examples.
function aiExampleRows_(table, fields) {
   const rows = apiReadTable_(table).rows.filter(r => String(r["Status"] || "Active") === "Active");
   const score = r => fields.filter(f => String(r[f] === undefined ? "" : r[f]).trim() !== "").length;
   return rows.sort((a, b) => score(b) - score(a)).slice(0, 2).map(r => {
      const o = {};
      fields.forEach(f => { if (String(r[f] === undefined ? "" : r[f]).trim() !== "") o[f] = r[f]; });
      return o;
   });
}

// Keeps only usable suggestions: numbers for number fields, exact list values for
// strict dropdowns, matching spelling for other lists, trimmed text.
function aiCleanSuggestions_(fields, raw) {
   const out = {};
   fields.forEach(f => {
      let v = raw[f.name];
      if (v === undefined || v === null) return;
      if (Array.isArray(v)) v = v.join("; ");
      if (typeof v === "object") return;
      v = String(v).trim();
      if (!v || /^(null|n\/a|unknown|none)$/i.test(v)) return;
      if (f.type === "number") {
         const n = Number(v.replace(/[^0-9.\-]/g, ""));
         if (v.replace(/[^0-9.\-]/g, "") === "" || isNaN(n)) return;
         v = n;
      } else if (f.type === "list" && f.strict) {
         const match = (f.options || []).find(o => o.toLowerCase() === v.toLowerCase());
         if (!match) return;
         v = match;
      } else if (f.type === "list") {
         const match = (f.options || []).find(o => o.toLowerCase() === v.toLowerCase());
         if (match) v = match;
      }
      if (typeof v === "string") v = v.slice(0, 1000);
      out[f.name] = v;
   });
   return out;
}


// ------------------------------------------------------------
// Identify from a photo
// req: { image: { data: <base64>, mimeType }, typeHint? }
// ------------------------------------------------------------
function apiAiIdentify_(req, user) {
   aiRequireUser_(user);
   const img = req.image || {};
   if (!img.data) throw apiError_("INVALID", "Add a photo first.");
   // Accept only JPEG/PNG/WebP photos under ~6 MB.
   const mimeType = /^image\/(jpeg|png|webp)$/.test(String(img.mimeType)) ? img.mimeType : "image/jpeg";
   const data = String(img.data).replace(/^data:[^,]*,/, "");
   if (data.length > 8 * 1024 * 1024) throw apiError_("INVALID", "That photo is too large.");
   const hint = AI_TABLES[req.typeHint] ? "The user expects it to be: " + AI_TABLES[req.typeHint].kind + ".\n" : "";
   // Ask the AI what the photo shows, as JSON.
   const prompt =
      "Identify the aquarium item in this photo for a home aquarium database.\n" + hint +
      "It may be a live animal, a plant, equipment (often a box, label or store tag), or a medication bottle.\n" +
      "For equipment and medications, read the brand and model or product name from the label if visible.\n" +
      "Reply with JSON only: {\"type\": \"species\" | \"plants\" | \"equipment\" | \"medications\", " +
      "\"name\": \"common name, or product name\", \"scientificName\": \"for animals and plants, else empty\", " +
      "\"manufacturer\": \"for equipment/medications, else empty\", \"model\": \"for equipment, else empty\", " +
      "\"confidence\": \"High\" | \"Medium\" | \"Low\", \"alternatives\": [{\"name\": \"\", \"scientificName\": \"\"}] (up to 3, only if unsure), " +
      "\"notes\": \"short: what you saw / why unsure\"}";
   const ai = aiGenerateJson_([{ text: prompt }, { inline_data: { mime_type: mimeType, data: data } }]);
   // Clean up the answer before sending it to the app.
   const s = v => String(v || "").trim().slice(0, 200);
   return {
      type: AI_TABLES[ai.type] ? ai.type : "",
      name: s(ai.name), scientificName: s(ai.scientificName), manufacturer: s(ai.manufacturer), model: s(ai.model),
      confidence: /^(High|Medium|Low)$/i.test(String(ai.confidence)) ? String(ai.confidence).replace(/^./, c => c.toUpperCase()) : "Low",
      alternatives: (Array.isArray(ai.alternatives) ? ai.alternatives : []).slice(0, 3)
         .map(a => ({ name: s(a && a.name), scientificName: s(a && a.scientificName) })).filter(a => a.name),
      notes: String(ai.notes || "").slice(0, 400)
   };
}
