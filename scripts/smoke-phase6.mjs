/**
 * Phase 6 smoke test: routing, navigation and RBAC-driven UI surface.
 *
 * WHY THIS IS A SMOKE TEST AND NOT A UNIT TEST
 *
 * The Phase 6 defects were almost entirely invisible to `tsc`, ESLint and Vitest.
 * Five of the six passed every automated gate and were only observable in a
 * browser - a stylesheet that compiled but computed to nothing, components
 * rendering with zero padding, navigation that looked present but pointed
 * nowhere. See ADR-006.
 *
 * This script therefore asserts the things that actually broke, over real HTTP:
 *
 *   - `/` answers with a real 302 and sends the user to the right place. The
 *     distinction matters - a client-side redirect passes a `Location`-header
 *     assertion nowhere, and paints the wrong screen first.
 *   - the authenticated area is unreachable without a cookie, and remembers
 *     where the user was going.
 *   - the permission catalogue that drives the sidebar agrees with what the API
 *     actually grants, for a role on each side of the boundary.
 *
 * It also asserts the *negative* case that a nav tree tends to get wrong: that
 * the roles which cannot see a section really cannot.
 *
 * Usage (API on API_BASE_URL, web client on WEB_BASE_URL - both must be up):
 *   node scripts/smoke-phase6.mjs
 */
import { loadEnvFile } from './lib/env.mjs';

loadEnvFile();

const API = process.env.API_BASE_URL ?? 'http://localhost:4000';
const WEB = process.env.WEB_BASE_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;
/** Demo accounts share one password; see the security note in README. */
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Ops#Field2026x';

let passed = 0;
let failed = 0;

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function check(label, actual, expected, note = '') {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  ${green('PASS')} ${label} = ${actual}`);
  } else {
    failed++;
    console.log(
      `  ${red('FAIL')} ${label} = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}${note ? ` (${note})` : ''}`,
    );
  }
  return ok;
}

function checkThat(label, ok, note = '') {
  return check(label, Boolean(ok), true, note);
}

function section(title) {
  console.log(`\n${dim(`--- ${title} ---`)}`);
}

/**
 * Normalises a `Location` header to a comparable path.
 *
 * Next emits a *relative* Location (`/login?next=%2Fadmin`), not an absolute
 * URL, so comparing against `http://localhost:3000/...` fails against correct
 * behaviour. Resolving against the web origin first keeps the assertions about
 * the destination rather than about how the header happens to be spelled.
 */
function locationPath(location) {
  if (!location) return null;
  return new URL(location, WEB).pathname + new URL(location, WEB).search;
}

/**
 * Follows no redirects and returns only the status and `Location`.
 *
 * `fetch` follows redirects by default, which would hide the very thing being
 * asserted - the 302 itself, and where it points.
 */
