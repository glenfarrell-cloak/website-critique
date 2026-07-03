/**
 * Executive Website & Positioning Review — Portal Server
 * Modern Consulting Group · portal.glenfarrell.net/WebsiteCritique
 *
 * Node.js / Express app — runs on port 8081
 * Nginx proxies /WebsiteCritique → localhost:8081
 *
 * Env vars (.env):
 *   PORT=8081
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   RESEND_API_KEY=re_...
 *   FROM_EMAIL=reports@modernconsultinggroup.com
 *   NOTIFY_EMAIL=glen.farrell@gmail.com
 *   SITE_URL=https://portal.glenfarrell.net
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8081;
const BASE = '/WebsiteCritique';

// ── Storage (JSON file — zero native dependencies) ────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'submissions.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

function saveSubmission(record) {
  const rows = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  rows.push(record);
  fs.writeFileSync(DB_FILE, JSON.stringify(rows, null, 2));
}

function getSubmission(id) {
  const rows = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return rows.find(r => r.id === id) || null;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Strip /WebsiteCritique prefix if nginx passes it through
app.use((req, res, next) => {
  if (req.path.startsWith(BASE)) {
    req.url = req.url.slice(BASE.length) || '/';
  }
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.get(['/', '/apply', '/apply/'], (req, res) => {
  res.send(appHTML());
});

app.post('/api/analyze', async (req, res) => {
  try {
    const body = req.body;
    const required = ['website_url', 'name', 'email', 'industry'];
    for (const f of required) {
      if (!body[f]) return res.status(400).json({ error: `Missing: ${f}` });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    let url = body.website_url.trim();
    if (!url.startsWith('http')) url = 'https://' + url;

    // Fetch website evidence
    let siteEvidence = null;
    try {
      siteEvidence = await fetchWebsiteEvidence(url);
    } catch (e) {
      siteEvidence = buildFailedEvidence(url, e);
    }

    // Generate report
    const report = await generateReport(body, siteEvidence, url);

    // Store
    const id = crypto.randomBytes(6).toString('hex');
    saveSubmission({
      id,
      created_at: new Date().toISOString(),
      name: body.name,
      email: body.email,
      website_url: url,
      form_data: body,
      report,
      evidence_summary: report.evidence_summary
    });

    // Emails (non-blocking)
    sendReportEmail(body.email, body.name, url, report, id).catch(console.error);
    sendNotify(body.name, body.email, url, id).catch(console.error);

    res.json({ success: true, report_id: id, report });
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/report/:id', (req, res) => {
  const row = getSubmission(req.params.id);
  if (!row) return res.status(404).send('<h1>Report not found</h1>');
  res.send(reportPageHTML(row, row.report));
});

app.get('/status', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Also handle with the BASE prefix directly (if nginx passes full path)
app.get(BASE, (req, res) => res.redirect(`${BASE}/`));
app.get(`${BASE}/`, (req, res) => res.send(appHTML()));
app.get(`${BASE}/apply`, (req, res) => res.send(appHTML()));
app.post(`${BASE}/api/analyze`, (req, res) => {
  req.url = '/api/analyze';
  app.handle(req, res);
});
app.get(`${BASE}/report/:id`, (req, res) => {
  const row = getSubmission(req.params.id);
  if (!row) return res.status(404).send('<h1>Report not found</h1>');
  res.send(reportPageHTML(row, row.report));
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Website Critique portal running on port ${PORT}`));
}

// ── AI Report Generation ───────────────────────────────────────────────────────
async function generateReport(form, siteEvidence, url) {
  const prompt = buildPrompt(form, siteEvidence, url);

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: `You are a senior strategic business advisor producing executive-grade website assessments for Modern Consulting Group. Be specific, blunt, and commercially grounded. Output VALID JSON only — no markdown, no preamble.`,
    messages: [{ role: 'user', content: prompt }]
  });

  const data = await apiPost('api.anthropic.com', '/v1/messages', body, {
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  });

  let text = data.content?.[0]?.text || '';
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) text = match[1];
  return applyEvidenceGuardrails(JSON.parse(text.trim()), siteEvidence);
}

function buildPrompt(form, siteEvidence, url) {
  const evidence = normalizeEvidenceForPrompt(siteEvidence);
  return `Analyze this website and produce a concise Executive Website & Positioning Review.

WEBSITE URL: ${url}

WEBSITE EVIDENCE JSON:
${JSON.stringify(evidence, null, 2).slice(0, 18000)}

CLIENT CONTEXT (from intake form):
- Industry: ${form.industry}
- Primary concern (self-identified): ${form.concern || 'Not specified'}

EVIDENCE RULES:
- Ground every major criticism in the WEBSITE EVIDENCE JSON.
- Never say "no CTA", "no booking path", "no visible call-to-action", "no conversion path", "no lead mechanism", or similar if observed_ctas contains relevant CTA evidence.
- If evidence coverage is low, say the finding is uncertain because extraction coverage was low. Do not punish the business as if the feature is definitely absent.
- Use "not observed in fetched evidence" only when coverage is adequate and the evidence truly lacks the item.
- Distinguish "missing" from "present but weak/unclear/underdeveloped".
- Treat nav, header, body, and footer CTAs as valid conversion-path evidence.

Return ONLY this JSON:
{
  "business_name": "name from website",
  "website_url": "${url}",
  "evidence_summary": {
    "extraction_mode": "static|rendered|script_fallback|failed",
    "confidence": "high|medium|low",
    "warnings": ["short warning"],
    "observed_ctas": ["short CTA label or empty"],
    "observed_conversion_paths": ["short path or empty"]
  },
  "composite_score": <0-80>,
  "maturity_classification": "Emerging|Established|Growth-Ready|Premium Operator|Category Leader",
  "executive_summary": "3 punchy sentences: what the site does well, where it fails, what's at stake",
  "scores": {
    "brand_clarity":       {"score": <1-10>, "grade": "Weak|Below Average|Average|Strong|Exceptional", "note": "one line"},
    "strategic_positioning":{"score": <1-10>, "grade": "...", "note": "one line"},
    "commercial_readiness": {"score": <1-10>, "grade": "...", "note": "one line"},
    "executive_credibility":{"score": <1-10>, "grade": "...", "note": "one line"},
    "emotional_impact":     {"score": <1-10>, "grade": "...", "note": "one line"},
    "user_experience":      {"score": <1-10>, "grade": "...", "note": "one line"},
    "conversion_readiness": {"score": <1-10>, "grade": "...", "note": "one line"},
    "overall_potential":    {"score": <1-10>, "grade": "...", "note": "one line"}
  },
  "top_strengths": [
    {"title": "strength", "detail": "2 sentences"},
    {"title": "strength", "detail": "2 sentences"},
    {"title": "strength", "detail": "2 sentences"}
  ],
  "top_weaknesses": [
    {"title": "weakness", "severity": "High|Medium|Low", "detail": "2 sentences", "fix": "one concrete fix"},
    {"title": "weakness", "severity": "High|Medium|Low", "detail": "2 sentences", "fix": "one concrete fix"},
    {"title": "weakness", "severity": "High|Medium|Low", "detail": "2 sentences", "fix": "one concrete fix"}
  ],
  "top_recommendations": [
    {"action": "specific action", "impact": "High|Medium", "timeframe": "This week|This month|This quarter"},
    {"action": "specific action", "impact": "High|Medium", "timeframe": "..."},
    {"action": "specific action", "impact": "High|Medium", "timeframe": "..."},
    {"action": "specific action", "impact": "High|Medium", "timeframe": "..."},
    {"action": "specific action", "impact": "High|Medium", "timeframe": "..."}
  ],
  "the_one_thing": "Single most important directive — one sentence",
  "strategic_outlook": "2 sentences on ceiling and trajectory"
}`;
}

// ── Fetch website evidence ────────────────────────────────────────────────────
const CTA_RE = /\b(book|schedule|call|consult|contact|strategy session|discovery|calendar|calendly|demo|estimate|quote|get started|talk)\b/i;
const ABSOLUTE_MISSING_CTA_RE = /\b(no|zero|without|lacks?|missing)\b.{0,80}\b(visible )?(cta|call-to-action|conversion path|lead mechanism|booking path|booking option|next step)\b/i;
const INSTALL_CTA_RE = /\b(install|add|create|place)\b.{0,80}\b(cta|call-to-action|booking|calendar|conversion path|lead mechanism)\b/i;

async function fetchWebsiteEvidence(url) {
  const warnings = [];
  const staticFetch = await fetchRawWebsite(url);
  const staticEvidence = extractStaticEvidence(staticFetch.html, staticFetch.finalUrl || url);
  const spaShell = isLikelySpaShell(staticFetch.html, staticEvidence);

  let renderedEvidence = null;
  if (spaShell || (staticEvidence.text.length < 800 && staticEvidence.ctas.length === 0)) {
    try {
      renderedEvidence = await renderWebsiteEvidence(staticFetch.finalUrl || url);
    } catch (err) {
      warnings.push(`render_failed: ${err.message}`);
    }
  }

  let scriptEvidence = null;
  if (!renderedEvidence || renderedEvidence.ctas.length === 0) {
    try {
      scriptEvidence = await extractScriptFallbackEvidence(staticFetch.html, staticFetch.finalUrl || url);
    } catch (err) {
      warnings.push(`script_fallback_failed: ${err.message}`);
    }
  }

  const best = chooseBestEvidence(staticEvidence, renderedEvidence, scriptEvidence);
  if (spaShell) warnings.push('spa_shell_detected');
  if (best.text.length < 500) warnings.push('low_text_coverage');
  if (best.mode === 'script_fallback') warnings.push('cta_text_found_in_script_bundle_not_rendered_dom');

  const confidence = best.mode === 'rendered' && best.text.length >= 800 ? 'high'
    : best.ctas.length > 0 && best.text.length >= 250 ? 'medium'
    : 'low';

  return {
    url,
    final_url: staticFetch.finalUrl || url,
    extraction: {
      mode: best.mode,
      confidence,
      warnings: [...new Set([...warnings, ...best.warnings])],
      static_status: staticFetch.statusCode,
      static_html_bytes: Buffer.byteLength(staticFetch.html || '', 'utf8'),
      static_text_length: staticEvidence.text.length,
      rendered_text_length: renderedEvidence ? renderedEvidence.text.length : 0
    },
    content: best
  };
}

function fetchRawWebsite(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'MCG-WebsiteReview/1.0 (Strategic Assessment; hello@modernconsultinggroup.com)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 12000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, url).toString();
        return fetchRawWebsite(nextUrl, redirects + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 750000) req.destroy(new Error('Response too large'));
      });
      res.on('end', () => resolve({ html: data, statusCode: res.statusCode, finalUrl: url }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Timeout')); });
  });
}

function extractStaticEvidence(html, url) {
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription = firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const navHtml = collectTagHtml(html, 'nav').join(' ');
  const footerHtml = collectTagHtml(html, 'footer').join(' ');
  const links = extractLinks(html, url);
  const buttons = extractButtons(html);
  const headings = extractHeadings(html);
  const forms = extractForms(html);
  const navLinks = extractLinks(navHtml, url);
  const footerLinks = extractLinks(footerHtml, url);
  const ctas = dedupeByText([...links, ...buttons].filter(item => CTA_RE.test(`${item.text} ${item.href || ''}`)));
  return {
    mode: 'static',
    warnings: [],
    title,
    meta_description: metaDescription,
    text: stripHTML(html),
    text_sample: stripHTML(html).slice(0, 9000),
    headings,
    nav_links: navLinks,
    footer_links: footerLinks,
    links: links.slice(0, 120),
    buttons: buttons.slice(0, 80),
    forms,
    ctas: ctas.slice(0, 30)
  };
}

async function renderWebsiteEvidence(url) {
  const playwright = require('playwright');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || findChromeExecutable();
  const launchOptions = { headless: true };
  if (executablePath) launchOptions.executablePath = executablePath;

  const browser = await playwright.chromium.launch(launchOptions);
  try {
    const page = await browser.newPage({
      userAgent: 'MCG-WebsiteReview/1.0 (Strategic Assessment; hello@modernconsultinggroup.com)'
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const result = await page.evaluate(() => {
      const clean = value => (value || '').replace(/\s+/g, ' ').trim();
      const locationOf = el => {
        if (el.closest('header')) return 'header';
        if (el.closest('nav')) return 'nav';
        if (el.closest('main')) return 'main';
        if (el.closest('footer')) return 'footer';
        if (el.closest('section')) return 'section';
        return 'body';
      };
      const linkFor = a => ({ text: clean(a.innerText || a.textContent), href: a.href || '', location: locationOf(a) });
      const buttonFor = b => ({ text: clean(b.innerText || b.textContent || b.getAttribute('aria-label')), href: '', location: locationOf(b) });
      const links = Array.from(document.querySelectorAll('a')).map(linkFor).filter(a => a.text || a.href);
      const buttons = Array.from(document.querySelectorAll('button,[role="button"]')).map(buttonFor).filter(b => b.text);
      const forms = Array.from(document.querySelectorAll('form')).map(form => ({
        action: form.action || '',
        method: form.method || 'get',
        text: clean(form.innerText || form.textContent),
        inputs: Array.from(form.querySelectorAll('input,textarea,select')).map(input => clean(input.name || input.id || input.placeholder || input.type)).filter(Boolean).slice(0, 20)
      }));
      return {
        title: clean(document.title),
        meta_description: clean(document.querySelector('meta[name="description"]')?.content),
        text: clean(document.body?.innerText || document.body?.textContent),
        headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(h => ({ level: h.tagName.toLowerCase(), text: clean(h.innerText || h.textContent) })).filter(h => h.text).slice(0, 80),
        nav_links: links.filter(a => a.location === 'nav' || a.location === 'header').slice(0, 80),
        footer_links: links.filter(a => a.location === 'footer').slice(0, 80),
        links: links.slice(0, 140),
        buttons: buttons.slice(0, 100),
        forms
      };
    });

    const ctas = dedupeByText([...result.links, ...result.buttons].filter(item => CTA_RE.test(`${item.text} ${item.href || ''}`)));
    return {
      mode: 'rendered',
      warnings: [],
      ...result,
      text_sample: result.text.slice(0, 12000),
      ctas: ctas.slice(0, 40)
    };
  } finally {
    await browser.close();
  }
}

async function extractScriptFallbackEvidence(html, url) {
  const scriptSrcs = Array.from(html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi))
    .map(match => new URL(match[1], url).toString())
    .slice(0, 8);
  const snippets = [];
  for (const src of scriptSrcs) {
    const fetched = await fetchRawAsset(src);
    const matches = extractReadableCtaStrings(fetched).slice(0, 30);
    snippets.push(...matches.map(text => ({ text, href: src, location: 'script' })));
  }
  const ctas = dedupeByText(snippets.filter(item => CTA_RE.test(item.text)));
  return {
    mode: 'script_fallback',
    warnings: [],
    title: firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    meta_description: '',
    text: ctas.map(c => c.text).join(' '),
    text_sample: ctas.map(c => c.text).join('\n').slice(0, 5000),
    headings: [],
    nav_links: [],
    footer_links: [],
    links: [],
    buttons: [],
    forms: [],
    ctas: ctas.slice(0, 30)
  };
}

function fetchRawAsset(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'MCG-WebsiteReview/1.0' }, timeout: 12000 }, (res) => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 1000000) req.destroy(new Error('Asset too large'));
      });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout')));
  });
}

function chooseBestEvidence(staticEvidence, renderedEvidence, scriptEvidence) {
  if (renderedEvidence && (renderedEvidence.text.length > staticEvidence.text.length * 1.5 || renderedEvidence.ctas.length >= staticEvidence.ctas.length)) {
    return renderedEvidence;
  }
  if (staticEvidence.ctas.length > 0 && staticEvidence.text.length >= 500) return staticEvidence;
  if (scriptEvidence && scriptEvidence.ctas.length > 0) return scriptEvidence;
  return renderedEvidence || staticEvidence;
}

function isLikelySpaShell(html, evidence) {
  return /<div[^>]+id=["']root["']/i.test(html)
    && /<script[^>]+type=["']module["']/i.test(html)
    && evidence.text.length < 600;
}

function stripHTML(html) {
  return decodeEntities((html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim());
}

function collectTagHtml(html, tag) {
  return Array.from((html || '').matchAll(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'))).map(m => m[0]);
}

function extractLinks(html, baseUrl) {
  return Array.from((html || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)).map(match => {
    const attrs = match[1] || '';
    const href = firstMatch(attrs, /\bhref=["']([^"']+)["']/i);
    return {
      text: stripHTML(match[2]),
      href: href ? safeAbsoluteUrl(href, baseUrl) : '',
      location: 'html'
    };
  }).filter(link => link.text || link.href);
}

function extractButtons(html) {
  return Array.from((html || '').matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi))
    .map(match => ({ text: stripHTML(match[1]), href: '', location: 'html' }))
    .filter(button => button.text);
}

function extractHeadings(html) {
  return Array.from((html || '').matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi))
    .map(match => ({ level: match[1].toLowerCase(), text: stripHTML(match[2]) }))
    .filter(h => h.text)
    .slice(0, 80);
}

function extractForms(html) {
  return Array.from((html || '').matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)).map(match => ({
    action: firstMatch(match[1], /\baction=["']([^"']+)["']/i),
    method: firstMatch(match[1], /\bmethod=["']([^"']+)["']/i) || 'get',
    text: stripHTML(match[2]).slice(0, 500),
    inputs: Array.from(match[2].matchAll(/<(input|textarea|select)\b([^>]*)>/gi)).map(input =>
      firstMatch(input[2], /\b(name|id|placeholder|type)=["']([^"']+)["']/i, 2)
    ).filter(Boolean).slice(0, 20)
  }));
}

function extractReadableCtaStrings(source) {
  const matches = Array.from((source || '').matchAll(/["'`]([^"'`]{3,140})["'`]/g))
    .map(match => decodeEntities(match[1]).replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(text => /[A-Za-z]/.test(text) && CTA_RE.test(text));
  return [...new Set(matches)].slice(0, 80);
}

function normalizeEvidenceForPrompt(siteEvidence) {
  if (!siteEvidence || typeof siteEvidence === 'string') {
    return { extraction: { mode: 'unknown', confidence: 'low', warnings: ['legacy_or_missing_evidence'] }, content_text: String(siteEvidence || '').slice(0, 10000) };
  }
  const content = siteEvidence.content || {};
  return {
    url: siteEvidence.url,
    final_url: siteEvidence.final_url,
    extraction: siteEvidence.extraction,
    title: content.title,
    meta_description: content.meta_description,
    headings: content.headings,
    observed_ctas: summarizeCtas(content.ctas),
    observed_conversion_paths: summarizeConversionPaths(content),
    nav_links: (content.nav_links || []).slice(0, 40),
    footer_links: (content.footer_links || []).slice(0, 40),
    forms: content.forms || [],
    body_text_sample: content.text_sample || ''
  };
}

function applyEvidenceGuardrails(report, siteEvidence) {
  const content = siteEvidence?.content || {};
  const ctas = summarizeCtas(content.ctas);
  const paths = summarizeConversionPaths(content);
  const warnings = siteEvidence?.extraction?.warnings || [];
  report.evidence_summary = {
    extraction_mode: siteEvidence?.extraction?.mode || 'failed',
    confidence: siteEvidence?.extraction?.confidence || 'low',
    warnings,
    observed_ctas: ctas,
    observed_conversion_paths: paths
  };

  if (ctas.length > 0 && Array.isArray(report.top_weaknesses)) {
    report.top_weaknesses = report.top_weaknesses.map(weakness => {
      const text = `${weakness.title || ''} ${weakness.detail || ''} ${weakness.fix || ''}`;
      if (!ABSOLUTE_MISSING_CTA_RE.test(text)) return weakness;
      return {
        ...weakness,
        title: 'Conversion Path Needs Stronger Qualification',
        detail: `The analyzer observed CTA evidence (${ctas.slice(0, 3).join('; ')}), so the issue is not absence of a booking path. Review whether those CTAs are prominent, specific, and tied to a qualified next step.`,
        fix: 'Keep the booking CTAs, then strengthen surrounding copy with who should book, what the call covers, and what happens next.'
      };
    });
  }

  if (ctas.length > 0 && Array.isArray(report.top_recommendations)) {
    report.top_recommendations = report.top_recommendations.map(recommendation => {
      const action = recommendation.action || '';
      if (!ABSOLUTE_MISSING_CTA_RE.test(action) && !INSTALL_CTA_RE.test(action)) return recommendation;
      return {
        ...recommendation,
        action: 'Strengthen the observed booking path with clearer qualification copy and next-step expectations'
      };
    });
  }

  const conversion = report.scores?.conversion_readiness;
  if (ctas.length > 0 && conversion?.note && ABSOLUTE_MISSING_CTA_RE.test(conversion.note)) {
    conversion.note = 'Booking CTAs are present; assess prominence, specificity, and qualification strength rather than absence.';
  }

  if (siteEvidence?.extraction?.confidence === 'low') {
    report.executive_summary = `${report.executive_summary || ''} Note: extraction confidence was low, so missing-feature claims should be treated as preliminary.`.trim();
  }
  return report;
}

function buildFailedEvidence(url, err) {
  return {
    url,
    final_url: url,
    extraction: {
      mode: 'failed',
      confidence: 'low',
      warnings: [`fetch_failed: ${err.message}`],
      static_status: null,
      static_html_bytes: 0,
      static_text_length: 0,
      rendered_text_length: 0
    },
    content: {
      mode: 'failed',
      warnings: [],
      title: '',
      meta_description: '',
      text: '',
      text_sample: '',
      headings: [],
      nav_links: [],
      footer_links: [],
      links: [],
      buttons: [],
      forms: [],
      ctas: []
    }
  };
}

function summarizeCtas(ctas = []) {
  return dedupeByText(ctas)
    .map(cta => `${cta.text || cta.href}${cta.location ? ` (${cta.location})` : ''}`.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function summarizeConversionPaths(content = {}) {
  const items = [...(content.ctas || []), ...(content.forms || [])];
  return items.map(item => {
    if (item.inputs) return `form: ${item.inputs.join(', ') || item.text || item.action || 'form detected'}`;
    return `${item.text || item.href}${item.href ? ` -> ${item.href}` : ''}`;
  }).filter(Boolean).slice(0, 12);
}

function dedupeByText(items = []) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.text || ''}|${item.href || ''}`.toLowerCase();
    if (!key.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function firstMatch(value, regex, group = 1) {
  const match = (value || '').match(regex);
  return match ? decodeEntities(match[group] || '').trim() : '';
}

function safeAbsoluteUrl(href, baseUrl) {
  try { return new URL(href, baseUrl).toString(); }
  catch { return href; }
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function findChromeExecutable() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

// ── HTTP API helper ───────────────────────────────────────────────────────────
function apiPost(host, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const req = https.request({
      hostname: host, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        ...extraHeaders
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`API ${res.statusCode}: ${data.slice(0, 300)}`));
          else resolve(parsed);
        } catch { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// ── Email ─────────────────────────────────────────────────────────────────────
async function sendReportEmail(to, name, url, report, id) {
  const siteUrl = process.env.SITE_URL || 'https://portal.glenfarrell.net';
  const html = buildEmailHTML(name, url, report, id, siteUrl);
  await apiPost('api.resend.com', '/emails', JSON.stringify({
    from: `${process.env.FROM_NAME || 'Modern Consulting Group'} <${process.env.FROM_EMAIL || 'reports@modernconsultinggroup.com'}>`,
    to: [to],
    subject: `Your Executive Website Review — ${report.business_name || url}`,
    html
  }), { Authorization: `Bearer ${process.env.RESEND_API_KEY}` });
}

async function sendNotify(name, email, url, id) {
  const siteUrl = process.env.SITE_URL || 'https://portal.glenfarrell.net';
  await apiPost('api.resend.com', '/emails', JSON.stringify({
    from: `${process.env.FROM_NAME || 'Modern Consulting Group'} <${process.env.FROM_EMAIL || 'reports@modernconsultinggroup.com'}>`,
    to: [process.env.NOTIFY_EMAIL || 'glen.farrell@gmail.com'],
    subject: `New Review — ${name} (${url})`,
    html: `<p><b>Name:</b> ${name}<br><b>Email:</b> ${email}<br><b>Site:</b> ${url}</p><p><a href="${siteUrl}/WebsiteCritique/report/${id}">View Report</a></p>`
  }), { Authorization: `Bearer ${process.env.RESEND_API_KEY}` });
}

// ── HTML: Single-page app (landing + 10-question form + preview) ──────────────
function appHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Executive Website Review — Modern Consulting Group</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#090909;--surface:#111;--card:#161616;--border:#1e1e1e;--border2:#2a2a2a;
  --text:#e2e2e2;--muted:#666;--muted2:#888;--white:#fff;
  --gold:#c9a96e;--gold2:#e8c98a;--green:#52b788;--red:#e05252;--orange:#f0a500;
  --r:10px;
}
html{scroll-behavior:smooth}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
a{color:var(--gold);text-decoration:none}

/* ── NAV ── */
nav{
  position:fixed;top:0;left:0;right:0;z-index:50;
  display:flex;align-items:center;justify-content:space-between;
  padding:18px 40px;
  background:rgba(9,9,9,0.85);backdrop-filter:blur(16px);
  border-bottom:1px solid var(--border);
}
.nav-logo{font-size:12px;font-weight:500;color:var(--muted2);letter-spacing:.06em;text-transform:uppercase}
.nav-logo b{color:var(--white)}
.nav-btn{
  background:var(--gold);color:#000;
  padding:8px 20px;border-radius:6px;
  font-size:12px;font-weight:700;letter-spacing:.02em;
  cursor:pointer;border:none;font-family:inherit;
  transition:background .15s;
}
.nav-btn:hover{background:var(--gold2)}

