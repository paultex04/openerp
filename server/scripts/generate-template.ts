/**
 * Generates the data-import workbook: `import/OpenERP-import-template.xlsx`.
 *
 * One sheet per table in dependency order, each with typed headers, dropdown
 * validation for every enum, notes on the tricky columns, and one EXAMPLE row
 * that the importer skips (any row whose first cell starts with "EXAMPLE").
 *
 * Every enum list is imported from `@openerp/shared`, never re-typed here, so
 * a new status or category cannot silently diverge from the labels the API and
 * the database actually accept.
 *
 * Usage: npm run import:template
 */
import ExcelJS from 'exceljs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHEETS } from './import-spec.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = resolve(root, 'import');
const OUT_FILE = resolve(OUT_DIR, 'OpenERP-import-template.xlsx');

/** Rows the validation dropdowns apply to. 2000 data rows per sheet. */
const FIRST_DATA_ROW = 2;
const LAST_DATA_ROW = 2001;

const INSTRUCTIONS: string[][] = [
  ['OpenERP data import — read this sheet first'],
  [],
  ['Order of work'],
  [
    '1. Run the database seed first (npm run seed --workspace server). The importer reuses seeded reference rows by exact name.',
  ],
  [
    '2. Fill the sheets in tab order, left to right. Every reference points backwards to something already entered.',
  ],
  [
    '3. Rows whose first cell starts with EXAMPLE are worked examples. The importer skips them — delete or overwrite them with real data.',
  ],
  ['4. Run the dry run: npm run import:data -- --file import/OpenERP-import-template.xlsx'],
  ['   It validates everything and writes nothing. Fix all errors it reports.'],
  ['5. Back up the database. Then run again with --apply.'],
  [],
  ['Conventions used on every sheet'],
  [
    'Dates are ISO text: YYYY-MM-DD, e.g. 2026-03-14. Excel may try to reformat them — set the cells to Text if it does.',
  ],
  ['TRUE / FALSE are capitalised text, picked from a dropdown.'],
  ['Money is plain numbers with at most 2 decimals. Rates allow 4.'],
  ['Fractions vs percents — this is the one that bites:'],
  [
    '  * Columns ending in "fraction" (VAT rate, wage premium, profit, material markup) are FRACTIONS: 0.095 means 9.5%. The API rejects anything above 1.',
  ],
  [
    '  * CostParameters Value rows with UoM % are PERCENT NUMBERS: 7 means 7%. The engine divides by 100 itself.',
  ],
  [
    'References are natural keys (emails, contract numbers, codes), never database ids. The importer resolves them and refuses unknown or ambiguous ones by name.',
  ],
  [
    'Required columns are marked * in the header. Blank optional cells stay blank — never type N/A or a dash.',
  ],
  [],
  ['What is deliberately not imported'],
  [
    'User accounts: passwords cannot come from a spreadsheet. Create logins in Administration → Users after importing the employees.',
  ],
  [
    'Actual quantities and invoices: this template carries open work only. New jobs start at 01. Scoping with planned quantities; actuals are recorded in the field view and invoices raised from them.',
  ],
  [
    'Job status is limited to Scoping / Scoped / Awaiting PO. Later stages are reached by using the system, not by typing a status.',
  ],
];

function styleHeader(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 11 };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  row.height = 30;
}

function styleExample(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    cell.font = { italic: true, size: 11 };
  });
}

async function main(): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OpenERP import template generator';
  wb.created = new Date();

  // --- instructions sheet ---
  const readme = wb.addWorksheet('README', {
    properties: { tabColor: { argb: 'FFC00000' } },
  });
  readme.columns = [{ width: 140 }];
  for (const [line] of INSTRUCTIONS) {
    const row = readme.addRow([line ?? '']);
    if (!line) continue;
    if (line.startsWith('OpenERP data import')) {
      row.font = { bold: true, size: 14 };
    } else if (
      line.startsWith('Order') ||
      line.startsWith('Conventions') ||
      line.startsWith('What is')
    ) {
      row.font = { bold: true, size: 12 };
    }
  }

  // --- data sheets ---
  for (const spec of SHEETS) {
    const ws = wb.addWorksheet(spec.name);
    ws.columns = spec.columns.map((c) => ({
      header: `${c.header}${c.required ? ' *' : ''}${c.default ? ` [${c.default}]` : ''}`,
      key: c.key,
      width: c.width,
    }));
    styleHeader(ws.getRow(1));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: spec.columns.length },
    };

    // Dropdown validation over the data rows.
    spec.columns.forEach((col, index) => {
      if (!col.list) return;
      const colLetter = String.fromCharCode(65 + index);
      ws.dataValidations.add(`${colLetter}${FIRST_DATA_ROW}:${colLetter}${LAST_DATA_ROW}`, {
        type: 'list',
        formulae: [`"${col.list.join(',')}"`],
        showErrorMessage: true,
        errorTitle: 'Pick from the list',
        error: `“${col.header}” must be one of: ${col.list.join(' · ')}. Typed values must match exactly, including spaces and punctuation.`,
      });
    });

    // Notes on tricky columns (header row).
    spec.columns.forEach((col, index) => {
      if (!col.note) return;
      ws.getCell(1, index + 1).note = col.note;
    });

    // One worked example, skipped by the importer.
    const exampleRow = ws.addRow(
      Object.fromEntries(spec.columns.map((c) => [c.key, c.example ?? ''])),
    );
    styleExample(exampleRow);

    // The material recipe example needs an R1 Material code to point at.
    if (spec.name === 'ServiceCodes') {
      const r1 = ws.addRow({
        contractNumber: 'EXAMPLE-001',
        amendmentNumber: 'EXAMPLE-001',
        code: 'EXAMPLE-R1-001',
        description: 'Example procurement of cable and accessories',
        category: 'R1 Material',
        uom: 'LOT',
        materialMarkupPct: 0.1,
      });
      styleExample(r1);
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  await wb.xlsx.writeFile(OUT_FILE);
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
