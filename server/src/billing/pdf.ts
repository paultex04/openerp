/**
 * SARS-Compliant Tax Invoice PDF Generator (Phase 5).
 *
 * Generates official PDF Tax Invoices compliant with Section 20(4) of the South African
 * Value-Added Tax Act No. 89 of 1991:
 *  - Prominent "TAX INVOICE" header
 *  - Contractor details, company registration and SARS VAT number
 *  - Recipient legal entity name, client address and client VAT registration number
 *  - Individual serialized invoice number, issue date and due date
 *  - Itemized deliverable lines with quantity, UOM, unit rate and subtotal
 *  - 15% VAT calculation and total consideration payable in ZAR
 *  - Official banking details and settlement instructions
 */
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { InvoiceDetail } from './service.js';

function formatZar(amount: number): string {
  const parts = Math.abs(amount).toFixed(2).split('.');
  const intPart = parts[0]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = amount < 0 ? '-' : '';
  return `${sign}R ${intPart}.${parts[1]}`;
}

export interface CompanyDetails {
  name: string;
  subtitle: string;
  address: string;
  regNumber: string;
  vatNumber: string;
  email: string;
  phone: string;
  bankName: string;
  accountNumber: string;
  branchCode: string;
}

const DEFAULT_COMPANY: CompanyDetails = {
  name: 'OpenERP Contracting (Pty) Ltd',
  subtitle: 'Industrial Electrical & Instrumentation (EC&I) Solutions',
  address: '102 West Street, Sandton, Johannesburg, 2196',
  regNumber: '2021/108422/07',
  vatNumber: '4920182736',
  email: 'accounts@openerp.co.za',
  phone: '+27 (0) 11 842 9000',
  bankName: 'First National Bank (FNB)',
  accountNumber: '62891234567',
  branchCode: '250655',
};