/* ── HERO ── */
.hero{
  min-height:100vh;display:flex;align-items:center;
  padding:120px 40px 80px;max-width:1060px;margin:0 auto;
}
.hero-inner{max-width:640px}
.pill{
  display:inline-flex;align-items:center;gap:8px;
  background:rgba(201,169,110,.1);border:1px solid rgba(201,169,110,.25);
  color:var(--gold);font-size:11px;font-weight:700;
  letter-spacing:.12em;text-transform:uppercase;
  padding:5px 12px;border-radius:100px;margin-bottom:28px;
}
.pill::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--gold);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
h1{font-size:clamp(36px,5vw,62px);font-weight:800;color:var(--white);line-height:1.08;letter-spacing:-.03em;margin-bottom:22px}
h1 em{color:var(--gold);font-style:normal}
.hero-sub{font-size:17px;color:var(--muted2);line-height:1.7;margin-bottom:36px;max-width:520px}
.hero-actions{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.btn-cta{
  display:inline-flex;align-items:center;gap:8px;
  background:var(--gold);color:#000;
  padding:15px 30px;border-radius:var(--r);
  font-size:15px;font-weight:700;
  cursor:pointer;border:none;font-family:inherit;
  transition:background .15s,transform .1s;
}
.btn-cta:hover{background:var(--gold2);transform:translateY(-1px)}
.hero-proof{
  display:flex;gap:28px;margin-top:48px;flex-wrap:wrap;
}
.proof-stat{border-left:2px solid var(--border2);padding-left:16px}
.proof-num{font-size:24px;font-weight:700;color:var(--white)}
.proof-label{font-size:11px;color:var(--muted);margin-top:2px}

/* ── SECTION ── */
.section{padding:80px 40px;max-width:1060px;margin:0 auto}
.section-tag{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);margin-bottom:14px}
h2{font-size:clamp(26px,3vw,40px);font-weight:700;color:var(--white);letter-spacing:-.02em;margin-bottom:14px}
.divider{border:none;border-top:1px solid var(--border);max-width:1060px;margin:0 auto}

