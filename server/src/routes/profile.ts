/**
 * Self-service profile: my own details and my avatar.
 *
 * ## Why these routes take no permission
 *
 * Every other write in this API is gated on a catalogue permission, because
 * every other write touches shared data. These two do not: they edit the
 * caller's *own* account and person record, and requiring `employee.write` to
 * correct your own mobile number would lock most of the company out of its
 * profile. "Signed in" is the whole authorisation rule, and the payload is the
 * boundary that keeps it narrow - the update can only reach the personal
 * columns on the employee row (name, surname, mobile, personal email), never
 * the job title, rate, manager or contract type that make it reference data.
 * Those stay admin territory, on the employees master-data panel.
 *
 * ## Why the paths sit under /api/auth/me
 *
 * They are the session's own account: `GET /api/auth/me` already answers "who
 * am I", so "change who I am" belongs beside it rather than on a second
 * resource id. The password lives with the other credential routes in auth.ts.
 *
 * ## Avatar processing
 *
 * The upload is never stored as sent. `sharp` auto-orients by EXIF, crops to a
 * square and re-encodes to WebP at a fixed 256x256 - so the database holds one
 * format, one size, and a few tens of KB per account, whatever the user
 * uploaded. `limitInputPixels` (sharp's default) refuses decompression bombs
 * without any extra work here.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { HttpError } from '../auth/plugin.js';
import type { Config } from '../config.js';
import { prisma } from '../db/client.js';
import { downloadBlob, isS3Active, uploadBlob } from '../storage/index.js';

/** Processed avatar size in pixels. Square; `sharp` crops to cover. */
const AVATAR_SIZE = 256;

/** JPEG quality / WebP quality ceiling for the processed image. */
const AVATAR_QUALITY = 80;

/**
 * Upload cap, shared with the multipart registration in app.ts so an oversized
 * file is refused while it streams instead of after it has been buffered.
 */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

const loginEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email('A valid login email address is required.')
  .max(255);

/** Blank, whitespace-only and null all mean "not recorded". */
function emptyToNull(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? null : value;
}

/**
 * An optional free-text field.
 *
 * Absent (`undefined`) means "leave unchanged"; blank or null clears it. The
 * distinction matters because the profile form sends every field on every save:
 * clearing the mobile number must be expressible, and zod's default `.partial()`
 * behaviour of filling defaults in was exactly the trap Phase 15 hit elsewhere.
 */
const optionalText = (max: number) =>
  z.preprocess(emptyToNull, z.string().trim().max(max).nullable()).optional();

/** An optional email field; blank clears it. */
const optionalEmail = () =>
  z
    .preprocess(
      emptyToNull,
      z
        .string()
        .trim()
        .toLowerCase()
        .email('A valid email address is required.')
        .max(255)
        .nullable(),
    )
    .optional();

const profileUpdateSchema = z.object({
  email: loginEmail,
  name: z.string().trim().min(1, 'Name is required.').max(100),
  surname: z.string().trim().min(1, 'Surname is required.').max(100),
  mobile: optionalText(50),
  personalEmail: optionalEmail(),
});

/** The multipart plugin's "file exceeded limits.fileSize" signal. */
export function fileTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE'
  );
}

