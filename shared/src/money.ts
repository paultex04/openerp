/**
 * Numeric precision helpers.
 *
 * The whole pricing engine is deliberately built on IEEE-754 doubles with
 * explicit, centralised rounding rather than on a decimal type. Two reasons:
 *
 *  1. The engine is pure and isomorphic (it runs on the client for live inline
 *     previews and on the server for authoritative persistence), and pulling a
 *     decimal library into the browser bundle for this would be wasteful.
 *  2. Binary floating point is *sufficient* here provided that rounding happens
 *     at exactly one place per value. The failure mode this guards against is
 *     `0.1 + 0.2 !== 0.3`-style drift accumulating across a build-up chain.
 *
 * Every intermediate result is kept at full precision and rounded exactly once,
 * on output. See ADR-001 for the arithmetic that produced the published vectors.
 */

/**
 * Anything the engine will accept as a number.
 *
 * PostgreSQL `numeric` arrives from Prisma as `Decimal`, which serialises to a
 * string over JSON. Accepting strings keeps the engine usable with either.
 */
export type DecimalLike = number | string;

/** Coerces to a finite number, rejecting anything that is not one. */
export function toNumber(value: DecimalLike, field = 'value'): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new RangeError(`Expected ${field} to be a finite number, received "${value}".`);
  }
  return n;
}

/**
 * Rounds half-away-from-zero to `dp` decimal places.
 *
 * Two subtleties make this harder than `Math.round(n * 100) / 100`:
 *
 *  1. **Representation error.** `1.005 * 100` is `100.49999999999999`, so the
 *     naive form rounds 1.005 down to 1.00 instead of up to 1.01. Multiplying by
 *     a power of ten introduces exactly this kind of error just below a `.5`
 *     boundary, which is precisely where financial rounding matters most.
 *     The fix is to shift the decimal point through a *string* round-trip:
 *     `Number("1.005e2")` is the correctly-rounded double `100.5`.
 *
 *  2. **Symmetry.** `Math.round` is half-up, so it rounds `-2.5` to `-2`. A
 *     credit must round to `-3`. Rounding the magnitude and reapplying the sign
 *     gives half-away-from-zero, which is what a finance team expects.
 */
export function round(value: DecimalLike, dp: number, field = 'value'): number {
  const n = toNumber(value, field);
  const factor = 10 ** dp;

  const asString = String(n);
  const hasExponent = asString.includes('e') || asString.includes('E');

  // Shift the decimal point via a string round-trip so the scaled value is the
  // correctly-rounded double of the decimal literal. Numbers already in
  // exponential form (very large or very small) skip this and multiply, where
  // the error is below the precision we care about anyway.
  const scaled = hasExponent ? n * factor : Number(`${asString}e${dp}`);

  if (!Number.isFinite(scaled)) return n;

  const magnitude = Math.round(Math.abs(scaled));
  return (n < 0 ? -magnitude : magnitude) / factor;
}

/** Rounds to cents. The default for monetary amounts. */
export function roundMoney(value: DecimalLike, field = 'value'): number {
  return round(value, 2, field);
}

/** Rounds to 4dp. The unit-rate precision used across the schema. */
export function roundRate(value: DecimalLike, field = 'value'): number {
  return round(value, 4, field);
}

/** Rounds a percentage fraction (0.075) to the schema's 4dp storage scale. */
export function roundPct(value: DecimalLike, field = 'value'): number {
  return round(value, 4, field);
}

/**
 * Sums values, rounding only once at the end.
 *
 * Rounding each addend separately is the classic source of off-by-a-cent
 * errors when a build-up chain has many terms.
 */
export function sumExact(values: readonly DecimalLike[], field = 'value'): number {
  let total = 0;
  for (const v of values) total += toNumber(v, field);
  return total;
}

/**
 * Applies a percentage fraction to an amount.
 *
 * Kept as a named helper so the "is this a fraction or a percentage?" question
 * has exactly one answer in the codebase: **always a fraction**. 0.07 means 7%,
 * matching how the baseline database stores `*_pct` columns.
 */
export function applyFraction(amount: DecimalLike, fraction: DecimalLike): number {
  return toNumber(amount, 'amount') * toNumber(fraction, 'fraction');
}

export function isZeroWithin(value: DecimalLike, epsilon = 1e-9): boolean {
  return Math.abs(toNumber(value)) < epsilon;
}