/* ── WHAT YOU GET ── */
.not-grid{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-top:40px}
.not-col{padding:36px}
.not-col:first-child{border-right:1px solid var(--border)}
.not-col h3{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:18px}
.not-col.bad h3{color:var(--muted)}
.not-col.good h3{color:var(--gold)}
.not-list{list-style:none}
.not-list li{padding:9px 0;border-bottom:1px solid var(--border);font-size:13px;color:var(--muted2);display:flex;gap:10px;align-items:flex-start;line-height:1.5}
.not-list li:last-child{border-bottom:none}
.not-col.good .not-list li{color:var(--text)}

/* ── 8 CATEGORIES ── */
.cats{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-top:36px}
.cat{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:22px}
.cat-n{font-size:10px;color:var(--gold);font-weight:700;letter-spacing:.1em;margin-bottom:8px}
.cat h3{font-size:14px;font-weight:600;color:var(--white);margin-bottom:6px}
.cat p{font-size:12px;color:var(--muted2);line-height:1.55}

/* ── MODAL / FORM OVERLAY ── */
.overlay{
  display:none;position:fixed;inset:0;z-index:100;
  background:rgba(9,9,9,.97);backdrop-filter:blur(8px);
  overflow-y:auto;
}
.overlay.open{display:flex;align-items:flex-start;justify-content:center;padding:40px 20px}
.form-box{width:100%;max-width:620px;padding:0 0 60px}

