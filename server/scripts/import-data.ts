/**
 * Imports a filled import workbook into the database.
 *
 *   Dry run (default, writes nothing):
 *     npm run import:data -- --file import/OpenERP-import-template.xlsx
 *   Apply:
 *     npm run import:data -- --file import/OpenERP-import-template.xlsx --apply
 *
 * ## Dry run is the default on purpose
 *
 * A spreadsheet is edited by hand, so every failure mode is a data-entry slip:
 * a mistyped contract number, a date Excel reformatted, a percent entered as a
 * fraction. The dry run resolves every reference and computes every derived
 * figure without writing a row, and reports all errors with sheet, row and
 * column. `--apply` re-runs the same validation and writes only when it is
 * clean, so an apply-phase failure means a database race, not a typo.
 *
 * ## References are natural keys, never ids
 *
 * Nobody can be expected to know that Sasol is client 1. Every reference is the
 * business key — email, contract number, project code, service code within its
 * amendment — resolved against the file first, then the live database. An
 * unknown or ambiguous reference is an error naming what was looked for.
 *
 * ## Existing rows are reused or refused, never overwritten
 *
 * Pure reference rows (brokers, contract types) resolve to the existing row by
 * exact name. Everything else aborts on a natural-key collision: silently
 * updating a client's VAT flag from a spreadsheet would be a data-loss vector.
 * Fix the sheet or clean the database, then re-run.
 *
 * ## Derived figures are computed, not typed
 *
 * Rate-card build-ups, recipe subtotals, service-code rollups, planned
 * subtotals and pricing snapshots are all produced by the same shared engines
 * and service functions the application itself uses (`saveRateCard`,
 * `addDeliverable`, `computeServiceCodeRate`). The sheet carries inputs only,
 * so an imported rate cannot disagree with what the UI would have computed.
 *
 * ## Writes are sequential, not one transaction
 *
 * `saveRateCard` and `addDeliverable` own their writes through the shared Prisma
 * client and cannot join a caller transaction. Sequential writes with full
 * up-front validation is the honest alternative: back up the database before
 * `--apply`. Every write is audit-logged by the Prisma extension as `system`,
 * same as the seed — row-level entries, so the trail shows exactly which rows
 * came from the import.
 */
import ExcelJS from 'exceljs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  AMENDMENT_TYPE,
  amendmentUpsertSchema,
  assignmentCreateSchema,
  brokerUpsertSchema,
  clientUpsertSchema,
  contactUpsertSchema,
  CONTRACT_AMENDMENT_STATUS,
  contractUpsertSchema,
  costParameterUpsertSchema,
  COST_PARAMETER_CATEGORY,
  deliverableCreateSchema,
  employeeContractTypeUpsertSchema,
  employeeUpsertSchema,
  jobUpsertSchema,
  JOB_PRIORITY,
  JOB_STATUS,
  labourItemUpsertSchema,
  materialItemUpsertSchema,
  projectUpsertSchema,
  serviceCodeUpsertSchema,
  serviceMasterRateUpsertSchema,
  SERVICE_CODE_CATEGORY,
  SHIFT_TYPE,
  computeActivityRate,
  computeFullLoadedRate,
  computeMaterialRate,
  COST_PARAMETER_NAMES,
  readCostParameters,
  roundMoney,
  roundRate,
  sumExact,
  type Tier1OverheadPolicy,
} from '@openerp/shared';
import { IMPORT_JOB_STATUSES, SHEETS } from './import-spec.js';
import { prisma } from '../src/db/client.js';
import { loadEnvFile } from '../src/lib/env.js';
import { asSystem } from '../src/audit/context.js';
import { saveRateCard } from '../src/pricing/service.js';
import { addDeliverable } from '../src/operations/service.js';

