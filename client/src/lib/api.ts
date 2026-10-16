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
 * Empty by design: requests go to the client's own origin and are forwarded to
 * the API by the Route Handler at `app/api/[...path]/route.ts`. That keeps the
 * HTTP-only session cookie first-party and avoids both CORS and the fragile
 * dependency on `NEXT_PUBLIC_*` variables being inlined at build time.
 *
 * Set `NEXT_PUBLIC_API_BASE_URL` only if you deliberately want direct
 * cross-origin calls; the API must then allow this origin via `CLIENT_ORIGIN`.
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

  return readResponse<T>(response);
}

/**
 * Uploads a `FormData` body - the profile avatar today.
 *
 * Separate from `apiRequest` because `fetch` must set the multipart boundary
 * itself: setting `Content-Type` by hand produces a body the server cannot
 * parse. The CSRF header still rides along, because an upload is a mutation
 * like any other.
 */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = readCookie(CSRF_COOKIE);
  if (token) headers[CSRF_HEADER] = token;

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: form,
  });

  return readResponse<T>(response);
}

/**
 * Completes a request: unwraps the `{ error, message }` envelope, or returns
 * the parsed JSON. Shared so every path fails the same way.
 */
async function readResponse<T>(response: Response): Promise<T> {
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
  mobile: string | null;
  email: string | null;
}

export interface CurrentUser {
  user: {
    id: number;
    email: string;
    isActive: boolean;
    /** Cache-buster for the avatar URL; null when none has been uploaded. */
    avatarUpdatedAt: string | null;
  };
  employee: EmployeeSummary;
  roles: Array<{ key: string; name: string; description: string | null }>;
  permissions: string[];
}

