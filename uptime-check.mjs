#!/usr/bin/env node
// Promtable uptime + Workers error-rate probe. No dependencies; Node >= 20.
// Env: CLOUDFLARE_ANALYTICS_TOKEN (optional, Account Analytics Read), REPORT_FILE (optional markdown output).
import { appendFile } from 'node:fs/promises';

const ORIGIN = process.env.PROMTABLE_ORIGIN || 'https://promtable.com';
// Free-plan Bot Fight Mode challenges GitHub's Azure runners on the zone and cannot be skipped, so content checks
// hit the same Worker on workers.dev; promtable.com itself is checked for an edge answer (200 or a BFM challenge).
const APP_ORIGIN = process.env.PROMTABLE_APP_ORIGIN || 'https://promtable-app.onur-vct-20260722.workers.dev';
const ACCOUNT = 'cf3c8df00d5cfd1347dd58230f5933e7';
const SCRIPT = 'promtable-app';
export const EDGE_CHECK = { origin: ORIGIN, path: '/', expect: body => body.includes('Promtable'), allowChallenge: true };
export const CHECKS = [
  { path: '/', expect: body => body.includes('Promtable') },
  { path: '/alternatives/zed', expect: body => body.includes('Zed alternatives') },
  { path: '/advertise', expect: body => body.includes('</html>') },
  { path: '/sitemap.xml', expect: body => body.includes('<sitemapindex') },
  { path: '/api/creem', expect: body => JSON.parse(body).available === true },
];
// Alert when >= MIN_REQUESTS ran in the window and more than MAX_ERROR_RATE of them threw.
export const MIN_REQUESTS = 50, MAX_ERROR_RATE = 0.05, WINDOW_MINUTES = 30;

export function errorRateVerdict(rows) {
  const requests = rows.reduce((sum, row) => sum + (row.sum?.requests || 0), 0);
  const errors = rows.reduce((sum, row) => sum + (row.sum?.errors || 0), 0);
  const rate = requests ? errors / requests : 0;
  return { requests, errors, rate, ok: requests < MIN_REQUESTS || rate <= MAX_ERROR_RATE };
}

export function probeVerdict(status, challenged, matched, allowChallenge) {
  if (status === 200) return matched ? { ok: true, detail: 'HTTP 200' } : { ok: false, detail: 'HTTP 200 (unexpected body)' };
  if (status === 403 && challenged && allowChallenge) return { ok: true, detail: 'HTTP 403 Bot Fight Mode challenge (edge up)' };
  return { ok: false, detail: `HTTP ${status}${challenged ? ' (challenged)' : ''}` };
}

async function probe({ origin = APP_ORIGIN, path, expect, allowChallenge = false }) {
  const started = Date.now();
  const label = origin === APP_ORIGIN ? path : `${new URL(origin).host}${path}`;
  try {
    const res = await fetch(origin + path, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; promtable-uptime/1.0)', Accept: path.startsWith('/api/') ? 'application/json' : 'text/html,application/xml' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    let matched = false;
    try { matched = expect(body); } catch { matched = false; }
    return { label, ...probeVerdict(res.status, res.headers.get('cf-mitigated') === 'challenge', matched, allowChallenge), ms: Date.now() - started };
  } catch (error) {
    return { label, ok: false, detail: error.name === 'TimeoutError' ? 'timeout 15s' : error.message, ms: Date.now() - started };
  }
}

async function workersErrorRate(token) {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60000).toISOString();
  const query = `{viewer{accounts(filter:{accountTag:"${ACCOUNT}"}){workersInvocationsAdaptive(limit:100,filter:{scriptName:"${SCRIPT}",datetime_geq:"${since}"}){sum{requests errors}}}}}`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15000) });
  const json = await res.json();
  if (!res.ok || json.errors?.length) throw new Error(`GraphQL ${res.status} ${json.errors?.[0]?.message || ''}`.trim());
  return errorRateVerdict(json.data.viewer.accounts[0]?.workersInvocationsAdaptive || []);
}

async function main() {
  const all = [EDGE_CHECK, ...CHECKS];
  let results = await Promise.all(all.map(probe));
  if (results.some(r => !r.ok)) {
    // One retry after 20s so a single edge blip does not open an issue.
    await new Promise(resolve => setTimeout(resolve, 20000));
    results = await Promise.all(all.map((check, i) => results[i].ok ? results[i] : probe(check)));
  }
  const lines = results.map(r => `| \`${r.label}\` | ${r.ok ? 'ok' : '**FAIL**'} | ${r.detail} | ${r.ms} ms |`);
  let workersOk = true, workersLine = 'Workers error rate: not checked (no CLOUDFLARE_ANALYTICS_TOKEN).';
  if (process.env.CLOUDFLARE_ANALYTICS_TOKEN) {
    try {
      const v = await workersErrorRate(process.env.CLOUDFLARE_ANALYTICS_TOKEN);
      workersOk = v.ok;
      workersLine = `Workers \`${SCRIPT}\` last ${WINDOW_MINUTES} min: ${v.errors}/${v.requests} errors (${(v.rate * 100).toFixed(2)}%) — ${v.ok ? 'ok' : `**FAIL** (> ${MAX_ERROR_RATE * 100}% with >= ${MIN_REQUESTS} requests)`}`;
    } catch (error) {
      // Analytics API trouble is reported but never pages on its own.
      workersLine = `Workers error rate: unavailable (${error.message}).`;
    }
  }
  const ok = results.every(r => r.ok) && workersOk;
  const report = [`Probe at ${new Date().toISOString()} against ${ORIGIN} (content via ${APP_ORIGIN}): ${ok ? 'all green' : 'FAILING'}`, '', '| URL | Status | Detail | Time |', '|---|---|---|---|', ...lines, '', workersLine].join('\n');
  console.log(report);
  if (process.env.REPORT_FILE) await appendFile(process.env.REPORT_FILE, report + '\n');
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
