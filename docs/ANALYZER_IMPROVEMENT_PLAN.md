# WebsiteCritique Analyzer Improvement Plan

## Goal

WebsiteCritique must produce evidence-grounded reviews. It should accurately detect calls to action, booking paths, conversion mechanisms, and credibility signals on modern JavaScript-rendered websites before assigning scores or making missing-feature claims.

## Current Status

Implemented, deployed, and validated on 2026-07-02.

The analyzer now renders JavaScript-driven sites, preserves navigation and footer evidence, sends structured evidence to the LLM, exposes evidence coverage in the report, and applies deterministic guardrails when observed CTA evidence contradicts an absolute missing-CTA finding.

## Trigger

Modern Consulting Group was reviewed at `https://modernconsultinggroup.com` and received a 34/80 score. The generated PDF said there was no visible conversion path or lead mechanism, but the live site includes booking CTAs in the header, body, and footer.

## Findings

- The current analyzer fetches only the initial server HTML with `https.get`.
- The Modern Consulting Group homepage is a Vite/React shell in the static response: it contains `#root`, asset links, and minimal title/meta content.
- The actual page content and booking CTA text live in the JavaScript bundle, not in the static HTML sent to Claude.
- Current HTML cleanup removes `<nav>` and `<footer>` entirely. That would delete common CTA locations even on non-SPA sites.
- The prompt asks for blunt critique but does not require evidence citations or confidence checks before saying something is missing.
- The report does not show extraction coverage, rendered/static fetch status, observed CTAs, or uncertainty warnings.

## Root Cause

The report mismatch is primarily an extraction and evidence problem. The analyzer judged a thin, non-rendered HTML shell as if it represented the full website. Because the prompt does not guard against low-coverage input, the model filled the evidence gap with definitive missing-feature language.

## Required Updates

1. Add rendered-page extraction.
   - Use Playwright or an equivalent headless browser for JavaScript-rendered websites.
   - Detect SPA shells and automatically fall back to rendered DOM extraction.
   - Capture final page text after network idle or a bounded wait.

2. Preserve and structure navigation and footer evidence.
   - Stop deleting `<nav>` and `<footer>` during extraction.
   - Extract nav links, footer links, buttons, forms, and anchor text as separate evidence fields.

3. Build an evidence model before calling the LLM.
   - Include headings, body copy, CTAs, buttons, forms, booking/calendar links, nav links, footer links, social proof markers, methodology markers, and leadership markers.
   - Include extraction metadata: static HTML length, rendered text length, fetch mode, warnings, and confidence.

4. Harden the prompt.
   - Require every major weakness to be grounded in observed evidence.
   - Forbid claims like "no CTA" or "no booking path" when CTA evidence is present.
   - Use "not observed in fetched evidence" only when extraction coverage is adequate.
   - Use "uncertain due to low extraction coverage" when content could not be confidently inspected.

5. Update the report UI/PDF.
   - Add an Evidence Coverage section.
   - Show observed CTA/conversion evidence.
   - Surface warnings when the analyzer had to render JavaScript or when evidence was thin.

6. Add regression tests.
   - Static HTML page with nav/footer CTA.
   - SPA shell page whose rendered DOM contains CTAs.
   - Low-content page that should produce uncertainty instead of harsh missing-feature claims.
   - Modern Consulting Group fixture confirming "Book a Call" evidence prevents "no conversion path" findings.

## Acceptance Criteria

- Running WebsiteCritique against `modernconsultinggroup.com` detects the booking CTAs before scoring.
- The report no longer says there is no visible CTA or no conversion path when booking CTAs are observed.
- If rendered extraction fails, the report states low confidence instead of making definitive missing-feature claims.
- The generated report includes extraction coverage and observed conversion evidence.
- Automated tests cover CTA detection in nav, body, footer, and rendered SPA content.

## Validation Result

Production validation from the Cloak runtime confirmed:

- Extraction mode: `rendered`
- Confidence: `high`
- Warning: `spa_shell_detected`
- Rendered text length: `3737`
- Observed CTAs:
  - `Book a Call [nav]`
  - `Book a 15-Minute Call [section]`
  - `Book a 15-Min Builder Chat [section]`
  - `Request a Sample [section]`
  - `Book a 15-Min Strategy Call [section]`

When the old finding text is passed through the current guardrail, `No Conversion Path or Lead Mechanism` is corrected to `Conversion Path Needs Stronger Qualification`.

Fresh validation report: `https://portal.glenfarrell.net/WebsiteCritique/report/e5550f9dcc3f`

## Implementation Phases

### Phase 1: Evidence Extraction

Implement rendered extraction, SPA detection, structured CTA/link/form capture, and extraction warnings.

### Phase 2: Scoring Guardrails

Update the prompt and JSON schema so scores and weaknesses are tied to observed evidence and confidence.

### Phase 3: Report Transparency

Update report rendering to show evidence coverage, observed CTAs, and confidence notes.

### Phase 4: Regression Verification

Add fixtures and tests, re-run the Modern Consulting Group report, compare before/after output, and document deployment status.