loadEnvFile();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Issue {
  sheet: string;
  row: number;
  column: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

/** Excel hands back strings, numbers, booleans, Dates and rich text. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'object') {
    const v = value as {
      text?: string | { text: string }[];
      richText?: { text: string }[];
      result?: unknown;
    };
    if (v.result !== undefined) return cellText(v.result as ExcelJS.CellValue);
    if (typeof v.text === 'string') return v.text.trim();
    if (Array.isArray(v.text))
      return v.text
        .map((t) => t.text)
        .join('')
        .trim();
    if (Array.isArray(v.richText))
      return v.richText
        .map((t) => t.text)
        .join('')
        .trim();
    return '';
  }
  return String(value).trim();
}

function cellNumber(raw: string): number | null {
  if (raw === '') return null;
  // South African thousand separators ("1 000", "1'000") are stripped; a comma
  // decimal separator is refused rather than guessed, because 1,5 could mean
  // one-point-five or one thousand five depending on who typed it.
  if (/,\d/.test(raw)) return NaN;
  const n = Number(raw.replace(/[\s']/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function isExampleRow(firstCell: string): boolean {
  return firstCell.toUpperCase().startsWith('EXAMPLE');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Strips the ` [unit]` and ` *` decorations from a template column header. */
const baseHeader = (h: string) => h.split(' [')[0].replace(/ \*$/, '');

// ---------------------------------------------------------------------------
// Workbook loading
// ---------------------------------------------------------------------------

type RawRow = { excelRow: number; values: Record<string, string> };

function loadSheet(wb: ExcelJS.Workbook, sheetName: string, errors: Issue[]): RawRow[] | null {
  const ws = wb.getWorksheet(sheetName);
  if (!ws) {
    errors.push({ sheet: sheetName, row: 0, column: '', message: 'Sheet is missing.' });
    return null;
  }
  const spec = SHEETS.find((s) => s.name === sheetName)!;

  const headerRow = ws.getRow(1);
  const colToKey = new Map<number, string>();
  const seen = new Set<string>();
  headerRow.eachCell((cell, colNumber) => {
    const base = baseHeader(cellText(cell.value));
    const match = spec.columns.find((c) => c.header === base);
    if (match) {
      colToKey.set(colNumber, match.key);
      seen.add(match.key);
    } else if (base !== '') {
      errors.push({
        sheet: sheetName,
        row: 1,
        column: base,
        message: `Unknown column — expected one of: ${spec.columns.map((c) => c.header).join(', ')}.`,
      });
    }
  });
  for (const col of spec.columns) {
    if (!seen.has(col.key)) {
      errors.push({
        sheet: sheetName,
        row: 1,
        column: col.header,
        message: 'Column is missing. The sheet may be from an older template — regenerate it.',
      });
    }
  }
  if (errors.some((e) => e.sheet === sheetName && e.row === 1)) return null;

  const rows: RawRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const values: Record<string, string> = {};
    let empty = true;
    for (const [colNumber, key] of colToKey) {
      const text = cellText(row.getCell(colNumber).value);
      if (text !== '') empty = false;
      values[key] = text;
    }
    if (empty) continue;
    const firstKey = spec.columns[0]!.key;
    if (isExampleRow(values[firstKey] ?? '')) continue;
    rows.push({ excelRow: r, values });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Resolved plan
//
// Rows being imported have no database ids yet, but later sheets must reference
// them. Negative stand-ins can never collide with a serial id; on apply each is
// replaced with the real id the moment its row is written.
// ---------------------------------------------------------------------------

interface Plan {
  brokers: { name: string; id: number; reused: boolean }[];
  contractTypes: { name: string; id: number; reused: boolean }[];
  clients: { data: Record<string, unknown>; id: number }[];
  contacts: { data: Record<string, unknown>; id: number }[];
  employees: { data: Record<string, unknown>; id: number }[];
  employeeManagers: { employeeId: number; managerId: number }[];
  contracts: { data: Record<string, unknown>; id: number }[];
  amendments: { data: Record<string, unknown>; id: number }[];
  costParams: { data: Record<string, unknown> }[];
  rateCards: {
    input: Record<string, unknown>;
    derive: boolean;
    id: number;
    computedRate: number;
  }[];
  serviceCodes: { data: Record<string, unknown>; id: number; computedRate: number }[];
  recipeLabour: { data: Record<string, unknown> }[];
  recipeMaterial: { data: Record<string, unknown> }[];
  projects: { data: Record<string, unknown>; id: number; contractNumber: string }[];
  jobs: {
    ref: string;
    data: Record<string, unknown>;
    status: string;
    id: number;
    plannedTotal: number;
  }[];
  jobLines: { jobRef: string; data: Record<string, unknown> }[];
  crew: { jobRef: string; data: Record<string, unknown> }[];
}

function err(
  errors: Issue[],
  sheet: string,
  excelRow: number,
  column: string,
  message: string,
): void {
  errors.push({ sheet, row: excelRow, column, message });
}

function zodReport(
  errors: Issue[],
  sheet: string,
  excelRow: number,
  result: {
    success: boolean;
    error?: { issues: { path: (string | number)[]; message: string }[] };
  },
): boolean {
  if (result.success) return true;
  for (const issue of result.error?.issues ?? []) {
    err(
      errors,
      sheet,
      excelRow,
      String(issue.path[0] ?? ''),
      `${String(issue.path.join('.'))}: ${issue.message}`,
    );
  }
  return false;
}

function enumKey(
  errors: Issue[],
  sheet: string,
  excelRow: number,
  column: string,
  label: string,
  map: { toKey: (label: string) => string; labels: readonly string[] },
): string | null {
  try {
    return map.toKey(label);
  } catch {
    err(
      errors,
      sheet,
      excelRow,
      column,
      `"${label}" is not valid. Pick one of: ${map.labels.join(' · ')}.`,
    );
    return null;
  }
}

let nextDryId = -1;
function dryId(): number {
  return nextDryId--;
}

function opt(raw: string): string | null {
  const t = raw.trim();
  return t === '' ? null : t;
}

/**
 * Shape-validation stand-in for foreign keys.
 *
 * Rows being imported carry negative placeholder ids until apply time, and
 * every upsert schema requires positive integers. Existence of each reference
 * is already checked by the resolvers above — the schema check only needs to
 * validate shapes — so placeholders are swapped for 1, field by field. Only
 * the named FK fields are touched: a genuinely negative user number (a rate of
 * -5) must still fail, never be masked.
 */
function fk(obj: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const out = { ...obj };
  for (const key of keys) {
    const v = out[key];
    if (typeof v === 'number' && Number.isInteger(v) && v < 0) out[key] = 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation — resolves every reference, computes every derived figure
// ---------------------------------------------------------------------------

/**
 * Reports the first use of a duplicate key within one sheet section, or null.
 * Hoisted to module scope: it captures nothing from `validate` and is called
 * from every section.
 */
function dupWithin(m: Map<string, number>, k: string): number | null {
  if (m.has(k)) return m.get(k)!;
  return null;
}

async function validate(
  sheets: Record<string, RawRow[]>,
  errors: Issue[],
  warnings: Issue[],
): Promise<Plan | null> {
  const plan: Plan = {
    brokers: [],
    contractTypes: [],
    clients: [],
    contacts: [],
    employees: [],
    employeeManagers: [],
    contracts: [],
    amendments: [],
    costParams: [],
    rateCards: [],
    serviceCodes: [],
    recipeLabour: [],
    recipeMaterial: [],
    projects: [],
    jobs: [],
    jobLines: [],
    crew: [],
  };
  let failed = false;
  const fail = () => {
    failed = true;
  };

  const rows = (name: string): RawRow[] => sheets[name] ?? [];

  // ---- Brokers & contract types: reuse by exact name ----
  const brokerIds = new Map<string, number>();
  {
    const seen = new Map<string, number>();
    for (const r of rows('Brokers')) {
      const v = r.values;
      if (!v.name) {
        err(errors, 'Brokers', r.excelRow, 'Broker name', 'Required.');
        fail();
        continue;
      }
      if (
        !zodReport(errors, 'Brokers', r.excelRow, brokerUpsertSchema.safeParse({ name: v.name }))
      ) {
        fail();
        continue;
      }
      const d = dupWithin(seen, v.name.toLowerCase());
      if (d !== null) {
        err(errors, 'Brokers', r.excelRow, 'Broker name', `Duplicate of row ${d} in this sheet.`);
        fail();
        continue;
      }
      seen.set(v.name.toLowerCase(), r.excelRow);
      const existing = await prisma.broker.findFirst({ where: { name: v.name } });
      if (existing) {
        plan.brokers.push({ name: v.name, id: existing.id, reused: true });
        brokerIds.set(v.name.toLowerCase(), existing.id);
      } else {
        const id = dryId();
        plan.brokers.push({ name: v.name, id, reused: false });
        brokerIds.set(v.name.toLowerCase(), id);
      }
    }
  }
  const typeIds = new Map<string, number>();
  {
    const seen = new Map<string, number>();
    for (const r of rows('ContractTypes')) {
      const v = r.values;
      if (!v.name) {
        err(errors, 'ContractTypes', r.excelRow, 'Type name', 'Required.');
        fail();
        continue;
      }
      if (
        !zodReport(
          errors,
          'ContractTypes',
          r.excelRow,
          employeeContractTypeUpsertSchema.safeParse({ name: v.name }),
        )
      ) {
        fail();
        continue;
      }
      const d = dupWithin(seen, v.name.toLowerCase());
      if (d !== null) {
        err(
          errors,
          'ContractTypes',
          r.excelRow,
          'Type name',
          `Duplicate of row ${d} in this sheet.`,
        );
        fail();
        continue;
      }
      seen.set(v.name.toLowerCase(), r.excelRow);
      const existing = await prisma.employeeContractType.findFirst({ where: { name: v.name } });
      if (existing) {
        plan.contractTypes.push({ name: v.name, id: existing.id, reused: true });
        typeIds.set(v.name.toLowerCase(), existing.id);
      } else {
        const id = dryId();
        plan.contractTypes.push({ name: v.name, id, reused: false });
        typeIds.set(v.name.toLowerCase(), id);
      }
    }
  }

  // ---- Clients ----
  const clientIds = new Map<string, number>();
  {
    const seen = new Map<string, number>();
    for (const r of rows('Clients')) {
      const v = r.values;
      let ok = true;
      if (!v.name) {
        err(errors, 'Clients', r.excelRow, 'Client name', 'Required.');
        ok = false;
      }
      if (!v.email) {
        err(errors, 'Clients', r.excelRow, 'Email', 'Required.');
        ok = false;
      }
      const email = v.email.trim().toLowerCase();
      if (v.email && !EMAIL_RE.test(email)) {
        err(errors, 'Clients', r.excelRow, 'Email', `"${v.email}" is not an email address.`);
        ok = false;
      }
      if (v.email && dupWithin(seen, email) !== null) {
        err(
          errors,
          'Clients',
          r.excelRow,
          'Email',
          `Duplicate of row ${seen.get(email)} in this sheet.`,
        );
        ok = false;
      }
      if (v.email) seen.set(email, r.excelRow);
      let vat: boolean | null = null;
      if (v.isVatRegistered !== '') {
        const parsed = parseBoolish(v.isVatRegistered);
        if (parsed === null) {
          err(errors, 'Clients', r.excelRow, 'VAT registered', 'Use TRUE or FALSE.');
          ok = false;
        } else vat = parsed;
      }
      if (!ok) {
        fail();
        continue;
      }
      if (await prisma.client.findUnique({ where: { email } })) {
        err(
          errors,
          'Clients',
          r.excelRow,
          'Email',
          `A client with email "${email}" already exists. Existing rows are never overwritten.`,
        );
        fail();
        continue;
      }
      const vatNumber = v.vatNumber.trim().replace(/\s/g, '');
      const payload = {
        name: v.name.trim(),
        email,
        address: opt(v.address),
        isVatRegistered: vat ?? true,
        vatNumber: vatNumber === '' ? null : vatNumber,
      };
      if (!zodReport(errors, 'Clients', r.excelRow, clientUpsertSchema.safeParse(payload))) {
        fail();
        continue;
      }
      if ((vat ?? true) && vatNumber === '') {
        warnings.push({
          sheet: 'Clients',
          row: r.excelRow,
          column: 'VAT number',
          message: 'Registered for VAT but no VAT number given.',
        });
      }
      const id = dryId();
      plan.clients.push({ data: payload, id });
      clientIds.set(email, id);
    }
  }

  async function resolveClient(emailRaw: string): Promise<number | null> {
    const email = emailRaw.trim().toLowerCase();
    const inFile = clientIds.get(email);
    if (inFile !== undefined) return inFile;
    const existing = await prisma.client.findUnique({ where: { email } });
    return existing?.id ?? null;
  }

  // ---- Contacts ----
  const contactIdsByEmail = new Map<string, number[]>();
  {
    for (const r of rows('Contacts')) {
      const v = r.values;
      let ok = true;
      if (!v.clientEmail) {
        err(errors, 'Contacts', r.excelRow, 'Client email', 'Required.');
        ok = false;
      }
      if (!v.name) {
        err(errors, 'Contacts', r.excelRow, 'Full name', 'Required.');
        ok = false;
      }
      const clientId = v.clientEmail ? await resolveClient(v.clientEmail) : null;
      if (v.clientEmail && clientId === null) {
        err(
          errors,
          'Contacts',
          r.excelRow,
          'Client email',
          `No client "${v.clientEmail}" in the file or the database.`,
        );
        ok = false;
      }
      let email: string | null = null;
      if (v.email !== '') {
        email = v.email.trim().toLowerCase();
        if (!EMAIL_RE.test(email)) {
          err(errors, 'Contacts', r.excelRow, 'Email', `"${v.email}" is not an email address.`);
          ok = false;
        }
      }
      if (!ok) {
        fail();
        continue;
      }
      const payload = {
        clientId: clientId!,
        name: v.name.trim(),
        mobile: opt(v.mobile),
        email,
        role: opt(v.role),
      };
      if (
        !zodReport(
          errors,
          'Contacts',
          r.excelRow,
          contactUpsertSchema.safeParse(fk(payload, 'clientId')),
        )
      ) {
        fail();
        continue;
      }
      const id = dryId();
      plan.contacts.push({ data: payload, id });
      if (email) {
        const list = contactIdsByEmail.get(email) ?? [];
        list.push(id);
        contactIdsByEmail.set(email, list);
      }
    }
  }

  async function resolveContact(emailRaw: string): Promise<number | 'ambiguous' | null> {
    const email = emailRaw.trim().toLowerCase();
    const inFile = contactIdsByEmail.get(email) ?? [];
    const inDb = await prisma.contact.findMany({ where: { email }, select: { id: true } });
    if (inFile.length + inDb.length === 0) return null;
    if (inFile.length + inDb.length > 1) return 'ambiguous';
    return inFile.length === 1 ? inFile[0]! : inDb[0]!.id;
  }

  // ---- Employees (two passes: rows first, manager links second) ----
  const employeeIds = new Map<string, number>();
  const employeeRows: { row: RawRow; planId: number; managerEmail: string }[] = [];
  {
    const seenEmail = new Map<string, number>();
    const seenIdNo = new Map<string, number>();
    for (const r of rows('Employees')) {
      const v = r.values;
      let ok = true;
      if (!v.name) {
        err(errors, 'Employees', r.excelRow, 'First name', 'Required.');
        ok = false;
      }
      if (!v.surname) {
        err(errors, 'Employees', r.excelRow, 'Surname', 'Required.');
        ok = false;
      }
      if (!v.startDate) {
        err(errors, 'Employees', r.excelRow, 'Start date', 'Required.');
        ok = false;
      }
      if (!v.contractType) {
        err(errors, 'Employees', r.excelRow, 'Contract type', 'Required.');
        ok = false;
      }
      let email: string | null = null;
      if (v.email !== '') {
        email = v.email.trim().toLowerCase();
        if (!EMAIL_RE.test(email)) {
          err(errors, 'Employees', r.excelRow, 'Email', `"${v.email}" is not an email address.`);
          ok = false;
        } else {
          if (dupWithin(seenEmail, email) !== null) {
            err(
              errors,
              'Employees',
              r.excelRow,
              'Email',
              `Duplicate of row ${seenEmail.get(email)} in this sheet.`,
            );
            ok = false;
          }
          seenEmail.set(email, r.excelRow);
          if (await prisma.employee.findUnique({ where: { email } })) {
            err(
              errors,
              'Employees',
              r.excelRow,
              'Email',
              `An employee with email "${email}" already exists.`,
            );
            ok = false;
          }
        }
      }
      const idNumber = opt(v.idNumber);
      if (idNumber) {
        if (dupWithin(seenIdNo, idNumber) !== null) {
          err(
            errors,
            'Employees',
            r.excelRow,
            'ID number',
            `Duplicate of row ${seenIdNo.get(idNumber)} in this sheet.`,
          );
          ok = false;
        }
        seenIdNo.set(idNumber, r.excelRow);
        if (await prisma.employee.findUnique({ where: { idNumber } })) {
          err(
            errors,
            'Employees',
            r.excelRow,
            'ID number',
            `An employee with ID number "${idNumber}" already exists.`,
          );
          ok = false;
        }
      }
      let brokerId: number | null = null;
      if (v.broker !== '') {
        const found = brokerIds.get(v.broker.trim().toLowerCase());
        if (found === undefined) {
          const existing = await prisma.broker.findFirst({ where: { name: v.broker.trim() } });
          if (!existing) {
            err(
              errors,
              'Employees',
              r.excelRow,
              'Broker',
              `No broker "${v.broker}" in the file or the database.`,
            );
            ok = false;
          } else brokerId = existing.id;
        } else brokerId = found;
      }
      let contractTypeId: number | null = null;
      if (v.contractType !== '') {
        const found = typeIds.get(v.contractType.trim().toLowerCase());
        if (found === undefined) {
          const existing = await prisma.employeeContractType.findFirst({
            where: { name: v.contractType.trim() },
          });
          if (!existing) {
            err(
              errors,
              'Employees',
              r.excelRow,
              'Contract type',
              `No contract type "${v.contractType}" in the file or the database.`,
            );
            ok = false;
          } else contractTypeId = existing.id;
        } else contractTypeId = found;
      }
      let rate: number | null | undefined;
      if (v.rate !== '') {
        const n = cellNumber(v.rate);
        if (n === null || Number.isNaN(n)) {
          err(errors, 'Employees', r.excelRow, 'Rate ZAR/hr', `"${v.rate}" is not a number.`);
          ok = false;
        } else rate = n;
      }
      const payload = {
        name: v.name.trim(),
        surname: v.surname.trim(),
        mobile: opt(v.mobile),
        email,
        idNumber,
        startDate: v.startDate.trim(),
        endDate: opt(v.endDate),
        brokerId,
        contractTypeId,
        rate: rate ?? null,
      };
      if (
        ok &&
        !zodReport(
          errors,
          'Employees',
          r.excelRow,
          employeeUpsertSchema.safeParse(fk(payload, 'brokerId', 'contractTypeId')),
        )
      )
        ok = false;
      if (!ok) {
        fail();
        continue;
      }
      const id = dryId();
      employeeRows.push({ row: r, planId: id, managerEmail: v.managerEmail.trim() });
      plan.employees.push({ data: payload, id });
      if (email) employeeIds.set(email, id);
    }
    // Second pass: managers, now that every file employee has an id.
    for (const e of employeeRows) {
      if (e.managerEmail === '') continue;
      const key = e.managerEmail.toLowerCase();
      const inFile = employeeIds.get(key);
      if (inFile !== undefined) {
        plan.employeeManagers.push({ employeeId: e.planId, managerId: inFile });
      } else {
        const existing = await prisma.employee.findUnique({
          where: { email: key },
          select: { id: true },
        });
        if (!existing) {
          err(
            errors,
            'Employees',
            e.row.excelRow,
            'Manager email',
            `No employee "${e.managerEmail}" in the file or the database.`,
          );
          fail();
        } else {
          plan.employeeManagers.push({ employeeId: e.planId, managerId: existing.id });
        }
      }
    }
  }

  // ---- Contracts ----
  const contractIds = new Map<string, number>();
  {
    const seen = new Map<string, number>();
    for (const r of rows('Contracts')) {
      const v = r.values;
      let ok = true;
      if (!v.clientEmail) {
        err(errors, 'Contracts', r.excelRow, 'Client email', 'Required.');
        ok = false;
      }
      if (!v.number) {
        err(errors, 'Contracts', r.excelRow, 'Contract number', 'Required.');
        ok = false;
      }
      if (!v.description) {
        err(errors, 'Contracts', r.excelRow, 'Description', 'Required.');
        ok = false;
      }
      const clientId = v.clientEmail ? await resolveClient(v.clientEmail) : null;
      if (v.clientEmail && clientId === null) {
        err(
          errors,
          'Contracts',
          r.excelRow,
          'Client email',
          `No client "${v.clientEmail}" in the file or the database.`,
        );
        ok = false;
      }
      const number = v.number.trim();
      if (v.number) {
        if (dupWithin(seen, number.toLowerCase()) !== null) {
          err(
            errors,
            'Contracts',
            r.excelRow,
            'Contract number',
            `Duplicate of row ${seen.get(number.toLowerCase())} in this sheet.`,
          );
          ok = false;
        }
        seen.set(number.toLowerCase(), r.excelRow);
        if (await prisma.contract.findUnique({ where: { number } })) {
          err(
            errors,
            'Contracts',
            r.excelRow,
            'Contract number',
            `Contract "${number}" already exists. Existing rows are never overwritten.`,
          );
          ok = false;
        }
      }
      if (!ok) {
        fail();
        continue;
      }
      const payload = {
        clientId: clientId!,
        number,
        description: v.description.trim(),
        type: opt(v.type),
      };
      if (
        !zodReport(
          errors,
          'Contracts',
          r.excelRow,
          contractUpsertSchema.safeParse(fk(payload, 'clientId')),
        )
      ) {
        fail();
        continue;
      }
      const id = dryId();
      plan.contracts.push({ data: payload, id });
      contractIds.set(number.toLowerCase(), id);
    }
  }

  async function resolveContract(numberRaw: string): Promise<number | null> {
    const key = numberRaw.trim().toLowerCase();
    const inFile = contractIds.get(key);
    if (inFile !== undefined) return inFile;
    const existing = await prisma.contract.findUnique({ where: { number: numberRaw.trim() } });
    return existing?.id ?? null;
  }

  // ---- Amendments ----
  const amendmentIds = new Map<string, number>();
  {
    const seen = new Map<string, number>();
    for (const r of rows('Amendments')) {
      const v = r.values;
      let ok = true;
      if (!v.contractNumber) {
        err(errors, 'Amendments', r.excelRow, 'Contract number', 'Required.');
        ok = false;
      }
      if (!v.amendmentNumber) {
        err(errors, 'Amendments', r.excelRow, 'Amendment number', 'Required.');
        ok = false;
      }
      if (!v.effectiveDate) {
        err(errors, 'Amendments', r.excelRow, 'Effective date', 'Required.');
        ok = false;
      }
      const contractId = v.contractNumber ? await resolveContract(v.contractNumber) : null;
      if (v.contractNumber && contractId === null) {
        err(
          errors,
          'Amendments',
          r.excelRow,
          'Contract number',
          `No contract "${v.contractNumber}" in the file or the database.`,
        );
        ok = false;
      }
      const pairKey = `${v.contractNumber.trim().toLowerCase()}|${v.amendmentNumber.trim().toLowerCase()}`;
      if (v.contractNumber && v.amendmentNumber) {
        if (dupWithin(seen, pairKey) !== null) {
          err(
            errors,
            'Amendments',
            r.excelRow,
            'Amendment number',
            `Duplicate of row ${seen.get(pairKey)} in this sheet (same contract).`,
          );
          ok = false;
        }
        seen.set(pairKey, r.excelRow);
        if (contractId !== null && contractId > 0) {
          const clash = await prisma.contractAmendment.findFirst({
            where: { contractId, amendmentNumber: v.amendmentNumber.trim() },
          });
          if (clash) {
            err(
              errors,
              'Amendments',
              r.excelRow,
              'Amendment number',
              `Amendment "${v.amendmentNumber}" already exists on contract "${v.contractNumber}".`,
            );
            ok = false;
          }
        }
      }
      const amendmentType = v.amendmentType === '' ? 'Annual Escalation' : v.amendmentType.trim();
      const status = v.status === '' ? 'Active' : v.status.trim();
      if (enumKey(errors, 'Amendments', r.excelRow, 'Type', amendmentType, AMENDMENT_TYPE) === null)
        ok = false;
      if (
        enumKey(errors, 'Amendments', r.excelRow, 'Status', status, CONTRACT_AMENDMENT_STATUS) ===
        null
      )
        ok = false;
      let vatRate: number | undefined;
      if (v.vatRate === '') vatRate = 0.15;
      else {
        const n = cellNumber(v.vatRate);
        if (n === null || Number.isNaN(n)) {
          err(
            errors,
            'Amendments',
            r.excelRow,
            'VAT rate fraction',
            `"${v.vatRate}" is not a number. Use a fraction: 0.15 means 15%.`,
          );
          ok = false;
        } else vatRate = n;
      }
      if (v.effectiveDate && v.expiryDate && v.expiryDate < v.effectiveDate) {
        warnings.push({
          sheet: 'Amendments',
          row: r.excelRow,
          column: 'Expiry date',
          message: 'Expiry is before the effective date.',
        });
      }
      if (!ok) {
        fail();
        continue;
      }
      const payload = {
        contractId: contractId!,
        amendmentNumber: v.amendmentNumber.trim(),
        amendmentType,
        effectiveDate: v.effectiveDate.trim(),
        expiryDate: opt(v.expiryDate),
        status,
        signedDate: opt(v.signedDate),
        notes: opt(v.notes),
        vatRate,
      };
      if (
        !zodReport(
          errors,
          'Amendments',
          r.excelRow,
          amendmentUpsertSchema.safeParse(fk(payload, 'contractId')),
        )
      ) {
        fail();
        continue;
      }
      const id = dryId();
      plan.amendments.push({ data: payload, id });
      amendmentIds.set(pairKey, id);
    }
  }

  async function resolveAmendment(
    contractRaw: string,
    amendmentRaw: string,
  ): Promise<number | null> {
    const key = `${contractRaw.trim().toLowerCase()}|${amendmentRaw.trim().toLowerCase()}`;
    const inFile = amendmentIds.get(key);
    if (inFile !== undefined) return inFile;
    const contractId = await resolveContract(contractRaw);
    if (contractId === null || contractId < 0) return null;
    const existing = await prisma.contractAmendment.findFirst({
      where: { contractId, amendmentNumber: amendmentRaw.trim() },
    });
    return existing?.id ?? null;
  }

  // ---- Cost parameters ----
  {
    const seen = new Map<string, number>();
    for (const r of rows('CostParameters')) {
      const v = r.values;
      let ok = true;
      if (!v.contractNumber) {
        err(errors, 'CostParameters', r.excelRow, 'Contract number', 'Required.');
        ok = false;
      }
      if (!v.amendmentNumber) {
        err(errors, 'CostParameters', r.excelRow, 'Amendment number', 'Required.');
        ok = false;
      }
      if (!v.category) {
        err(errors, 'CostParameters', r.excelRow, 'Category', 'Required.');
        ok = false;
      }
      if (!v.parameterName) {
        err(errors, 'CostParameters', r.excelRow, 'Parameter name', 'Required.');
        ok = false;
      }
      if (!v.uom) {
        err(errors, 'CostParameters', r.excelRow, 'UoM', 'Required.');
        ok = false;
      }
      const amendmentId =
        v.contractNumber && v.amendmentNumber
          ? await resolveAmendment(v.contractNumber, v.amendmentNumber)
          : null;
      if (v.contractNumber && v.amendmentNumber && amendmentId === null) {
        err(
          errors,
          'CostParameters',
          r.excelRow,
          'Amendment number',
          `No amendment "${v.amendmentNumber}" on contract "${v.contractNumber}" in the file or the database.`,
        );
        ok = false;
      }
      const pairKey = `${amendmentId}|${v.parameterName.trim().toLowerCase()}`;
      if (v.parameterName) {
        if (dupWithin(seen, pairKey) !== null) {
          err(
            errors,
            'CostParameters',
            r.excelRow,
            'Parameter name',
            `Duplicate of row ${seen.get(pairKey)} in this sheet (same amendment).`,
          );
          ok = false;
        }
        seen.set(pairKey, r.excelRow);
        if (amendmentId !== null && amendmentId > 0) {
          const clash = await prisma.contractCostParameter.findFirst({
            where: { amendmentId, parameterName: v.parameterName.trim() },
          });
          if (clash) {
            err(
              errors,
              'CostParameters',
              r.excelRow,
              'Parameter name',
              `Parameter "${v.parameterName}" already exists on this amendment.`,
            );
            ok = false;
          }
        }
      }
      // Kept as the display label for zod validation; mapped to the Prisma
      // key at apply time. Mapping first would fail validation, which speaks
      // labels — this exact bug was caught by the dry run.
      let category: string | null = null;
      if (v.category) {
        if (
          enumKey(
            errors,
            'CostParameters',
            r.excelRow,
            'Category',
            v.category.trim(),
            COST_PARAMETER_CATEGORY,
          ) === null
        )
          ok = false;
        else category = v.category.trim();
      } else {
        err(errors, 'CostParameters', r.excelRow, 'Category', 'Required.');
        ok = false;
      }
      let numericValue: number | null = null;
      if (v.numericValue === '') {
        err(errors, 'CostParameters', r.excelRow, 'Value', 'Required.');
        ok = false;
      } else {
        const n = cellNumber(v.numericValue);
        if (n === null || Number.isNaN(n)) {
          err(
            errors,
            'CostParameters',
            r.excelRow,
            'Value',
            `"${v.numericValue}" is not a number.`,
          );
          ok = false;
        } else numericValue = n;
      }
      if (!ok) {
        fail();
        continue;
      }
      const payload = {
        amendmentId: amendmentId!,
        category: category!,
        parameterName: v.parameterName.trim(),
        numericValue: numericValue!,
        uom: v.uom.trim(),
        notes: opt(v.notes),
      };
      if (
        !zodReport(
          errors,
          'CostParameters',
          r.excelRow,
          costParameterUpsertSchema.safeParse(fk(payload, 'amendmentId')),
        )
      ) {
        fail();
        continue;
      }
      plan.costParams.push({ data: payload });
    }
  }

  // ---- Rate cards ----
  // Keyed by amendment + code + shift, and by amendment + trade + shift.
  const rateCardIds = new Map<string, number>();
  {
    const seenCode = new Map<string, number>();
    const seenTrade = new Map<string, number>();
    for (const r of rows('RateCards')) {
      const v = r.values;
      let ok = true;
      if (!v.contractNumber) {
        err(errors, 'RateCards', r.excelRow, 'Contract number', 'Required.');
        ok = false;
      }
      if (!v.amendmentNumber) {
        err(errors, 'RateCards', r.excelRow, 'Amendment number', 'Required.');
        ok = false;
      }
      if (!v.serviceMasterCode) {
        err(errors, 'RateCards', r.excelRow, 'Rate code', 'Required.');
        ok = false;
      }
      if (!v.labourType) {
        err(errors, 'RateCards', r.excelRow, 'Trade / labour type', 'Required.');
        ok = false;
      }
      const amendmentId =
        v.contractNumber && v.amendmentNumber
          ? await resolveAmendment(v.contractNumber, v.amendmentNumber)
          : null;
      if (v.contractNumber && v.amendmentNumber && amendmentId === null) {
        err(
          errors,
          'RateCards',
          r.excelRow,
          'Amendment number',
          `No amendment "${v.amendmentNumber}" on contract "${v.contractNumber}" in the file or the database.`,
        );
        ok = false;
      }
      const shift = v.shiftType === '' ? 'NT' : v.shiftType.trim();
      if (enumKey(errors, 'RateCards', r.excelRow, 'Shift', shift, SHIFT_TYPE) === null) ok = false;
      const num = (col: string, raw: string, def?: number): number | undefined => {
        if (raw === '') return def;
        const n = cellNumber(raw);
        if (n === null || Number.isNaN(n)) {
          err(errors, 'RateCards', r.excelRow, col, `"${raw}" is not a number.`);
          ok = false;
          return undefined;
        }
        return n;
      };
      const councilRate = num('Council rate', v.councilRate);
      const customRate = num('Custom rate', v.customRate);
      if (
        councilRate === undefined &&
        customRate === undefined &&
        v.councilRate === '' &&
        v.customRate === ''
      ) {
        err(
          errors,
          'RateCards',
          r.excelRow,
          'Council rate',
          'Provide either a council rate or a custom rate.',
        );
        ok = false;
      }
      const wagePremiumPct = num('Wage premium fraction', v.wagePremiumPct, 0) ?? 0;
      const leavePay = num('Leave pay', v.leavePay, 0) ?? 0;
      const totalStatutoryCost = num('Statutory', v.totalStatutoryCost, 0) ?? 0;
      const ppeCost = num('PPE cost', v.ppeCost, 0) ?? 0;
      const transportCost = num('Transport cost', v.transportCost, 0) ?? 0;
      const equipmentCost = num('Equipment cost', v.equipmentCost, 0) ?? 0;
      const overheadCost = num('Overhead cost', v.overheadCost);
      const sgaCost = num('SG&A cost', v.sgaCost);
      const profitPct = num('Profit fraction', v.profitPct, 0) ?? 0;
      if ((overheadCost === undefined) !== (sgaCost === undefined)) {
        err(
          errors,
          'RateCards',
          r.excelRow,
          'Overhead cost',
          'Overhead and SG&A come as a pair: provide both authoritative amounts, or leave both blank to derive them from the amendment parameters.',
        );
        ok = false;
      }
      const deriving = overheadCost === undefined && sgaCost === undefined;
      if (deriving && amendmentId !== null) {
        // saveRateCard would fail here without an Operational Overhead %
        // parameter; surface it now with the sheet and row attached. Both
        // parameters are required, not just overhead: deriving SG&A from an
        // implicit zero would silently underprice every hour.
        const need = [COST_PARAMETER_NAMES.overheadPct, COST_PARAMETER_NAMES.sgaPct];
        const missing: string[] = [];
        for (const name of need) {
          const inFile = plan.costParams.some(
            (p) =>
              (p.data.amendmentId as number) === amendmentId &&
              (p.data.parameterName as string).toLowerCase() === name.toLowerCase(),
          );
          const inDb =
            amendmentId > 0 &&
            (await prisma.contractCostParameter.findFirst({
              where: { amendmentId, parameterName: name },
              select: { id: true },
            }));
          if (!inFile && !inDb) missing.push(name);
        }
        if (missing.length > 0) {
          err(
            errors,
            'RateCards',
            r.excelRow,
            'Overhead cost',
            `Overheads are blank so they must derive from the amendment, but ${missing.map((m) => `"${m}"`).join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing from the CostParameters sheet and the database. Add the parameter(s) or type authoritative amounts.`,
          );
          ok = false;
        }
      }
      if (!ok) {
        fail();
        continue;
      }
      const codeKey = `${amendmentId}|${v.serviceMasterCode.trim().toLowerCase()}|${shift}`;
      const tradeKey = `${amendmentId}|${v.labourType.trim().toLowerCase()}|${shift}`;
      for (const [map, key, what] of [
        [seenCode, codeKey, 'rate code'],
        [seenTrade, tradeKey, 'trade + shift'],
      ] as const) {
        if (dupWithin(map, key) !== null) {
          err(
            errors,
            'RateCards',
            r.excelRow,
            'Rate code',
            `Duplicate ${what} of row ${map.get(key)} in this sheet (same amendment).`,
          );
          ok = false;
        }
        map.set(key, r.excelRow);
      }
      if (amendmentId !== null && amendmentId > 0) {
        const clash = await prisma.serviceMasterRate.findFirst({
          where: {
            amendmentId,
            OR: [
              { serviceMasterCode: v.serviceMasterCode.trim(), shiftType: shift as never },
              { labourType: v.labourType.trim(), shiftType: shift as never },
            ],
          },
          select: { id: true },
        });
        if (clash) {
          err(
            errors,
            'RateCards',
            r.excelRow,
            'Rate code',
            'A rate card with this code or trade + shift already exists on the amendment.',
          );
          ok = false;
        }
      }
      if (!ok) {
        fail();
        continue;
      }
      const input = {
        amendmentId: amendmentId!,
        serviceMasterCode: v.serviceMasterCode.trim(),
        labourType: v.labourType.trim(),
        shiftType: shift,
        uom: v.uom === '' ? 'per Hour' : v.uom.trim(),
        bargainingCouncilDesc: opt(v.bargainingCouncilDesc),
        councilRate: councilRate ?? null,
        customRate: customRate ?? null,
        wagePremiumPct,
        leavePay,
        totalStatutoryCost,
        ppeCost,
        transportCost,
        equipmentCost,
        overheadCost: overheadCost ?? null,
        sgaCost: sgaCost ?? null,
        profitPct,
      };
      if (
        !zodReport(
          errors,
          'RateCards',
          r.excelRow,
          serviceMasterRateUpsertSchema.safeParse(fk(input, 'amendmentId')),
        )
      ) {
        fail();
        continue;
      }
      const id = dryId();
      plan.rateCards.push({ input, derive: deriving, id, computedRate: 0 });
      rateCardIds.set(codeKey, id);
      rateCardIds.set(tradeKey, id);
    }
  }

  async function resolveRateCard(
    amendmentId: number,
    codeRaw: string,
    shiftRaw: string,
  ): Promise<number | null> {
    const key = `${amendmentId}|${codeRaw.trim().toLowerCase()}|${(shiftRaw === '' ? 'NT' : shiftRaw).trim()}`;
    const inFile = rateCardIds.get(key);
    if (inFile !== undefined) return inFile;
    if (amendmentId < 0) return null;
    const existing = await prisma.serviceMasterRate.findFirst({
      where: {
        amendmentId,
        serviceMasterCode: codeRaw.trim(),
        shiftType: (shiftRaw === '' ? 'NT' : shiftRaw.trim()) as never,
      },
      select: { id: true },
    });
    return existing?.id ?? null;
  }

  // ---- Service codes ----
  const serviceCodeIds = new Map<string, number>();
  {
    const seen = new Map<string, number>();
    for (const r of rows('ServiceCodes')) {
      const v = r.values;
      let ok = true;
      if (!v.contractNumber) {
        err(errors, 'ServiceCodes', r.excelRow, 'Contract number', 'Required.');
        ok = false;
      }
      if (!v.amendmentNumber) {
        err(errors, 'ServiceCodes', r.excelRow, 'Amendment number', 'Required.');
        ok = false;
      }
      if (!v.code) {
        err(errors, 'ServiceCodes', r.excelRow, 'Code', 'Required.');
        ok = false;
      }
      if (!v.description) {
        err(errors, 'ServiceCodes', r.excelRow, 'Description', 'Required.');
        ok = false;
      }
      if (!v.uom) {
        err(errors, 'ServiceCodes', r.excelRow, 'UoM', 'Required.');
        ok = false;
      }
      const amendmentId =
        v.contractNumber && v.amendmentNumber
          ? await resolveAmendment(v.contractNumber, v.amendmentNumber)
          : null;
      if (v.contractNumber && v.amendmentNumber && amendmentId === null) {
        err(
          errors,
          'ServiceCodes',
          r.excelRow,
          'Amendment number',
          `No amendment "${v.amendmentNumber}" on contract "${v.contractNumber}" in the file or the database.`,
        );
        ok = false;
      }
      const category = v.category === '' ? 'Activity' : v.category.trim();
      if (
        enumKey(errors, 'ServiceCodes', r.excelRow, 'Category', category, SERVICE_CODE_CATEGORY) ===
        null
      )
        ok = false;
      let markup = 0;
      if (v.materialMarkupPct !== '') {
        const n = cellNumber(v.materialMarkupPct);
        if (n === null || Number.isNaN(n)) {
          err(
            errors,
            'ServiceCodes',
            r.excelRow,
            'Material markup fraction',
            `"${v.materialMarkupPct}" is not a number. Use a fraction: 0.10 means 10%.`,
          );
          ok = false;
        } else markup = n;
      }
      const codeKey = `${amendmentId}|${v.code.trim().toLowerCase()}`;
      if (v.code) {
        if (dupWithin(seen, codeKey) !== null) {
          err(
            errors,
            'ServiceCodes',
            r.excelRow,
            'Code',
            `Duplicate of row ${seen.get(codeKey)} in this sheet (same amendment).`,
          );
          ok = false;
        }
        seen.set(codeKey, r.excelRow);
        if (amendmentId !== null && amendmentId > 0) {
          const clash = await prisma.serviceCode.findFirst({
            where: { amendmentId, code: v.code.trim() },
            select: { id: true },
          });
          if (clash) {
            err(
              errors,
              'ServiceCodes',
              r.excelRow,
              'Code',
              `Service code "${v.code}" already exists on this amendment.`,
            );
            ok = false;
          }
        }
      }
      if (!ok) {
        fail();
        continue;
      }
      const payload = {
        amendmentId: amendmentId!,
        code: v.code.trim(),
        description: v.description.trim(),
        category,
        uom: v.uom.trim(),
        materialMarkupPct: markup,
      };
      if (
        !zodReport(
          errors,
          'ServiceCodes',
          r.excelRow,
          serviceCodeUpsertSchema.safeParse(fk(payload, 'amendmentId')),
        )
      ) {
        fail();
        continue;
      }
      const id = dryId();
      plan.serviceCodes.push({ data: payload, id, computedRate: 0 });
      serviceCodeIds.set(codeKey, id);
    }
  }

  async function resolveServiceCode(amendmentId: number, codeRaw: string): Promise<number | null> {
    const key = `${amendmentId}|${codeRaw.trim().toLowerCase()}`;
    const inFile = serviceCodeIds.get(key);
    if (inFile !== undefined) return inFile;
    if (amendmentId < 0) return null;
    const existing = await prisma.serviceCode.findFirst({
      where: { amendmentId, code: codeRaw.trim() },
      select: { id: true },
    });
    return existing?.id ?? null;
  }

  // ---- Recipe labour ----
  {
    const seen = new Map<string, number>();
    for (const r of rows('RecipeLabour')) {
      const v = r.values;
      let ok = true;
      if (!v.contractNumber) {
        err(errors, 'RecipeLabour', r.excelRow, 'Contract number', 'Required.');
        ok = false;
      }
      if (!v.amendmentNumber) {
        err(errors, 'RecipeLabour', r.excelRow, 'Amendment number', 'Required.');
        ok = false;
      }
      if (!v.serviceCode) {
        err(errors, 'RecipeLabour', r.excelRow, 'Service code', 'Required.');
        ok = false;
      }
      if (!v.rateCardCode) {
        err(errors, 'RecipeLabour', r.excelRow, 'Rate code', 'Required.');
        ok = false;
      }
      const amendmentId =
        v.contractNumber && v.amendmentNumber
          ? await resolveAmendment(v.contractNumber, v.amendmentNumber)
          : null;
      if (v.contractNumber && v.amendmentNumber && amendmentId === null) {
        err(
          errors,
          'RecipeLabour',
          r.excelRow,
          'Amendment number',
          `No amendment "${v.amendmentNumber}" on contract "${v.contractNumber}" in the file or the database.`,
        );
        ok = false;
      }
      const codeId =
        amendmentId !== null && v.serviceCode
          ? await resolveServiceCode(amendmentId, v.serviceCode)
          : null;
      if (v.serviceCode && amendmentId !== null && codeId === null) {
        err(
          errors,
          'RecipeLabour',
          r.excelRow,
          'Service code',
          `No service code "${v.serviceCode}" on this amendment in the file or the database.`,
        );
        ok = false;
      }
      const shift = v.shiftType === '' ? 'NT' : v.shiftType.trim();
      const rateId =
        amendmentId !== null && v.rateCardCode
          ? await resolveRateCard(amendmentId, v.rateCardCode, shift)
          : null;
      if (v.rateCardCode && amendmentId !== null && rateId === null) {
        err(
          errors,
          'RecipeLabour',
          r.excelRow,
          'Rate code',
          `No rate card "${v.rateCardCode}" (${shift}) on this amendment in the file or the database.`,
        );
        ok = false;
      }
      const crew = v.crewQuantity === '' ? 1 : cellNumber(v.crewQuantity);
      if (crew === null || (typeof crew === 'number' && Number.isNaN(crew))) {
        err(errors, 'RecipeLabour', r.excelRow, 'Crew qty', `"${v.crewQuantity}" is not a number.`);
        ok = false;
      }
      let hours: number | null = null;
      if (v.hoursPerUnit === '') {
        err(errors, 'RecipeLabour', r.excelRow, 'Hours per unit', 'Required.');
        ok = false;
      } else {
        const n = cellNumber(v.hoursPerUnit);
        if (n === null || Number.isNaN(n)) {
          err(
            errors,
            'RecipeLabour',
            r.excelRow,
            'Hours per unit',
            `"${v.hoursPerUnit}" is not a number.`,
          );
          ok = false;
        } else hours = n;
      }
      const pairKey = `${codeId}|${rateId}`;
      if (codeId !== null && rateId !== null) {
        if (dupWithin(seen, pairKey) !== null) {
          err(
            errors,
            'RecipeLabour',
            r.excelRow,
            'Rate code',
            `Duplicate of row ${seen.get(pairKey)} in this sheet (same code + rate).`,
          );
          ok = false;
        }
        seen.set(pairKey, r.excelRow);
      }
      if (!ok) {
        fail();
        continue;
      }
      const payload = {
        serviceCodeId: codeId!,
        serviceMasterRateId: rateId!,
        crewQuantity: crew as number,
        hoursPerUnit: hours!,
      };
      if (
        !zodReport(
          errors,
          'RecipeLabour',
          r.excelRow,
          labourItemUpsertSchema.safeParse(fk(payload, 'serviceCodeId', 'serviceMasterRateId')),
        )
      ) {
        fail();
        continue;
      }
      plan.recipeLabour.push({ data: payload });
    }
  }

  // ---- Recipe material ----
  {
    for (const r of rows('RecipeMaterial')) {
      const v = r.values;
      let ok = true;
      if (!v.contractNumber) {
        err(errors, 'RecipeMaterial', r.excelRow, 'Contract number', 'Required.');
        ok = false;
      }
      if (!v.amendmentNumber) {
        err(errors, 'RecipeMaterial', r.excelRow, 'Amendment number', 'Required.');
        ok = false;
      }
      if (!v.serviceCode) {
        err(errors, 'RecipeMaterial', r.excelRow, 'Service code', 'Required.');
        ok = false;
      }
      if (!v.description) {
        err(errors, 'RecipeMaterial', r.excelRow, 'Description', 'Required.');
        ok = false;
      }
      const amendmentId =
        v.contractNumber && v.amendmentNumber
          ? await resolveAmendment(v.contractNumber, v.amendmentNumber)
          : null;
      if (v.contractNumber && v.amendmentNumber && amendmentId === null) {
        err(
          errors,
          'RecipeMaterial',
          r.excelRow,
          'Amendment number',
          `No amendment "${v.amendmentNumber}" on contract "${v.contractNumber}" in the file or the database.`,
        );
        ok = false;
      }
      const codeId =
        amendmentId !== null && v.serviceCode
          ? await resolveServiceCode(amendmentId, v.serviceCode)
          : null;
      if (v.serviceCode && amendmentId !== null && codeId === null) {
        err(
          errors,
          'RecipeMaterial',
          r.excelRow,
          'Service code',
          `No service code "${v.serviceCode}" on this amendment in the file or the database.`,
        );
        ok = false;
      }
      let unitCost: number | null = null;
      if (v.unitCost === '') {
        err(errors, 'RecipeMaterial', r.excelRow, 'Unit cost', 'Required.');
        ok = false;
      } else {
        const n = cellNumber(v.unitCost);
        if (n === null || Number.isNaN(n)) {
          err(
            errors,
            'RecipeMaterial',
            r.excelRow,
            'Unit cost',
            `"${v.unitCost}" is not a number.`,
          );
          ok = false;
        } else unitCost = n;
      }
      const quantity = v.quantity === '' ? 1 : cellNumber(v.quantity);
      if (quantity === null || (typeof quantity === 'number' && Number.isNaN(quantity))) {
        err(errors, 'RecipeMaterial', r.excelRow, 'Quantity', `"${v.quantity}" is not a number.`);
        ok = false;
      }
      if (!ok) {
        fail();
        continue;
      }
      const payload = {
        serviceCodeId: codeId!,
        itemCode: opt(v.itemCode),
        description: v.description.trim(),
        supplierName: opt(v.supplierName),
        unitCost: unitCost!,
        quantity: quantity as number,
        uom: v.uom === '' ? 'EA' : v.uom.trim(),
      };
      if (
        !zodReport(
          errors,
          'RecipeMaterial',
          r.excelRow,
          materialItemUpsertSchema.safeParse(fk(payload, 'serviceCodeId')),
        )
      ) {
        fail();
        continue;
      }
      plan.recipeMaterial.push({ data: payload });
    }
  }

  // ---- Projects ----
  const projectIds = new Map<string, number>();
  {
    const seen = new Map<string, number>();
    for (const r of rows('Projects')) {
      const v = r.values;
      let ok = true;
      if (!v.contractNumber) {
        err(errors, 'Projects', r.excelRow, 'Contract number', 'Required.');
        ok = false;
      }
      if (!v.amendmentNumber) {
        err(errors, 'Projects', r.excelRow, 'Amendment number', 'Required.');
        ok = false;
      }
      if (!v.code) {
        err(errors, 'Projects', r.excelRow, 'Project code', 'Required.');
        ok = false;
      }
      if (!v.year) {
        err(errors, 'Projects', r.excelRow, 'Year', 'Required.');
        ok = false;
      }
      const contractId = v.contractNumber ? await resolveContract(v.contractNumber) : null;
      if (v.contractNumber && contractId === null) {
        err(
          errors,
          'Projects',
          r.excelRow,
          'Contract number',
          `No contract "${v.contractNumber}" in the file or the database.`,
        );
        ok = false;
      }
      const amendmentId =
        v.contractNumber && v.amendmentNumber
          ? await resolveAmendment(v.contractNumber, v.amendmentNumber)
          : null;
      if (v.contractNumber && v.amendmentNumber && amendmentId === null) {
        err(
          errors,
          'Projects',
          r.excelRow,
          'Amendment number',
          `No amendment "${v.amendmentNumber}" on contract "${v.contractNumber}" in the file or the database — and it must belong to that contract, not just exist.`,
        );
        ok = false;
      }
      const code = v.code.trim();
      if (v.code) {
        if (dupWithin(seen, code.toLowerCase()) !== null) {
          err(
            errors,
            'Projects',
            r.excelRow,
            'Project code',
            `Duplicate of row ${seen.get(code.toLowerCase())} in this sheet.`,
          );
          ok = false;
        }
        seen.set(code.toLowerCase(), r.excelRow);
        if (await prisma.project.findUnique({ where: { code } })) {
          err(
            errors,
            'Projects',
            r.excelRow,
            'Project code',
            `Project "${code}" already exists. Existing rows are never overwritten.`,
          );
          ok = false;
        }
      }
      if (!ok) {
        fail();
        continue;
      }
      const payload = {
        contractId: contractId!,
        amendmentId: amendmentId!,
        code,
        year: v.year.trim(),
        startDate: opt(v.startDate),
        endDate: opt(v.endDate),
        description: opt(v.description),
      };
      if (
        !zodReport(
          errors,
          'Projects',
          r.excelRow,
          projectUpsertSchema.safeParse(fk(payload, 'contractId', 'amendmentId')),
        )
      ) {
        fail();
        continue;
      }
      const id = dryId();
      plan.projects.push({ data: payload, id, contractNumber: v.contractNumber.trim() });
      projectIds.set(code.toLowerCase(), id);
    }
  }

  async function resolveProject(codeRaw: string): Promise<number | null> {
    const key = codeRaw.trim().toLowerCase();
    const inFile = projectIds.get(key);
    if (inFile !== undefined) return inFile;
    const existing = await prisma.project.findUnique({ where: { code: codeRaw.trim() } });
    return existing?.id ?? null;
  }

  // ---- Jobs ----
  const jobIdsByRef = new Map<string, number>();
  {
    const seen = new Map<string, number>();
    for (const r of rows('Jobs')) {
      const v = r.values;
      let ok = true;
      if (!v.ref) {
        err(
          errors,
          'Jobs',
          r.excelRow,
          'Ref',
          'Required. Give the row a key (e.g. JOB-001) so lines and crew can point at it.',
        );
        ok = false;
      }
      if (!v.projectCode) {
        err(errors, 'Jobs', r.excelRow, 'Project code', 'Required.');
        ok = false;
      }
      const ref = v.ref.trim();
      if (v.ref) {
        if (dupWithin(seen, ref.toLowerCase()) !== null) {
          err(
            errors,
            'Jobs',
            r.excelRow,
            'Ref',
            `Duplicate of row ${seen.get(ref.toLowerCase())} in this sheet.`,
          );
          ok = false;
        }
        seen.set(ref.toLowerCase(), r.excelRow);
      }
      const projectId = v.projectCode ? await resolveProject(v.projectCode) : null;
      if (v.projectCode && projectId === null) {
        err(
          errors,
          'Jobs',
          r.excelRow,
          'Project code',
          `No project "${v.projectCode}" in the file or the database.`,
        );
        ok = false;
      }
      // The project's contract decides which amendment values are legal.
      let projectContractId: number | null = null;
      if (projectId !== null) {
        if (projectId < 0) {
          const entry = plan.projects.find((p) => p.id === projectId);
          projectContractId = (entry?.data.contractId as number) ?? null;
        } else {
          const existing = await prisma.project.findUnique({
            where: { id: projectId },
            select: { contractId: true },
          });
          projectContractId = existing?.contractId ?? null;
        }
      }
      let amendmentId: number | null = null;
      if (v.amendmentNumber !== '') {
        // Resolve within the project's contract by exact (contract, number) key,
        // so a same-named amendment on another contract cannot slip through.
        const wanted = v.amendmentNumber.trim();
        let contractNumber: string | null = null;
        if (projectId !== null) {
          if (projectId < 0) {
            contractNumber = plan.projects.find((p) => p.id === projectId)?.contractNumber ?? null;
          } else {
            const existing = await prisma.project.findUnique({
              where: { id: projectId },
              select: { contract: { select: { number: true } } },
            });
            contractNumber = existing?.contract.number ?? null;
          }
        }
        const candidates: number[] = [];
        if (contractNumber !== null) {
          const inFile = amendmentIds.get(
            `${contractNumber.toLowerCase()}|${wanted.toLowerCase()}`,
          );
          if (inFile !== undefined) candidates.push(inFile);
        }
        if (projectContractId !== null && projectContractId > 0) {
          const db = await prisma.contractAmendment.findMany({
            where: { contractId: projectContractId, amendmentNumber: wanted },
            select: { id: true },
          });
          candidates.push(...db.map((a) => a.id));
        }
        if (candidates.length === 0) {
          err(
            errors,
            'Jobs',
            r.excelRow,
            'Amendment number',
            `No amendment "${wanted}" on this job's contract in the file or the database.`,
          );
          ok = false;
        } else if (candidates.length > 1) {
          err(
            errors,
            'Jobs',
            r.excelRow,
            'Amendment number',
            `Amendment "${wanted}" is ambiguous — name it exactly as on the Amendments sheet.`,
          );
          ok = false;
        } else amendmentId = candidates[0]!;
      }
      let supervisorId: number | null = null;
      if (v.supervisorEmail !== '') {
        const key = v.supervisorEmail.trim().toLowerCase();
        const inFile = employeeIds.get(key);
        if (inFile !== undefined) supervisorId = inFile;
        else {
          const existing = await prisma.employee.findUnique({
            where: { email: key },
            select: { id: true },
          });
          if (!existing) {
            err(
              errors,
              'Jobs',
              r.excelRow,
              'Supervisor email',
              `No employee "${v.supervisorEmail}" in the file or the database.`,
            );
            ok = false;
          } else supervisorId = existing.id;
        }
      }
      let clientContactId: number | null = null;
      if (v.contactEmail !== '') {
        const resolved = await resolveContact(v.contactEmail);
        if (resolved === null) {
          err(
            errors,
            'Jobs',
            r.excelRow,
            'Contact email',
            `No contact "${v.contactEmail}" in the file or the database. Contacts without an email cannot be linked — link them in the app.`,
          );
          ok = false;
        } else if (resolved === 'ambiguous') {
          err(
            errors,
            'Jobs',
            r.excelRow,
            'Contact email',
            `More than one contact uses "${v.contactEmail}" — make it unique, then re-run.`,
          );
          ok = false;
        } else clientContactId = resolved;
      }
      const priority = v.priority === '' ? 'P3 - Routine / Normal' : v.priority.trim();
      if (enumKey(errors, 'Jobs', r.excelRow, 'Priority', priority, JOB_PRIORITY) === null)
        ok = false;
      const status = v.status === '' ? '01. Scoping' : v.status.trim();
      if (!(IMPORT_JOB_STATUSES as readonly string[]).includes(status)) {
        err(
          errors,
          'Jobs',
          r.excelRow,
          'Status',
          `"${status}" cannot be imported. Open work only: ${IMPORT_JOB_STATUSES.join(' · ')}. Later stages are reached by using the system.`,
        );
        ok = false;
      }
      if (!ok) {
        fail();
        continue;
      }
      const payload = {
        projectId: projectId!,
        amendmentId,
        supervisorId,
        clientContactId,
        priority,
        workOrder: opt(v.workOrder),
        workOrderReceivedDate: opt(v.workOrderReceivedDate),
        purchaseOrder: opt(v.purchaseOrder),
        purchaseOrderReceivedDate: opt(v.purchaseOrderReceivedDate),
        plannedStartDate: opt(v.plannedStartDate),
        plannedEndDate: opt(v.plannedEndDate),
        area: opt(v.area),
        description: opt(v.description),
      };
      if (
        !zodReport(
          errors,
          'Jobs',
          r.excelRow,
          jobUpsertSchema.safeParse(
            fk(payload, 'projectId', 'amendmentId', 'supervisorId', 'clientContactId'),
          ),
        )
      ) {
        fail();
        continue;
      }
      const id = dryId();
      plan.jobs.push({ ref, data: payload, status, id, plannedTotal: 0 });
      jobIdsByRef.set(ref.toLowerCase(), id);
    }
  }

  // ---- Job lines ----
  {
    const seen = new Map<string, number>();
    for (const r of rows('JobLines')) {
      const v = r.values;
      let ok = true;
      if (!v.jobRef) {
        err(
          errors,
          'JobLines',
          r.excelRow,
          'Job ref',
          'Required. Must match a Ref on the Jobs sheet.',
        );
        ok = false;
      }
      if (!v.serviceCode) {
        err(errors, 'JobLines', r.excelRow, 'Service code', 'Required.');
        ok = false;
      }
      const jobId = v.jobRef ? (jobIdsByRef.get(v.jobRef.trim().toLowerCase()) ?? null) : null;
      if (v.jobRef && jobId === null) {
        err(
          errors,
          'JobLines',
          r.excelRow,
          'Job ref',
          `No job with Ref "${v.jobRef}" on the Jobs sheet. Lines can only belong to imported jobs.`,
        );
        ok = false;
      }
      // The code resolves within the job's amendment: amendment scoping is a
      // pricing rule, not a lookup convenience.
      let codeId: number | null = null;
      let jobAmendmentId: number | null = null;
      if (jobId !== null) {
        const job = plan.jobs.find((j) => j.id === jobId)!;
        const explicit = (job.data.amendmentId as number | null) ?? null;
        if (explicit !== null && explicit > 0) jobAmendmentId = explicit;
        else {
          const pid = job.data.projectId as number;
          if (pid < 0) {
            const proj = plan.projects.find((p) => p.id === pid)!;
            jobAmendmentId = proj.data.amendmentId as number;
          } else {
            const existing = await prisma.project.findUnique({
              where: { id: pid },
              select: { amendmentId: true },
            });
            jobAmendmentId = existing?.amendmentId ?? null;
          }
        }
        if (jobAmendmentId !== null) {
          codeId = await resolveServiceCode(jobAmendmentId, v.serviceCode);
          if (v.serviceCode && codeId === null) {
            err(
              errors,
              'JobLines',
              r.excelRow,
              'Service code',
              `No code "${v.serviceCode}" on this job's amendment in the file or the database.`,
            );
            ok = false;
          }
        }
      }
      let plannedQuantity: number | null = null;
      if (v.plannedQuantity === '') {
        err(errors, 'JobLines', r.excelRow, 'Planned qty', 'Required.');
        ok = false;
      } else {
        const n = cellNumber(v.plannedQuantity);
        if (n === null || Number.isNaN(n)) {
          err(
            errors,
            'JobLines',
            r.excelRow,
            'Planned qty',
            `"${v.plannedQuantity}" is not a number.`,
          );
          ok = false;
        } else plannedQuantity = n;
      }
      let appliedRate: number | undefined;
      if (v.appliedRate !== '') {
        const n = cellNumber(v.appliedRate);
        if (n === null || Number.isNaN(n)) {
          err(
            errors,
            'JobLines',
            r.excelRow,
            'Applied rate override',
            `"${v.appliedRate}" is not a number.`,
          );
          ok = false;
        } else appliedRate = n;
      }
      const pairKey = `${jobId}|${codeId}`;
      if (jobId !== null && codeId !== null) {
        if (dupWithin(seen, pairKey) !== null) {
          err(
            errors,
            'JobLines',
            r.excelRow,
            'Service code',
            `Duplicate of row ${seen.get(pairKey)} in this sheet (same job).`,
          );
          ok = false;
        }
        seen.set(pairKey, r.excelRow);
      }
      if (!ok) {
        fail();
        continue;
      }
      const payload = {
        serviceCodeId: codeId!,
        plannedQuantity: plannedQuantity!,
        ...(appliedRate !== undefined && { appliedRate }),
      };
      if (
        !zodReport(
          errors,
          'JobLines',
          r.excelRow,
          deliverableCreateSchema.safeParse(fk(payload, 'serviceCodeId')),
        )
      ) {
        fail();
        continue;
      }
      plan.jobLines.push({ jobRef: v.jobRef.trim(), data: payload });
    }
  }

  // ---- Crew ----
  {
    const seen = new Map<string, number>();
    for (const r of rows('Crew')) {
      const v = r.values;
      let ok = true;
      if (!v.jobRef) {
        err(errors, 'Crew', r.excelRow, 'Job ref', 'Required.');
        ok = false;
      }
      if (!v.employeeEmail) {
        err(errors, 'Crew', r.excelRow, 'Employee email', 'Required.');
        ok = false;
      }
      const jobId = v.jobRef ? (jobIdsByRef.get(v.jobRef.trim().toLowerCase()) ?? null) : null;
      if (v.jobRef && jobId === null) {
        err(
          errors,
          'Crew',
          r.excelRow,
          'Job ref',
          `No job with Ref "${v.jobRef}" on the Jobs sheet.`,
        );
        ok = false;
      }
      let employeeId: number | null = null;
      if (v.employeeEmail) {
        const key = v.employeeEmail.trim().toLowerCase();
        const inFile = employeeIds.get(key);
        if (inFile !== undefined) employeeId = inFile;
        else {
          const existing = await prisma.employee.findUnique({
            where: { email: key },
            select: { id: true },
          });
          if (!existing) {
            err(
              errors,
              'Crew',
              r.excelRow,
              'Employee email',
              `No employee "${v.employeeEmail}" in the file or the database.`,
            );
            ok = false;
          } else employeeId = existing.id;
        }
      }
      const pairKey = `${jobId}|${employeeId}`;
      if (jobId !== null && employeeId !== null) {
        if (dupWithin(seen, pairKey) !== null) {
          err(
            errors,
            'Crew',
            r.excelRow,
            'Employee email',
            `Duplicate of row ${seen.get(pairKey)} in this sheet (same job).`,
          );
          ok = false;
        }
        seen.set(pairKey, r.excelRow);
      }
      if (!ok) {
        fail();
        continue;
      }
      const payload = {
        jobId: jobId!,
        employeeId: employeeId!,
        role: opt(v.role),
        assignedDate: opt(v.assignedDate),
      };
      if (
        !zodReport(
          errors,
          'Crew',
          r.excelRow,
          assignmentCreateSchema.safeParse(fk(payload, 'jobId', 'employeeId')),
        )
      ) {
        fail();
        continue;
      }
      plan.crew.push({ jobRef: v.jobRef.trim(), data: payload });
    }
  }

  // ---- Post-pass: prove the pricing ties ----
  //
  // Everything above validated shapes and references. This pass runs the same
  // shared engines the apply phase will use and stores the results on the plan,
  // so the dry-run report shows real rates and totals — "EXAMPLE-ACT-001 →
  // 203.97 ZAR/M" — rather than asking anyone to trust unseen arithmetic.
  if (!failed) {
    // Rate cards first: recipes and jobs price from them.
    const rateById = new Map<number, number>();
    for (const entry of plan.rateCards) {
      const input = entry.input;
      // Cost parameters for the derived policy: file rows first, database
      // fallback. Names clash impossible — the pair is unique per amendment.
      const paramRows: { parameterName: string; numericValue: number | string }[] = [];
      const seen = new Set<string>();
      for (const p of plan.costParams) {
        if ((p.data.amendmentId as number) !== (input.amendmentId as number)) continue;
        const name = p.data.parameterName as string;
        if (!seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase());
          paramRows.push({ parameterName: name, numericValue: p.data.numericValue as number });
        }
      }
      if ((input.amendmentId as number) > 0) {
        const dbParams = await prisma.contractCostParameter.findMany({
          where: { amendmentId: input.amendmentId as number },
          select: { parameterName: true, numericValue: true },
        });
        for (const p of dbParams) {
          if (!seen.has(p.parameterName.toLowerCase())) {
            paramRows.push({
              parameterName: p.parameterName,
              numericValue: p.numericValue.toString(),
            });
          }
        }
      }
      const params = readCostParameters(
        paramRows.map((r) => ({
          category: '',
          parameterName: r.parameterName,
          numericValue: r.numericValue,
        })),
      );
      const policy: Tier1OverheadPolicy = entry.derive
        ? { mode: 'derived', overheadPct: params.overheadPct ?? 0, sgaPct: params.sgaPct ?? 0 }
        : {
            mode: 'authoritative',
            overheadCost: input.overheadCost as number,
            sgaCost: input.sgaCost as number,
          };
      const computed = computeFullLoadedRate(
        {
          councilRate: (input.councilRate as number | null) ?? null,
          customRate: (input.customRate as number | null) ?? null,
          wagePremiumPct: input.wagePremiumPct as number,
          leavePay: input.leavePay as number,
          totalStatutoryCost: input.totalStatutoryCost as number,
          ppeCost: input.ppeCost as number,
          transportCost: input.transportCost as number,
          equipmentCost: input.equipmentCost as number,
          profitPct: input.profitPct as number,
        },
        policy,
      );
      entry.computedRate = computed.fullLoadedRate;
      rateById.set(entry.id, computed.fullLoadedRate);
    }

    // Service-code rollups from their recipes.
    const codeRate = new Map<number, number>();
    for (const entry of plan.serviceCodes) {
      const labour = plan.recipeLabour
        .filter((l) => (l.data.serviceCodeId as number) === entry.id)
        .map((l) => ({
          crewQuantity: l.data.crewQuantity as number,
          hoursPerUnit: l.data.hoursPerUnit as number,
          fullLoadedRate: rateById.get(l.data.serviceMasterRateId as number) ?? 0,
        }));
      const material = plan.recipeMaterial
        .filter((m) => (m.data.serviceCodeId as number) === entry.id)
        .map((m) => ({ unitCost: m.data.unitCost as number, quantity: m.data.quantity as number }));
      const result =
        (entry.data.category as string) === 'R1 Material'
          ? computeMaterialRate(material, (entry.data.materialMarkupPct as number) ?? 0)
          : computeActivityRate(labour);
      entry.computedRate = result.calculatedUnitRate;
      codeRate.set(entry.id, result.calculatedUnitRate);
    }

    // Job planned totals from their lines.
    for (const job of plan.jobs) {
      let total = 0;
      for (const line of plan.jobLines) {
        if (line.jobRef.toLowerCase() !== job.ref.toLowerCase()) continue;
        const d = line.data;
        const rate =
          (d.appliedRate as number | undefined) ?? codeRate.get(d.serviceCodeId as number) ?? 0;
        total = roundMoney(total + (d.plannedQuantity as number) * rate);
      }
      job.plannedTotal = total;
    }
  }

  if (failed) return null;
  return plan;
}

function parseBoolish(raw: string): boolean | null {
  const v = raw.trim().toUpperCase();
  if (v === 'TRUE') return true;
  if (v === 'FALSE') return false;
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileEq = args.find((a) => a.startsWith('--file='));
  const fileFlag = args.indexOf('--file');
  const fileRaw =
    fileEq !== undefined
      ? fileEq.split('=')[1]!
      : fileFlag !== -1 && args[fileFlag + 1]
        ? args[fileFlag + 1]!
        : 'import/OpenERP-import-template.xlsx';
  const file = resolve(root, fileRaw);
  const apply = args.includes('--apply');

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(file);
  } catch {
    console.error(`Cannot read workbook: ${file}`);
    console.error('Generate one with npm run import:template, then fill it in.');
    process.exitCode = 1;
    return;
  }

  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const sheets: Record<string, RawRow[] | null> = {};
  for (const spec of SHEETS) {
    sheets[spec.name] = loadSheet(wb, spec.name, errors);
  }
  if (errors.length > 0) {
    report(errors, warnings, false);
    process.exitCode = 1;
    return;
  }

  const plan = await validate(sheets as Record<string, RawRow[]>, errors, warnings);
  if (!plan) {
    report(errors, warnings, false);
    process.exitCode = 1;
    return;
  }
  report(errors, warnings, true);

  printPlan(plan);

  if (!apply) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to import.');
    return;
  }

  console.log('\nBack up the database first: writes are sequential, not one transaction.');
  try {
    await asSystem(async () => applyPlan(plan));
  } catch (error) {
    // Validation passed, so this is a database-level failure (usually a race:
    // something with the same natural key appeared between validation and
    // write). Rows written before the failure stay written — restore from the
    // backup, remove the cause, and re-run.
    console.error(`\nAPPLY FAILED partway: ${error instanceof Error ? error.message : error}`);
    console.error('Rows written so far stay written. Restore from backup and re-run.');
    process.exitCode = 1;
    return;
  }
  console.log('\nImport complete — every write is in the audit log as system.');
}

function report(errors: Issue[], warnings: Issue[], valid: boolean): void {
  for (const w of warnings) {
    console.log(`  WARN  ${w.sheet} row ${w.row} [${w.column}]: ${w.message}`);
  }
  if (!valid) {
    console.log(`\n${errors.length} error(s):`);
    for (const e of errors) {
      console.log(
        `  FAIL  ${e.sheet} row ${e.row}${e.column ? ` [${e.column}]` : ''}: ${e.message}`,
      );
    }
  }
}

function printPlan(plan: Plan): void {
  const counts: [string, number][] = [
    ['brokers', plan.brokers.filter((b) => !b.reused).length],
    ['contract types', plan.contractTypes.filter((t) => !t.reused).length],
    ['clients', plan.clients.length],
    ['contacts', plan.contacts.length],
    ['employees', plan.employees.length],
    ['contracts', plan.contracts.length],
    ['amendments', plan.amendments.length],
    ['cost parameters', plan.costParams.length],
    ['rate cards', plan.rateCards.length],
    ['service codes', plan.serviceCodes.length],
    ['labour recipe lines', plan.recipeLabour.length],
    ['material recipe lines', plan.recipeMaterial.length],
    ['projects', plan.projects.length],
    ['jobs', plan.jobs.length],
    ['job lines', plan.jobLines.length],
    ['crew assignments', plan.crew.length],
  ];
  const reused = [
    ...plan.brokers.filter((b) => b.reused).map((b) => `broker "${b.name}"`),
    ...plan.contractTypes.filter((t) => t.reused).map((t) => `contract type "${t.name}"`),
  ];
  console.log('\nPlan (validated, references resolved):');
  for (const [label, n] of counts) {
    if (n > 0) console.log(`  create ${n} ${label}`);
  }
  for (const r of reused) console.log(`  reuse ${r}`);
  for (const card of plan.rateCards) {
    const code = card.input.serviceMasterCode as string;
    console.log(`  rate   ${code} → ${card.computedRate.toFixed(2)} ZAR/hr`);
  }
  for (const code of plan.serviceCodes) {
    console.log(
      `  code   ${code.data.code as string} → ${(code.computedRate as number).toFixed(4)} ZAR/${code.data.uom as string}`,
    );
  }
  for (const job of plan.jobs) {
    console.log(`  job    ${job.ref} → planned R ${job.plannedTotal.toFixed(2)} (${job.status})`);
  }
}

// ---------------------------------------------------------------------------
// Apply — writes in dependency order, remapping dry-run ids to real ones
// ---------------------------------------------------------------------------

function toDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined || raw === '') return null;
  return new Date(raw as string);
}

