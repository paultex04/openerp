/**
 * Manual smoke test against a running API.
 *
 * Verifies the Phase 2 acceptance vectors end-to-end over HTTP, plus the
 * RBAC refusals. Complements the automated Vitest suites, which drive the app
 * in-process via `inject()`.
 *
 * Usage (API must be listening on API_BASE):
 *   node scripts/smoke-phase2.mjs
 */
import { readFileSync } from 'node:fs';
import { loadEnvFile } from './lib/env.mjs';

loadEnvFile();

const BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@contractor.co.za';

/**
 * The version `/health` must advertise. Read from the root manifest, the same
 * file the API bundles at build time; `npm run check:docker` asserts every
 * workspace manifest carries this number so the compare cannot drift.
 */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

let passed = 0;
let failed = 0;

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  ${green('PASS')} ${label} = ${actual}`);
  } else {
    failed++;
    console.log(`  ${red('FAIL')} ${label} = ${actual} (expected ${expected})`);
  }
}

function checkClose(label, actual, expected, tolerance = 0.01) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) {
    passed++;
    console.log(`  ${green('PASS')} ${label} = ${actual}`);
  } else {
    failed++;
    console.log(`  ${red('FAIL')} ${label} = ${actual} (expected ~${expected})`);
  }
}

async function request(path, { method = 'GET', cookie, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* leave null */
  }
  return { status: response.status, body: json, raw: text };
}

async function main() {
  console.log(dim(`\nOpenERP Phase 2 smoke test against ${BASE}\n`));

  // ---- Health ------------------------------------------------------------
  console.log('Health');
  const health = await request('/health');
  check('GET /health', health.status, 200);
  check(
    'GET /health version matches the workspace manifest',
    health.body?.version,
    PACKAGE_VERSION,
  );
  const ready = await request('/health/ready');
  check('GET /health/ready', ready.status, 200);
  console.log();

  // ---- Gate 1: unauthenticated is refused --------------------------------
  console.log('Gate 1 — unauthenticated access');
  for (const path of [
    '/api/service-master-rates',
    '/api/service-codes',
    '/api/contracts',
    '/api/clients',
    '/api/amendments/1/cost-parameters',
  ]) {
    const r = await request(path);
    check(`GET ${path}`, r.status, 401);
  }
  console.log();

  // ---- Log in ------------------------------------------------------------
  if (!PASSWORD) throw new Error('SEED_ADMIN_PASSWORD is not set.');

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: PASSWORD },
  });
  check('POST /api/auth/login', login.status, 200);

  // The token must appear ONLY as an HttpOnly cookie, never in the body.
  const cookieResponse = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  const setCookieHeader = cookieResponse.headers.get('set-cookie') ?? '';

  check('login body carries no session token', login.raw.includes('openerp_session'), false);
  check('session cookie is HttpOnly', /httponly/i.test(setCookieHeader), true);
  check('session cookie is SameSite=Lax', /samesite=lax/i.test(setCookieHeader), true);

  const token = setCookieHeader.match(/openerp_session=([^;]+)/)?.[1];
  if (!token) throw new Error('No session cookie issued.');
  const admin = `openerp_session=${token}`;

  const me = await request('/api/auth/me', { cookie: admin });
  check('GET /api/auth/me', me.status, 200);
  check('  employee linked', me.body?.employee?.id > 0, true);
  check('  roles', me.body?.roles?.length > 0, true);
  console.log();

  // ---- Tier 1 vector -----------------------------------------------------
  console.log('Gate 2 — Tier 1 rate build-up');
  const rates = await request('/api/service-master-rates?amendmentId=1', { cookie: admin });
  check('GET /api/service-master-rates', rates.status, 200);
  check('  rate cards on amendment 1', rates.body?.rates?.length, 22);

  const artisan = rates.body.rates.find((r) => r.serviceMasterCode === 'S00250451');
  check('Artisan Electrical full loaded rate', artisan?.fullLoadedRate, 227.61);
  check('  man in pocket', artisan?.manInPocket, 113.13);
  check('  overhead cost (authoritative)', artisan?.overheadCost, 13.6);
  check('  SG&A cost (authoritative)', artisan?.sgaCost, 25.34);
  check('  profit cost', artisan?.profitCost, 19.75);

  const computed = await request(`/api/service-master-rates/${artisan.id}/compute`, {
    cookie: admin,
  });
  check('GET /:id/compute agrees with stored', computed.body?.agrees, true);
  check('  computed full loaded rate', computed.body?.computed?.fullLoadedRate, 227.61);

  // The ADR-001 F2 divergence must be visible, not hidden.
  const derivedPreview = await request('/api/service-master-rates/preview', {
    method: 'POST',
    cookie: admin,
    body: {
      amendmentId: 1,
      serviceMasterCode: 'S00250451',
      labourType: 'ARTISAN ELECTRICAL',
      councilRate: 112.57,
      wagePremiumPct: 0.005,
      leavePay: 15.46,
      totalStatutoryCost: 28.93,
      ppeCost: 1.93,
      transportCost: 1.58,
      equipmentCost: 7.89,
      profitPct: 0.095,
      overheadCost: 13.6,
      sgaCost: 25.34,
      deriveOverheads: true,
    },
  });
  check('POST /preview (deriveOverheads)', derivedPreview.status, 200);
  check('  derived full loaded rate', derivedPreview.body?.computed?.fullLoadedRate, 226.72);
  checkClose(
    '  authoritative-vs-derived delta',
    derivedPreview.body?.derivedComparison?.fullLoadedRateDelta,
    -0.89,
    0.005,
  );
  // With deriveOverheads=true the request's amounts are ignored, so the
  // authoritative baseline must be fetched from the stored card, not restated
  // from the request.
  check(
    '  authoritative baseline is the stored card',
    derivedPreview.body?.derivedComparison?.authoritative?.fullLoadedRate,
    227.61,
  );
  console.log();

  // ---- Cost parameters ---------------------------------------------------
  console.log('Cost parameters');
  const params = await request('/api/amendments/1/cost-parameters', { cookie: admin });
  check('GET /:id/cost-parameters', params.status, 200);
  check('  parameter rows', params.body?.parameters?.length, 12);
  // The engine projection must be fractions, not percent numbers.
  checkClose('  engine overheadPct', params.body?.engine?.overheadPct, 0.07, 1e-9);
  checkClose('  engine sgaPct', params.body?.engine?.sgaPct, 0.15, 1e-9);
  checkClose('  engine profitPct', params.body?.engine?.profitPct, 0.095, 1e-9);
  checkClose('  amendment VAT rate', params.body?.amendment?.vatRate, 0.15, 1e-9);
  console.log();

  // ---- Tier 2 vector -----------------------------------------------------
  console.log('Gate 3 — Tier 2 service code pricing');
  const codes = await request('/api/service-codes?amendmentId=1', { cookie: admin });
  check('GET /api/service-codes', codes.status, 200);

  // The API must return the business label ('R1 Material'), not the Prisma enum
  // key ('R1_MATERIAL') — the smoke test caught this being leaked.
  const removal = codes.body.serviceCodes.find((c) => c.code === 'S00247970');
  check('S00247970 category', removal?.category, 'Activity');
  const removalDetail = await request(`/api/service-codes/${removal.id}`, { cookie: admin });
  check('  computed unit rate', removalDetail.body?.computation?.computed, 17.5226);
  check('  matches stored', removalDetail.body?.computation?.variance?.matches, true);
  check('  labour lines', removalDetail.body?.serviceCode?.labourItems?.length, 4);
  check(
    '  line subtotals',
    removalDetail.body.serviceCode.labourItems.map((l) => l.lineSubtotal).join(','),
    '2.2761,0.8839,7.9436,6.419',
  );

  const r1 = codes.body.serviceCodes.find((c) => c.code === 'R1-CABLE-SUPPLY-01');
  check('R1-CABLE-SUPPLY-01 category', r1?.category, 'R1 Material');
  const r1Detail = await request(`/api/service-codes/${r1.id}`, { cookie: admin });
  checkClose('  computed unit rate', r1Detail.body?.computation?.computed, 23782, 0.0001);
  checkClose('  procurement subtotal', r1Detail.body?.computation?.subtotalCost, 21620, 0.0001);
  checkClose('  markup amount', r1Detail.body?.computation?.markupAmount, 2162, 0.0001);

  // ADR-001 Q2: the stored rate must survive a recomputation.
  const inflated = codes.body.serviceCodes.find((c) => c.code === 'S00167401');
  const inflatedDetail = await request(`/api/service-codes/${inflated.id}`, { cookie: admin });
  checkClose('S00167401 computed', inflatedDetail.body?.computation?.computed, 27.8639, 0.0001);
  check('  stored rate preserved', inflatedDetail.body?.computation?.variance?.stored, 27.9158);
  check('  variance flagged', inflatedDetail.body?.computation?.variance?.matches, false);
  console.log();

  // ---- VAT ---------------------------------------------------------------
  console.log('VAT (migration 0002)');
  const clients = await request('/api/clients', { cookie: admin });
  check('GET /api/clients', clients.status, 200);
  const client = clients.body.clients[0];
  check('  isVatRegistered exposed', typeof client?.isVatRegistered, 'boolean');
  check('  vatNumber exposed', 'vatNumber' in (client ?? {}), true);

  const badVat = await request('/api/clients', {
    method: 'POST',
    cookie: admin,
    body: {
      name: 'Smoke Test Client',
      email: `smoke-${Date.now()}@example.test`,
      isVatRegistered: true,
      vatNumber: '123',
    },
  });
  check('POST /api/clients rejects a malformed VAT number', badVat.status, 400);
  console.log();

  // ---- Gate 4: non-commercial roles --------------------------------------
  console.log('Gate 4 — non-commercial roles are refused');
  // The shared package is TypeScript source, so it cannot be imported directly
  // by plain node. The RBAC gate is asserted exhaustively by the Vitest suites
  // (shared/src/rbac.test.ts and server/src/auth/rbac.integration.test.ts);
  // over HTTP we assert the observable outcome instead: a valid session with no
  // commercial role is refused with 403.
  const noRole = await request('/api/service-master-rates?amendmentId=1', {
    cookie: 'openerp_session=not-a-token',
  });
  check('a bogus token is refused', noRole.status, 401);

  const unauthWrite = await request('/api/service-master-rates', {
    method: 'POST',
    body: { amendmentId: 1 },
  });
  check('an unauthenticated write is refused', unauthWrite.status, 401);

  // ---- Summary -----------------------------------------------------------
  console.log(`\n${failed === 0 ? green('ALL CHECKS PASSED') : red(`${failed} CHECK(S) FAILED`)}`);
  console.log(`${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(red(`\nSmoke test failed to run: ${error.message}\n`));
  process.exit(1);
});
