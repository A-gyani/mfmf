# MF, MF! — project guide (read this first)

> Documentation for anyone (human or a future Claude session) picking this up cold.
> It explains **what the app is, how it's built, and where to make changes.**
> Companion docs: [`SETUP.md`](SETUP.md) (one-time Firebase setup) and
> [`automation/README.md`](automation/README.md) (the analysis engine).

---

## 1. What it is

**MF, MF!** ("Manage Finance, MF!") is a personal **q-commerce expense tracker** PWA.
You drop in screenshots of your Blinkit / Zepto / Instamart / etc. orders; a Claude-vision
engine reads them into structured line items; you tag each item **Personal** or **Shared**;
and you get spending **insights** and an **Excel export** to settle with a flatmate.

It is single-user, personal, and **free to run**: the analysis uses the owner's **Claude Max**
plan via the `claude` CLI (no Claude API key / no per-call cost), and everything else runs on
Firebase's free tier + GitHub Pages.

### Core loop
```
Phone: add screenshot(s) ──sync──▶ Firestore inbox (status: Queued)
                                        │  ⏱ ~15 min (laptop on) — the Scheduled Task
        analysis engine runs ──▶ Claude vision groups + extracts + dedupes
                                        │
Firestore receipts (status: ready) ──sync──▶ Phone: order "Ready to tag"
        you tag items Personal/Shared ──▶ Insights + Excel export
```

**Key trade-off:** analysis runs on the **owner's laptop** (that's where `claude` lives), so a
phone-added screenshot is processed on the next engine run (~15 min) while the laptop is on.
The phone alone cannot analyze.

---

## 2. Status

**Feature-complete v1, deployed and in use.** Live at **https://a-gyani.github.io/mfmf/**
(repo `https://github.com/A-gyani/mfmf`). Done: capture (screenshot, **invoice PDF**, **or**
manual), vision analysis with **group-then-extract** + **robust duplicate detection**, tagging
(per-item + bulk), Orders (sort/filter/edit/delete), Insights (tax-reconciled), Excel export,
Firebase sync, PWA install, 15-min auto-analyze Scheduled Task. SW cache is at **`mfmf-v14`**
(bump it on every deploy — see §10).

---

## 3. Tech stack & hard constraints

- **Frontend:** a single static file `index.html` (no build step, no framework). Vanilla JS,
  Material You styling, Roboto + Material Symbols Rounded (Google Fonts), all paths relative.
- **Sync/auth/DB:** Firebase — Google Auth + Cloud Firestore (free Spark tier).
- **Analysis:** Node scripts in `automation/` that shell out to the `claude` CLI (vision).
- **Excel:** SheetJS (`xlsx`), lazy-loaded from cdnjs in the browser.
- **Hosting:** GitHub Pages (public repo; data lives in Firestore/localStorage, not the repo).
- **Constraints (do not break these):** must stay **free**; **no Claude API** (use the Max-plan
  `claude` CLI); **no build step** (keep it a hand-editable single HTML file); **no dark mode**
  (intentional); keep the UI **clean — no helper/sub-label text** under fields.

---

## 4. File map

**In the repo (served by GitHub Pages — keep this minimal):**
| File | Purpose |
|---|---|
| `index.html` | The entire app — UI, all screens, capture, tagging, insights, export, Firebase sync. ~900 lines. |
| `sw.js` | Service worker: caches the shell (`CORE` list) + network-first navigation so deploys auto-update. **Bump `CACHE` every deploy.** |
| `manifest.webmanifest` | PWA metadata; icon → `speed-rupee-logo.svg`. |
| `speed-rupee-logo.svg` | App logo (blue→pink gradient tile + ₹). Used as icon + in the home header. |
| `bg.jpg` | Full-screen app wallpaper (pastel finance-icon image, optimized to ~31 KB). |
| `SETUP.md`, `CLAUDE.md` | Docs. |

**Local-only (git-ignored — never committed, never deployed):**
| Path | Purpose |
|---|---|
| `automation/` | The Claude-vision engine (runs on the laptop). See §8. |
| `automation/service-account.json` | **SECRET** Firebase admin key. Never commit, never paste in chat. |
| `automation/node_modules/`, `automation/_work/`, `*.log` | deps / scratch / logs. |
| `*.png`, `*.avif` | source design images (e.g. wallpaper/logo sources). Only the optimized `bg.jpg` is committed. |

`.gitignore` enforces the split. **When adding a served asset, also add it to `sw.js` `CORE`.**

---

## 5. Architecture & data flow

