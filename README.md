# Ayers Aquariums

Mobile web app for the Aquarium Portfolio Master Database Google Sheet.

- Front end: static files served by GitHub Pages (`index.html`, `app.js`, `styles.css`, `config.js`).
- Back end: `apps-script/Api.gs`, installed in the sheet's Apps Script project and deployed as a web app.
- Sign-in: Google Identity Services; access is controlled by the **App Users** tab in the sheet.

## Apps Script files (`apps-script/`)

All of these live in the sheet's Apps Script project ("Aquarium Database"); GitHub keeps the reference copy.

| File | What it does |
|---|---|
| `OnOpen.gs` | Adds the sheet's **Processing** menu. |
| `Entry Forms.gs` | The sheet's Add Species / Tank / Equipment / Plant / Medication / Water Parameter forms, and `SHEET_IDS` (tab IDs used everywhere). |
| `Api.gs` | Web app entry point (`doPost`), sign-in check, roles, reading and writing records, Change Log. |
| `Receipts.gs` | Receipt photo uploads (Drive) and linking receipts to records. |
| `WaterTests.gs` | Test types, water test sessions and readings. |
| `Maintenance.gs` | Water changes. |
| `Ai.gs` | Google Gemini helper: Fill with AI, photo identification, Read label (equipment photos). Needs the `GEMINI_API_KEY` script property; run `aiTest()` to check it. |
| `Wishlist.gs` | Wishlist, Mark purchased, AI compatibility checks, private item photos. |
| `Delete.gs` | Permanent delete for admins: records (with everything linked to them), receipts and item photos; Drive files go to the Drive trash. |
| `Photos.gs` | Item Photos tab: several photos per species, equipment or plant (admins add, caption, remove, pick the list picture; everyone can view). |
| `Prices.gs` | Price tracker: Price Items and Prices tabs. One row per item, the latest price at each store, history kept; admins and editors add, edit and delete. |
| `Lists.gs` | Dropdown lists (Lookups tab): admins add, rename (records using the value are updated), turn off/on and describe values; admins can also type new values into form dropdowns. |

`apps-script/archive/` holds old code that is no longer in the project (kept for reference only).
