/**
 * Typed API client.
 *
 * Wraps `fetch` with the conventions this app relies on:
 *  - the session cookie is sent on every request (same-origin via the Next.js
 *    rewrite in next.config.mjs, so no CORS preflight in the browser)
 *  - errors from the server's `{ error, message, ... }` envelope are converted
 *    into a real `ApiError` so callers can branch on `code` and show `message`
 *  - the CSRF double-submit token is attached automatically for mutations
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Base URL for API calls.
 *
 * Empty in development, which makes requests same-origin and lets the Next.js
 * rewrite proxy them; set `NEXT_PUBLIC_API_BASE_URL` to call the API directly
 * (e.g. when the rewrite proxy is unavailable). Must be an absolute origin in
 * that case, and the API must allow it via `CLIENT_ORIGIN`.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

const CSRF_COOKIE = 'openerp_csrf';
const CSRF_HEADER = 'x-csrf-token';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  // Double-submit CSRF: echo the readable token cookie into a header. The cookie
  // is deliberately NOT httpOnly so the client can read and copy it.
  if (method !== 'GET') {
    const token = readCookie(CSRF_COOKIE);
    if (token) headers[CSRF_HEADER] = token;
  }

  const url = `${API_BASE}${buildUrl(path, options.query)}`;

  const response = await fetch(url, {
    method,
    headers,
    // Required so the HTTP-only session cookie travels on a cross-origin call.
    credentials: 'include',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body means something upstream (proxy, gateway) failed.
    throw new ApiError(
      response.status,
      'INVALID_RESPONSE',
      `Expected JSON but received ${response.headers.get('content-type') ?? 'an unknown type'}.`,
    );
  }

  if (!response.ok) {
    const envelope = (payload ?? {}) as { error?: string; message?: string; issues?: unknown };
    throw new ApiError(
      response.status,
      envelope.error ?? 'UNKNOWN',
      envelope.message ?? `Request failed with status ${response.status}.`,
      envelope.issues,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    apiRequest<T>(path, {
      method: 'GET',
      ...(query ? { query } : {}),
      ...(signal ? { signal } : {}),
    }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface EmployeeSummary {
  id: number;
  name: string;
  surname: string;
  email: string | null;
}

export interface CurrentUser {
  user: { id: number; email: string; isActive: boolean };
  employee: EmployeeSummary;
  roles: Array<{ key: string; name: string; description: string | null }>;
  permissions: string[];
}

export interface ClientRow {
  id: number;
  name: string;
  email: string;
  address: string | null;
  isVatRegistered: boolean;
  vatNumber: string | null;
  _count?: { contracts: number };
}

export interface AmendmentSummary {
  id: number;
  amendmentNumber: string;
  status: string;
  effectiveDate: string;
  expiryDate: string | null;
  vatRate: number;
}

export interface ContractRow {
  id: number;
  number: string;
  description: string;
  type: string | null;
  client: Pick<ClientRow, 'id' | 'name' | 'isVatRegistered' | 'vatNumber'>;
  amendments: AmendmentSummary[];
  _count?: { projects: number };
}

export interface RateCardRow {
  id: number;
  amendmentId: number;
  serviceMasterCode: string;
  labourType: string;
  shiftType: string;
  uom: string;
  councilRate: number | null;
  customRate: number | null;
  wagePremiumPct: number;
  manInPocket: number;
  leavePay: number;
  totalStatutoryCost: number;
  ppeCost: number;
  transportCost: number;
  equipmentCost: number;
  overheadCost: number;
  sgaCost: number;
  profitCost: number;
  fullLoadedRate: number;
  _count?: { labourItems: number };
}

export interface ServiceCodeRow {
  id: number;
  amendmentId: number;
  code: string;
  description: string;
  category: string;
  uom: string;
  materialMarkupPct: number;
  calculatedUnitRate: number;
  _count?: { labourItems: number; materialItems: number };
}

export interface LabourLine {
  id: number;
  serviceCodeId: number;
  serviceMasterRateId: number;
  crewQuantity: number;
  hoursPerUnit: number;
  lineSubtotal: number;
  serviceMasterRate: {
    id: number;
    serviceMasterCode: string;
    labourType: string;
    fullLoadedRate: number;
  };
}

export interface MaterialLine {
  id: number;
  serviceCodeId: number;
  itemCode: string | null;
  description: string;
  supplierName: string | null;
  unitCost: number;
  quantity: number;
  uom: string;
  subtotalCost: number;
}

export interface ServiceCodeDetail extends ServiceCodeRow {
  labourItems: LabourLine[];
  materialItems: MaterialLine[];
  amendment: { id: number; amendmentNumber: string; vatRate: number };
}

export interface ComputationResult {
  serviceCodeId: number;
  category: string;
  computed: number;
  variance: { computed: number; stored: number; delta: number; matches: boolean };
  lines: Array<Record<string, number>>;
  subtotalCost?: number;
  markupAmount?: number;
  totalHoursPerUnit?: number;
}

export interface Tier1Computation {
  baseRate: number;
  baseRateSource: 'custom' | 'council';
  manInPocket: number;
  baseDirectLabour: number;
  overheadCost: number;
  sgaCost: number;
  profitCost: number;
  fullLoadedRate: number;
}

export interface CostParameterRow {
  id: number;
  amendmentId: number;
  category: string;
  parameterName: string;
  numericValue: number;
  uom: string;
  notes: string | null;
}

export interface EngineParameters {
  overheadPct?: number;
  sgaPct?: number;
  profitPct?: number;
  equipmentHourlyRate?: number;
  ppePerHour?: number;
  transportHourlyRate?: number;
  r1MaterialMarkupPct?: number;
}