```
┌── CLIENT (index.html on GitHub Pages) ───────────────────────────────┐
│  localStorage (instant cache)  ◀▶  in-memory `state.receipts`         │
│  two <script> blocks:                                                 │
│   (a) plain  <script>  = all app logic + UI render + a window.* bridge│
│   (b) <script type="module"> = Firebase (auth + Firestore live sync)  │
└───────────────┬───────────────────────────────────────────┬──────────┘
        writes pending order + base64 images        reads ready receipts
                ▼                                            ▼
┌── FIREBASE (project mf-mf-7cee1, free) ──────────────────────────────┐
│  Auth: Google                                                         │
│  Firestore:  users/{uid}/receipts/{id}   (orders, lean)               │
│              inbox/{autoId}              (transient pending screenshots)│
└───────────────┬───────────────────────────────────────────────────────┘
        service-account reads inbox / writes receipts (bypasses rules)
                ▼
┌── ANALYSIS ENGINE (automation/, owner's laptop, Claude Max = $0) ────┐
│  fetch pending inbox → claude vision (group+extract+dedup) → write     │
│  receipts (status: ready) → delete inbox images. Runs every ~15 min   │
│  via the "MF MF Analyze" Scheduled Task; idle runs skip Claude.       │
└───────────────────────────────────────────────────────────────────────┘
```

The client and engine never talk directly — **Firestore is the only channel.** The client
writes `inbox` docs + a placeholder `receipt`; the engine consumes `inbox` and fills `receipts`.

---

## 6. Data model

### Firestore
- `users/{uid}/receipts/{receiptId}` — one document **per order** (a collection, not one big
  doc, because orders grow unbounded). Fields:
  ```
  { id, vendor, status, total, currency:'INR',
    orderId,            // printed order id if read (used for dedup)
    sig,                // dedup signature (see §8)
    orderDate,          // ms epoch (number)  — normalize Firestore Timestamps with toMs()
    createdAt,          // ms epoch or serverTimestamp
    screenshots,        // count
    fees:{delivery,handling,tip,discount},
    items:[ {id, name, qty, unit, price, category, tag} ],  // tag: 'personal'|'shared'|null
    manual:true|undefined }
  ```
  `status` ∈ `pending` → `analyzing` → `ready` → `tagged`; plus `duplicate` (a dismissible
  "already analyzed" notice). Manual entries skip straight to `ready`/`tagged`.
- `inbox/{autoId}` — transient, one **per file** (screenshot **or** invoice PDF): `{ uid, batchId,
  idx, vendor, image (base64 dataURL — JPEG or `application/pdf`), status:'pending', createdAt }`.
  Deleted by the engine after analysis.
- `users/{uid}` parent doc has **no fields** (only the subcollection) — so a top-level
  `collection('users').get()` returns 0 docs; **use `collectionGroup('receipts')`** to scan.

### Local (browser)
- `localStorage['mfmf.v1']` = `{ receipts:[...], settings:{} }` (mirror of receipts).
- `localStorage['mfmf.queue']` = `{ [receiptId]: {vendor, images:[dataURL]} }` — screenshots
  captured but not yet uploaded (flushed to `inbox` on sign-in).

### Firestore security rules
Owner-only on `users/**`; `inbox` is **create-only** for the signed-in user (the engine reads
it via the service account, which bypasses rules). Full rules text is in [`SETUP.md`](SETUP.md) §B.

---

## 7. The app — `index.html` structure

One file, two scripts. The app logic is organized into clearly-commented sections
(`/* ===== SECTION ===== */`). **Reference functions/sections by name — line numbers drift.**

### Screens (sections toggled by `go(id)`)
`home` · `orders` · `tag` · `insights` · `export` · `add` (screenshot capture) · `manual`
(manual entry **and** the order editor). Bottom nav has 5 tabs: Home / Orders / Tag / Insights
/ Export. The pink **FAB** (Add) shows **only on Home** (`go()` hides it when `id!=='home'`).

### State & globals (top of the plain `<script>`)
`state` (`{receipts, settings}`), `current` (active screen), `editingId`/`manualReturn`
(editor), `oSort/oVendor/oMonth` (Orders filters), `period` (Insights), `xMonth` (Export),
`draftImages/draftVendor` (capture), `mVendor` (manual), `extraVendors/extraCats` (custom
values added this session). Constants: `VENDORS`, `VENDOR_COLOR`, `CATS`.

### Code map (function → what it does)
- **Helpers:** `load/saveLocal`, `loadQueue/saveQueue`, `uid`, `inr` (₹ format), `toMs`
  (normalize numbers/strings/Firestore Timestamps), `localDateStr`, `toast`, `esc`.
