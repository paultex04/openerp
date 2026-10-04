/**
 * Password hashing.
 *
 * Uses bcrypt. `bcryptjs` is a pure-JavaScript implementation of the same
 * algorithm as the native `bcrypt` binding: hashes are interchangeable and
 * portable, but no node-gyp toolchain is needed to install or build.
 *
 * Cost 12 is ~250ms per hash on modern server hardware, which is the usual
 * balance between login latency and resistance to offline cracking.
 */
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

/** Minimum accepted length. bcrypt silently truncates beyond 72 bytes. */
export const MIN_PASSWORD_LENGTH = 12;

/** bcrypt only consumes the first 72 bytes of input. */
export const MAX_PASSWORD_BYTES = 72;

export async function hashPassword(plain: string): Promise<string> {
  assertPasswordAcceptable(plain);
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (typeof hash !== 'string' || hash.length === 0) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * Constant-time-ish password check for accounts that do not exist.
 *
 * Without this, a login attempt for an unknown email returns markedly faster
 * than one for a known email, which lets an attacker enumerate valid accounts.
 */
const DUMMY_HASH = bcrypt.hashSync('openerp-timing-equaliser', SALT_ROUNDS);

export async function fakeVerify(plain: string): Promise<void> {
  await bcrypt.compare(plain, DUMMY_HASH);
}

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

export function assertPasswordAcceptable(plain: string): void {
  const bytes = Buffer.byteLength(plain, 'utf8');
  if (bytes > MAX_PASSWORD_BYTES) {
    throw new PasswordPolicyError(
      `Password must be at most ${MAX_PASSWORD_BYTES} bytes when UTF-8 encoded.`,
    );
  }
  if (plain.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(plain)).length;
  if (classes < 3) {
    throw new PasswordPolicyError(
      'Password must combine at least three of: lowercase, uppercase, digit, symbol.',
    );
  }
}
