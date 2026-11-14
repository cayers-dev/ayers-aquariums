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
// reference text this script fetches itself (FishBase, Seriously Fish,
// SeaLifeBase, Tropica and Wikipedia for species and plants, or a product
// page link you provide). Google may use free-tier requests to improve
// its products.
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
   userAgent: "AyersAquariums/1.0 (Google Apps Script; personal aquarium database)",
   // Change this when the lookup changes, so lookups saved in the last 6 hours aren't reused.
   cacheVersion: "2"
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
// (tries each name in turn; one request per name).
function aiWikipedia_(names, kind) {
   const tried = {};
   for (let i = 0; i < names.length; i++) {
      const q = String(names[i] || "").trim();
      if (!q || tried[q.toLowerCase()]) continue;
      tried[q.toLowerCase()] = true;
      const wiki = aiWikipediaFromJson_(aiFetchHtml_(aiWikipediaUrl_(q, kind)));
      if (wiki) return wiki;
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

// Request options shared by the page fetches below.
function aiFetchOpts_(url) {
   return { url: url, muteHttpExceptions: true, followRedirects: true,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; " + AI_CONFIG.userAgent + ")" } };
}

// Raw HTML of a web page, or null if it can't be fetched (not found, blocked, timed out).
function aiFetchHtml_(url) {
   return aiFetchAll_([url])[0];
}

// Fetches several pages at the same time (much faster than one after another).
// Returns each page's HTML (or null) in the same order as the URLs; a null URL gives null.
function aiFetchAll_(urls) {
   const ok = u => /^https?:\/\/[^\s]+$/i.test(String(u || ""));
   const list = urls.filter(ok);
   const byUrl = {};
   if (list.length) {
      let res = null;
      try {
         res = UrlFetchApp.fetchAll(list.map(aiFetchOpts_));
      } catch (e) {
         // One bad host makes fetchAll fail as a whole: fall back to one at a time.
         res = list.map(u => { try { return UrlFetchApp.fetch(u, aiFetchOpts_(u)); } catch (e2) { return null; } });
      }
      list.forEach((u, i) => {
         const r = res[i];
         byUrl[u] = r && r.getResponseCode() === 200 ? r.getContentText() : null;
      });
   }
   return urls.map(u => (ok(u) ? byUrl[u] : null));
}

// Page HTML -> plain text (scripts, styles and tags removed, common entities decoded).
function aiHtmlText_(html) {
   return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
      .replace(/&deg;/g, "°").replace(/&ndash;|&#8211;/g, "–").replace(/\s+/g, " ").trim();
}

// { title, url, text } from a fetched page, or null when there's next to no text.
function aiPageFromHtml_(url, html) {
   if (!html) return null;
   const title = aiHtmlText_((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || url);
   const text = aiHtmlText_(html);
   if (text.length < 200) return null;
   return { title: title.slice(0, 120), url: url, text: text.slice(0, AI_CONFIG.maxRefChars) };
}

// Visible text of a web page (a product page the user linked, or a credible source page).
function aiPageText_(url) {
   return aiPageFromHtml_(url, aiFetchHtml_(url));
}


// ------------------------------------------------------------
// Credible sources for species and plants (fetched by this script)
//   Fish:             FishBase (scientific data) + Seriously Fish (aquarium care)
//   Shrimp, snails..: SeaLifeBase (FishBase's sister database for other aquatic life)
//   Plants:           Tropica (aquarium plant grower)
// Each page is { title, url, text } (null when the site has no page for the species).
// ------------------------------------------------------------

// "Genus species" from a scientific name (drops authors, "var.", extra words).
function aiBinomial_(sci) {
   const m = String(sci || "").trim().match(/^([A-Z][a-z]+)\s+([a-z][a-z\-]+)/);
   return m ? { genus: m[1], species: m[2] } : null;
}

// Page addresses for a species on each site.
function aiFishBaseUrl_(sci, sealife) {
   const b = aiBinomial_(sci);
   return b ? (sealife ? "https://www.sealifebase.se" : "https://www.fishbase.se") + "/summary/" + b.genus + "-" + b.species + ".html" : null;
}
function aiSeriouslyFishUrl_(sci) {
   const b = aiBinomial_(sci);
   return b ? "https://www.seriouslyfish.com/species/" + (b.genus + "-" + b.species).toLowerCase() + "/" : null;
}

// FishBase or SeaLifeBase species summary page, from its fetched HTML.
function aiFishBasePage_(sci, sealife, html) {
   const b = aiBinomial_(sci);
   const pg = b ? aiPageFromHtml_(aiFishBaseUrl_(sci, sealife), html) : null;
   // A real species page has its environment and size sections.
   if (!pg || !/Environment/i.test(pg.text) || !/(Max length|Size)/i.test(pg.text)) return null;
   const full = aiHtmlText_(html);
   const i = full.search(/Environment/i);
   pg.text = full.slice(Math.max(0, i - 200), Math.max(0, i - 200) + AI_CONFIG.maxRefChars);   // skip the menus
   pg.title = (sealife ? "SeaLifeBase: " : "FishBase: ") + b.genus + " " + b.species;
   return pg;
}

// Seriously Fish species profile (aquarium size, water conditions, diet, behaviour), from its fetched HTML.
function aiSeriouslyFishPage_(sci, html) {
   const b = aiBinomial_(sci);
   const pg = b ? aiPageFromHtml_(aiSeriouslyFishUrl_(sci), html) : null;
   if (!pg || !/(Water conditions|Temp)/i.test(pg.text)) return null;
   pg.title = "Seriously Fish: " + b.genus + " " + b.species;
   return pg;
}

// Tropica plant page address, found by matching the name against Tropica's plant list.
function aiTropicaUrl_(names) {
   const norm = s => String(s || "").toLowerCase().replace(/var\.|'/g, "").replace(/[^a-z0-9]/g, "");
   const cache = CacheService.getScriptCache();
   let list = null;
   try { list = JSON.parse(cache.get("tropica_plants") || "null"); } catch (e) { list = null; }
   if (!list) {
      const html = aiFetchHtml_("https://tropica.com/en/plants/");
      if (!html) return null;
      list = [];
      const seen = {};
      const re = /\/en\/plants\/plantdetails\/([^"<>\s]+?)\(([A-Za-z0-9]+)\)\/(\d+)/g;
      let m;
      while ((m = re.exec(html))) {
         const path = m[0];
         if (seen[path]) continue;
         seen[path] = true;
         let label = m[1];
         try { label = decodeURIComponent(label); } catch (e) { /* keep as is */ }
         list.push({ key: norm(label), path: path });
      }
      if (list.length) cache.put("tropica_plants", JSON.stringify(list), 21600);   // 6 hours
   }
   const wanted = names.map(norm).filter(k => k.length >= 4);
   let hit = null;
   wanted.some(w => (hit = list.find(x => x.key === w)));                          // exact name
   if (!hit) wanted.some(w => (hit = list.find(x => x.key.indexOf(w) === 0)));      // e.g. "anubiasbarteri" -> "anubiasbarterinana"
   return hit ? "https://tropica.com" + hit.path : null;
}

// Tropica plant page, from its fetched HTML.
function aiTropicaPage_(url, html) {
   const pg = aiPageFromHtml_(url, html);
   if (!pg) return null;
   pg.title = "Tropica: " + pg.title.replace(/\s*[|-].*$/, "");
   return pg;
}

// Wikipedia search address that returns the best article's text, photo and link in one request.
function aiWikipediaUrl_(name, kind) {
   const q = String(name || "").trim();
   if (!q) return null;
   return "https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&generator=search&gsrlimit=1" +
          "&prop=extracts%7Cpageimages%7Cinfo&explaintext=1&piprop=original&inprop=url&gsrsearch=" +
          encodeURIComponent(q + (kind === "plants" ? " aquatic plant" : " aquarium"));
}

// { title, url, text, imageFile } from that request's JSON, or null.
function aiWikipediaFromJson_(json) {
   let data = null;
   try { data = JSON.parse(json || "null"); } catch (e) { return null; }
   const pages = data && data.query && data.query.pages;
   const p = pages && pages[Object.keys(pages)[0]];
   if (!p || !p.extract) return null;
   const imageFile = p.original && p.original.source ? decodeURIComponent(String(p.original.source).split("?")[0].split("/").pop()) : "";
   return { title: p.title, url: p.fullurl || ("https://en.wikipedia.org/wiki/" + encodeURIComponent(p.title.replace(/ /g, "_"))),
            text: String(p.extract).slice(0, AI_CONFIG.maxRefChars), imageFile: imageFile };
}


// ------------------------------------------------------------
// Scientific name from a typed common name (trusted sources first)
//   1. FishBase / SeaLifeBase common-name search (species)
//   2. GBIF, the Global Biodiversity Information Facility (species and plants)
//   3. Fallback: Wikipedia's article title, then the AI (the app outlines it amber)
// Returns { sci, how: "trusted" | "fallback" | "", source: {title, url} | null,
//           choices: [{ scientificName, commonName, source }], pages: { fishbase html, ... } }
// ------------------------------------------------------------

// Compares common names loosely ("Amano Shrimp" = "amano shrimps" = "Amano's shrimp").
function aiNameKey_(s) {
   return String(s || "").toLowerCase().replace(/&#39;|'s\b|'/g, "").replace(/[^a-z0-9]/g, "").replace(/s$/, "");
}

// Species whose common name matches exactly, from a FishBase / SeaLifeBase common-name search page.
// When only one species matches, FishBase opens its summary page directly; that page is returned too.
function aiComNameHits_(html, typed) {
   if (!html) return { hits: [] };
   const title = aiHtmlText_((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
   if (/Environment/i.test(html) && aiBinomial_(title) && !/Search Result/i.test(title)) {
      const b = aiBinomial_(title);
      return { hits: [{ sci: b.genus + " " + b.species, common: typed }], summary: html };
   }
   const m = html.match(/var table_data_arr = (\{[\s\S]*?\});\s*var /);
   if (!m) return { hits: [] };
   let rows = [];
   try { rows = (JSON.parse(m[1]).table_filter) || []; } catch (e) { return { hits: [] }; }
   const want = aiNameKey_(typed);
   const hits = [];
   rows.forEach(r => {
      const common = aiHtmlText_(r[1]);
      const b = aiBinomial_(aiHtmlText_(r[6]));
      if (!b || aiNameKey_(common) !== want) return;
      const sci = b.genus + " " + b.species;
      if (!hits.some(h => h.sci === sci)) hits.push({ sci: sci, common: common });
   });
   return { hits: hits };
}

// Species whose English common name matches exactly, from GBIF's name search.
function aiGbifHits_(json, typed, table) {
   let data = null;
   try { data = JSON.parse(json || "null"); } catch (e) { return []; }
   const kingdom = table === "plants" ? "Plantae" : "Animalia";
   const want = aiNameKey_(typed);
   const hits = [];
   ((data && data.results) || []).forEach(r => {
      if (r.kingdom !== kingdom || !aiBinomial_(r.canonicalName)) return;
      const names = (r.vernacularNames || []).filter(v => !v.language || v.language === "eng").map(v => v.vernacularName);
      const match = names.find(n => aiNameKey_(n) === want);
      if (!match) return;
      const b = aiBinomial_(r.canonicalName);
      const sci = b.genus + " " + b.species;
      if (!hits.some(h => h.sci === sci)) hits.push({ sci: sci, common: match });
   });
   return hits;
}

// GBIF's exact match for a scientific name: { sci (the accepted name), key }, or null when GBIF
// doesn't know it as a species (or it's in the wrong kingdom, e.g. an animal for a plant).
function aiGbifMatch_(name, table) {
   let r = null;
   try { r = JSON.parse(aiFetchHtml_("https://api.gbif.org/v1/species/match?strict=true&name=" + encodeURIComponent(name)) || "null"); } catch (e) { return null; }
   if (!r || r.matchType !== "EXACT" || r.rank !== "SPECIES" || !r.species) return null;
   if (r.kingdom !== (table === "plants" ? "Plantae" : "Animalia")) return null;
   const b = aiBinomial_(r.species);
   return b ? { sci: b.genus + " " + b.species, key: r.speciesKey || r.usageKey } : null;
}

// Other scientific names (synonyms) GBIF lists for a species, e.g. Java fern's older
// name Microsorum pteropus, which is the name Tropica uses.
function aiGbifSynonyms_(sci, table) {
   const g = aiGbifMatch_(sci, table);
   if (!g || !g.key) return [];
   let r = null;
   try { r = JSON.parse(aiFetchHtml_("https://api.gbif.org/v1/species/" + g.key + "/synonyms?limit=50") || "null"); } catch (e) { return []; }
   const names = [g.sci];
   ((r && r.results) || []).forEach(x => { const b = aiBinomial_(x.canonicalName); if (b && names.indexOf(b.genus + " " + b.species) === -1) names.push(b.genus + " " + b.species); });
   return names;
}

function aiResolveName_(table, typed) {
   const out = { sci: "", how: "", source: null, choices: [], pages: {} };
   const q = encodeURIComponent(String(typed).trim());
   // 1. FishBase and SeaLifeBase common names (searched at the same time).
   if (table === "species") {
      const urls = ["https://www.fishbase.se/ComNames/CommonNameSearchList.php?CommonName=" + q,
                    "https://www.sealifebase.se/ComNames/CommonNameSearchList.php?CommonName=" + q];
      const html = aiFetchAll_(urls);
      const fb = aiComNameHits_(html[0], typed), slb = aiComNameHits_(html[1], typed);
      const hits = [];
      fb.hits.forEach(h => hits.push({ sci: h.sci, common: h.common, source: "FishBase", url: urls[0] }));
      slb.hits.forEach(h => { if (!hits.some(x => x.sci === h.sci)) hits.push({ sci: h.sci, common: h.common, source: "SeaLifeBase", url: urls[1] }); });
      if (fb.summary) out.pages.fishbase = fb.summary;
      if (slb.summary) out.pages.sealife = slb.summary;
      if (hits.length === 1) {
         out.sci = hits[0].sci; out.how = "trusted";
         out.source = { title: hits[0].source + ": common name \"" + typed + "\"", url: hits[0].url };
         return out;
      }
      if (hits.length > 1) { out.choices = hits.map(h => ({ scientificName: h.sci, commonName: h.common, source: h.source })); return out; }
   }
   // 2. GBIF common names.
   const gbifUrl = "https://api.gbif.org/v1/species/search?qField=VERNACULAR&rank=SPECIES&status=ACCEPTED" +
                   "&datasetKey=d7dddbf4-2cf0-4f39-9b2a-bb099caae36c&limit=20&q=" + q;
   const gbif = aiGbifHits_(aiFetchHtml_(gbifUrl), typed, table);
   if (gbif.length === 1) {
      out.sci = gbif[0].sci; out.how = "trusted";
      out.source = { title: "GBIF: common name \"" + typed + "\"", url: "https://www.gbif.org/species/search?q=" + q };
      return out;
   }
   if (gbif.length > 1) { out.choices = gbif.slice(0, 8).map(h => ({ scientificName: h.sci, commonName: h.common, source: "GBIF" })); return out; }
   // 3. Fallback: the Wikipedia article (its title, or the first scientific name in brackets in its
   //    opening lines), accepted only if GBIF confirms it's a real species; otherwise ask the AI.
   const wiki = aiWikipediaFromJson_(aiFetchHtml_(aiWikipediaUrl_(typed, table)));
   if (wiki && !/^List of|^Lists of/i.test(wiki.title)) {
      out.pages.wiki = wiki;
      const cands = [wiki.title];
      const m = String(wiki.text).slice(0, 400).match(/\(([A-Z][a-z]+ [a-z][a-z\-]+)/);
      if (m) cands.push(m[1]);
      for (let i = 0; i < cands.length; i++) {
         const g = aiBinomial_(cands[i]) ? aiGbifMatch_(cands[i], table) : null;
         if (g) {
            out.sci = g.sci; out.how = "fallback";
            out.source = { title: "Wikipedia: " + wiki.title, url: wiki.url };
            return out;
         }
      }
   }
   const ai = aiScientificName_(typed, table);
   if (ai) { out.sci = ai; out.how = "fallback"; }
   return out;
}

// Asks the AI for the scientific name when no source recognizes the common name.
function aiScientificName_(commonName, type) {
   const ai = aiGenerateJson_([{ text:
      "Give the accepted scientific name (genus and species) of this " + AI_TABLES[type].kind + " as it is sold in the aquarium hobby: \"" +
      commonName + "\". Reply with JSON only: {\"scientificName\": \"Genus species\" or \"\" if unsure}" }]);
   return aiBinomial_(ai.scientificName) ? String(ai.scientificName).trim() : "";
}


// ------------------------------------------------------------
// Credible reference pages for a species or plant, plus the Wikipedia
// article (photo, and fallback text), all fetched at the same time.
// pages: HTML already fetched while finding the scientific name.
// Returns { refs: [page], wiki }
// ------------------------------------------------------------
function aiCredibleSources_(table, known, sci, pages, wantWiki) {
   pages = pages || {};
   const refs = [];
   const wikiName = aiBinomial_(sci) ? sci : known["Common Name"];
   if (table === "plants") {
      // Tropica may list the plant under an older scientific name: try GBIF's synonyms too.
      let tUrl = aiTropicaUrl_([sci, known["Common Name"]]);
      if (!tUrl) tUrl = aiTropicaUrl_(aiGbifSynonyms_(sci, table));
      const got = aiFetchAll_([tUrl, pages.wiki || !wantWiki ? null : aiWikipediaUrl_(wikiName, table)]);
      const t = tUrl ? aiTropicaPage_(tUrl, got[0]) : null;
      if (t) refs.push(t);
      return { refs: refs, wiki: pages.wiki || aiWikipediaFromJson_(got[1]) };
   }
   // Fish are on FishBase (+ Seriously Fish); anything FishBase doesn't have is taken from
   // SeaLifeBase. The Category typed in isn't trusted here, since it may be the thing that's wrong.
   const got = aiFetchAll_([
      pages.fishbase ? null : aiFishBaseUrl_(sci, false),
      pages.sealife ? null : aiFishBaseUrl_(sci, true),
      aiSeriouslyFishUrl_(sci),
      pages.wiki || !wantWiki ? null : aiWikipediaUrl_(wikiName, table)
   ]);
   const fb = aiFishBasePage_(sci, false, pages.fishbase || got[0]);
   if (fb) {
      refs.push(fb);
      const sf = aiSeriouslyFishPage_(sci, got[2]);
      if (sf) refs.push(sf);
   } else {
      const slb = aiFishBasePage_(sci, true, pages.sealife || got[1]);
      if (slb) refs.push(slb);
   }
   return { refs: refs, wiki: pages.wiki || aiWikipediaFromJson_(got[3]) };
}

// Numbers read straight off the credible pages (no AI), so they match the source exactly.
// Seriously Fish (aquarium values) wins over FishBase/SeaLifeBase (wild habitat values).
// Returns { field: { value, source } } for Temp Min °F, Temp Max °F and Max Size (in).
function aiSourceNumbers_(refs) {
   const out = {};
   const set = (f, v, src) => { if (!(f in out) && v !== null && isFinite(v)) out[f] = { value: v, source: src }; };
   const ordered = refs.filter(r => /^Seriously Fish:/.test(r.title)).concat(refs.filter(r => /^(FishBase|SeaLifeBase):/.test(r.title)));
   ordered.forEach(r => {
      const t = r.text;
      let m;
      if (/^Seriously Fish:/.test(r.title)) {
         // "Quick facts ... Max size 150 mm SL 6 in SL ... Temp 24–28 °C 75–82 °F"
         if ((m = t.match(/Temp\s+[\d.]+\s*[–-]\s*[\d.]+\s*°C\s+(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)\s*°F/))) {
            const lo = Math.round(Number(m[1])), hi = Math.round(Number(m[2]));
            if (lo < hi && lo >= 32 && hi <= 100) { set("Temp Min °F", lo, r.title); set("Temp Max °F", hi, r.title); }
         }
         if ((m = t.match(/Max size\s+[\d.]+\s*mm\s*\w*\s+(\d+(?:\.\d+)?)\s*in\b/))) set("Max Size (in)", Number(m[1]), r.title);
      } else {
         // "Tropical; 21°C - 25°C" and "Max length : 27.5 cm TL"
         if ((m = t.match(/(-?\d+(?:\.\d+)?)\s*°C\s*[–-]\s*(-?\d+(?:\.\d+)?)\s*°C/))) {
            const lo = Math.round(Number(m[1]) * 9 / 5 + 32), hi = Math.round(Number(m[2]) * 9 / 5 + 32);
            if (lo < hi && lo >= 32 && hi <= 100) { set("Temp Min °F", lo, r.title); set("Temp Max °F", hi, r.title); }
         }
         if ((m = t.match(/Max length\s*:\s*(\d+(?:\.\d+)?)\s*cm/i))) set("Max Size (in)", Math.round(Number(m[1]) / 2.54 * 10) / 10, r.title);
      }
   });
   return out;
}


// ------------------------------------------------------------
// Fill with AI
// req: { table, values: { field: current value }, link?, findPhoto? }
// Returns suggestions for the blank fields only, corrections to entered
// values, or (when a common name fits several species) choices to pick from.
// The same lookup repeated within 6 hours is answered from the cache.
// ------------------------------------------------------------
function apiAiFill_(req, user) {
   aiRequireUser_(user);
   const t0 = Date.now();
   const vals = {};
   Object.keys(req.values || {}).sort().forEach(k => { const v = String(req.values[k] === null || req.values[k] === undefined ? "" : req.values[k]).trim(); if (v) vals[k] = v; });
   // The key includes AI_CONFIG.cacheVersion, so saved results are dropped when the lookup logic changes.
   const key = "aifill_" + AI_CONFIG.cacheVersion + "_" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
      JSON.stringify([req.table, vals, req.link || "", !!req.findPhoto]), Utilities.Charset.UTF_8));
   const cache = CacheService.getScriptCache();
   const hit = cache.get(key);
   if (hit) {
      try { const out = JSON.parse(hit); out.cached = true; out.ms = Date.now() - t0; return out; } catch (e) { /* look it up again */ }
   }
   const out = aiFill_(req);
   out.ms = Date.now() - t0;
   try { cache.put(key, JSON.stringify(out), 21600); } catch (e) { /* too big to cache: fine */ }
   return out;
}

// The lookup itself (apiAiFill_ adds the cache).
function aiFill_(req) {
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
   // Entered values the AI may correct when a credible source contradicts them
   // (text, dropdown and number fields, names included).
   const checkable = fillable.filter(f => !isBlank(current[f.name]));
   const name = table === "equipment" ? [known["Manufacturer"], known["Filter Model"]].filter(Boolean).join(" ")
              : (known[cfg.name] || known["Common Name"] || known["Scientific Name"] || known["Product Name"]);
   if (!name) throw apiError_("INVALID", "Type a name first" + (table === "equipment" ? " (brand and model)" : "") + ".");
   if (!blanks.length && !checkable.length) return { suggestions: {}, sources: [], notes: "Every field already has a value.", filled: 0 };

   // Reference text. Species and plants: credible sources only (FishBase, Seriously Fish,
   // SeaLifeBase, Tropica). Wikipedia is used for the photo, and for information only
   // when no credible source has the species (then everything is marked to verify).
   const sources = [];
   let refs = "";
   let credible = false, fallback = false, partial = false, sci = known["Scientific Name"] || "";
   const addRef = (label, pg) => {
      refs += "\n\nREFERENCE \"" + label + "\" (" + pg.url + "):\n" + pg.text;
      sources.push({ title: label, url: pg.url });
   };
   if (req.link) {
      const pg = aiPageText_(req.link);
      if (pg) addRef(pg.title, pg);
   }
   let wiki = null, nameHow = "typed", nameLabel = "", direct = {};
   if (table === "species" || table === "plants") {
      // Common name only: find the scientific name (trusted sources first).
      let pages = {};
      if (!aiBinomial_(sci) && known["Common Name"]) {
         const nm = aiResolveName_(table, known["Common Name"]);
         if (nm.choices.length) {
            return { choices: nm.choices, suggestions: {}, corrections: {}, sources: [], filled: 0,
                     notes: "\"" + known["Common Name"] + "\" is the common name of more than one species. Pick the one you mean." };
         }
         sci = nm.sci; nameHow = nm.how || "none"; pages = nm.pages;
         nameLabel = nm.source ? nm.source.title : "";
         if (nm.source && nm.how === "trusted") sources.push(nm.source);
      }
      const wantWiki = !!(req.findPhoto && isBlank(current["Thumbnail URL"]));
      // The Wikipedia article is fetched alongside (photo, and text when the sources fall short).
      const found = aiBinomial_(sci) ? aiCredibleSources_(table, known, sci, pages, true) : { refs: [], wiki: pages.wiki || null };
      found.refs.forEach(pg => addRef(pg.title, pg));
      credible = found.refs.length > 0;
      // SeaLifeBase alone has little aquarium data (shrimp, snails): fields it doesn't cover may
      // come from Wikipedia / AI knowledge, marked "verify" in the app.
      partial = credible && found.refs.every(pg => /^SeaLifeBase:/.test(pg.title));
      wiki = found.wiki;
      if (!wiki && (!credible || partial || wantWiki)) wiki = aiWikipedia_([sci, known["Common Name"]], table);
      if ((!credible || partial) && wiki) { addRef("Wikipedia: " + wiki.title, { url: wiki.url, text: wiki.text }); }
      fallback = !credible;
      // Numbers read straight off the credible pages (no AI needed for these).
      direct = credible ? aiSourceNumbers_(found.refs) : {};
      Object.keys(direct).forEach(f => { if (!fillable.some(x => x.name === f)) delete direct[f]; });
   }
   const credibleLabels = sources.filter(x => !/^Wikipedia:/.test(x.title)).map(x => x.title);
   const preset = {}, presetSources = {};
   if (table === "species" || table === "plants") {
      if (isBlank(current["Scientific Name"]) && aiBinomial_(sci) && (nameHow === "trusted" || nameHow === "fallback")) {
         preset["Scientific Name"] = sci;
         presetSources["Scientific Name"] = nameHow === "trusted" ? nameLabel : (/^Wikipedia/.test(nameLabel) ? "Wikipedia" : "AI knowledge");
      }
      Object.keys(direct).forEach(f => { if (isBlank(current[f])) { preset[f] = direct[f].value; presetSources[f] = direct[f].source; } });
   }
   const aiBlanks = blanks.filter(f => !(f.name in preset));
   // Entered numbers the source states exactly are checked here, not by the AI.
   const directFixes = {};
   checkable.forEach(f => {
      const d = direct[f.name];
      if (!d) return;
      const before = String(current[f.name]).trim();
      if (Number(before.replace(/,/g, "")) !== Number(d.value)) directFixes[f.name] = { from: before, to: d.value, source: d.source, reason: "the source gives " + d.value };
   });
   const aiCheckable = checkable.filter(f => !direct[f.name]);

   // Nothing blank and no credible source to check entered values against: nothing to do.
   if (!blanks.length && !credible && !Object.keys(preset).length) {
      return { suggestions: {}, corrections: {}, sources: sources, filled: 0, fallback: fallback,
               notes: "Every field already has a value, and no credible source was found to check them against." };
   }

   // Existing rows show the AI the expected style; list fields get their allowed values.
   const examples = aiExampleRows_(table, fillable.map(f => f.name));
   const fieldLines = aiBlanks.map(f => {
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
      (Object.keys(preset).length ? "Already taken from the sources (don't change these): " + JSON.stringify(preset) + "\n\n" : "") +
      (aiBlanks.length ? "Fill in ONLY these blank fields:\n" + fieldLines + "\n\n" : "There are no blank fields to fill.\n\n") +
      (examples.length ? "Match the style, wording length and units of these existing records from the same list:\n" + JSON.stringify(examples, null, 1) + "\n\n" : "") +
      "Rules:\n" +
      "- Use temperatures in °F and sizes in inches (convert from °C / cm when needed).\n" +
      (partial
        ? "- Use the SeaLifeBase reference wherever it covers a field. For fields it doesn't cover, use the Wikipedia reference or " +
          "well-established aquarium-hobby knowledge, and name that source (\"Wikipedia\" or \"AI knowledge\") in fieldSources.\n"
        : credible
        ? "- Use ONLY the reference pages below. If none of them supports a field, return null for it. " +
          "For aquarium care (temperature range, group size, temperament, diet, difficulty, adult size in aquariums) prefer the aquarium-care source " +
          "(Seriously Fish or Tropica) over FishBase/SeaLifeBase, whose temperatures are wild habitat values.\n"
        : "- Prefer the reference text below when it covers a field; otherwise use well-established knowledge.\n") +
      "- If a value isn't reasonably certain, use null. Never invent model numbers, measurements or links.\n" +
      "- Keep text fields short, like the examples.\n" +
      (credible && aiCheckable.length
        ? "- Also check these values the user entered: " + JSON.stringify(aiCheckable.reduce((o, f) => { o[f.name] = String(current[f.name]).trim(); return o; }, {})) + ". " +
          "Only if a reference page clearly contradicts one, put the corrected value in \"corrections\" with the reference name and a short reason. " +
          "Don't correct wording, spelling style or format differences, or values the references don't address. " +
          "Common names vary between sources: only correct a common name if it belongs to a different species than the one the references describe." +
          (aiCheckable.some(f => f.type === "list" && f.strict) ? " Dropdown fields must still use one of their allowed values: " +
            JSON.stringify(aiCheckable.filter(f => f.type === "list" && f.strict).reduce((o, f) => { o[f.name] = f.options; return o; }, {})) + "." : "") + "\n"
        : "") +
      "- In \"fieldSources\", give for each filled field the exact reference name it came from (as written in quotes after REFERENCE), or \"AI knowledge\".\n" +
      "Reply with JSON only: {\"identified\": \"the exact item you filled in for (name, scientific name or brand + model)\", " +
      "\"confidence\": \"High\" | \"Medium\" | \"Low\", \"fields\": {\"<field name>\": value or null}, " +
      "\"fieldSources\": {\"<field name>\": \"reference name\"}, " +
      "\"corrections\": {\"<field name>\": {\"value\": \"corrected value\", \"source\": \"reference name\", \"reason\": \"short\"}}, " +
      "\"notes\": \"one or two short caveats, or empty\"}" +
      refs;

   // Ask, then keep only valid suggestions for fields that were blank.
   // The AI is only asked when something is left for it (blank fields, or entered values to check).
   const ai = (aiBlanks.length || (credible && aiCheckable.length)) ? aiGenerateJson_([{ text: prompt }]) : {};
   const suggestions = aiCleanSuggestions_(aiBlanks, ai.fields || {});
   // Where each value came from. With credible sources, anything not traced to one is dropped.
   const fieldSources = {};
   const rawSources = ai.fieldSources || {};
   Object.keys(suggestions).forEach(f => {
      const src = String(rawSources[f] || "").trim();
      const match = credibleLabels.find(l => src && (src === l || src.indexOf(l) !== -1 || l.indexOf(src) !== -1));
      if (credible && !partial && !match) { delete suggestions[f]; return; }
      fieldSources[f] = match || (fallback ? (src && /^Wikipedia/i.test(src) ? "Wikipedia" : "AI knowledge") : (src || "AI knowledge"));
   });
   // Values taken straight from the sources join the AI's suggestions.
   Object.keys(preset).forEach(f => {
      const cleaned = aiCleanSuggestions_(blanks.filter(x => x.name === f), { [f]: preset[f] })[f];
      if (cleaned === undefined) return;
      suggestions[f] = cleaned;
      fieldSources[f] = presetSources[f];
   });
   const missing = credible ? blanks.map(f => f.name).filter(n => !(n in suggestions)) : [];
   // Fields not traced to a credible source (all of them in fallback mode): the app outlines them amber.
   const unverified = Object.keys(suggestions).filter(f => fallback || !credibleLabels.some(l => fieldSources[f] === l));
   // A scientific name found only through Wikipedia / the AI is always marked to verify.
   if (nameHow === "fallback" && "Scientific Name" in suggestions && unverified.indexOf("Scientific Name") === -1) unverified.push("Scientific Name");
   // Corrections to entered values: only when traced to a credible source. The app outlines
   // corrected fields so you can review them before saving.
   const corrections = directFixes;
   if (credible) {
      const rawC = ai.corrections || {};
      aiCheckable.forEach(f => {
         const c = rawC[f.name];
         if (!c || typeof c !== "object") return;
         const src = String(c.source || "").trim();
         const label = credibleLabels.find(l => src && (src === l || src.indexOf(l) !== -1 || l.indexOf(src) !== -1));
         if (!label) return;
         const cleaned = aiCleanSuggestions_([f], { [f.name]: c.value })[f.name];
         if (cleaned === undefined) return;
         const before = String(current[f.name]).trim();
         if (f.type === "number" ? Number(String(before).replace(/,/g, "")) === Number(cleaned)
                                 : String(cleaned).trim().toLowerCase() === before.toLowerCase()) return;
         corrections[f.name] = { from: before, to: cleaned, source: label, reason: String(c.reason || "").slice(0, 200) };
      });
   }
   const out = {
      suggestions: suggestions,
      fieldSources: fieldSources,
      corrections: corrections,
      unverified: unverified,
      credible: credible,
      fallback: fallback,
      notFound: missing,
      scientificName: sci,
      nameFrom: nameHow,
      filled: Object.keys(suggestions).length,
      identified: String(ai.identified || "").slice(0, 200),
      confidence: /^(High|Medium|Low)$/i.test(String(ai.confidence)) ? String(ai.confidence).replace(/^./, c => c.toUpperCase()) : "",
      notes: String(ai.notes || "").slice(0, 500),
      sources: sources,
      model: ai.fields ? AI_LAST_MODEL : ""
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
