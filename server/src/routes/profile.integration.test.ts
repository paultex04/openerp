/**
 * Phase 15 item 8 acceptance gates: the self-service profile.
 *
 *   1. `/api/auth/me` carries the avatar version and the person record the
 *      profile screen edits (mobile included).
 *   2. A signed-in account can change its own login email and person record,
 *      nobody else's, and a clash is refused without half-applying.
 *   3. An uploaded image is processed to a square WebP and served back; a
 *      non-image and an oversized file are refused with usable errors.
 *   4. The avatar bytes never reach the audit log raw.
 *
 * These routes deliberately take no catalogue permission ("signed in" is the
 * rule), so there is nothing to assert about 403s here — the lockout risk runs
 * the other way, and Gate 2 below is what pins the boundary as the *payload*.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { prisma, prismaBase } from '../db/client.js';
import { TEST_PASSWORD, createTestUser, destroyTestUser, login } from '../test/fixtures.js';

let app: FastifyInstance;

const created: Array<{ id: number; employeeId: number; email: string }> = [];
const track = async (roleKeys: string[]) => {
  const user = await createTestUser(roleKeys);
  created.push(user);
  return user;
};

beforeAll(async () => {
  app = await buildApp({ config: loadConfig(), logger: false });
  await app.ready();
});

afterAll(async () => {
  for (const user of created) {
    await destroyTestUser(user).catch(() => undefined);
  }
  await app.close();
  await prisma.$disconnect();
});

/** A multipart body carrying one file, shaped like the browser's upload. */
function fileUpload(filename: string, mime: string, bytes: Buffer) {
  const boundary = `----openerp-test-${filename}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** A tiny PNG, so the upload path is exercised with a real image. */
async function pngSource(width = 12, height = 8): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 190, g: 30, b: 40 } },
  })
    .png()
    .toBuffer();
}

/** Waits for the fire-and-forget audit insert to land (see audit tests). */
const auditSettled = () => new Promise((resolve) => setTimeout(resolve, 120));

// ---------------------------------------------------------------------------

describe('Gate 1: these endpoints need a session', () => {
  const routes: Array<['PATCH' | 'POST' | 'GET', string]> = [
    ['PATCH', '/api/auth/me'],
    ['POST', '/api/auth/me/avatar'],
    ['GET', '/api/auth/me/avatar'],
  ];

  for (const [method, url] of routes) {
    it(`${method} ${url} returns 401 without a token`, async () => {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe('UNAUTHORIZED');
    });
  }
});

// ---------------------------------------------------------------------------

describe('Gate 2: the payload is the boundary', () => {
  it('exposes exactly the editable fields on /api/auth/me', async () => {
    const user = await track(['site_supervisor']);
    const cookie = await login(app, user.email, TEST_PASSWORD);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.user.email).toBe(user.email);
    expect(body.user.avatarUpdatedAt).toBeNull();
    expect(body.employee).toMatchObject({ name: 'Test', surname: 'User', mobile: null });
    expect(body.employee.email).toBe(user.email);
  });

  it('saves the login email and the person record together', async () => {
    const user = await track(['site_supervisor']);
    const cookie = await login(app, user.email, TEST_PASSWORD);
    const nextEmail = `profile-${user.id}@example.test`;

    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: { cookie },
      payload: {
        // Deliberately scruffy: the server owns canonicalisation.
        email: `  ${nextEmail.toUpperCase()} `,
        name: '  Nomvula ',
        surname: 'Mokoena',
        mobile: '082 555 0100',
        personalEmail: 'nomvula@example.test',
      },
    });

    expect(saved.statusCode).toBe(200);
    const body = saved.json();
    expect(body.user.email).toBe(nextEmail);
    expect(body.employee).toMatchObject({
      name: 'Nomvula',
      surname: 'Mokoena',
      mobile: '082 555 0100',
      email: 'nomvula@example.test',
    });

    // Both rows really moved, in one transaction.
    const fromDb = await prisma.appUser.findUniqueOrThrow({
      where: { id: user.id },
      select: { email: true, employee: { select: { name: true, mobile: true } } },
    });
    expect(fromDb.email).toBe(nextEmail);
    expect(fromDb.employee.name).toBe('Nomvula');
    expect(fromDb.employee.mobile).toBe('082 555 0100');

    // And the new address is the one that signs in.
    await expect(login(app, nextEmail, TEST_PASSWORD)).resolves.toContain('openerp_session=');
  });

  it('clears optional fields with blanks and leaves omitted ones alone', async () => {
    const user = await track(['site_supervisor']);
    const cookie = await login(app, user.email, TEST_PASSWORD);

    // First give them something to clear.
    await app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: { cookie },
      payload: {
        email: user.email,
        name: 'Test',
        surname: 'User',
        mobile: '011 111 1111',
        personalEmail: 'personal@example.test',
      },
    });

    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: { cookie },
      payload: { email: user.email, name: 'Test', surname: 'User', mobile: '', personalEmail: '' },
    });

    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().employee.mobile).toBeNull();
    expect(cleared.json().employee.email).toBeNull();
  });

  it('refuses a login email another account already uses, without half-applying', async () => {
    const mine = await track(['site_supervisor']);
    const other = await track(['site_supervisor']);
    const cookie = await login(app, mine.email, TEST_PASSWORD);

    const clash = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: { cookie },
      payload: { email: other.email, name: 'Renamed', surname: 'Anyway' },
    });

    expect(clash.statusCode).toBe(409);

    // The rename must not have gone through on the employee row while the
    // account row failed: one transaction, both rows or neither.
    const fromDb = await prisma.appUser.findUniqueOrThrow({
      where: { id: mine.id },
      select: { email: true, employee: { select: { name: true } } },
    });
    expect(fromDb.email).toBe(mine.email);
    expect(fromDb.employee.name).toBe('Test');
  });

  it('validates the payload', async () => {
    const user = await track(['site_supervisor']);
    const cookie = await login(app, user.email, TEST_PASSWORD);

    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: { cookie },
      payload: { email: 'not-an-email', name: '', surname: 'User' },
    });

    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('VALIDATION_FAILED');
  });
});

// ---------------------------------------------------------------------------

describe('Gate 3: avatar processing', () => {
  it('404s before anything has been uploaded', async () => {
    const user = await track(['site_supervisor']);
    const cookie = await login(app, user.email, TEST_PASSWORD);

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me/avatar',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('NO_AVATAR');
  });

  it('crops an upload to a square WebP and serves it back', async () => {
    const user = await track(['site_supervisor']);
    const cookie = await login(app, user.email, TEST_PASSWORD);
    const upload = fileUpload('portrait.png', 'image/png', await pngSource(12, 8));

    const posted = await app.inject({
      method: 'POST',
      url: '/api/auth/me/avatar',
      headers: { cookie, 'content-type': upload.contentType },
      payload: upload.payload,
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().avatarUpdatedAt).toBeTruthy();

    const fetched = await app.inject({
      method: 'GET',
      url: '/api/auth/me/avatar',
      headers: { cookie },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['content-type']).toBe('image/webp');
    const image = await sharp(fetched.rawPayload).metadata();
    expect(image.format).toBe('webp');
    // Landscape in, square out: a 256x256 portrait-ish crop.
    expect(image.width).toBe(256);
    expect(image.height).toBe(256);

    // The session response advertises the version the client cache-busts with.
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json().user.avatarUpdatedAt).toBe(posted.json().avatarUpdatedAt);
  });

  it('refuses a file that is not an image', async () => {
    const user = await track(['site_supervisor']);
    const cookie = await login(app, user.email, TEST_PASSWORD);
    const upload = fileUpload('notes.txt', 'text/plain', Buffer.from('not an image at all'));

    const posted = await app.inject({
      method: 'POST',
      url: '/api/auth/me/avatar',
      headers: { cookie, 'content-type': upload.contentType },
      payload: upload.payload,
    });
    expect(posted.statusCode).toBe(400);
    expect(posted.json().error).toBe('AVATAR_UNREADABLE');
  });

  it('refuses an upload over the size cap', async () => {
    const user = await track(['site_supervisor']);
    const cookie = await login(app, user.email, TEST_PASSWORD);
    const upload = fileUpload('huge.png', 'image/png', Buffer.alloc(6 * 1024 * 1024, 7));

    const posted = await app.inject({
      method: 'POST',
      url: '/api/auth/me/avatar',
      headers: { cookie, 'content-type': upload.contentType },
      payload: upload.payload,
    });
    expect(posted.statusCode).toBe(413);
    expect(posted.json().error).toBe('AVATAR_TOO_LARGE');
  });
});

// ---------------------------------------------------------------------------

describe('Gate 4: the audit log keeps the change, not the image', () => {
  it('summarises binary columns instead of copying them', async () => {
    const user = await track(['site_supervisor']);
    const cookie = await login(app, user.email, TEST_PASSWORD);
    const upload = fileUpload('face.png', 'image/png', await pngSource());

    const posted = await app.inject({
      method: 'POST',
      url: '/api/auth/me/avatar',
      headers: { cookie, 'content-type': upload.contentType },
      payload: upload.payload,
    });
    expect(posted.statusCode).toBe(200);

    await auditSettled();

    const entry = await prismaBase.auditLog.findFirstOrThrow({
      where: { model: 'AppUser', recordId: String(user.id), action: 'UPDATE' },
      orderBy: { id: 'desc' },
    });
    expect(entry.changedFields).toContain('avatarBytes');
    const after = (entry.after ?? {}) as Record<string, unknown>;
    // "[238 bytes]" - a size marker, not one JSON key per byte. Without the
    // summary a 40 KB avatar became a ~250 KB audit entry.
    expect(String(after.avatarBytes)).toMatch(/^\[\d+ bytes\]$/);
  });
});