export async function generateTaxInvoicePdf(
  detail: InvoiceDetail,
  company: CompanyDetails = DEFAULT_COMPANY,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  // Standard A4: 595.28 x 841.89 points
  const page = doc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();

  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Palette
  const colorPrimary = rgb(0.08, 0.16, 0.32); // Deep Navy
  const colorText = rgb(0.12, 0.14, 0.18); // Dark Charcoal
  const colorMuted = rgb(0.4, 0.45, 0.52); // Slate Grey
  const colorBorder = rgb(0.82, 0.86, 0.9); // Light Grey
  const colorTableHeader = rgb(0.94, 0.96, 0.98); // Light Slate
  const colorHighlight = rgb(0.12, 0.45, 0.85); // Cobalt Blue

  let y = height - 45;
  const margin = 40;
  const contentWidth = width - margin * 2;

  // 1. Header: Contractor Logo/Title on Left, "TAX INVOICE" on Right
  page.drawText(company.name, {
    x: margin,
    y,
    size: 15,
    font: fontBold,
    color: colorPrimary,
  });

  page.drawText('TAX INVOICE', {
    x: width - margin - 150,
    y: y - 2,
    size: 20,
    font: fontBold,
    color: colorPrimary,
  });

  y -= 14;
  page.drawText(company.subtitle, {
    x: margin,
    y,
    size: 8.5,
    font: fontRegular,
    color: colorMuted,
  });

  y -= 12;
  page.drawText(company.address, {
    x: margin,
    y,
    size: 8,
    font: fontRegular,
    color: colorMuted,
  });

  y -= 11;
  page.drawText(
    `Reg: ${company.regNumber} | SARS VAT No: ${company.vatNumber} | Email: ${company.email}`,
    {
      x: margin,
      y,
      size: 8,
      font: fontRegular,
      color: colorMuted,
    },
  );

  // Invoice Meta on Right Side
  const metaX = width - margin - 150;
  let metaY = height - 70;
  const invoiceNum = String(detail.invoice.invoiceNumber ?? 'INV-0000');
  const issueDateStr = detail.invoice.issueDate
    ? String(detail.invoice.issueDate).slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const dueDateStr = detail.invoice.dueDate
    ? String(detail.invoice.dueDate).slice(0, 10)
    : 'Due on Receipt';
  const statusStr = String(detail.invoice.status ?? 'Draft');

  page.drawText(`Invoice No:`, { x: metaX, y: metaY, size: 8.5, font: fontBold, color: colorText });
  page.drawText(invoiceNum, {
    x: metaX + 65,
    y: metaY,
    size: 8.5,
    font: fontRegular,
    color: colorText,
  });
  metaY -= 13;

  page.drawText(`Issue Date:`, {
    x: metaX,
    y: metaY,
    size: 8.5,
    font: fontBold,
    color: colorText,
  });
  page.drawText(issueDateStr, {
    x: metaX + 65,
    y: metaY,
    size: 8.5,
    font: fontRegular,
    color: colorText,
  });
  metaY -= 13;

  page.drawText(`Due Date:`, { x: metaX, y: metaY, size: 8.5, font: fontBold, color: colorText });
  page.drawText(dueDateStr, {
    x: metaX + 65,
    y: metaY,
    size: 8.5,
    font: fontRegular,
    color: colorText,
  });
  metaY -= 13;

  page.drawText(`Status:`, { x: metaX, y: metaY, size: 8.5, font: fontBold, color: colorText });
  page.drawText(statusStr.toUpperCase(), {
    x: metaX + 65,
    y: metaY,
    size: 8.5,
    font: fontBold,
    color: colorHighlight,
  });

  // Divider Line
  y -= 14;
  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 1,
    color: colorBorder,
  });

  // 2. Client ("BILL TO") & References Box
  y -= 18;
  const colWidth = contentWidth / 2;

  // Bill To
  page.drawText('BILL TO (CLIENT):', {
    x: margin,
    y,
    size: 9,
    font: fontBold,
    color: colorPrimary,
  });

  // References
  page.drawText('COMMERCIAL & JOB REFERENCES:', {
    x: margin + colWidth,
    y,
    size: 9,
    font: fontBold,
    color: colorPrimary,
  });

  y -= 14;
  const client = (detail.client ?? {}) as Record<string, unknown>;
  const job = (detail.job ?? {}) as Record<string, unknown>;

  const clientName = String(client.name ?? 'Client');
  const clientVat = client.vatNumber
    ? `SARS VAT Reg: ${String(client.vatNumber)}`
    : client.isVatRegistered
      ? 'SARS VAT: Not provided'
      : 'SARS VAT: Non-VAT Registered Entity (0% VAT)';
  const clientAddress = String(client.address ?? 'Registered Office / Site Address');

  page.drawText(clientName, { x: margin, y, size: 10, font: fontBold, color: colorText });

  const contractNum = String(job.contractNumber ?? job.contract ?? 'N/A');
  const projectCode = String(job.projectCode ?? job.project ?? 'N/A');
  page.drawText(`Contract: ${contractNum}`, {
    x: margin + colWidth,
    y,
    size: 8.5,
    font: fontRegular,
    color: colorText,
  });

  y -= 12;
  page.drawText(clientVat, { x: margin, y, size: 8.5, font: fontRegular, color: colorMuted });

  const workOrder = String(job.workOrder ?? 'N/A');
  page.drawText(`Project: ${projectCode} | Work Order: ${workOrder}`, {
    x: margin + colWidth,
    y,
    size: 8.5,
    font: fontRegular,
    color: colorText,
  });

  y -= 12;
  page.drawText(clientAddress, { x: margin, y, size: 8.5, font: fontRegular, color: colorMuted });

  const purchaseOrder = String(job.purchaseOrder ?? 'N/A');
  page.drawText(`Purchase Order: ${purchaseOrder}`, {
    x: margin + colWidth,
    y,
    size: 8.5,
    font: fontRegular,
    color: colorText,
  });

  // 3. Line Items Table
  y -= 25;
  const tableTop = y;
  const colX = {
    code: margin + 6,
    desc: margin + 90,
    qty: margin + 295,
    uom: margin + 345,
    rate: margin + 395,
    total: width - margin - 6,
  };

  // Header background box
  page.drawRectangle({
    x: margin,
    y: tableTop - 4,
    width: contentWidth,
    height: 18,
    color: colorTableHeader,
    borderColor: colorBorder,
    borderWidth: 1,
  });

  page.drawText('Code', {
    x: colX.code,
    y: tableTop,
    size: 8.5,
    font: fontBold,
    color: colorPrimary,
  });
  page.drawText('Description of Supply', {
    x: colX.desc,
    y: tableTop,
    size: 8.5,
    font: fontBold,
    color: colorPrimary,
  });
  page.drawText('Qty', {
    x: colX.qty,
    y: tableTop,
    size: 8.5,
    font: fontBold,
    color: colorPrimary,
  });
  page.drawText('UOM', {
    x: colX.uom,
    y: tableTop,
    size: 8.5,
    font: fontBold,
    color: colorPrimary,
  });
  page.drawText('Unit Rate (ZAR)', {
    x: colX.rate,
    y: tableTop,
    size: 8.5,
    font: fontBold,
    color: colorPrimary,
  });
  page.drawText('Amount (excl. VAT)', {
    x: colX.total - 90,
    y: tableTop,
    size: 8.5,
    font: fontBold,
    color: colorPrimary,
  });

  y -= 16;

  // Rows
  const lines = detail.lines ?? [];
  for (const line of lines) {
    if (y < 160) {
      // Avoid running into footer; for invoices with many lines
      break;
    }

    const code = String(line.code ?? line.serviceCode ?? '');
    let desc = String(line.description ?? line.code ?? '');
    if (desc.length > 40) desc = desc.slice(0, 38) + '…';
    const qty = Number(line.billedQuantity ?? 1).toFixed(2);
    const uom = String(line.uom ?? 'EA');
    const unitPrice = formatZar(Number(line.unitPrice ?? 0));
    const subtotal = formatZar(Number(line.subtotal ?? 0));

    page.drawText(code, { x: colX.code, y, size: 8, font: fontRegular, color: colorText });
    page.drawText(desc, { x: colX.desc, y, size: 8, font: fontRegular, color: colorText });
    page.drawText(qty, { x: colX.qty, y, size: 8, font: fontRegular, color: colorText });
    page.drawText(uom, { x: colX.uom, y, size: 8, font: fontRegular, color: colorText });
    page.drawText(unitPrice, { x: colX.rate, y, size: 8, font: fontRegular, color: colorText });

    // Right aligned total
    page.drawText(subtotal, {
      x: colX.total - 65,
      y,
      size: 8,
      font: fontRegular,
      color: colorText,
    });

    // Row bottom line
    y -= 5;
    page.drawLine({
      start: { x: margin, y },
      end: { x: width - margin, y },
      thickness: 0.5,
      color: colorBorder,
    });
    y -= 11;
  }

  // 4. Financial Totals / SARS VAT Summary Box
  y = Math.min(y - 10, 220);

  const summaryWidth = 240;
  const summaryX = width - margin - summaryWidth;

  const vat = detail.vat ?? {
    subtotalAmount: Number(detail.invoice.subtotalAmount ?? 0),
    taxRate: Number(detail.invoice.taxRate ?? 0.15),
    taxAmount: Number(detail.invoice.taxAmount ?? 0),
    totalWithTax: Number(detail.invoice.totalWithTax ?? 0),
  };

  const vatPctLabel = (vat.taxRate * 100).toFixed(1);

  // Subtotal
  page.drawText('Subtotal (excl. VAT):', {
    x: summaryX,
    y,
    size: 9,
    font: fontBold,
    color: colorMuted,
  });
  page.drawText(formatZar(vat.subtotalAmount), {
    x: width - margin - 75,
    y,
    size: 9,
    font: fontBold,
    color: colorText,
  });
  y -= 14;

  // VAT
  page.drawText(`SARS VAT (${vatPctLabel}%):`, {
    x: summaryX,
    y,
    size: 9,
    font: fontBold,
    color: colorMuted,
  });
  page.drawText(formatZar(vat.taxAmount), {
    x: width - margin - 75,
    y,
    size: 9,
    font: fontBold,
    color: colorText,
  });
  y -= 16;

  // Highlight Box for Total Payable
  page.drawRectangle({
    x: summaryX - 8,
    y: y - 6,
    width: summaryWidth + 8,
    height: 24,
    color: colorTableHeader,
    borderColor: colorHighlight,
    borderWidth: 1,
  });

  page.drawText('TOTAL DUE (incl. VAT):', {
    x: summaryX,
    y: y + 2,
    size: 10,
    font: fontBold,
    color: colorPrimary,
  });
  page.drawText(formatZar(vat.totalWithTax), {
    x: width - margin - 75,
    y: y + 2,
    size: 11,
    font: fontBold,
    color: colorHighlight,
  });

  // 5. Settlement & Banking Details (Bottom Left)
  let bankY = 130;
  page.drawText('PAYMENT & BANKING DETAILS:', {
    x: margin,
    y: bankY,
    size: 8.5,
    font: fontBold,
    color: colorPrimary,
  });
  bankY -= 12;
  page.drawText(`Bank: ${company.bankName} | Branch Code: ${company.branchCode}`, {
    x: margin,
    y: bankY,
    size: 8,
    font: fontRegular,
    color: colorText,
  });
  bankY -= 11;
  page.drawText(`Account Name: ${company.name} | Account No: ${company.accountNumber}`, {
    x: margin,
    y: bankY,
    size: 8,
    font: fontRegular,
    color: colorText,
  });
  bankY -= 11;
  page.drawText(`Payment Reference: ${invoiceNum}`, {
    x: margin,
    y: bankY,
    size: 8,
    font: fontBold,
    color: colorHighlight,
  });

  // 6. SARS Legal Footer
  const footerY = 45;
  page.drawLine({
    start: { x: margin, y: footerY + 14 },
    end: { x: width - margin, y: footerY + 14 },
    thickness: 0.5,
    color: colorBorder,
  });

  page.drawText(
    'This document is a Tax Invoice issued in accordance with Section 20(4) of the Value-Added Tax Act No. 89 of 1991.',
    {
      x: margin,
      y: footerY + 4,
      size: 7.5,
      font: fontRegular,
      color: colorMuted,
    },
  );
  page.drawText(
    `Page 1 of 1 · Generated by OpenERP Contracting System · ${new Date().toISOString()}`,
    {
      x: margin,
      y: footerY - 6,
      size: 7,
      font: fontRegular,
      color: colorMuted,
    },
  );

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}