async function probe(url, cookie) {
  const response = await fetch(url, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
  return { status: response.status, location: response.headers.get('location') };
}

/** Millisecond sleep; used by the login retry below. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Signs in and returns the raw session cookie, or null on failure.
 *
 * Retries on 429. The API rate-limits the login route, and this script signs in
 * twice (administrator, then supervisor) in the same run. A test that reports
 * "could not sign in" when the real cause is a throttle is worse than useless -
 * it sends you looking for a seeding problem that does not exist.
 */
async function login(email, password, { attempts = 4 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (response.ok) {
      const setCookie = response.headers.get('set-cookie') ?? '';
      const match = new RegExp(`(?:^|,\\s*)(${encodeURIComponent('openerp_session')}=[^;,]+)`).exec(
        setCookie,
      );
      return match ? decodeURIComponent(match[1]) : null;
    }

    if (response.status !== 429 || attempt === attempts) return null;

    const body = await response.text();
    const wait = /retry in (\d+(?:\.\d+)?)\s*seconds?/i.exec(body);
    const waitMs = wait ? Math.ceil(Number(wait[1]) * 1000) + 500 : 15_000;
    console.log(dim(`  rate limited; retrying login in ${Math.round(waitMs / 1000)}s`));
    await sleep(waitMs);
  }
  return null;
}

async function permissionsFor(cookie) {
  const response = await fetch(`${API}/api/auth/me`, { headers: { cookie } });
  if (!response.ok) return null;
  const body = await response.json();
  return {
    email: body.user.email,
    roles: body.roles.map((role) => role.key),
    permissions: new Set(body.permissions),
  };
}

/**
 * The permission each nav entry is gated on, duplicated here on purpose.
 *
 * If this list and `client/src/lib/nav.ts` ever disagree, one of them is wrong
 * and the test below says which. A test that imported the same constant it is
 * asserting against would agree with the bug.
 */
const NAV_GATES = {
  commercial: [
    'contract.read',
    'amendment.read',
    'costparameter.read',
    'ratemaster.read',
    'servicecode.read',
  ],
  operations: ['project.read', 'job.read', 'deliverable.read', 'job.read.assigned'],
  billing: ['invoice.read'],
  administration: ['admin.user.read', 'admin.role.read', 'admin.audit.read'],
};

async function main() {
  console.log(dim(`\nOpenERP Phase 6 smoke test\n  web ${WEB}\n  api ${API}\n`));

  const adminCookie = await login(
    process.env.SEED_ADMIN_EMAIL ?? 'admin@contractor.co.za',
    PASSWORD,
  );
  if (!adminCookie) {
    console.log(
      red('\nCould not sign in as the seeded administrator. Is the API running and seeded?\n'),
    );
    process.exit(1);
  }
  const admin = await permissionsFor(adminCookie);

  // =====================================================================
  section('Gate 1: / is a router, and answers with a real 302');
  // =====================================================================

  const anonRoot = await probe(`${WEB}/`);
  check('GET / without a session -> status', anonRoot.status, 302);
  check('GET / without a session -> Location', locationPath(anonRoot.location), '/login');

  const authRoot = await probe(`${WEB}/`, adminCookie);
  check('GET / with a session -> status', authRoot.status, 302);
  check('GET / with a session -> Location', locationPath(authRoot.location), '/dashboard');

  // The fallback component also redirects, so the root can never render a
  // half-styled or misleading page even if middleware is bypassed.
  checkThat('GET / with a session never returns 200', authRoot.status !== 200);

  // =====================================================================
  section('Gate 2: the authenticated area is closed without a cookie');
  // =====================================================================

  for (const route of ['/dashboard', '/commercial', '/operations', '/billing', '/admin']) {
    const probeResult = await probe(`${WEB}${route}`);
    check(`GET ${route} without a session -> status`, probeResult.status, 302);
    checkThat(
      `GET ${route} without a session -> Location is /login`,
      locationPath(probeResult.location)?.startsWith('/login'),
      probeResult.location ?? 'no Location header',
    );
  }

  // The intended destination is preserved, so signing in resumes the journey.
  const deep = await probe(`${WEB}/admin?tab=audit`);
  checkThat(
    'the intended destination is preserved in ?next=',
    (locationPath(deep.location) ?? '').includes('next=%2Fadmin'),
    deep.location ?? 'no Location header',
  );

  section('Gate 2b: /login does not bounce a signed-in user');
  const loginAuthed = await probe(`${WEB}/login`, adminCookie);
  check('GET /login with a session -> status', loginAuthed.status, 302);
  check('GET /login with a session -> Location', locationPath(loginAuthed.location), '/dashboard');

  section('Gate 2c: /login is reachable without a session');
  const loginAnon = await probe(`${WEB}/login`);
  check('GET /login without a session -> status', loginAnon.status, 200);

  // =====================================================================
  section('Gate 3: static assets are not caught by the auth guard');
  // =====================================================================
  // The matcher is an allow-list for a reason: a stray match turns a missing
  // stylesheet into a redirect to /login and the app renders as bare HTML.

  const cssProbe = await fetch(`${WEB}/login`);
  const html = await cssProbe.text();
  // Every linked stylesheet is read and concatenated. A production build splits
  // CSS across chunks and the first link is not always the app stylesheet (in
  // the Turbopack build it is a small component sheet), while the dev server
  // serves the same CSS from `/_next/static/chunks/` with the authored syntax
  // instead of the minified `/css/` form. Reading a single link made this gate
  // report "0 themes" for whichever mode it was not written for - which read as
  // a UI defect rather than a parsing one.
  const cssHrefs = [
    ...new Set([...html.matchAll(/href="([^"]+\.css[^"]*)"/g)].map((match) => match[1])),
  ];

  // Declared out here so Gate 7 can reuse it; `const` inside the `if` below
  // would not be visible to the later block.
  let cssText = '';

  if (cssHrefs.length) {
    for (const href of cssHrefs) {
      const css = await fetch(`${WEB}${href}`, { redirect: 'manual' });
      check(`stylesheet ${href} -> status`, css.status, 200);
      if (css.status === 200) cssText += await css.text();
    }
    // The Phase 6 defect that made the entire app render unstyled: the utility
    // compiled but resolved to an invalid colour, so nothing was applied. The
    // selector is matched loosely because the minifier groups selectors
    // (`.bg-background,.bg-background\/95{…}`).
    checkThat(
      'bg-background resolves to a usable colour function',
      /\.bg-background[^{}]*\{\s*background-color:\s*var\(--background\)/.test(cssText),
      'expected var(--background), which would be invalid if wrapped in hsl()',
    );
    checkThat(
      'Card padding utilities are generated',
      /\.py-\\\(--card-spacing\\\)/.test(cssText),
      'Tailwind v3 cannot compile --spacing(); this asserts the v4 migration took',
    );
  } else {
    checkThat('a compiled stylesheet is referenced by /login', false, 'no .css link found');
  }

  // =====================================================================
  section('Gate 4: RBAC - an administrator sees every section');
  // =====================================================================

  checkThat('the administrator resolves', admin !== null);
  check('administrator holds the administrator role', admin.roles.includes('administrator'), true);

  for (const [sectionKey, gates] of Object.entries(NAV_GATES)) {
    const visible = gates.some((permission) => admin.permissions.has(permission));
    checkThat(
      `administrator can see "${sectionKey}"`,
      visible,
      `granted by one of: ${gates.join(', ')}`,
    );
  }

  // =====================================================================
  section('Gate 5: RBAC - a site supervisor sees neither Commercial nor Admin');
  // =====================================================================

  // The negative assertions. A nav tree that forgets to hide a section is the
  // failure this gate exists for.
  const supervisorCookie = await login('sipho.z@contractor.co.za', DEMO_PASSWORD);

  if (!supervisorCookie) {
    checkThat('site supervisor can sign in', false, 'demo account missing or password differs');
  } else {
    const supervisor = await permissionsFor(supervisorCookie);
    check('site supervisor role', supervisor.roles.includes('site_supervisor'), true);

    // Derive the conclusion from the *permissions the API granted*, not from a
    // hardcoded role name, so the gate keeps working if the matrix changes.
    const canSee = (sectionKey) =>
      NAV_GATES[sectionKey].some((permission) => supervisor.permissions.has(permission));

    checkThat('site supervisor CANNOT see Commercial', canSee('commercial') === false);
    checkThat('site supervisor CANNOT see Administration', canSee('administration') === false);
    checkThat(
      'site supervisor CANNOT see Billing',
      canSee('billing') === false,
      'billing requires invoice.read',
    );
    checkThat(
      'site supervisor CAN see Operations',
      canSee('operations') === true,
      'expected: job.read.assigned or deliverable.read',
    );

    // And the API must agree with the UI's conclusion. If the sidebar hides
    // something the API would happily serve, the hiding is cosmetic; if the API
    // refuses what the sidebar offers, the nav is lying.
    const forbidden = await fetch(`${API}/api/admin/users`, {
      headers: { cookie: supervisorCookie },
    });
    check('site supervisor GET /api/admin/users', forbidden.status, 403);

    const forbiddenAudit = await fetch(`${API}/api/admin/audit`, {
      headers: { cookie: supervisorCookie },
    });
    check('site supervisor GET /api/admin/audit', forbiddenAudit.status, 403);

    const allowed = await fetch(`${API}/api/jobs`, { headers: { cookie: supervisorCookie } });
    checkThat(
      'site supervisor GET /api/jobs is not refused',
      allowed.status !== 403,
      `status ${allowed.status}`,
    );
  }

  // =====================================================================
  section('Gate 6: a deep link resolves to a screen, not a 404');
  // =====================================================================

  for (const route of [
    '/dashboard',
    '/commercial?tab=contracts',
    '/commercial?tab=parameters',
    '/commercial?tab=rates',
    '/commercial?tab=recipes',
    '/operations?view=dashboard',
    '/operations?view=board',
    '/operations?view=board&status=07.%20Pack%20Ready',
    '/billing',
    '/admin?tab=users',
    '/admin?tab=roles',
    '/admin?tab=audit',
  ]) {
    const result = await probe(`${WEB}${route}`, adminCookie);
    check(`GET ${route} as administrator -> status`, result.status, 200);
  }

  // The Field Measurements & Actuals page was removed in Phase 15: it modelled a
  // workflow (walk the site, key in actuals) this business does not run. Its API
  // endpoints stay; only the screen is gone, and it must stay gone.
  const removedField = await probe(`${WEB}/field`, adminCookie);
  check('GET /field (removed page) as administrator -> status', removedField.status, 404);

  // =====================================================================
  section('Gate 7: the theme catalogue and the stylesheet agree');
  // =====================================================================
  // `client/src/lib/theme.ts` and the `[data-theme='...']` blocks in
  // `globals.css` are two views of one list. A theme added to only one of them
  // is the defect this gate exists to catch: it would render perfectly but be
  // impossible to select, or be selectable and render nothing.

  const themeIdsFromCss = [...cssText.matchAll(/\[data-theme=['"]?([a-z]+)['"]?\]/g)].map(
    (match) => match[1],
  );
  const uniqueCssThemes = [...new Set(themeIdsFromCss)].sort();

  check(
    'stylesheets define five themes',
    uniqueCssThemes.length,
    5,
    `found: ${uniqueCssThemes.join(', ')}`,
  );
  for (const id of ['harbour', 'steel', 'ember', 'verdant', 'midnight']) {
    checkThat(`stylesheet defines the "${id}" theme`, uniqueCssThemes.includes(id));
  }

  // Every theme must actually differ, or "five themes" is five labels over one
  // palette - which is exactly the "the application uses no colour" complaint
  // this feature was written to fix.
  const primaryByTheme = new Map();
  for (const id of uniqueCssThemes) {
    const block = new RegExp(`\\[data-theme=['"]?${id}['"]?\\]\\s*\\{([^}]*)\\}`).exec(cssText);
    const primary = block?.[1]?.match(/--primary:\s*([^;]+);/)?.[1]?.trim();
    if (primary) primaryByTheme.set(id, primary);
  }
  check('every theme declares --primary', primaryByTheme.size, 5);
  check(
    'all five themes use a distinct accent colour',
    new Set(primaryByTheme.values()).size,
    5,
    `accents: ${[...primaryByTheme.entries()].map(([id, c]) => `${id}=${c}`).join(' | ')}`,
  );

  // The accent must be a real colour, not a near-black placeholder. The v1.1.0
  // "no colour" problem was precisely `--primary: oklch(0.205 0 0)`.
  for (const [id, primary] of primaryByTheme) {
    // Production CSS is rewritten to `oklch(…)` by the minifier; the dev server
    // serves the authored hex. Each syntax is measured in its own terms - oklch
    // chroma, or the channel spread of a hex - with a grey failing both.
    // The minifier writes `oklch(55% .16 238)` - a percent lightness and a
    // dotless chroma - where the authored form is `oklch(0.55 0.16 238)`.
    const oklchChroma = Number(primary.match(/oklch\(\s*[\d.]+%?\s+([\d.]+)/)?.[1] ?? NaN);
    const hexSpread = /^#[0-9a-f]{6}$/i.test(primary)
      ? (() => {
          const rgb = Number.parseInt(primary.slice(1), 16);
          const r = (rgb >> 16) & 0xff;
          const g = (rgb >> 8) & 0xff;
          const b = rgb & 0xff;
          return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        })()
      : NaN;
    const chromatic = Number.isNaN(oklchChroma) ? hexSpread >= 0.25 : oklchChroma >= 0.1;
    checkThat(
      `"${id}" has a chromatic primary (not grey)`,
      chromatic,
      Number.isNaN(oklchChroma)
        ? `${primary} -> hex spread ${hexSpread.toFixed(2)}`
        : `${primary} -> oklch chroma ${oklchChroma}`,
    );
  }

  // The status tokens must be present too: job and invoice lifecycle colour is
  // carried by them, and without them the badges fall back to grey.
  for (const token of ['--success', '--warning', '--info', '--positive', '--negative']) {
    checkThat(`stylesheet exposes ${token}`, cssText.includes(`${token}:`));
  }

  // The dark theme must switch the browser's own widget rendering, or it gets
  // light scrollbars and looks half-applied. The check is scoped to the theme's
  // own block; the minified file has both `color-scheme:light` and `:dark`.
  const midnightBlock =
    new RegExp(`\\[data-theme=['"]?midnight['"]?\\]\\s*\\{([^}]*)\\}`).exec(cssText)?.[1] ?? '';
  checkThat('the dark theme sets color-scheme: dark', /color-scheme:\s*dark/.test(midnightBlock));

  // The theme must be applied before first paint, or every navigation flashes
  // the default palette. The bootstrap script has to be inline in the document.
  const loginHtml = await (await fetch(`${WEB}/login`)).text();
  checkThat(
    '/login inlines a pre-paint theme bootstrap',
    /localStorage\.getItem\(['"]openerp_theme/.test(loginHtml) ||
      /openerp_theme_v1/.test(loginHtml),
    'expected the theme bootstrap script in the served HTML',
  );

  // =====================================================================
  // Summary
  // =====================================================================
  const total = passed + failed;
  console.log(
    `\n${passed === total ? green('ALL CHECKS PASSED') : red(`${failed} CHECK(S) FAILED`)}`,
  );
  console.log(`${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(red(`\nSmoke test crashed: ${error?.stack ?? error}\n`));
  process.exit(1);
});