- **Nav:** `go(id)` (show screen + render it), `rerender()` (re-render current screen after data changes).
- **Shared render:** `vendorAva`, `statusPill`, `orderCardHTML`, `vendorName`, `monthKey/monthLabel/fmtDate`.
- **Home:** `renderHome()` — month total + personal/shared split bar + "ready to tag" banner +
  the **"Already analyzed" dup notice** (`dismissReceipt`) + the **5 most recent** orders.
- **Orders:** `renderOrders()` — all orders, sort (`oSort`) + filter (`oVendor`,`oMonth`); cards open the editor.
- **Tag:** `renderTag()` — `ready` orders as cards with per-item `.seg` Personal/Shared toggles
  (`tagItem`) + bulk `tagAll`; an order flips to `tagged` (and leaves the queue) when all items tagged.
- **Add (screenshot or PDF):** `openAdd`, `onFiles` (images → `compress` canvas-resize to JPEG
  dataURL < ~780 KB; **PDFs → `readDataURL`** as-is, capped ~700 KB / 950 000 chars for the 1 MB
  doc limit), `renderThumbs` (image thumb or a PDF placeholder), `submitOrder` (queues + uploads).
  Each file becomes one `inbox` doc; the dataURL's `data:` prefix tells the engine PDF vs image.
- **Manual / editor:** `openManual` (new), `editOrder(id)` (loads an existing order into the
  same form), `addItemRow` (name / **qty `×`** / ₹ line-total / category / tag — preserves `qty`
  and `unit`; never hardcode qty), `setRowTag`, `recalcTotal`, `catChanged`
  (the "+ Add category…" flow), `saveManual` (create or update), `deleteOrder`, `cancelManual`.
- **Vendor/category pickers:** `allVendors`/`allCats` derive options from base lists + values
  already used in receipts + `extraVendors/extraCats`; `renderChips` (with a "+ New" chip),
  `renderAddVendors`/`renderManVendors`, `catOptions`.
- **Insights:** `renderInsights` (period chips, stat cards, by-category bars, by-vendor rows,
  `monthlyTrend` stacked bars, most-bought). Pure CSS/SVG, no chart lib. **Reconciles:** headline
  Total = `receipt.total` (tax-inclusive) while breakdowns sum `item.price`; a **bridge line**
  shows `Items + taxes & charges = Total` (taxes = total − items — there is **no tax field**, q-comm
  taxes live only inside `total`), the split bar has an **untagged** (gray) slice, and most-bought
  collapses cosmetic name variants via `canonName` (e.g. the three "Gold Flake…" spellings → 1 row).
- **Export:** `renderExport`, `ensureXLSX` (lazy-load SheetJS), `exportExcel(mode)` (`full` =
  5-sheet workbook; `shared` = shared-items-only for the flatmate), `fname`.
- **Sync bridge (`window.__*`):** the plain script defines `__onAuth`, `__applyRemoteReceipts`,
  `__setSyncStatus`, `saveReceipt`, `flushQueue`, `pushLocalReceipts`; the **module script**
  defines `signInGoogle`, `signOutMfmf`, `__uploadPending`, `__uploadReceiptDoc`,
  `__deleteReceiptDoc` and runs the `onSnapshot` live sync. They communicate only via `window.*`.

### Styling
Material You via CSS variables in `:root` (blue base + pink accent; see `--primary`, `--pink`,
`--blue-c`, `--mint-c`, etc.). `bg.jpg` is a fixed full-screen wallpaper (`body::before`). The
home header (`.hero`/`.brandSplash`) is transparent — logo + bold wordmark sit on the wallpaper.

---

## 8. The analysis engine (`automation/`)

Runs on the laptop, on the Max plan ($0). Files: `analyze.js` (the engine), `check.js`
(connectivity/state probe, no Claude), `run-analyze.ps1` (Scheduled-Task wrapper → `analyze.log`),
`add-domain.js` (authorize a domain for Firebase sign-in via the service account), `package.json`.

**`analyze.js` flow:**
1. Read `inbox` where `status=='pending'`; **group by `uid`+`batchId`** (one batch = one "Add"). The
   engine reads the **whole** `inbox` (all users), so it processes any signed-in user's files — see §14.
