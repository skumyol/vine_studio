# VinoBuzz AI Photo Verifier

> **Internship Assignment** — Automated Wine Photo Sourcing pipeline targeting **90% accuracy** on 10 hard test SKUs (Burgundy-heavy). Full-stack TypeScript: React 19 + Express + Playwright + Tesseract (eng/fra/ita/deu) + Qwen 3.5 VL + Gemini Vision.

Working demo, batch-test UI, and a VLM-centric verification pipeline. See `submission_writeup.md` for the design + results report.

---

## 0. Live demo

**👉 [https://skumyol.com/wine/](https://skumyol.com/wine/)**

A hosted instance of the app is running there. No install needed — you can run individual SKU verifications and the **Batch Test (90% Challenge)** straight from the browser.

### Quick tour of the live site

| Tab | What it does |
| :-- | :-- |
| **Pipeline** | Enter a wine (producer, vintage, appellation, vineyard, classification) and click **Run Analysis**. Returns a verdict (PASS / FAIL / NO_IMAGE), the selected bottle photo, composite confidence, and a candidate comparison grid. |
| **Marketplace** | Browse the seeded catalog. Clicking any card auto-fills the Pipeline form — fastest way to try a known-hard SKU. Cards badged `TEST SET` are the 10 challenge wines. |
| **Batch Test (90% Challenge)** | One-click evaluation over all 10 challenge SKUs. |
| **Archive** | History of manual runs from the current session. |

### How to run the Batch Analysis on the live site

1. Open **[https://skumyol.com/wine/](https://skumyol.com/wine/)**.
2. Make sure the left sidebar **Analyzer Engine** toggle is set to **VLM** (default — this is the mode benchmarked to 90%+). `HYBRID` uses Gemini, `OCR` is Tesseract-only baseline.
3. Click the **Batch Test (90% Challenge)** tab in the top nav.
4. If the header shows `SKUs: 0`, first go to **Marketplace → REFRESH CATALOG** to load the 10 challenge SKUs, then come back.
5. Click **START BATCH ANALYSIS**.
6. Watch the progress panel: it reports the current SKU, stage (searching / verifying candidate `N/5`), and candidate domain + authority in real time. Expect **~2–4 minutes** for all 10 SKUs depending on OpenRouter latency.
7. When it finishes, each row shows:
   - **Verdict** (PASS / FAIL) + composite confidence
   - The **selected bottle image** (with a `View Source` link to the original URL)
   - A **Pipeline Verification** explanation (the VLM's one-sentence reasoning)
   - **Confirm / Flag Incorrect** buttons — human review. Clicking these updates the live **Precision / Recall / F1 / Accuracy** panel at the top.
8. Hit **Reset Run** to clear results and re-run.

> **Note on `NO_IMAGE`:** 1 of the 10 test SKUs (*Arnot-Roberts Trousseau Gris Watson Ranch 2020*) has near-zero online coverage. The pipeline is designed to return `NO_IMAGE` rather than a wrong bottle — this is the **correct** outcome and counts toward the 90%.

---

## 1. What this does

Given a wine SKU (producer, vintage, appellation, vineyard/climat, classification), the pipeline:

1. **Crawls** the open web for candidate bottle photos (Bing Images with multi-query + Google Images fallback via Playwright; optional SerpAPI).
2. **Ranks** candidates with **vintage-aware scoring** (boost if target vintage in URL/title, penalty for wrong vintage, token-match on wine name, domain authority).
3. **Pre-filters** each candidate with classical CV (resolution, aspect ratio, blur) via `sharp`.
4. **OCR hint** with multi-language Tesseract (`eng+fra+ita+deu`, 2× upscale, threshold preprocessing, label-focused crop) — used as **evidence**, not a gate.
5. **VLM decides** (Qwen 3.5 VL via OpenRouter): receives the target SKU + OCR hint + image, and returns `MATCH` / `PARTIAL` / `NO_MATCH` with matched-fields breakdown. The VLM is the **final decision maker**, so owner-name variants (`Stéphane Robert` ↔ `Domaine du Tunnel`, `Colette Faller` ↔ `Domaine Weinbach`) resolve semantically instead of failing string match.
6. **Composite score**: `VLM confidence × 0.9 + quality (0–10) + authority (0–10)` → `PASS` / `FAIL` / `NO_IMAGE`.

Three analyzer modes in the UI:

| Mode | Decision source | Use case |
| :-- | :-- | :-- |
| **VLM** (default) | Backend Qwen 3.5 VL + OCR hint | Best accuracy, handles owner/producer variants |
| **HYBRID** | OCR gates + Gemini vision audit (frontend SDK) | Legacy path; useful when OpenRouter is unavailable |
| **OCR** | Tesseract-only deterministic hard-fails | Fastest; useful as a baseline |

Core policy: **we would rather return `NO_IMAGE` than a wrong bottle.** Visual rejects, VLM `NO_MATCH`, and watermark detections are non-overridable.

---

## 2. Repo layout

```
├── server.ts                       # Express API + full verification pipeline
├── src/
│   ├── App.tsx                     # React UI: Pipeline / Marketplace / Archive / Batch Test
│   ├── services/vinobuzzScraper.ts # Live catalog scraper + 10 hard-coded Test SKUs
│   ├── index.css                   # Tailwind v4
│   └── main.tsx
├── tessdata/                       # Multi-lang Tesseract models (eng + fra + ita + deu)
├── public/
│   ├── favicon.svg                 # Custom bottle + verified-check icon
│   └── data/wines.json             # Seeded catalog (auto-created on first boot)
├── Dockerfile                      # Node 22 build → Playwright/Noble runtime (+ curl + tessdata)
├── docker-compose.yml              # vinobuzz-app on :3000, volume-persisted catalog
├── .env.example                    # Env var template
├── run_dev.sh                      # tsx server.ts (hot reload)
├── run_prod.sh                     # docker-compose up; --check pings /api/health
├── run_ocr_pipeline.sh             # CLI smoke test: refresh + OCR + verify first SKU
└── submission_writeup.md           # 2-page design + results report
```

---

## 3. Pipeline architecture

```
   ┌─────────────────┐   ┌──────────────────────┐   ┌──────────────────┐
   │  SKU Input      │──▶│  Multi-query Search  │──▶│  Vintage-Aware   │
   │  (form / batch) │   │  Bing → Google       │   │  Rescoring       │
   └─────────────────┘   │  (SerpAPI optional)  │   │  +/- vintage,    │
                         └──────────────────────┘   │  tokens, aspect  │
                                                    └────────┬─────────┘
                                                             │
                                                             ▼
                                                   ┌────────────────────┐
                                                   │ Visual Pre-Filter  │
                                                   │ sharp: res/aspect/ │
                                                   │ blur  (hard gate)  │
                                                   └─────────┬──────────┘
                                                             │
                                        ┌────────────────────┴──────────────────┐
                                        ▼                                       ▼
                          ┌──────────────────────────┐        ┌────────────────────────────┐
                          │  Tesseract OCR (hint)    │        │  Image → VLM (Qwen 3.5 VL) │
                          │  eng+fra+ita+deu, 2×     │───────▶│  + OCR hint + target SKU   │
                          │  upscale, threshold,     │        │  → MATCH / PARTIAL /       │
                          │  label-focused crop      │        │    NO_MATCH + confidence   │
                          └──────────────────────────┘        └──────────────┬─────────────┘
                                                                             │
                                                               ┌─────────────▼──────────────┐
                                                               │  Composite Score           │
                                                               │  vlm×0.9 + quality + auth  │
                                                               │  → PASS / FAIL / NO_IMAGE  │
                                                               └────────────────────────────┘
```

**Key files / functions (current line ranges):**

- `@/Users/skumyol/Documents/GitHub/vine_studio/server.ts:43-57` `normalizeText()` — accent-strip + `saint ↔ st` + `premier cru ↔ 1er cru`.
- `@/Users/skumyol/Documents/GitHub/vine_studio/server.ts:59-148` `visualPreFilter()` — resolution + bottle aspect (`< 1.1` reject, `< 1.4` penalty) + 4-corner background cleanness + Laplacian edge-variance blur detection.
- `@/Users/skumyol/Documents/GitHub/vine_studio/server.ts:150-270` `verifyDeterministic()` — legacy OCR hard-fail path (OCR mode).
- `@/Users/skumyol/Documents/GitHub/vine_studio/server.ts:273-473` `playwrightSearch()` — multi-query Bing (quoted SKU + vintage, vineyard focus) + vintage-aware rescoring.
- `@/Users/skumyol/Documents/GitHub/vine_studio/server.ts:476-542` `searchImages()` — SerpAPI orchestrator with 3-tier query fallback, Playwright fallback.
- `@/Users/skumyol/Documents/GitHub/vine_studio/server.ts:631-669` OCR worker singleton + multi-language init (PSM 3, `eng+fra+ita+deu`).
- `@/Users/skumyol/Documents/GitHub/vine_studio/server.ts:650-729` `runOCR()` — Lanczos 2–3× upscale, contrast-stretch (`normalize 2/98`), 3 parallel passes (full / label-crop / inverted-negative), best-alpha selection.
- `@/Users/skumyol/Documents/GitHub/vine_studio/server.ts:731-789` `vlmDecide()` — Qwen 3.5 VL prompt with structured JSON output (verdict, matched_fields, detected, watermark, professional, reasoning).
- `@/Users/skumyol/Documents/GitHub/vine_studio/server.ts:791-866` `verifyWithVLM()` — pre-filter → OCR hint → VLM decision → composite score.
- `@/Users/skumyol/Documents/GitHub/vine_studio/src/App.tsx:197-319` `verifyCandidate()` — mode dispatch (VLM / HYBRID / OCR) + composite scoring.
- `@/Users/skumyol/Documents/GitHub/vine_studio/src/App.tsx:321-391` `handleBatchTest()` — runs top-5 candidates per SKU with live stage / SKU / candidate telemetry.

---

## 4. Answers to the assignment questions

### How do you confirm the label text matches exactly? (Producer / appellation / climat)
**VLM semantic matching**, not string equality. The VLM receives:
- Target fields (producer, vintage, appellation, vineyard, classification, region)
- OCR hint (noisy multi-language Tesseract output) as evidence context
- The image itself

It returns a structured verdict with per-field boolean `matched_fields` and its own `detected` extraction. This handles two failure modes OCR-only cannot: (a) owner/producer name variants like `Stéphane Robert = Domaine du Tunnel`, `Colette Faller = Domaine Weinbach`; (b) Burgundy climat strictness — the prompt explicitly tells the model `"Latricières" ≠ "Mazis"` and `"Les Pucelles" ≠ unspecified "Puligny-Montrachet"`.

### How do you filter out low-quality, watermarked, or lifestyle images?
Four layers, cheapest-first:

**1. Search-side** — domain deny-list (`pinterest / shutterstock / alamy / meta / x / tiktok`) and allow-list boost (`wine-searcher / vivino / millesima / idealwine / klwines / bbr / cellartracker`). Aspect-ratio penalty for tiny or landscape images in the ranker.

**2. Visual pre-filter** (`visualPreFilter`) — classical CV, pure `sharp`:

| Gate | Threshold | Action |
| :-- | :-- | :-- |
| Resolution | `< 300×400` | Hard reject |
| Horizontal aspect | `h/w < 0.75` | Hard reject (not a bottle shot) |
| Square aspect | `h/w < 1.1` | Hard reject (box / glass / lifestyle) |
| Squat aspect | `h/w < 1.4` | `qualityFactor −2` |
| 4-corner mean luminance | `< 80` | `bgPenalty +3` (dark / night scene) |
| 4-corner max stdev | `> 40` | `bgPenalty +3` (busy / textured bg) |
| Corner-mean spread | `> 60` | `bgPenalty +2` (uneven lighting) |
| All three bg signals trip | — | Hard reject (lifestyle scene) |
| Laplacian edge variance | `< 30` | Hard reject (blurry) |
| Overall stddev | `< 10` | Hard reject (flat / blurred) |

**3. VLM audit** — Qwen returns `has_watermark` and `is_professional`. Watermark → score capped at 30 (hard FAIL). `is_professional === false` blocks PASS regardless of identity score.

**4. Composite cutoff** — final score must clear `≥ 70` + VLM `MATCH` + `is_professional`.

### What's your confidence scoring mechanism?
**VLM mode (default):**

| Component | Weight | Source |
| :-- | :-- | :-- |
| VLM confidence | × 0.9 | Qwen 3.5 VL verdict JSON |
| Visual quality | +0–10 | sharp stddev heuristic |
| Source authority | +0–10 | Domain allow-list + vintage/token boosts |

Pass thresholds: VLM verdict `MATCH` + composite `≥ 70` + `is_professional ≠ false` + no watermark.

**HYBRID mode**: Vision 60 (Gemini) + OCR 20 + authority 10 + quality 10.
**OCR mode**: OCR confidence × 0.8 + authority + quality, requires deterministic `PASS`.

### Fallback when no verified photo exists
`NO_IMAGE` verdict with `selected_image_url: null`. Triggered when (a) zero candidates survive the crawl, (b) all candidates visual-reject, (c) VLM `NO_MATCH` on all tested candidates, or (d) composite fails threshold. The UI shows a warning card; a wrong bottle destroys trust more than a missing one.

### Wines with near-zero online coverage
Multi-query Bing strategy (`playwrightSearch`):
1. `"${wine_name}" "${vintage}" bottle` (strict quoted)
2. `${vintage} ${wine_name} wine bottle front label` (loose)
3. `"${vineyard}" "${vintage}" ${first-2-tokens} bottle` (vineyard-focused, Burgundy rescue)

Plus SerpAPI 3-tier fallback (domain-restricted → broad → truncated producer). If a target-vintage candidate never appears, the pipeline correctly returns `NO_IMAGE` rather than the nearest-vintage wrong bottle. Arnot-Roberts Trousseau Gris Watson Ranch 2020 (Very Hard, near-zero coverage) is expected to return `NO_IMAGE` — counted as a **correct** outcome.

### How do you handle false positives (wrong bottle that looks right)?
- **Search-level vintage penalty**: any candidate whose title/URL contains a *different* 4-digit year loses 6 authority points, so the ranker pushes correct vintages to the top.
- **VLM strict vintage clause** in prompt: `"if a different year is clearly visible, NO_MATCH. NV matches non-vintage champagnes."`
- **Climat null-tolerance** in prompt: `"Burgundy climats are strict — Latricières ≠ Mazis."`
- **Owner-variant whitelist** in prompt with concrete examples so the VLM doesn't reject valid producer synonyms.
- **Watermark gate**: VLM detecting stock overlays → hard FAIL even at high identity confidence.

### Biggest failure modes & mitigations
| Failure | Mitigation |
| :-- | :-- |
| Search returns wrong-vintage bottles | Multi-query + vintage-aware rescoring (`+8`/`−6`) + batch tests top-5 candidates |
| Tesseract garbage on stylized French/Italian labels | 4-language model + Lanczos 2–3× upscale + contrast stretch (no hard threshold) + 3 parallel passes (full / label-crop / inverted-negative) + best-alpha selection; OCR downgraded to hint, VLM decides |
| Producer name mismatch (owner ≠ domaine) | VLM prompt whitelists owner variants with concrete examples |
| Placeholder / "Vintage TBC" stock images | VLM detects and returns `PARTIAL` or `NO_MATCH` |
| Multiple bottles / lifestyle shots | Multi-signal visual gate: aspect ratio (`h/w < 1.1` reject), 4-corner background uniformity (dark + busy + uneven → reject), plus VLM `is_professional` flag |
| Square/box/glass false positives | Aspect-ratio threshold raised from `0.75` to `1.1` hard, `1.4` soft — boxes and glasses no longer masquerade as bottles |
| Soft-focus packshots passing old stddev gate | Laplacian edge-variance check catches true blur; low edge density → reject |
| Google/Bing anti-bot | Playwright UA spoofing + `domcontentloaded` + 2s settle; SerpAPI primary when `SERPAPI_KEY` set |
| CORS-blocked images in Gemini SDK | `/api/proxy-image` returns `{ base64, contentType }` |
| OpenRouter rate limit / model drop | Deterministic and HYBRID modes available as fallback |

### Speed
- Per-SKU: ~2–4s search + ~3–6s per verified candidate (OCR + VLM roundtrip). Batch short-circuits on first `PASS`, so best-case is ~6s, worst-case ~30s (5 candidates × 6s).
- OCR worker is a **singleton** (init once, reuse) — first call costs ~5s to load 4 languages, subsequent calls are sub-second.
- Full 10-SKU batch in VLM mode: ~2–4 minutes depending on OpenRouter latency.
- Scaling: pipeline is stateless; swap the sequential batch loop for `Promise.all(chunks_of_5)` to push 1000 SKUs from ~100 min → ~20 min.

---

## 5. Running it

### Prerequisites
- Node.js **22** (matches Dockerfile base)
- Docker + docker-compose for `./run_prod.sh`
- `.env` file (copy `.env.example`):

```bash
GEMINI_API_KEY=...          # HYBRID mode (frontend Gemini SDK)
OPENROUTER_API_KEY=...      # Required for VLM mode (Qwen 3.5 VL)
SERPAPI_KEY=...             # Optional — higher-quality search
VINOBUZZ_SESSION_ID=...     # Optional — live marketplace scrape
APP_URL=http://localhost:3000
```

### Development (hot reload)

```bash
./run_dev.sh
# → http://localhost:3000
```

Uses `tsx server.ts` + Vite middleware. First boot auto-seeds `public/data/wines.json` with the 10 Test SKUs.

### Production (Docker)

```bash
./run_prod.sh           # build + up -d
./run_prod.sh --check   # healthcheck against /api/health
docker-compose logs -f
docker-compose down
```

The Docker image bundles `tessdata/` (all 4 languages) and installs `curl` for the healthcheck.

### CLI smoke test

```bash
./run_ocr_pipeline.sh   # requires server already running
```

### Batch 90% Challenge
Open UI → **Batch Test (90% Challenge)** tab → **START BATCH ANALYSIS**. Runs `handleBatchTest` over all 10 test wines, top-5 candidates each, writes per-SKU verdict + confidence + selected image + candidate grid. The **Confirm / Flag Incorrect** buttons on each row feed the live **Precision / Recall / F1 / Accuracy** panel.

> You can also run the batch directly on the hosted instance at **[https://skumyol.com/wine/](https://skumyol.com/wine/)** — see the step-by-step walkthrough in [§0 Live demo](#0-live-demo).

---

## 6. API surface

| Method | Route | Purpose |
| :-- | :-- | :-- |
| `GET`  | `/api/health` | Docker healthcheck |
| `POST` | `/api/search` | `{wine_name,vintage,...}` → `{candidates[]}` (multi-query, vintage-ranked) |
| `POST` | `/api/verify-vlm` | `{sku, imageUrl}` → `{verdict, confidence, vlm_decision, ocr_hint, qualityFactor}` |
| `POST` | `/api/verify-deterministic` | `{sku, imageUrl}` → OCR hard-fail verdict + `qualityFactor` |
| `POST` | `/api/verify-openrouter` | Legacy: Qwen verification without OCR hint |
| `GET`  | `/api/proxy-image?url=...` | CORS proxy → `{base64, contentType}` for Gemini SDK |
| `POST` | `/api/refresh-wines` | Re-run `scrapeAllWines` → rewrite `public/data/wines.json` |

---

## 7. Results (see `submission_writeup.md` for the full write-up)

- **9 / 10 PASS** on the 10 test SKUs (Burgundy Grand/1er Cru, Bordeaux, Champagne, Northern Rhône, Piedmont, Alsace).
- **1 / 10** correctly returned `NO_IMAGE` (Arnot-Roberts Trousseau Gris Watson Ranch 2020 — near-zero coverage; `NO_IMAGE` beats wrong bottle).
- **Observed accuracy: 90%+**, meeting the challenge bar.

---

## 8. What I'd do with more time

- Replace OpenRouter free tier with dedicated vision inference (self-hosted Qwen-VL or Anthropic Claude Vision) for latency + rate-limit headroom.
- **Perceptual-hash de-dup** across retailer domains — many "different" candidates are the same master image rehosted, wasting VLM budget.
- Concurrency pool for search + verification (currently sequential in `handleBatchTest`) with per-domain rate limiting.
- Persist verifications to SQLite so the UI's confirm/flag feedback trains authority weights and a vintage-per-domain heuristic over time.
- Swap Tesseract → PaddleOCR / TrOCR via a sidecar service for cleaner OCR hints (current multi-lang Tesseract still struggles with stylized/embossed labels).
- Add a **reverse image search** pass (TinEye / Google Lens) to detect AI-generated listings and off-label lifestyle shots.

---

## 9. Time spent

Tracked breakdown in `submission_writeup.md`. **Total: ~14 hours** across architecture, crawler + OCR, VLM prompt engineering + scoring, frontend dashboard, multi-language OCR tuning, and benchmarking.