/* progress dots */
.dots{display:flex;gap:8px;justify-content:center;margin-bottom:48px;padding-top:20px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--border2);transition:background .25s,transform .2s}
.dot.active{background:var(--gold);transform:scale(1.3)}
.dot.done{background:var(--green)}

/* question cards */
.q{display:none;animation:fadeUp .3s ease}
.q.visible{display:block}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.q-label{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);margin-bottom:10px}
.q-title{font-size:clamp(22px,3vw,30px);font-weight:700;color:var(--white);margin-bottom:8px;line-height:1.25}
.q-sub{font-size:14px;color:var(--muted2);margin-bottom:28px}

/* text input */
.text-input{
  width:100%;background:var(--card);border:1.5px solid var(--border2);
  border-radius:var(--r);color:var(--text);font-family:inherit;
  font-size:16px;padding:14px 18px;transition:border-color .2s;
  margin-bottom:8px;
}
.text-input:focus{outline:none;border-color:var(--gold)}
.text-input.err{border-color:var(--red)}
.err-msg{font-size:12px;color:var(--red);margin-bottom:16px;display:none}
.err-msg.show{display:block}

/* two-col inputs */
.input-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}

/* btn grid */
.btn-grid{display:grid;gap:10px;margin-bottom:8px}
.btn-grid.cols-2{grid-template-columns:repeat(2,1fr)}
.btn-grid.cols-3{grid-template-columns:repeat(3,1fr)}
.btn-grid.cols-4{grid-template-columns:repeat(4,1fr)}
.opt{
  background:var(--card);border:1.5px solid var(--border2);
  border-radius:var(--r);padding:12px 16px;
  font-size:13px;font-weight:500;color:var(--muted2);
  cursor:pointer;transition:border-color .15s,color .15s,background .15s;
  text-align:center;user-select:none;
}
.opt:hover{border-color:var(--border2);color:var(--text)}
.opt.sel{border-color:var(--gold);color:var(--white);background:rgba(201,169,110,.08)}
.opt.multi-sel{border-color:var(--green);color:var(--white);background:rgba(82,183,136,.07)}

/* slider */
.slider-wrap{margin-bottom:8px}
.slider-labels{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:10px}
input[type=range]{
  width:100%;-webkit-appearance:none;appearance:none;
  height:4px;border-radius:2px;background:var(--border2);
  outline:none;cursor:pointer;
}
input[type=range]::-webkit-slider-thumb{
  -webkit-appearance:none;width:22px;height:22px;border-radius:50%;
  background:var(--gold);cursor:pointer;border:3px solid var(--bg);
  box-shadow:0 0 0 2px var(--gold);transition:transform .15s;
}
input[type=range]::-webkit-slider-thumb:active{transform:scale(1.2)}
.slider-val{
  text-align:center;font-size:32px;font-weight:700;color:var(--white);
  margin:14px 0 4px;
}
.slider-val span{font-size:16px;color:var(--muted)}

/* nav buttons */
.q-nav{display:flex;justify-content:space-between;align-items:center;margin-top:36px}
.btn-back{
  background:none;border:1.5px solid var(--border2);color:var(--muted2);
  border-radius:var(--r);padding:12px 22px;font-size:14px;font-weight:500;
  cursor:pointer;font-family:inherit;transition:border-color .2s;
}
.btn-back:hover{border-color:var(--muted2);color:var(--text)}
.btn-next{
  background:var(--gold);color:#000;
  border:none;border-radius:var(--r);
  padding:14px 30px;font-size:15px;font-weight:700;
  cursor:pointer;font-family:inherit;transition:background .15s;
}
.btn-next:hover{background:var(--gold2)}
.btn-next:disabled{opacity:.4;cursor:default}
.invis{visibility:hidden}

/* ── LOADING ── */
.loading{
  display:none;position:fixed;inset:0;z-index:200;
  background:rgba(9,9,9,.97);
  flex-direction:column;align-items:center;justify-content:center;
  text-align:center;padding:40px;
}
.loading.show{display:flex}
.spin{
  width:52px;height:52px;border:3px solid var(--border2);
  border-top-color:var(--gold);border-radius:50%;
  animation:spin .75s linear infinite;margin-bottom:28px;
}
@keyframes spin{to{transform:rotate(360deg)}}
.load-title{font-size:22px;font-weight:700;color:var(--white);margin-bottom:8px}
.load-sub{font-size:14px;color:var(--muted2);max-width:320px}
.load-steps{margin-top:28px;display:flex;flex-direction:column;gap:10px;text-align:left;max-width:320px}
.ls{font-size:13px;color:var(--muted);display:flex;gap:10px;align-items:center}
.ls.on{color:var(--gold)}
.ls.done{color:var(--green)}
.ls-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0}

