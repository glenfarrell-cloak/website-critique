# Modern Consulting Group Review Validation

## Date

2026-07-02

## Purpose

Validate that WebsiteCritique no longer misreports the Modern Consulting Group website as lacking a booking option or conversion path.

## Original Mismatch

The earlier generated review scored Modern Consulting Group at 34/80 and included a weakness that said there was no visible conversion path or lead mechanism.

That finding was inaccurate because the live website has booking CTAs in the navigation and body, including HubSpot meeting links.

## Root Cause

`https://modernconsultinggroup.com` is a JavaScript-rendered Vite/React site. The static HTML response is a small shell with `#root`, asset links, and minimal title/meta content. The old analyzer fetched only that static HTML and stripped scripts, nav, and footer before sending content to the LLM.

## Current Production Validation

Validated from the Cloak production runtime:

```text
mode: rendered
confidence: high
warnings: spa_shell_detected
static_text_length: 71
rendered_text_length: 3737
```

Observed CTAs:

- `Book a Call [nav]`
- `Book a 15-Minute Call [section]`
- `Book a 15-Min Builder Chat [section]`
- `Request a Sample [section]`
- `Book a 15-Min Strategy Call [section]`

## Stored Report Updates

The stored production report rows for Modern Consulting Group were updated after backing up `data/submissions.json`.

- Backup: `data/submissions.2026-07-03T00-02-08-890Z.bak.json`
- Updated stale report: `https://portal.glenfarrell.net/WebsiteCritique/report/7d2efb79b8ae`
- Updated stale report: `https://portal.glenfarrell.net/WebsiteCritique/report/5abcbc819265`
- Fresh validation report: `https://portal.glenfarrell.net/WebsiteCritique/report/e5550f9dcc3f`

The two stale reports now show `Conversion Path Needs Stronger Qualification` and include Evidence Coverage with observed CTAs.

The fresh validation report scored Modern Consulting Group at `61/80` and did not include a missing-CTA or missing-conversion-path finding.

## Corrected Finding

The correct critique is not that the site has no conversion path. The corrected finding is:

```text
Conversion Path Needs Stronger Qualification
```

The system should say that booking CTAs are present, then evaluate whether those CTAs are prominent, specific, and supported by qualification copy that explains who should book, what the call covers, and what happens next.

## Verification

- Local tests: `npm test` passes.
- Production tests on Cloak: `npm test` passes.
- Public status endpoint: `https://portal.glenfarrell.net/WebsiteCritique/status` returns `status: ok`.
- Production evidence extraction detects the MCG booking CTAs before the report/scoring step.
- Live report pages for the stale report IDs no longer contain `No Conversion Path` or `No Conversion Architecture`.
