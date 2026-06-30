# MF, MF! — setup

A personal PWA that reads your q-commerce order screenshots (Blinkit, Zepto, Instamart…),
extracts the line items with Claude vision, and lets you tag them Personal/Shared, track
spending, and export to Excel. Built on the same pattern as Charaivati: local-first PWA +
Firebase sync + a Claude-Max analysis engine ($0).

This file covers **Phase 1** (the app shell + capture + sync). The analysis engine
(`automation/`) comes in Phase 2.

---

## A. Run it locally (no setup needed)
Open `index.html` in a browser, or serve the folder:
```
npx serve mfmf
```
You can already add screenshots — they're saved locally and queued. They'll say
**"Saved — sign in to analyze"** until Firebase is connected (next step).

---

## B. Connect Firebase sync (laptop ↔ phone)

> Use a **separate Firebase project** from Charaivati — keeps your finances isolated.

1. **Create the project** — [console.firebase.google.com](https://console.firebase.google.com) →
   *Add project* → name it e.g. `mf-mf` → you can disable Analytics.

2. **Add a Web app** — Project Overview → the `</>` (web) icon → register an app
   (no Hosting needed) → copy the `firebaseConfig` object.

3. **Paste the config** into `index.html` — find the `PASTE_ME` block near the bottom
   (the `<script type="module">`) and replace `apiKey`, `authDomain`, `projectId`, `appId`.
   (The `apiKey` is **not** a secret — security comes from the rules below.)

4. **Enable Google sign-in** — Build → Authentication → *Get started* →
   Sign-in method → **Google** → enable → save.

5. **Create Firestore** — Build → Firestore Database → *Create database* →
   start in **production mode** → pick a region (e.g. `asia-south1` Mumbai).

6. **Paste the security rules** — Firestore → Rules tab → replace with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // each user owns their data and their receipts
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
      match /receipts/{rid} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
    }

    // the inbox holds pending screenshots; clients may only DROP OFF their own.
    // The analysis engine (service account) reads & clears them, bypassing rules.
    match /inbox/{id} {
      allow create: if request.auth != null && request.resource.data.uid == request.auth.uid;
      allow read, update, delete: if false;
    }
  }
}
```
Publish.

7. **Reload the app and sign in.** The status row at the bottom of Home should read
   **"Synced · your@email"**. Any screenshots you'd queued upload automatically.

### Verify Phase 1 works
- Add a screenshot → it appears on Home as an order with a **"Queued"** status.
- In the Firebase console → Firestore, you should see a new doc under
  `inbox/…` (with the base64 image) and one under `users/{your-uid}/receipts/…`.
- That `inbox` doc is exactly what the Phase 2 engine will pick up to analyze.

---

## C. What's built
- ✅ Installable PWA, Material You watercolor aesthetic, 5-tab nav + FAB
- ✅ Add order: multi-screenshot capture (compressed) **or** manual entry with inline tagging
- ✅ Google sign-in, local-first storage, receipts collection sync, inbox upload
- ✅ **Phase 2** — Claude-vision analysis engine (`automation/`, runs on Max = $0)
- ✅ **Phase 3** — Tag screen (per-item Personal/Shared + bulk) · Orders tab (sort/filter) · edit + delete
- ✅ **Phase 4** — Insights (by category, by vendor, monthly trend, most-bought)
- ✅ **Phase 5** — Excel export (full multi-sheet workbook + shared-items-for-flatmate)
- ✅ **Share Target (Android)** — share Blinkit/Zepto screenshots or invoice PDFs straight into the app
  from the share sheet; multi-select or one-at-a-time shares accumulate into a single order
- ⏳ Register the Windows Scheduled Task (see `automation/README.md`) so phone screenshots auto-analyze

## Files
- `index.html` — the whole app (UI + capture + tag + insights + export + Firebase sync)
- `sw.js` · `manifest.webmanifest` · `speed-rupee-logo.svg` · `bg.jpg` — PWA shell
- `automation/` — the Claude-vision analysis engine (`analyze.js`, `check.js`, `run-analyze.ps1`)