/* ── PREVIEW ── */
.preview{display:none}
.preview.show{display:block}
.preview-hero{
  text-align:center;padding:48px 32px;
  background:var(--card);border:1px solid var(--border);
  border-radius:var(--r);margin-bottom:24px;
}
.big-score{font-size:80px;font-weight:800;color:var(--gold);line-height:1}
.score-denom{font-size:32px;color:var(--muted)}
.score-label{font-size:13px;color:var(--muted2);margin-top:6px}
.class-badge{
  display:inline-block;margin-top:16px;
  background:rgba(201,169,110,.1);border:1px solid rgba(201,169,110,.3);
  color:var(--gold);font-size:12px;font-weight:700;
  letter-spacing:.1em;padding:6px 16px;border-radius:100px;
}
.score-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin:20px 0}
.sc{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px}
.sc-cat{font-size:10px;color:var(--muted);margin-bottom:5px}
.sc-val{font-size:22px;font-weight:700;color:var(--white)}
.sc-val small{font-size:11px;color:var(--muted)}
.sc-grade{font-size:10px;margin-top:3px}
.g-Exceptional,.g-Strong{color:var(--green)}
.g-Average{color:var(--orange)}
.g-Below-Average,.g-Weak{color:var(--red)}
.pv-section{margin:28px 0}
.pv-section h3{font-size:16px;font-weight:700;color:var(--white);margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.pv-para{font-size:14px;color:var(--muted2);line-height:1.7;margin-bottom:10px}
.card-list{display:flex;flex-direction:column;gap:10px}
.pcard{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px}
.pcard.strength{border-left:3px solid var(--green)}
.pcard.weakness{border-left:3px solid var(--orange)}
.pcard.rec{border-left:3px solid var(--gold)}
.pcard-title{font-size:14px;font-weight:600;color:var(--white);margin-bottom:4px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.pcard-detail{font-size:13px;color:var(--muted2);line-height:1.55}
.badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap;flex-shrink:0}
.badge-H{background:rgba(224,82,82,.15);color:var(--red)}
.badge-M{background:rgba(240,165,0,.15);color:var(--orange)}
.badge-TW{background:rgba(201,169,110,.12);color:var(--gold)}
.badge-TM{background:rgba(82,183,136,.12);color:var(--green)}
.badge-TQ{background:rgba(255,255,255,.08);color:var(--muted2)}
.one-thing{
  background:rgba(201,169,110,.07);border:1px solid rgba(201,169,110,.25);
  border-radius:var(--r);padding:28px;margin:28px 0;text-align:center;
}
.ot-label{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);margin-bottom:10px}
.ot-text{font-size:18px;font-weight:600;color:var(--white);line-height:1.4}
.email-box{
  background:var(--card);border:1px solid var(--border);
  border-radius:var(--r);padding:32px;text-align:center;margin-top:32px;
}
.email-box h3{font-size:20px;font-weight:700;color:var(--white);margin-bottom:8px}
.email-box p{font-size:13px;color:var(--muted2);margin-bottom:20px;line-height:1.6}
.btn-session{
  display:inline-block;background:var(--gold);color:#000;
  padding:14px 28px;border-radius:var(--r);
  font-size:14px;font-weight:700;text-decoration:none;
}
.btn-session:hover{background:var(--gold2);color:#000}

/* ── FOOTER ── */
footer{
  border-top:1px solid var(--border);padding:28px 40px;
  display:flex;justify-content:space-between;align-items:center;
  max-width:1060px;margin:0 auto;font-size:12px;color:var(--muted);
}
footer a{color:var(--muted);margin-left:20px}
footer a:hover{color:var(--text)}

@media(max-width:700px){
  nav{padding:16px 20px}
  .hero{padding:100px 20px 60px}
  .section{padding:60px 20px}
  .not-grid{grid-template-columns:1fr}
  .not-col:first-child{border-right:none;border-bottom:1px solid var(--border)}
  .btn-grid.cols-4{grid-template-columns:repeat(2,1fr)}
  .input-row{grid-template-columns:1fr}
  footer{flex-direction:column;gap:12px;text-align:center;padding:24px 20px}
}
</style>
</head>
<body>

<!-- NAV -->
<nav>
  <div class="nav-logo">Modern Consulting Group · <b>Website Review</b></div>
  <button class="nav-btn" onclick="openForm()">Get My Report →</button>
</nav>

<!-- HERO -->
<section class="hero">
  <div class="hero-inner">
    <div class="pill">Executive Website & Positioning Review</div>
    <h1>Your website is either<br>building trust — <em>or losing it.</em></h1>
    <p class="hero-sub">Find out which. We analyze your site across 8 strategic categories and tell you exactly what's working, what isn't, and what to fix first.</p>
    <div class="hero-actions">
      <button class="btn-cta" onclick="openForm()">Start My Review — It's Free →</button>
    </div>
    <div class="hero-proof">
      <div class="proof-stat"><div class="proof-num">8</div><div class="proof-label">Strategic categories scored</div></div>
      <div class="proof-stat"><div class="proof-num">4</div><div class="proof-label">Questions to get started</div></div>
      <div class="proof-stat"><div class="proof-num">Instant</div><div class="proof-label">Preview in your browser</div></div>
    </div>
  </div>
</section>

<hr class="divider">

<!-- NOT A DESIGN AUDIT -->
<section class="section">
  <p class="section-tag">The Difference</p>
  <h2>Not a design audit.<br>A business assessment.</h2>
  <div class="not-grid">
    <div class="not-col bad">
      <h3>✗ What this isn't</h3>
      <ul class="not-list">
        <li><span>—</span>A visual or design review</li>
        <li><span>—</span>An SEO or traffic report</li>
        <li><span>—</span>A generic checklist</li>
        <li><span>—</span>Feedback that makes you feel good but changes nothing</li>
      </ul>
    </div>
    <div class="not-col good">
      <h3>✓ What this is</h3>
      <ul class="not-list">
        <li><span>✓</span>A commercial readiness and conversion assessment</li>
        <li><span>✓</span>A strategic positioning review — differentiated or forgettable?</li>
        <li><span>✓</span>An executive credibility audit — do you earn premium rates?</li>
        <li><span>✓</span>Blunt, prioritized recommendations from an advisor who tells you the truth</li>
      </ul>
    </div>
  </div>
</section>

<hr class="divider">

<!-- 8 CATEGORIES -->
<section class="section">
  <p class="section-tag">The Framework</p>
  <h2>Eight categories. One honest score.</h2>
  <div class="cats">
    <div class="cat"><div class="cat-n">01</div><h3>Brand Clarity</h3><p>Can a cold visitor understand what you do in under 10 seconds?</p></div>
    <div class="cat"><div class="cat-n">02</div><h3>Strategic Positioning</h3><p>Do you sound distinct — or like every other firm in your category?</p></div>
    <div class="cat"><div class="cat-n">03</div><h3>Commercial Readiness</h3><p>Is your site built to convert visitors — or just inform them?</p></div>
    <div class="cat"><div class="cat-n">04</div><h3>Executive Credibility</h3><p>Would a skeptical executive trust you with real money based on this site?</p></div>
    <div class="cat"><div class="cat-n">05</div><h3>Emotional Impact</h3><p>What does the site make visitors feel — confidence, or nothing?</p></div>
    <div class="cat"><div class="cat-n">06</div><h3>User Experience</h3><p>Easy to navigate, logical flow, or visitor confusion?</p></div>
    <div class="cat"><div class="cat-n">07</div><h3>Conversion Readiness</h3><p>Is there a conversion engine — or just information?</p></div>
    <div class="cat"><div class="cat-n">08</div><h3>Overall Potential</h3><p>What's the ceiling — and is this site helping you reach it?</p></div>
  </div>
</section>

<hr class="divider">

<!-- FINAL CTA -->
<section class="section" style="text-align:center;padding-bottom:100px">
  <p class="section-tag">Ready?</p>
  <h2>Two minutes. Instant results.</h2>
  <p style="color:var(--muted2);font-size:16px;margin:14px auto 36px;max-width:440px">Submit your website. Get your executive review — on screen immediately, full report in your inbox.</p>
  <button class="btn-cta" style="font-size:16px;padding:18px 38px" onclick="openForm()">Start My Free Review →</button>
</section>

<footer>
  <span>Modern Consulting Group · Toronto, Canada · <a href="https://modernconsultinggroup.com">modernconsultinggroup.com</a></span>
  <span><a href="mailto:hello@modernconsultinggroup.com">hello@modernconsultinggroup.com</a></span>
</footer>

<!-- ── FORM OVERLAY ── -->
<div class="overlay" id="overlay">
  <div class="form-box" id="formBox">

    <!-- Close -->
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <button onclick="closeForm()" style="background:none;border:none;color:var(--muted2);font-size:22px;cursor:pointer;padding:4px 8px">×</button>
    </div>

    <!-- Progress dots -->
    <div class="dots" id="dots"></div>

    <!-- Q1: Website URL -->
    <div class="q visible" id="q1">
      <div class="q-label">Question 1 of 4</div>
      <div class="q-title">What's your website URL?</div>
      <div class="q-sub">We'll pull the content directly for analysis.</div>
      <input class="text-input" type="url" id="website_url" placeholder="https://yourcompany.com" autocomplete="off">
      <div class="err-msg" id="err-url">Please enter a valid website URL.</div>
      <div class="q-nav">
        <span class="invis">-</span>
        <button class="btn-next" onclick="goNext(1)">Continue →</button>
      </div>
    </div>

    <!-- Q2: Industry -->
    <div class="q" id="q2">
      <div class="q-label">Question 2 of 4</div>
      <div class="q-title">What industry are you in?</div>
      <div class="q-sub">We calibrate benchmarks to your sector.</div>
      <div class="btn-grid cols-2" id="industry-grid">
        <div class="opt" onclick="pick('industry',this)">Professional Services</div>
        <div class="opt" onclick="pick('industry',this)">Technology / SaaS</div>
        <div class="opt" onclick="pick('industry',this)">Agency / Creative</div>
        <div class="opt" onclick="pick('industry',this)">Healthcare / Wellness</div>
        <div class="opt" onclick="pick('industry',this)">Finance / Legal</div>
        <div class="opt" onclick="pick('industry',this)">Real Estate</div>
        <div class="opt" onclick="pick('industry',this)">Retail / E-commerce</div>
        <div class="opt" onclick="pick('industry',this)">Other</div>
      </div>
      <div class="err-msg" id="err-industry">Please select your industry.</div>
      <div class="q-nav">
        <button class="btn-back" onclick="goBack(2)">← Back</button>
        <button class="btn-next" onclick="goNext(2)">Continue →</button>
      </div>
    </div>

    <!-- Q3: Primary concern -->
    <div class="q" id="q3">
      <div class="q-label">Question 3 of 4</div>
      <div class="q-title">What's your biggest concern with your current site?</div>
      <div class="q-sub">Pick the one that stings the most.</div>
      <div class="btn-grid cols-2" id="concern-grid">
        <div class="opt" onclick="pick('concern',this)">Unclear messaging / positioning</div>
        <div class="opt" onclick="pick('concern',this)">Weak lead generation</div>
        <div class="opt" onclick="pick('concern',this)">Poor design / outdated look</div>
        <div class="opt" onclick="pick('concern',this)">Low traffic / not found on Google</div>
        <div class="opt" onclick="pick('concern',this)">Not converting visitors to inquiries</div>
        <div class="opt" onclick="pick('concern',this)">I don't know</div>
      </div>
      <div class="err-msg" id="err-concern">Please make a selection.</div>
      <div class="q-nav">
        <button class="btn-back" onclick="goBack(3)">← Back</button>
        <button class="btn-next" onclick="goNext(3)">Continue →</button>
      </div>
    </div>

    <!-- Q4: Name + Email -->
    <div class="q" id="q4">
      <div class="q-label">Question 4 of 4</div>
      <div class="q-title">Where should we send your report?</div>
      <div class="q-sub">Your preview appears immediately. The full report lands in your inbox.</div>
      <div class="input-row">
        <div>
          <input class="text-input" type="text" id="name" placeholder="Your name" autocomplete="name">
          <div class="err-msg" id="err-name">Please enter your name.</div>
        </div>
        <div>
          <input class="text-input" type="email" id="email" placeholder="you@company.com" autocomplete="email">
          <div class="err-msg" id="err-email">Please enter a valid email.</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">No spam. No sales calls. Just your report.</div>
      <div class="q-nav">
        <button class="btn-back" onclick="goBack(4)">← Back</button>
        <button class="btn-next" onclick="submitForm()" id="submitBtn">Get My Report →</button>
      </div>
    </div>

    <!-- Preview -->
    <div class="preview" id="preview"></div>

  </div><!-- /form-box -->
</div><!-- /overlay -->

<!-- LOADING -->
<div class="loading" id="loading">
  <div class="spin"></div>
  <div class="load-title">Analyzing your website…</div>
  <div class="load-sub">Our AI advisor is reviewing your site across 8 strategic categories.</div>
  <div class="load-steps">
    <div class="ls" id="ls1"><div class="ls-dot"></div>Reading your website</div>
    <div class="ls" id="ls2"><div class="ls-dot"></div>Scoring brand clarity & positioning</div>
    <div class="ls" id="ls3"><div class="ls-dot"></div>Evaluating credibility & conversion</div>
    <div class="ls" id="ls4"><div class="ls-dot"></div>Writing strategic recommendations</div>
    <div class="ls" id="ls5"><div class="ls-dot"></div>Preparing your report</div>
  </div>
</div>

<script>
const TOTAL = 4;
const state = { industry:'', concern:'' };
let current = 1;

// Build dots
(function(){
  const d = document.getElementById('dots');
  for(let i=1;i<=TOTAL;i++){
    const s = document.createElement('div');
    s.className = 'dot' + (i===1?' active':'');
    s.id = 'dot'+i;
    d.appendChild(s);
  }
})();

function openForm(){
  document.getElementById('overlay').classList.add('open');
  document.body.style.overflow='hidden';
}
function closeForm(){
  document.getElementById('overlay').classList.remove('open');
  document.body.style.overflow='';
}

function showQ(n){
  document.querySelectorAll('.q').forEach(q=>q.classList.remove('visible'));
  const q = document.getElementById('q'+n);
  if(q) q.classList.add('visible');
  // dots
  for(let i=1;i<=TOTAL;i++){
    const d=document.getElementById('dot'+i);
    d.className='dot'+(i<n?' done':i===n?' active':'');
  }
  current=n;
  document.getElementById('formBox').scrollTop=0;
  document.getElementById('overlay').scrollTop=0;
}

function pick(key, el){
  el.closest('.btn-grid').querySelectorAll('.opt').forEach(o=>o.classList.remove('sel'));
  el.classList.add('sel');
  state[key]=el.textContent.trim();
}

function multiPick(key, el, max){
  const isSelected = el.classList.contains('multi-sel');
  if(isSelected){
    el.classList.remove('multi-sel');
    state[key]=state[key].filter(v=>v!==el.textContent.trim());
  } else {
    if(state[key].length>=max) return;
    el.classList.add('multi-sel');
    if(!Array.isArray(state[key])) state[key]=[];
    state[key].push(el.textContent.trim());
  }
}

function showErr(id,show){ document.getElementById(id)?.classList.toggle('show',show); }
function markErr(id,err){ document.getElementById(id)?.classList.toggle('err',err); }

function validate(n){
  let ok=true;
  if(n===1){
    let url=document.getElementById('website_url').value.trim();
    if(!url){ok=false;showErr('err-url',true);markErr('website_url',true);}
    else{showErr('err-url',false);markErr('website_url',false);}
  }
  if(n===2){
    if(!state.industry){ok=false;showErr('err-industry',true);}
    else showErr('err-industry',false);
  }
  if(n===3){
    if(!state.concern){ok=false;showErr('err-concern',true);}
    else showErr('err-concern',false);
  }
  if(n===4){
    const name=document.getElementById('name').value.trim();
    const email=document.getElementById('email').value.trim();
    if(!name){ok=false;showErr('err-name',true);markErr('name',true);}
    else{showErr('err-name',false);markErr('name',false);}
    if(!email||!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)){
      ok=false;showErr('err-email',true);markErr('email',true);
    } else{showErr('err-email',false);markErr('email',false);}
  }
  return ok;
}