export async function registerProfileRoutes(app: FastifyInstance, config: Config): Promise<void> {
  // ---- PATCH /api/auth/me -------------------------------------------------
  app.patch(
    '/api/auth/me',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal!;
      const body = profileUpdateSchema.parse(request.body);

      // Both rows move together. A half-applied profile - new name against the
      // old address - is worse than one that failed and can be retried, and the
      // interactive form of `$transaction` keeps the audit actor bound to both
      // writes (see the note in db/client.ts).
      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.appUser.update({
          where: { id: principal.userId },
          data: { email: body.email },
          select: { id: true, email: true, isActive: true, avatarUpdatedAt: true },
        });
        const employee = await tx.employee.update({
          where: { id: principal.employeeId },
          data: {
            name: body.name,
            surname: body.surname,
            // `undefined` leaves the value alone; null clears it.
            mobile: body.mobile,
            email: body.personalEmail,
          },
          select: { id: true, name: true, surname: true, mobile: true, email: true },
        });
        return { user, employee };
      });

      return reply.code(200).send({ ...result, message: 'Profile updated.' });
    },
  );

  // ---- POST /api/auth/me/avatar -------------------------------------------
  app.post(
    '/api/auth/me/avatar',
    {
      preHandler: [app.authenticate],
      // Image processing is the most expensive thing a signed-in user can ask
      // for, so it is capped per account. Skipped under NODE_ENV=test for the
      // same reason the login limiter is: the suite uploads faster than a human
      // ever would and unrelated assertions would turn into 429s.
      config: config.isTest ? {} : { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal!;

      if (!request.isMultipart()) {
        throw new HttpError(
          400,
          'AVATAR_REQUIRED',
          'Send the image as a multipart form field named "file".',
        );
      }

      let source: Buffer;
      try {
        const upload = await request.file();
        if (!upload) {
          throw new HttpError(400, 'AVATAR_REQUIRED', 'No image was attached.');
        }
        source = await upload.toBuffer();
      } catch (error) {
        if (fileTooLarge(error)) {
          throw new HttpError(
            413,
            'AVATAR_TOO_LARGE',
            `Avatars must be ${Math.floor(AVATAR_MAX_BYTES / (1024 * 1024))} MB or smaller.`,
          );
        }
        throw error;
      }

      let processed: Buffer;
      try {
        processed = await sharp(source)
          // Honour EXIF orientation first: cropping a sideways photo to a
          // square before rotating it gives a sideways square.
          .rotate()
          .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
          .webp({ quality: AVATAR_QUALITY })
          .toBuffer();
      } catch {
        throw new HttpError(
          400,
          'AVATAR_UNREADABLE',
          'That file could not be read as an image. Send a PNG, JPEG or WebP.',
        );
      }

      const avatarUpdatedAt = new Date();
      let avatarStorageKey: string | null = null;
      let avatarBytes: Uint8Array<ArrayBuffer> | null = null;

      if (isS3Active()) {
        const key = `avatars/user-${principal.userId}-${avatarUpdatedAt.getTime()}.webp`;
        await uploadBlob(key, processed, 'image/webp');
        avatarStorageKey = key;
      } else {
        const ab = new ArrayBuffer(processed.byteLength);
        const view = new Uint8Array(ab);
        view.set(processed);
        avatarBytes = view;
      }

      /*
       * Deliberately no `select`: the audit extension records the *returned*
       * row, so a narrowed result ({ id }) produces an entry that claims
       * nothing changed. The full row costs nothing here - the route ignores
       * it - and it is what lets the log show `avatarBytes [n bytes]`.
       */
      await prisma.appUser.update({
        where: { id: principal.userId },
        data: {
          avatarBytes,
          avatarStorageKey,
          avatarMime: 'image/webp',
          avatarUpdatedAt,
        },
      });

      return reply.code(200).send({ ok: true, avatarUpdatedAt, message: 'Avatar updated.' });
    },
  );

  // ---- GET /api/auth/me/avatar --------------------------------------------
  app.get(
    '/api/auth/me/avatar',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = request.principal!;

      const user = await prisma.appUser.findUnique({
        where: { id: principal.userId },
        select: { avatarBytes: true, avatarStorageKey: true, avatarMime: true },
      });

      if (!user || (!user.avatarBytes && !user.avatarStorageKey) || !user.avatarMime) {
        return reply.code(404).send({ error: 'NO_AVATAR', message: 'This account has no avatar.' });
      }

      let buffer: Buffer;
      if (user.avatarStorageKey && isS3Active()) {
        const obj = await downloadBlob(user.avatarStorageKey);
        if (!obj) {
          return reply
            .code(404)
            .send({ error: 'NO_AVATAR', message: 'Avatar image not found in storage.' });
        }
        buffer = obj.buffer;
      } else if (user.avatarBytes) {
        buffer = Buffer.from(user.avatarBytes);
      } else {
        return reply
          .code(404)
          .send({ error: 'NO_AVATAR', message: 'Avatar image could not be loaded.' });
      }

      return (
        reply
          .header('content-type', user.avatarMime)
          // The URL carries `?v=<avatarUpdatedAt>`, so the bytes never change
          // under a given URL: a long private cache is safe, and the shell avatar
          // does not refetch on every render.
          .header('cache-control', 'private, max-age=31536000, immutable')
          .send(buffer)
      );
    },
  );
}
