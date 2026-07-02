const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  fetchWebsiteEvidence,
  stripHTML,
  applyEvidenceGuardrails
} = require('../server');

function withServer(handler, fn) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        resolve(await fn(`http://127.0.0.1:${port}`));
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test('stripHTML preserves nav and footer CTA text', () => {
  const text = stripHTML(`
    <html>
      <body>
        <nav><a href="/book">Book a Call</a></nav>
        <main><h1>Operator Advisory</h1></main>
        <footer><a href="/strategy">Book a Strategy Session</a></footer>
      </body>
    </html>
  `);

  assert.match(text, /Book a Call/);
  assert.match(text, /Book a Strategy Session/);
});

test('fetchWebsiteEvidence captures CTA evidence from static nav and footer', async () => {
  await withServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`
      <!doctype html>
      <html>
        <head><title>Static CTA Site</title></head>
        <body>
          <nav><a href="/book">Book a Call</a></nav>
          <main><h1>Clear consulting offer</h1><p>We help executives fix technology execution.</p></main>
          <footer><a href="/contact">Contact us</a></footer>
        </body>
      </html>
    `);
  }, async url => {
    const evidence = await fetchWebsiteEvidence(url);
    const observed = evidence.content.ctas.map(cta => cta.text).join(' | ');

    assert.match(observed, /Book a Call/);
    assert.match(observed, /Contact us/);
    assert.notEqual(evidence.extraction.mode, 'failed');
  });
});

test('fetchWebsiteEvidence renders SPA shell before judging CTA presence', async () => {
  await withServer((req, res) => {
    if (req.url === '/assets/app.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end(`
        document.getElementById('root').innerHTML = [
          '<header><a href="/book">Book a Call</a></header>',
          '<main><h1>Modern Consulting Group</h1><p>Executive technology strategy.</p><button>Book a 15-Minute Call</button></main>',
          '<footer><a href="/strategy">Book a Strategy Call</a></footer>'
        ].join('');
      `);
      return;
    }

    res.setHeader('content-type', 'text/html');
    res.end(`
      <!doctype html>
      <html>
        <head><title>SPA CTA Site</title></head>
        <body>
          <div id="root"></div>
          <script type="module" src="/assets/app.js"></script>
        </body>
      </html>
    `);
  }, async url => {
    const evidence = await fetchWebsiteEvidence(url);
    const observed = evidence.content.ctas.map(cta => cta.text).join(' | ');

    assert.equal(evidence.extraction.mode, 'rendered');
    assert.match(observed, /Book a Call/);
    assert.match(observed, /Book a 15-Minute Call/);
    assert.match(observed, /Book a Strategy Call/);
  });
});

test('applyEvidenceGuardrails rewrites absolute missing-CTA claims when CTAs are observed', () => {
  const report = applyEvidenceGuardrails({
    executive_summary: 'The site needs work.',
    top_weaknesses: [{
      title: 'No Conversion Path or Lead Mechanism',
      severity: 'High',
      detail: 'There is no visible call-to-action that moves a visitor toward a conversation.',
      fix: 'Install a booking CTA.'
    }]
  }, {
    extraction: { mode: 'rendered', confidence: 'high', warnings: [] },
    content: {
      ctas: [{ text: 'Book a Call', href: '/book', location: 'header' }],
      forms: []
    }
  });

  assert.equal(report.top_weaknesses[0].title, 'Conversion Path Needs Stronger Qualification');
  assert.match(report.top_weaknesses[0].detail, /Book a Call/);
  assert.deepEqual(report.evidence_summary.observed_ctas, ['Book a Call (header)']);
});

test('fetchWebsiteEvidence marks very thin pages as low confidence', async () => {
  await withServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><head><title>Thin</title></head><body><h1>Thin</h1></body></html>');
  }, async url => {
    const evidence = await fetchWebsiteEvidence(url);

    assert.equal(evidence.extraction.confidence, 'low');
    assert.ok(evidence.extraction.warnings.includes('low_text_coverage'));
  });
});