function goNext(n){
  if(!validate(n)) return;
  if(n<TOTAL) showQ(n+1);
}
function goBack(n){ if(n>1) showQ(n-1); }

function animateLoading(){
  const steps=[1,2,3,4,5];
  let i=0;
  function next(){
    if(i>0) document.getElementById('ls'+steps[i-1]).classList.replace('on','done');
    if(i<steps.length){ document.getElementById('ls'+steps[i]).classList.add('on'); i++; setTimeout(next,7000); }
  }
  next();
}

async function submitForm(){
  if(!validate(4)) return;
  const url = document.getElementById('website_url').value.trim();
  const payload = {
    website_url: url,
    name: document.getElementById('name').value.trim(),
    email: document.getElementById('email').value.trim(),
    industry: state.industry,
    concern: state.concern
  };

  document.getElementById('loading').classList.add('show');
  animateLoading();

  try{
    const res = await fetch('/WebsiteCritique/api/analyze',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    document.getElementById('loading').classList.remove('show');
    if(!res.ok||!data.success) throw new Error(data.error||'Unknown error');
    renderPreview(data.report, payload.email, data.report_id);
  } catch(e){
    document.getElementById('loading').classList.remove('show');
    alert('Something went wrong: '+e.message+'. Please try again.');
  }
}

function gradeClass(g){ return 'g-'+(g||'').replace(/ /g,'-'); }
function badgeTF(tf){
  const map={'This week':'badge-TW','This month':'badge-TM','This quarter':'badge-TQ'};
  return map[tf]||'badge-TQ';
}

function renderPreview(r, email, id){
  // Hide form, show preview
  document.querySelectorAll('.q').forEach(q=>q.classList.remove('visible'));
  document.getElementById('dots').style.display='none';

  const scores = r.scores||{};
  const cats = [
    ['Brand Clarity','brand_clarity'],['Positioning','strategic_positioning'],
    ['Commercial','commercial_readiness'],['Credibility','executive_credibility'],
    ['Emotional','emotional_impact'],['UX','user_experience'],
    ['Conversion','conversion_readiness'],['Potential','overall_potential']
  ];
  const scoreGrid = cats.map(([label,key])=>{
    const s=scores[key]; if(!s) return '';
    return \`<div class="sc">
      <div class="sc-cat">\${label}</div>
      <div class="sc-val">\${s.score}<small>/10</small></div>
      <div class="sc-grade \${gradeClass(s.grade)}">\${s.grade||''}</div>
    </div>\`;
  }).join('');

  const strengths = (r.top_strengths||[]).map(s=>\`
    <div class="pcard strength">
      <div class="pcard-title">\${s.title}</div>
      <div class="pcard-detail">\${s.detail}</div>
    </div>\`).join('');

  const weaknesses = (r.top_weaknesses||[]).map(w=>\`
    <div class="pcard weakness">
      <div class="pcard-title">\${w.title}<span class="badge badge-\${w.severity[0]}">\${w.severity}</span></div>
      <div class="pcard-detail">\${w.detail}</div>
    </div>\`).join('');

  const recs = (r.top_recommendations||[]).map(rec=>\`
    <div class="pcard rec">
      <div class="pcard-title">\${rec.action}<span class="badge \${badgeTF(rec.timeframe)}">\${rec.timeframe}</span></div>
    </div>\`).join('');

  const siteUrl = window.location.origin;
  const html = \`
    <div style="text-align:center;margin-bottom:32px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);margin-bottom:10px">Your Executive Review</div>
      <div style="font-size:26px;font-weight:700;color:var(--white)">\${r.business_name||r.website_url}</div>
    </div>
    <div class="preview-hero">
      <div class="big-score">\${r.composite_score}<span class="score-denom">/80</span></div>
      <div class="score-label">Composite Score</div>
      <div class="class-badge">\${r.maturity_classification}</div>
    </div>
    <div class="score-grid">\${scoreGrid}</div>
    <div class="pv-section">
      <h3>Strategic Overview</h3>
      <p class="pv-para">\${r.executive_summary}</p>
    </div>
    <div class="pv-section">
      <h3>Top Strengths</h3>
      <div class="card-list">\${strengths}</div>
    </div>
    <div class="pv-section">
      <h3>What to Fix</h3>
      <div class="card-list">\${weaknesses}</div>
    </div>
    <div class="pv-section">
      <h3>Prioritized Actions</h3>
      <div class="card-list">\${recs}</div>
    </div>
    \${r.the_one_thing?\`<div class="one-thing"><div class="ot-label">The Single Most Important Action</div><div class="ot-text">\${r.the_one_thing}</div></div>\`:''}
    <div class="email-box">
      <h3>📧 Full report sent to \${email}</h3>
      <p>The complete executive report — all 8 categories scored in detail, competitive positioning analysis, growth opportunities, and strategic outlook — is on its way to your inbox.<br><br>Don't see it? Check spam. Add hello@modernconsultinggroup.com to contacts.</p>
      <a href="mailto:hello@modernconsultinggroup.com?subject=Follow up on my Website Review" class="btn-session">Book a Strategy Session →</a>
    </div>
  \`;

  const prev = document.getElementById('preview');
  prev.innerHTML = html;
  prev.classList.add('show');
  document.getElementById('overlay').scrollTop = 0;
}
</script>
</body>
</html>`;
}

// ── Full report page ──────────────────────────────────────────────────────────
function reportPageHTML(row, r) {
  const scores = r.scores || {};
  const evidence = r.evidence_summary || row.evidence_summary || {};
  const cats = [
    ['Brand Clarity','brand_clarity'],['Strategic Positioning','strategic_positioning'],
    ['Commercial Readiness','commercial_readiness'],['Executive Credibility','executive_credibility'],
    ['Emotional Impact','emotional_impact'],['User Experience','user_experience'],
    ['Conversion Readiness','conversion_readiness'],['Overall Potential','overall_potential']
  ];
  const scoreRows = cats.map(([label,key]) => {
    const s = scores[key]; if (!s) return '';
    return `<tr>
      <td style="padding:12px 0;border-bottom:1px solid #1e1e1e;font-size:14px;color:#999">${label}</td>
      <td style="padding:12px 0;border-bottom:1px solid #1e1e1e;font-size:18px;font-weight:700;color:#fff;text-align:right">${s.score}<span style="font-size:11px;color:#555">/10</span></td>
      <td style="padding:12px 0;border-bottom:1px solid #1e1e1e;font-size:11px;color:#c9a96e;text-align:right">${s.grade}</td>
    </tr>`;
  }).join('');
  const evidenceWarnings = (evidence.warnings || []).map(w => `<li>${w}</li>`).join('');
  const evidenceCtas = (evidence.observed_ctas || []).map(cta => `<li>${cta}</li>`).join('');
  const evidencePaths = (evidence.observed_conversion_paths || []).map(path => `<li>${path}</li>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Executive Review — ${r.business_name || row.website_url}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,sans-serif;background:#090909;color:#e2e2e2;line-height:1.6}
.wrap{max-width:780px;margin:0 auto;padding:60px 32px}
h1{font-size:32px;font-weight:800;color:#fff;margin-bottom:8px;letter-spacing:-.02em}
h2{font-size:22px;font-weight:700;color:#fff;margin:44px 0 14px}
p{font-size:14px;color:#888;line-height:1.7;margin-bottom:10px}
table{width:100%;border-collapse:collapse}
.tag{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#c9a96e;margin-bottom:8px}
.divider{border:none;border-top:1px solid #1e1e1e;margin:40px 0}
.card{background:#161616;border:1px solid #1e1e1e;border-radius:10px;padding:20px;margin-bottom:12px}
.card.s{border-left:3px solid #52b788}
.card.w{border-left:3px solid #f0a500}
.card-t{font-size:15px;font-weight:600;color:#fff;margin-bottom:5px}
.card-d{font-size:13px;color:#888;line-height:1.55}
.card-fix{font-size:13px;color:#c9a96e;margin-top:8px}
.badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px}
.bH{background:rgba(224,82,82,.15);color:#e05252}
.bM{background:rgba(240,165,0,.15);color:#f0a500}
.bL{background:rgba(82,183,136,.15);color:#52b788}
.ot{background:rgba(201,169,110,.08);border:1px solid rgba(201,169,110,.25);border-radius:10px;padding:28px;text-align:center;margin:32px 0}
.ot-l{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#c9a96e;margin-bottom:10px}
.ot-t{font-size:18px;font-weight:600;color:#fff;line-height:1.4}
.evidence-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}
.mini{background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:14px}
.mini-k{font-size:10px;font-weight:700;letter-spacing:.08em;color:#555;text-transform:uppercase;margin-bottom:4px}
.mini-v{font-size:14px;font-weight:600;color:#fff}
ul.evidence{margin:8px 0 0 18px;color:#888;font-size:13px;line-height:1.6}
</style>
</head>
<body>
<div class="wrap">
  <div class="tag">Executive Website &amp; Positioning Review</div>
  <h1>${r.business_name || row.website_url}</h1>
  <p style="color:#555;font-size:13px">${row.website_url} · Reviewed ${new Date(row.created_at).toLocaleDateString('en-CA')} · Modern Consulting Group</p>

  <div style="display:flex;gap:20px;margin:32px 0;flex-wrap:wrap">
    <div style="background:#161616;border:1px solid #1e1e1e;border-radius:10px;padding:24px;text-align:center;flex:0 0 auto">
      <div style="font-size:52px;font-weight:800;color:#c9a96e">${r.composite_score}<span style="font-size:22px;color:#444">/80</span></div>
      <div style="font-size:12px;color:#555;margin-top:4px">Composite Score</div>
    </div>
    <div style="background:#161616;border:1px solid #c9a96e;border-radius:10px;padding:24px;flex:1;min-width:220px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:#c9a96e;margin-bottom:6px">BUSINESS MATURITY</div>
      <div style="font-size:20px;font-weight:700;color:#fff;margin-bottom:8px">${r.maturity_classification}</div>
      <div style="font-size:13px;color:#888">${r.strategic_outlook || ''}</div>
    </div>
  </div>

  <hr class="divider">
  <div class="tag">Strategic Overview</div>
  <p style="color:#ccc;font-size:15px">${r.executive_summary}</p>

  <hr class="divider">
  <div class="tag">Score Breakdown</div>
  <table>${scoreRows}</table>

  <hr class="divider">
  <div class="tag">Evidence Coverage</div>
  <div class="evidence-grid">
    <div class="mini"><div class="mini-k">Extraction Mode</div><div class="mini-v">${evidence.extraction_mode || 'unknown'}</div></div>
    <div class="mini"><div class="mini-k">Confidence</div><div class="mini-v">${evidence.confidence || 'unknown'}</div></div>
  </div>
  ${evidenceCtas ? `<p style="color:#ccc;font-size:14px;margin-top:14px">Observed CTAs</p><ul class="evidence">${evidenceCtas}</ul>` : '<p>No CTA evidence was observed in the extracted content.</p>'}
  ${evidencePaths ? `<p style="color:#ccc;font-size:14px;margin-top:14px">Observed Conversion Paths</p><ul class="evidence">${evidencePaths}</ul>` : ''}
  ${evidenceWarnings ? `<p style="color:#ccc;font-size:14px;margin-top:14px">Extraction Warnings</p><ul class="evidence">${evidenceWarnings}</ul>` : ''}

  <hr class="divider">
  <div class="tag">Top Strengths</div>
  ${(r.top_strengths||[]).map(s=>`<div class="card s"><div class="card-t">${s.title}</div><div class="card-d">${s.detail}</div></div>`).join('')}

  <hr class="divider">
  <div class="tag">What to Fix</div>
  ${(r.top_weaknesses||[]).map(w=>`<div class="card w">
    <div class="card-t" style="display:flex;justify-content:space-between">${w.title}<span class="badge b${w.severity[0]}">${w.severity}</span></div>
    <div class="card-d">${w.detail}</div>
    ${w.fix?`<div class="card-fix">→ ${w.fix}</div>`:''}
  </div>`).join('')}

  <hr class="divider">
  <div class="tag">Prioritized Actions</div>
  ${(r.top_recommendations||[]).map(rec=>`<div class="card" style="border-left:3px solid #c9a96e">
    <div class="card-t" style="display:flex;justify-content:space-between">${rec.action}<span style="font-size:11px;color:#c9a96e;font-weight:600">${rec.timeframe}</span></div>
  </div>`).join('')}

  ${r.the_one_thing?`<div class="ot"><div class="ot-l">The Single Most Important Action</div><div class="ot-t">${r.the_one_thing}</div></div>`:''}

  <hr class="divider">
  <div style="text-align:center;padding:32px 0">
    <p style="font-size:13px;color:#555;margin-bottom:16px">Prepared by Modern Consulting Group · Toronto, Canada</p>
    <a href="mailto:hello@modernconsultinggroup.com?subject=Follow up on my Website Review" style="display:inline-block;background:#c9a96e;color:#000;padding:14px 28px;border-radius:8px;font-size:14px;font-weight:700;text-decoration:none">Book a Strategy Session →</a>
  </div>
</div>
</body>
</html>`;
}

// ── Email template ────────────────────────────────────────────────────────────
function buildEmailHTML(toName, url, r, id, siteUrl) {
  const scores = r.scores || {};
  const scoreRows = Object.entries({
    'Brand Clarity': scores.brand_clarity?.score,
    'Strategic Positioning': scores.strategic_positioning?.score,
    'Commercial Readiness': scores.commercial_readiness?.score,
    'Executive Credibility': scores.executive_credibility?.score,
    'Conversion Readiness': scores.conversion_readiness?.score,
    'Overall Potential': scores.overall_potential?.score
  }).filter(([,v]) => v != null).map(([cat,val]) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #1e1e1e;font-size:13px;color:#999;font-family:Arial">${cat}</td><td style="padding:8px 0;border-bottom:1px solid #1e1e1e;font-size:16px;font-weight:700;color:#fff;text-align:right;font-family:Arial">${val}/10</td></tr>`
  ).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#090909;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:40px 24px">
  <div style="text-align:center;padding:36px;background:#161616;border:1px solid #1e1e1e;border-radius:10px;margin-bottom:20px">
    <div style="font-size:10px;font-weight:700;letter-spacing:.14em;color:#c9a96e;margin-bottom:10px;text-transform:uppercase">Executive Website Review</div>
    <div style="font-size:26px;font-weight:700;color:#fff;margin-bottom:4px">${r.business_name || url}</div>
    <div style="font-size:13px;color:#555">${url}</div>
    <div style="font-size:60px;font-weight:800;color:#c9a96e;margin:20px 0 4px">${r.composite_score}<span style="font-size:24px;color:#444">/80</span></div>
    <div style="display:inline-block;background:rgba(201,169,110,.1);border:1px solid rgba(201,169,110,.25);color:#c9a96e;font-size:11px;font-weight:700;padding:5px 14px;border-radius:100px;letter-spacing:.08em">${r.maturity_classification}</div>
  </div>
  <div style="background:#161616;border:1px solid #1e1e1e;border-radius:10px;padding:24px;margin-bottom:20px">
    <div style="font-size:10px;font-weight:700;letter-spacing:.14em;color:#c9a96e;margin-bottom:14px;text-transform:uppercase">Strategic Overview</div>
    <p style="font-size:14px;color:#aaa;line-height:1.7;margin:0">${r.executive_summary}</p>
  </div>
  <div style="background:#161616;border:1px solid #1e1e1e;border-radius:10px;padding:24px;margin-bottom:20px">
    <div style="font-size:10px;font-weight:700;letter-spacing:.14em;color:#c9a96e;margin-bottom:14px;text-transform:uppercase">Scores</div>
    <table style="width:100%;border-collapse:collapse">${scoreRows}</table>
  </div>
  ${r.the_one_thing?`<div style="background:rgba(201,169,110,.07);border:1px solid rgba(201,169,110,.25);border-radius:10px;padding:24px;margin-bottom:20px;text-align:center">
    <div style="font-size:10px;font-weight:700;letter-spacing:.14em;color:#c9a96e;margin-bottom:10px;text-transform:uppercase">The Single Most Important Action</div>
    <div style="font-size:16px;font-weight:600;color:#fff;line-height:1.4">${r.the_one_thing}</div>
  </div>`:''}
  <div style="text-align:center;margin-bottom:20px">
    <a href="${siteUrl}/WebsiteCritique/report/${id}" style="display:inline-block;background:#c9a96e;color:#000;padding:14px 28px;border-radius:8px;font-size:14px;font-weight:700;text-decoration:none">View Full Report Online →</a>
  </div>
  <div style="text-align:center;padding-top:20px;border-top:1px solid #1e1e1e">
    <p style="font-size:12px;color:#444;margin:0">Modern Consulting Group · Toronto · <a href="https://modernconsultinggroup.com" style="color:#666;text-decoration:none">modernconsultinggroup.com</a></p>
  </div>
</div>
</body></html>`;
}

module.exports = {
  app,
  fetchWebsiteEvidence,
  generateReport,
  buildPrompt,
  stripHTML,
  applyEvidenceGuardrails,
  normalizeEvidenceForPrompt
};