2. For each batch: decode each `inbox` file to `_work/` — a `data:application/pdf` dataURL → `*.pdf`,
   else `*.jpg` (Claude's Read tool reads PDFs natively). Set the placeholder to `analyzing`.
3. Split the batch by kind, then extract (`claude -p --allowedTools Read --model sonnet`):
   - **PDFs → one call each.** An invoice PDF is one complete order, so each is extracted on its own
     (no grouping) — any number can be added at once with no big/timeout-prone call.
   - **Screenshots → GROUP-THEN-EXTRACT** (replaced the old fixed-size chunking, which split an order
     straddling a chunk edge into partial/0-item duplicate fragments). ≤`CHUNK`=6 screenshots → one
     combined group+extract call; more → one **light grouping pass** over all screenshots
     (`buildGroupPrompt`, decides order boundaries with full context), then each order extracted from
     **only its own screenshots** (`buildPrompt`) — never split across calls.
   Extraction returns `vendor, orderId, orderDate, items[], fees, total`; the category enum is
   **dynamic** (`loadCats` = base `CATS` ∪ categories used in your receipts). **0-item "orders" are dropped.**
4. **Dedup** (`idKey`/`contentKey`/`isDup`/`remember`, was `orderSig`): a printed `orderId` keys
   **vendor-agnostically** (`id|<orderid>`); the content key is **date + sorted item prices** (robust
   to vendor mis-reads, item-name variance, and tax-shifted totals); an order WITH an id also matches
   a manual/legacy copy WITHOUT one. Compared against existing `ready/tagged` receipts (per uid). New
   orders are created (first reuses the placeholder, extras become new docs); a batch that's **entirely**
   duplicates becomes one `status:'duplicate'` notice; skipped dups are logged.
5. Delete the batch's `inbox` files. On failure, revert the placeholder to `pending` (retries next run).

**Run it:** `node automation/check.js` (verify wiring, free) · `node automation/analyze.js`
("Analyze now") · or the Scheduled Task (§11).

---

## 9. Firebase project

- Project **`mf-mf-7cee1`** (separate from the owner's other apps). Web config (apiKey etc., **not
  secret** — security is the rules) is pasted in the `firebaseConfig` block near the bottom of
  `index.html`. The admin **service-account key is secret**, lives at
  `automation/service-account.json` (git-ignored).
- Authorized sign-in domains include `localhost` + `a-gyani.github.io`. To add a new domain,
  run `node automation/add-domain.js <domain>` (uses the service account; works where the
  GitHub API doesn't — see §10).

---

## 10. Deploy / redeploy workflow

The repo is **just the served files**; the engine is local. To deploy a change to `index.html`/
`sw.js`/assets:

1. Edit files in this folder.
2. **Bump `CACHE` in `sw.js`** (e.g. `mfmf-v11` → `mfmf-v12`) — this is what makes installed PWAs
   pull the new version.
3. Commit & push:
   ```
   git add <changed files>
   git -c user.name="A-gyani" -c user.email="cmfellow2025.ysca@gmail.com" commit -m "…"
   git push origin main
   ```
4. GitHub Pages rebuilds in ~1 min; the live URL updates. Installed app updates on next open
   (service worker is network-first for navigation + self-updates).

**⚠ Environment network quirk (important for automated/sandboxed sessions):** in the dev sandbox,
`git push` to **github.com works**, and **node can reach googleapis.com** (Firestore, Identity
Toolkit) — but it **cannot reach `api.github.com`** (repo/Pages API) nor, intermittently,
`a-gyani.github.io` (the Pages CDN). Practical consequences:
- **Creating the repo / toggling Pages** must be done in a browser (or via `gh` in a real
  terminal), not from the sandbox.
- To confirm a deploy from the sandbox, check **`git ls-remote origin -h refs/heads/main`** equals
  local `HEAD` (don't rely on fetching the live URL).
- The local preview (`python -m http.server`, launch.json name `mfmf`, port 8002) is how to verify
  UI changes in-sandbox. (Note: `preview_screenshot` was flaky in past sessions — verify via
  `preview_eval` DOM inspection instead.)

---

## 11. The "MF MF Analyze" Scheduled Task

A Windows Task runs `automation/run-analyze.ps1` every **15 min** (as the user, interactive,
hidden window, runs on battery). That's what makes phone-added screenshots get analyzed
hands-off while the laptop is on. Manage it:
- Pause: `Disable-ScheduledTask -TaskName "MF MF Analyze"`
- Resume: `Enable-ScheduledTask -TaskName "MF MF Analyze"`
- Remove: `Unregister-ScheduledTask -TaskName "MF MF Analyze" -Confirm:$false`
- Run now: `Start-ScheduledTask -TaskName "MF MF Analyze"`
Each run appends to `automation/analyze.log`.

---

## 12. Conventions & gotchas

- **Currency** is INR; format with `inr()`. **Dates** are stored as ms epoch numbers; always read
  through `toMs()` (Firestore returns Timestamp objects that break `new Date()` / sorting).
- **Receipts grow forever** → always a collection + `collectionGroup('receipts')` to scan; never
  one big doc.
- **Images:** compress client-side (`compress()`); each `inbox` doc holds one base64 image and must
  stay under Firestore's 1 MB doc limit.
- **No build step / no framework** — keep `index.html` hand-editable. Match existing style; don't
  add helper text under fields (deliberate "clean" rule).
- **Status flow** drives everything: only `ready`/`tagged` receipts count in Home/Insights/Export;
  `duplicate` shows a dismissible notice; `pending`/`analyzing` show a spinner.
- After mutating `state`, call `saveReceipt(r)` (persists + syncs) or `saveLocal()` then `rerender()`.
- **`item.price` is the LINE TOTAL** (qty × per-unit), not per-unit; `item.qty` is the count;
  per-unit is derived (`price/qty`). "Most bought" sums `qty` (units), not occurrences. Never
  hardcode `qty` — the editor must read/write it (a past bug hardcoded `qty:1` and wiped quantities).

---

## 13. "Where do I edit…?" recipes

| You want to… | Edit |
|---|---|
| Add/rename a **vendor** or its chip colour | `VENDORS` + `VENDOR_COLOR` in `index.html` (users can also add custom vendors at runtime via "+ New"). |
| Add/rename a **category** | `CATS` in **both** `index.html` and `automation/analyze.js`. (Custom categories you add at runtime auto-flow to the engine via `loadCats`.) |
| Change the **vision extraction / grouping / dedup** | `buildPrompt()`/`buildGroupPrompt()` and the main loop in `automation/analyze.js`; dedup keys = `idKey()`/`contentKey()`/`isDup()`/`remember()`. |
| Change a **screen's layout/content** | the matching `render*()` function + that screen's `<section>` markup + CSS. |
| Change **tagging** behaviour | `tagItem`/`tagAll` (Tag screen) and `setRowTag`/`saveManual` (editor). |
| Change **Insights** metrics/charts | `renderInsights` + `monthlyTrend`. |
| Change **Excel** sheets/columns | `exportExcel()`. |
| Change **colours / theme / wallpaper** | `:root` CSS variables; `bg.jpg` (wallpaper) / `speed-rupee-logo.svg` (logo). |
| Change the **analysis schedule** | re-register the Scheduled Task (§11) with a new interval. |
| Add a **served asset** | drop the file in, reference it, **add it to `sw.js` `CORE`**, bump `CACHE`. |
| **Deploy** any change | §10 (bump `CACHE`, commit, push). |

---

## 14. Known limitations & v2 ideas (not built)

- Analysis needs the **laptop on** (Claude runs locally). An always-on cloud routine is the
  deferred alternative.
- **Shared = label-only** by design (no 50/50 split / "who owes whom" math — the Excel "Shared
  items" sheet is the settle-up artifact).
- Notifications are an **in-app badge** ("N ready to tag"), not real push (FCM web-push is a v2 idea).
- **Single-user by design — sharing is possible but not safe for strangers.** Firestore rules isolate
  each Google account's data (`users/{uid}/**` owner-only), so others who sign in can't see your
  receipts and vice-versa. BUT the engine reads the **whole shared `inbox`** and runs on the **owner's
  laptop + owner's Claude Max plan**: other users' files are analyzed on your machine/quota, only while
  it's on, and the **admin service account can read everyone's data**. So it's OK for a few trusted
  people, not a public/multi-tenant app. A proper per-user/cloud engine (or the household ledger) is v2.
- **No tax field.** `fees` only holds delivery/handling/tip/discount; GST/packaging "Taxes & Charges"
  exist only inside `total`. Insights surfaces the gap as a "taxes & charges" bridge line. **Invoice PDFs
  capture taxes/items/order-id most accurately** — prefer them over screenshots when available.
- **Not signed in / offline:** the app is local-first (manual entry, tagging, Insights, export all work
  on `localStorage`), but screenshot/PDF **analysis needs sign-in** (files queue locally and only upload
  to `inbox` on sign-in, then analyze on the next engine run).
- Dedup content fallback (no printed order id) keys on `date + sorted item prices`, so two genuinely
  identical-priced orders on the same day could be flagged as one — rare; loosen `contentKey()` if it bites.
- **Batch size:** invoice **PDFs are extracted one-per-call**, so you can add **any number** at once
  (each PDF must be < ~700 KB; a big dump just makes one engine run take a few extra minutes — add a
  per-run cap if that bites). Only *screenshots* are grouped; the heavy case is one order spanning many
  screenshots.
