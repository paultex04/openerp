/**
 * Display formatting.
 *
 * All money is ZAR. Rates carry 4dp where the business needs them (unit prices
 * such as 17.5226 ZAR/m) and 2dp for hourly money amounts. Percentages arrive
 * from the API as fractions and are rendered as percent values.
 */
import { roundMoney } from '@openerp/shared';

const ZAR = new Intl.NumberFormat('en-ZA', {
  style: 'currency',
  currency: 'ZAR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const ZAR_RATE = new Intl.NumberFormat('en-ZA', {
  style: 'currency',
  currency: 'ZAR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const PLAIN = new Intl.NumberFormat('en-ZA', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

export function formatZar(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return ZAR.format(value);
}

/** 4dp currency, for unit rates that price below a cent. */
export function formatZarRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return ZAR_RATE.format(value);
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return PLAIN.format(value);
}

/** 0.005 -> "0.5%" */
export function formatPercent(fraction: number | null | undefined, dp = 2): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(dp).replace(/\.?0+$/, '')}%`;
}

/** Signed delta, e.g. "-0.89 ZAR". */
export function formatDelta(value: number): string {
  if (value === 0) return 'no change';
  return `${value > 0 ? '+' : ''}${formatZarRate(value)}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium' }).format(date);
}

/** Money from a possibly-string Decimal, defensively rounded. */
export function money(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  return roundMoney(Number(value));
}