/** Response of `PATCH /api/auth/me`: the saved profile, echoed back. */
export interface ProfileUpdateResponse {
  user: CurrentUser['user'];
  employee: EmployeeSummary;
  message: string;
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

// ---------------------------------------------------------------------------
// Operations (Phase 3)
// ---------------------------------------------------------------------------

export interface JobRow {
  id: number;
  status: string;
  priority: string;
  description: string | null;
  workOrder: string | null;
  purchaseOrder: string | null;
  area: string | null;
  workOrderReceivedDate?: string | null;
  purchaseOrderReceivedDate?: string | null;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  project: {
    id: number;
    code: string;
    year: number;
    contract: { id?: number; number: string; client?: { name: string } };
  };
  supervisor: { id: number; name: string; surname: string } | null;
  /** Present on the paginated jobs register; the detail endpoint carries more. */
  projectId?: number;
  amendmentId?: number | null;
  supervisorId?: number | null;
  clientContactId?: number | null;
  _count?: { serviceCodes: number; assignments: number; invoices: number };
}

/**
 * `GET /api/jobs` with pagination.
 *
 * `total` / `page` / `pageSize` are present only when the request supplied both
 * `page` and `pageSize`. An unpaginated call still returns every job, which is
 * what the /field view and the admin panel rely on.
 */
export interface JobListResponse {
  jobs: JobRow[];
  total?: number;
  page?: number;
  pageSize?: number;
}

export interface DeliverableRow {
  id: number;
  jobId: number;
  serviceCodeId: number;
  code: string;
  description: string;
  category: string;
  uom: string;
  /** Immutable price snapshot, ZAR per unit. */
  appliedRate: number;
  plannedQuantity: number;
  actualQuantity: number;
  plannedSubtotal: number;
  actualSubtotal: number;
  quantityVariance: number;
  valueVariance: number;
  /** True when the service code has been re-priced since scoping. */
  rateHasDrifted: boolean;
  currentRate: number | null;
  plannedLocked: boolean;
  plannedLockReason: string | null;
  actualsLocked: boolean;
  actualsLockReason: string | null;
}

export interface VarianceSummary {
  plannedSubtotal: number;
  actualSubtotal: number;
  valueVariance: number;
  lineCount: number;
  linesWithActuals: number;
  linesOverrun: number;
}

export interface TransitionOption {
  to: string;
  allowed: boolean;
  reason: string;
  requiredPermission?: string;
}

export interface JobDetail {
  job: {
    id: number;
    status: string;
    priority: string;
    description: string | null;
    workOrder: string | null;
    workOrderReceivedDate: string | null;
    purchaseOrder: string | null;
    purchaseOrderReceivedDate: string | null;
    area: string | null;
    supervisorId: number | null;
    clientContactId: number | null;
    plannedStartDate: string | null;
    plannedEndDate: string | null;
    actualStartDate: string | null;
    actualEndDate: string | null;
    amendmentId: number;
    amendment: { id: number; amendmentNumber: string; status: string; vatRate: number } | null;
    amendmentInherited: boolean;
    project: {
      id: number;
      code: string;
      year: number;
      contract: { id: number; number: string; client: { id: number; name: string } };
    };
    supervisor: { id: number; name: string; surname: string } | null;
    clientContact: { id: number; name: string; email: string | null; mobile: string | null } | null;
    assignments: Array<{
      id: number;
      role: string | null;
      assignedDate: string | null;
      employee: { id: number; name: string; surname: string };
    }>;
    invoices: Array<{ id: number; invoiceNumber: string; status: string; totalWithTax: number }>;
  };
  permissions: {
    canEditJob: boolean;
    canEditPlanned: boolean;
    plannedLockReason: string | null;
    canEditActuals: boolean;
    actualsLockReason: string | null;
    canAddDeliverable: boolean;
    /** Phase 7: whether this viewer may attach crew to the job. */
    canAssign: boolean;
    availableTransitions: string[];
    scopedToAssignedJobs: boolean;
  };
  deliverables: DeliverableRow[];
  summary: VarianceSummary;
}

export interface ProjectRow {
  id: number;
  code: string;
  year: number;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  contract: { id: number; number: string; client: { id: number; name: string } };
  amendment: { id: number; amendmentNumber: string; status: string; vatRate: number };
  jobs: Array<{ id: number; status: string; priority: string; description: string | null }>;
  statusCounts: Record<string, number>;
}

export interface ProjectDetail {
  project: Omit<ProjectRow, 'jobs' | 'statusCounts'> & {
    jobs: Array<
      JobRow & {
        plannedSubtotal: number;
        actualSubtotal: number;
        valueVariance: number;
        lineCount: number;
        linesWithActuals: number;
        linesOverrun: number;
      }
    >;
    exposure: {
      plannedSubtotal: number;
      actualSubtotal: number;
      valueVariance: number;
      lineCount: number;
      linesWithActuals: number;
      linesOverrun: number;
    };
  };
}

export interface FieldJob {
  id: number;
  status: string;
  description: string | null;
  workOrder: string | null;
  area: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  project: { code: string; contract: { number: string } };
  permissions: {
    canEditActuals: boolean;
    actualsLockReason: string | null;
    availableTransitions: string[];
  };
  deliverables: DeliverableRow[];
  summary: VarianceSummary;
}

// ---------------------------------------------------------------------------
// Billing (Phase 4)
// ---------------------------------------------------------------------------

export interface InvoiceRow {
  id: number;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  status: string;
  subtotalAmount: number;
  taxRate: number;
  taxAmount: number;
  totalWithTax: number;
  lineCount: number;
  job: {
    id: number;
    description: string | null;
    project: { code: string; contract: { number: string; client: { name: string } } };
  };
}

export interface InvoiceLine {
  id: number;
  serviceCodeId: number;
  code: string;
  uom: string;
  description: string | null;
  billedQuantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface InvoiceDetail {
  invoice: {
    id: number;
    invoiceNumber: string;
    issueDate: string;
    dueDate: string;
    status: string;
    subtotalAmount: number;
    taxRate: number;
    taxAmount: number;
    totalWithTax: number;
    totalAmount: number;
    notes: string | null;
  };
  lines: InvoiceLine[];
  client: { id: number; name: string; vatNumber: string | null; isVatRegistered: boolean };
  job: {
    id: number;
    status: string;
    description: string | null;
    workOrder: string | null;
    purchaseOrder: string | null;
    project: { code: string; contract: { number: string } };
  };
  vat: {
    subtotalAmount: number;
    taxRate: number;
    /** Zero for a client not registered for VAT, whatever the amendment says. */
    effectiveTaxRate: number;
    taxAmount: number;
    totalWithTax: number;
  };
  compliance: { ok: boolean; warnings: string[] };
  permissions: { canEdit: boolean; canDelete: boolean; availableTransitions: string[] };
  jobPosition: {
    jobActualTotal: number;
    recognisedBilledTotal: number;
    /** Negative when the invoice total exceeds the VAT-exclusive actuals. */
    remainingUnbilled: number;
  };
}

export interface InvoiceTransitionOption {
  to: string;
  allowed: boolean;
  reason: string;
  requiredPermission?: string;
}

// ---------------------------------------------------------------------------
// Phase 16: timesheets & job costing
// ---------------------------------------------------------------------------

/** The shift code as the API speaks it (a label), not Prisma's key. */
export type ShiftType = 'NT' | 'OT1.5' | 'DT2.0' | 'NS' | 'ST';
export type TimesheetStatus = 'Draft' | 'Submitted' | 'Approved' | 'Rejected';

export interface TimesheetEntryView {
  id: number;
  jobId: number;
  job: {
    id: number;
    workOrder: string | null;
    area: string | null;
    description: string | null;
  } | null;
  jobServiceCodeId: number | null;
  workDate: string;
  labourType: string;
  shiftType: ShiftType;
  hours: number;
  isBillable: boolean;
  notes: string | null;
  costRateOverride: number | null;
  overrideReason: string | null;
  /** Frozen at approval; null while the week is still editable. */
  costRate: number | null;
  costAmount: number | null;
  /** What approval would freeze right now — the grid's live figure. */
  preview: {
    costRate: number;
    costAmount: number;
    source: 'override' | 'service_master_rate' | 'employee_rate' | 'unpriced';
    priced: boolean;
  };
}

export interface TimesheetView {
  id: number;
  employeeId: number;
  employee: { id: number; name: string; surname: string };
  periodStart: string;
  periodEnd: string;
  status: TimesheetStatus;
  notes: string | null;
  submittedAt: string | null;
  submittedBy: { id: number; email: string } | null;
  decidedAt: string | null;
  decidedBy: { id: number; email: string } | null;
  decisionNote: string | null;
  canEdit: boolean;
  /** An approved week this approver may correct in place. */
  canAmend: boolean;
  canApprove: boolean;
  totals: { hours: number; cost: number; unpricedLines: number };
  entries: TimesheetEntryView[];
}

export interface TimesheetSummary {
  id: number;
  employeeId: number;
  employee: { id: number; name: string; surname: string };
  periodStart: string;
  periodEnd: string;
  status: TimesheetStatus;
  totalHours: number;
  approvedCost: number;
  entryCount: number;
  canApprove: boolean;
}

export interface LoggableJob {
  id: number;
  workOrder: string | null;
  area: string | null;
  description: string | null;
  status: string;
  projectCode: string;
  clientName: string;
}

/** An employee the current user may record time for, as the picker needs them. */
export interface TimesheetEmployee {
  id: number;
  name: string;
  surname: string;
  rate: number | null;
  hasRate: boolean;
  isSelf: boolean;
}

export interface RateCardResponse {
  jobId: number;
  amendmentId: number;
  rates: Array<{ labourType: string; shiftType: ShiftType; costRate: number }>;
}

export interface LabourGroupRow {
  labourType: string;
  shiftType: string;
  hoursPlanned: number;
  hoursActual: number;
  costPlanned: number;
  costActual: number;
  costVariance: number;
}

/** One job's cost-vs-revenue, as `GET /api/costing/jobs/:jobId` returns it. */
export interface JobCosting {
  jobId: number;
  job: {
    id: number;
    workOrder: string | null;
    area: string | null;
    description: string | null;
    status: string;
    projectCode: string;
    contractNumber: string;
    clientName: string;
  };
  revenueActual: number;
  revenueInvoiced: number;
  hoursPlanned: number;
  costPlanned: number;
  hoursActual: number;
  labourCostActual: number;
  materialCostActual: number;
  costActual: number;
  grossMargin: number;
  grossMarginPct: number;
  hoursVariance: number;
  costVariance: number;
  byLabourType: LabourGroupRow[];
}

/**
 * One line of time booked to a job, as `GET /api/timesheets/job-entries` returns it.
 *
 * An approved line carries the cost frozen when its week was approved; an
 * unsent or pending one carries the live preview, with `priced: false` when the
 * employee has no rate to price it at.
 */
export interface JobTimeEntry {
  id: number;
  workDate: string;
  labourType: string;
  shiftType: ShiftType;
  hours: number;
  isBillable: boolean;
  notes: string | null;
  employee: { id: number; name: string; surname: string };
  timesheetId: number;
  timesheetStatus: TimesheetStatus;
  periodStart: string;
  periodEnd: string;
  costRate: number | null;
  costAmount: number | null;
  priced: boolean;
}

export interface JobTimeEntries {
  entries: JobTimeEntry[];
  totals: { hours: number; billableHours: number; cost: number; unpricedLines: number };
}

// ---------------------------------------------------------------------------
// Phase 17: internal chat
// ---------------------------------------------------------------------------

/** Another account, as the chat directory and a conversation's peer present it. */
export interface ChatUser {
  id: number;
  employeeId: number;
  name: string;
  email: string;
  isActive: boolean;
  avatarUpdatedAt: string | null;
}

/** An image on a message. Its bytes are fetched from `/api/chat/attachments/:id`. */
export interface ChatAttachment {
  id: number;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  originalName: string | null;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  senderId: number;
  senderName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  /** The image sent with the message, if any. `null` for a text-only message. */
  attachment: ChatAttachment | null;
}

/** A conversation as the list needs it. Step 1 only creates direct ones. */
export interface ChatConversation {
  id: number;
  kind: string;
  /** The other member. */
  peer: ChatUser;
  lastMessage: ChatMessage | null;
  lastMessageAt: string | null;
  lastReadAt: string | null;
  /** The peer's read watermark, used to render a "Seen" marker on own messages. */
  peerLastReadAt: string | null;
  unreadCount: number;
}

export interface ChatConversationsResponse {
  conversations: ChatConversation[];
}
export interface ChatConversationResponse {
  conversation: ChatConversation;
}
export interface ChatMessagesResponse {
  messages: ChatMessage[];
}
export interface ChatMessageResponse {
  message: ChatMessage;
}
export interface ChatUsersResponse {
  users: ChatUser[];
}

/** A message found by search, with the conversation it belongs to. */
export interface ChatSearchResult {
  conversationId: number;
  peer: ChatUser;
  message: ChatMessage;
}
export interface ChatSearchResponse {
  results: ChatSearchResult[];
}

/**
 * Frames on `/api/chat/stream`. `ready` carries the initial online snapshot;
 * the rest mirror the server's event bus. Mirrored by hand, like the other chat
 * types, because the server's view types live in the server workspace.
 */
export type ChatStreamEvent =
  | { type: 'ready'; selfId: number; online: number[] }
  | { type: 'message'; conversationId: number; message: ChatMessage }
  | { type: 'read'; conversationId: number; userId: number; lastReadAt: string }
  | { type: 'typing'; conversationId: number; userId: number; isTyping: boolean }
  | { type: 'presence'; userId: number; online: boolean }
  | { type: 'deleted'; conversationId: number };

/** `connecting`/`open` while the stream is up; `closed` means polling takes over. */
export type ChatStreamStatus = 'connecting' | 'open' | 'closed';
