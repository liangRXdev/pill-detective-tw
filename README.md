# Pill Detective TW — Taiwan Drug Appearance Search (藥丸偵探)

**English** | [繁體中文](README.zh-TW.md)

[![Live Demo](https://img.shields.io/badge/Live%20Demo-Pill%20Detective%20TW-3D7A8A?style=for-the-badge&logo=github)](https://liangrxdev.github.io/pill-detective-tw/)

Narrows down candidate drugs by **appearance features** (imprint, color, shape, score line) using public data from the Taiwan Food and Drug Administration (TFDA), for pharmacists and healthcare staff to **confirm by manual comparison**. The interface is in Traditional Chinese.

> This is "appearance criteria search → candidate drugs → manual confirmation",
> **not** "upload a photo → the system claims it is drug X".
> The site uses no AI to guess drug identity and gives no similarity scores.

## What this tool cares about most: don't miss

The most likely way a user gets hurt is not "a few extra candidates" but
**"it's not in the list → I conclude this pill isn't that drug", when the real drug was silently excluded by the system**.
So the design leans in that direction:

| Situation | Typical approach | This site |
|---|---|---|
| TFDA didn't record the color (217 records) | Disappears when "white" is checked | Goes into a "data not provided" section explaining it can't be excluded |
| TFDA recorded only part of the imprint (1,293 records) | Excluded when you type the full imprint | Goes into a "partial match" section |
| Tablet held upside down, `S` read as `5` | Returns "not found" | Goes into an "imprint may be upside down or look-alike" section, labelled with which one |
| 0 results in the main section | Shows "not found" | Only says not found when **every record clearly doesn't match** |
| Data file fails to load | Shows 0 results | Disables search and says plainly "data temporarily unavailable" |

Only two misses are deliberately accepted, both to keep the list from getting too long to use at the medication cart:

- **Single-character queries don't enable the "contains" level.** Typing `S` and getting drugs imprinted `EVEREST` or `YSP` is unusable at the cart.
- **The variant section only accepts exact equality**, and single characters get no look-alike conversion. See the next section for why.

## Search Rules (deterministic, no scoring)

The imprint is tokenized first (uppercased, non-alphanumerics treated as separators), and **every query token must match** (order-independent).
Full matches are split by precision into **three mutually exclusive levels**; in addition there are three "cannot be excluded" sections: "partial match", "data not provided" and
"imprint may be upside down or look-alike":

| Section | Meaning |
|---|---|
| Exact match | Every input token is identical to an imprint token |
| Prefix match | Every input token is the beginning of an imprint token |
| Contains | Every input token appears within the imprint (not enabled for single-character queries) |
| Partial match | At least one token matches but not all — TFDA recorded only part of the imprint |
| Data not provided | TFDA left that field blank, so it can't be excluded |
| Imprint may be upside down or look-alike | Doesn't match as-is, but matches exactly when read upside down or after glyph flattening |

Colors and shapes allow multiple selection (OR within a group), and criteria combine with AND.
Marking 1 / marking 2 are **not labelled front / back** — TFDA doesn't define which face each field refers to.

### Upside-down and look-alike imprints (variant section)

Two deterministic conversions are tried **only when the imprint doesn't match as-is**. Hits always go into a separate fifth section and
**are never mixed into any of the sections above** — membership of the existing four sections is unchanged record by record.

| Conversion | Rule |
|---|---|
| 180° rotation | A fixed 14-character table: `0 1 8 H I N O S X Z` map to themselves, `6↔9`, `M↔W`. Any character outside the table means no variant |
| Look-alike glyphs | Flattened into 5 equivalence classes: `0/O`, `1/I/L`, `5/S`, `2/Z`, `8/B` |

Four tightening rules, all to keep this section a usable length:

- **Exact equality only** — variants don't get the prefix or contains levels
- **No look-alike conversion for single characters** (otherwise `I` would return 801 records and `5` 768)
- **No combined variants**: no rotation followed by flattening, and different tokens can't each use a different rule to add up to a full match
- **No edit distance / fuzzy matching, no scores or rankings returned**

Each card is labelled "upside down" or "look-alike" itself, rather than putting the reason in the section header — two cards in the same section may have got there for different reasons.

The rules are symmetric, so **the variant section can be larger than the main one**: `SH` gives 37 in the main section and 42 in the variant section after rotating to `HS`.
The worst case is misreading a manufacturer prefix: `Y5P` gives 0 in the main section and 111 in the variant section (`YSP`, Yung Shin, is printed on 111 products).
This isn't suppressed — suppressing it would make the most common misreading unsearchable. Instead a test watches it:
`A17` fingerprints the complete reachable query closure (3,103 queries) and goes red as soon as the rules drift.

## Interface

- **Sticky search bar, filter panel scrolls with the page** — whatever sticks to the top is always shorter than the viewport and never hides results
- **Confident matches expanded, low-certainty ones collapsed**: partial match, data not provided and variant sections use native `<details>`;
  the summary keeps the section name and count, and cards are only built on first expansion (queries like `M 40` have up to 2,379 low-certainty candidates)
- **The variant section comes last**: the not-provided section at least means "this drug doesn't contradict your input",
  while the variant section means "it contradicts, unless you read it upside down" — one more layer of assumption, so it goes further down
- **Cards and the detail dialog show mirrored official images** (WebP, 640 px long edge), with a direct link to the TFDA original
- **The detail dialog offers "View TFDA package insert"** (by license number)
- Missing or failed images always show a placeholder, never a broken image
- **The footer shows data freshness**: see "Data update dates" below

## Offline and Install (PWA)

Installable to the phone home screen and searchable offline — **there often isn't a stable connection at the medication cart**.

| | Available offline | Notes |
|---|---|---|
| Interface and search logic | ✅ | About 118 KB (including 44 KB of PWA icons), prefetched on install |
| All 6,295 search records | ✅ | 3.7 MB, **saved along the way on first load**, not prefetched |
| Drug images | The 500 most recently fetched | 87 MB in total; no full offline pack. Over the limit, evicted **in fetch order** (not LRU) |

Two deliberate trade-offs:

- **The first visit is not offline-capable**; it needs one more load. Prefetching 3.7 MB would charge that traffic to people who only clicked in for a quick look.
- **Offline is always announced**. The top of the page shows "no connection — showing previously saved data (source version …)".
  Clinically, a screen that looks normal but is weeks old is far more dangerous than a clearly broken one —
  which is also why the cache **never** pretends to succeed when data truly can't be fetched; that case still shows "data temporarily unavailable".

## Data

| | |
|---|---|
| Source | [TFDA Open Data drug appearance dataset](https://data.fda.gov.tw/opendata/exportDataList.do?method=openData&infoId=42) (infoId=42) |
| Records | 6,295 (**everything included, no filtering**), snapshot 2026-08-10 |
| Images | 6,273 records have official appearance images, 6,798 images in total; the rest have no usable image at the source. Converted to WebP (640 px long edge), 87 MB total. Official originals have a median of 1.5 MB; 20 per page would be about 68 MB, so hot-linking is not feasible on mobile networks |
| Image versioning | File names are fixed as `sha1(id)-n.webp`, and requests carry `?v=<first 8 chars of sha256>` — so an in-place official image replacement never reads a stale browser cache |
| Updates | GitHub Actions every Monday 04:17; **any validation failure means nothing is published** and the previous version stays. Failures automatically open an issue |
| Update status | `data/status.json` records the last successful check date and is **stored separately** from `appearance.json` — the latter must stay byte-idempotent (no diff if the source hasn't changed), and writing the run time into it would break that |
| Freshness | Quarterly HEAD scan of all originals comparing content length + deep check of 100 random images; detected official image replacements are **not updated automatically** but open an issue for manual confirmation |

### The two dates in the footer

They mean different things, so they are shown separately:

> 資料版本：2026-08-10（TFDA 來源日期） · 最後檢查：2026-08-12 · 收錄：6,295 筆
> 每週一自動檢查 TFDA 來源更新
>
> (Data version: 2026-08-10 (TFDA source date) · Last checked: 2026-08-12 · Records: 6,295 · TFDA source checked automatically every Monday)

**Showing only the "data version" would make the site look unmaintained whenever TFDA goes three months without an update.**
Separating them distinguishes "checked but the source hasn't changed" from "not running at all".

- "Last checked" **only advances after the whole pipeline (gate / mirroring / validation / tests / publishing) passes**.
  If the weekly update fails it stays at the last successful date — that is correct behavior, not a bug
- If there has been no successful update for more than 14 days (= two missed weekly runs), that line switches to a warning color and shows the number of days
- If the status file can't be read or is corrupt, less is shown — **a guessed date is never shown**

## Privacy

No login, no accounts, no cookies, no localStorage, no analytics, no backend. Search and local thumbnail browsing send no user input to third parties; only when the user actively clicks "TFDA original image / package insert" does the browser go to the official TFDA site. Not even fonts come from a CDN. No name / medical record number / birthday / prescription content is requested.

The offline feature uses the browser's Cache Storage, **storing only this site's own files** (interface, search data, viewed images),
never search input, query history or user state, and nothing is sent anywhere.
Use the browser's "clear site data" to remove it all.

## Development

```bash
npm test                          # 137 tests: search semantics / variant rules / normalization / pipeline fail-closed / regression fixtures / static contracts
npm run build -- --source <zip>   # build canonical (use a local zip during development to avoid hitting TFDA repeatedly)
uv run tools/fetch-images.py      # mirror images (needs uv + Pillow)
npm run verify -- --source <zip> --in data/appearance.json.staging
npm run publish:metadata          # publish searchable data first while images aren't ready
npm run publish:data              # data-ready cutover (refuses if images aren't all done)
node tools/write-status.mjs       # write data/status.json (**must run after publish**)

uv run tools/fetch-images.py --in data/appearance.json --freshness   # quarterly freshness check
```

Zero dependencies, no build step, Node ≥ 22, static deployment on GitHub Pages. The service worker is hand-written, not Workbox.

The spec is `.ai-review/plan.md` (v1.10); the variant-section addendum is `.ai-review/plan-imprint-variant.md` (v0.3).
The same directory holds each spec review and verdict (`plan-review*.md` / `plan-verdict*.md`, two rounds for the variant section),
one code review round (`codex-review.md`), and manual acceptance records under `evidence/`.
Engineering conventions are in `CLAUDE.md`.

Expected values for the regression fixtures are produced by `tools/make-expected.mjs`, an **independent second implementation** that imports nothing from `search.js` —
the same code checking itself isn't verification. The variant rules add a static assertion (C20) guarding that independence.

The following two areas **can't be verified by static tests**; rerun the corresponding manual records after changing them:

| Change | Rerun |
|---|---|
| `sw.js` (cache limit, which version the first reload after deploy gets, offline wording) | The six items in `.ai-review/evidence/e11-2026-08-13.md` |
| Variant-section UI (section position, per-card reason labels, collapsed summary) | `.ai-review/evidence/e12-2026-08-14.md` |

## Disclaimer

This tool provides candidate results based on TFDA public drug appearance data; similar appearance does not mean the same drug.
Actual drugs should still be confirmed from the original packaging, drug bag, license information or by healthcare professionals.
This tool is an identification aid, not a final dispensing verification system.

## License

MIT