async function applyPlan(plan: Plan): Promise<void> {
  const ids = new Map<number, number>();
  const R = (id: number): number => ids.get(id) ?? id;

  const counts: Record<string, number> = {};
  const count = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  for (const b of plan.brokers) {
    if (b.reused) continue;
    const created = await prisma.broker.create({ data: { name: b.name } });
    ids.set(b.id, created.id);
    count('brokers');
  }
  for (const t of plan.contractTypes) {
    if (t.reused) continue;
    const created = await prisma.employeeContractType.create({ data: { name: t.name } });
    ids.set(t.id, created.id);
    count('contract types');
  }
  for (const c of plan.clients) {
    const d = c.data;
    const created = await prisma.client.create({
      data: {
        name: d.name as string,
        email: d.email as string,
        address: d.address as string | null,
        isVatRegistered: d.isVatRegistered as boolean,
        vatNumber: d.vatNumber as string | null,
      },
    });
    ids.set(c.id, created.id);
    count('clients');
  }
  for (const c of plan.contacts) {
    const d = c.data;
    const created = await prisma.contact.create({
      data: {
        clientId: R(d.clientId as number),
        name: d.name as string,
        mobile: d.mobile as string | null,
        email: d.email as string | null,
        role: d.role as string | null,
      },
    });
    ids.set(c.id, created.id);
    count('contacts');
  }
  for (const e of plan.employees) {
    const d = e.data;
    const created = await prisma.employee.create({
      data: {
        name: d.name as string,
        surname: d.surname as string,
        mobile: d.mobile as string | null,
        email: d.email as string | null,
        idNumber: d.idNumber as string | null,
        startDate: toDate(d.startDate)!,
        endDate: toDate(d.endDate),
        brokerId: d.brokerId === null ? null : R(d.brokerId as number),
        contractTypeId: R(d.contractTypeId as number),
        rate: (d.rate as number | null) ?? null,
      },
    });
    ids.set(e.id, created.id);
    count('employees');
  }
  for (const m of plan.employeeManagers) {
    await prisma.employee.update({
      where: { id: R(m.employeeId) },
      data: { managerId: R(m.managerId) },
    });
  }
  for (const c of plan.contracts) {
    const d = c.data;
    const created = await prisma.contract.create({
      data: {
        clientId: R(d.clientId as number),
        number: d.number as string,
        description: d.description as string,
        type: d.type as string | null,
      },
    });
    ids.set(c.id, created.id);
    count('contracts');
  }
  for (const a of plan.amendments) {
    const d = a.data;
    const created = await prisma.contractAmendment.create({
      data: {
        contractId: R(d.contractId as number),
        amendmentNumber: d.amendmentNumber as string,
        amendmentType: AMENDMENT_TYPE.toKey(d.amendmentType as string) as never,
        effectiveDate: toDate(d.effectiveDate)!,
        expiryDate: toDate(d.expiryDate),
        status: CONTRACT_AMENDMENT_STATUS.toKey(d.status as string) as never,
        signedDate: toDate(d.signedDate),
        notes: d.notes as string | null,
        vatRate: d.vatRate as number,
      },
    });
    ids.set(a.id, created.id);
    count('amendments');
  }
  for (const p of plan.costParams) {
    const d = p.data;
    await prisma.contractCostParameter.create({
      data: {
        amendmentId: R(d.amendmentId as number),
        category: COST_PARAMETER_CATEGORY.toKey(d.category as string) as never,
        parameterName: d.parameterName as string,
        numericValue: d.numericValue as number,
        uom: d.uom as string,
        notes: d.notes as string | null,
      },
    });
    count('cost parameters');
  }

  // Rate cards go through the real pricing service, so the stored build-up is
  // identical to one created in the UI.
  const rateResults = new Map<number, { id: number; fullLoadedRate: number }>();
  for (const card of plan.rateCards) {
    const i = card.input;
    const result = await saveRateCard({
      amendmentId: R(i.amendmentId as number),
      serviceMasterCode: i.serviceMasterCode as string,
      labourType: i.labourType as string,
      shiftType: SHIFT_TYPE.toKey(i.shiftType as string),
      uom: i.uom as string,
      bargainingCouncilDesc: (i.bargainingCouncilDesc as string | null) ?? null,
      councilRate: (i.councilRate as number | null) ?? null,
      customRate: (i.customRate as number | null) ?? null,
      wagePremiumPct: i.wagePremiumPct as number,
      leavePay: i.leavePay as number,
      totalStatutoryCost: i.totalStatutoryCost as number,
      ppeCost: i.ppeCost as number,
      transportCost: i.transportCost as number,
      equipmentCost: i.equipmentCost as number,
      profitPct: i.profitPct as number,
      overheadCost: (i.overheadCost as number | null) ?? null,
      sgaCost: (i.sgaCost as number | null) ?? null,
      deriveOverheads: card.derive,
    });
    ids.set(card.id, result.id);
    rateResults.set(card.id, { id: result.id, fullLoadedRate: result.computed.fullLoadedRate });
    count('rate cards');
  }

  async function rateFullLoadedRate(rateDryId: number): Promise<number> {
    const created = rateResults.get(rateDryId);
    if (created) return created.fullLoadedRate;
    const realId = R(rateDryId);
    const card = await prisma.serviceMasterRate.findUniqueOrThrow({
      where: { id: realId },
      select: { fullLoadedRate: true },
    });
    return card.fullLoadedRate.toNumber();
  }

  // Service codes are created at rate 0 (like the route does), reciped, then
  // rolled up with the shared engine and stored.
  const labourSubs = new Map<number, number[]>();
  const materialSubs = new Map<number, number[]>();
  for (const s of plan.serviceCodes) {
    const d = s.data;
    const created = await prisma.serviceCode.create({
      data: {
        amendmentId: R(d.amendmentId as number),
        code: d.code as string,
        description: d.description as string,
        category: SERVICE_CODE_CATEGORY.toKey(d.category as string) as never,
        uom: d.uom as string,
        materialMarkupPct: d.materialMarkupPct as number,
        calculatedUnitRate: 0,
      },
    });
    ids.set(s.id, created.id);
    count('service codes');
  }
  for (const l of plan.recipeLabour) {
    const d = l.data;
    const rate = await rateFullLoadedRate(d.serviceMasterRateId as number);
    const subtotal = computeActivityRate([
      {
        crewQuantity: d.crewQuantity as number,
        hoursPerUnit: d.hoursPerUnit as number,
        fullLoadedRate: rate,
      },
    ]).lines[0]!.lineSubtotal;
    await prisma.serviceCodeLabourItem.create({
      data: {
        serviceCodeId: R(d.serviceCodeId as number),
        serviceMasterRateId: R(d.serviceMasterRateId as number),
        crewQuantity: d.crewQuantity as number,
        hoursPerUnit: d.hoursPerUnit as number,
        lineSubtotal: subtotal,
      },
    });
    const list = labourSubs.get(d.serviceCodeId as number) ?? [];
    list.push(subtotal);
    labourSubs.set(d.serviceCodeId as number, list);
    count('labour recipe lines');
  }
  for (const m of plan.recipeMaterial) {
    const d = m.data;
    const subtotal = computeMaterialRate(
      [{ unitCost: d.unitCost as number, quantity: d.quantity as number }],
      0,
    ).lines[0]!.subtotalCost;
    await prisma.serviceCodeMaterialItem.create({
      data: {
        serviceCodeId: R(d.serviceCodeId as number),
        itemCode: d.itemCode as string | null,
        description: d.description as string,
        supplierName: d.supplierName as string | null,
        unitCost: d.unitCost as number,
        quantity: d.quantity as number,
        uom: d.uom as string,
        subtotalCost: subtotal,
      },
    });
    const list = materialSubs.get(d.serviceCodeId as number) ?? [];
    list.push(subtotal);
    materialSubs.set(d.serviceCodeId as number, list);
    count('material recipe lines');
  }
  for (const s of plan.serviceCodes) {
    const d = s.data;
    const labour = labourSubs.get(s.id) ?? [];
    const material = materialSubs.get(s.id) ?? [];
    if (labour.length === 0 && material.length === 0) continue;
    // The rollup is defined as the sum of the rounded line subtotals — the
    // same rule tier2 documents — so it is summed directly rather than
    // re-derived from quantities and rates.
    const calculatedUnitRate =
      (d.category as string) === 'R1 Material'
        ? computeMaterialRate(
            material.map((subtotalCost) => ({ unitCost: subtotalCost, quantity: 1 })),
            (d.materialMarkupPct as number) ?? 0,
          ).calculatedUnitRate
        : roundRate(sumExact(labour, 'calculatedUnitRate'), 'calculatedUnitRate');
    await prisma.serviceCode.update({
      where: { id: R(s.id) },
      data: { calculatedUnitRate },
    });
  }

  for (const p of plan.projects) {
    const d = p.data;
    const created = await prisma.project.create({
      data: {
        contractId: R(d.contractId as number),
        amendmentId: R(d.amendmentId as number),
        code: d.code as string,
        year: Number(d.year),
        startDate: toDate(d.startDate),
        endDate: toDate(d.endDate),
        description: d.description as string | null,
      },
    });
    ids.set(p.id, created.id);
    count('projects');
  }
  for (const j of plan.jobs) {
    const d = j.data;
    const created = await prisma.job.create({
      data: {
        projectId: R(d.projectId as number),
        amendmentId: d.amendmentId === null ? null : R(d.amendmentId as number),
        supervisorId: d.supervisorId === null ? null : R(d.supervisorId as number),
        clientContactId: d.clientContactId === null ? null : R(d.clientContactId as number),
        status: JOB_STATUS.toKey(j.status) as never,
        priority: JOB_PRIORITY.toKey(d.priority as string) as never,
        workOrder: d.workOrder as string | null,
        workOrderReceivedDate: toDate(d.workOrderReceivedDate),
        purchaseOrder: d.purchaseOrder as string | null,
        purchaseOrderReceivedDate: toDate(d.purchaseOrderReceivedDate),
        plannedStartDate: toDate(d.plannedStartDate),
        plannedEndDate: toDate(d.plannedEndDate),
        area: d.area as string | null,
        description: d.description as string | null,
      },
    });
    ids.set(j.id, created.id);
    count('jobs');
  }
  for (const l of plan.jobLines) {
    const d = l.data;
    // addDeliverable enforces amendment scoping, freezes the rate snapshot with
    // provenance, and recomputes subtotals — the same path as the UI.
    await addDeliverable(
      R(plan.jobs.find((j) => j.ref.toLowerCase() === l.jobRef.toLowerCase())!.id),
      R(d.serviceCodeId as number),
      d.plannedQuantity as number,
      d.appliedRate as number | undefined,
    );
    count('job lines');
  }
  for (const c of plan.crew) {
    const d = c.data;
    await prisma.jobAssignment.create({
      data: {
        jobId: R(d.jobId as number),
        employeeId: R(d.employeeId as number),
        role: d.role as string | null,
        assignedDate: toDate(d.assignedDate),
      },
    });
    count('crew assignments');
  }

  console.log('\nWrote:');
  for (const [label, n] of Object.entries(counts)) {
    console.log(`  ${n} ${label}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
