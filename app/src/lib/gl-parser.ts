/**
 * Parse a Xero General Ledger (Detailed) Excel report.
 *
 * Handles multiple Xero GL export formats:
 *  - Global header row at the top + account sections below
 *  - Per-account-section header rows (headers repeated under each account)
 *  - Various column name conventions (Date/date, Debit/Dr, Credit/Cr, etc.)
 */
import * as XLSX from "xlsx";

export interface GLRow {
  accountCode: string;
  accountName: string;
  date: string; // YYYY-MM-DD
  source: string;
  description: string;
  reference: string;
  contact: string;
  debit: number;
  credit: number;
}

export interface GLParseResult {
  rows: GLRow[];
  dateFrom: string | null;
  dateTo: string | null;
  accountCount: number;
  accounts: string[]; // "620 - Prepayments", etc.
}

// Account header patterns:
//   "620 - Prepayments"
//   "620 – Prepayments (Revenue)"
//   "Account: 620 - Prepayments"
const ACCOUNT_HEADER_RE = /^(?:Account:?\s*)?(\d{2,5})\s*[-–—]\s*(.+)$/;

// Column name matching — case insensitive, trimmed
function isDateCol(s: string): boolean {
  const l = s.toLowerCase().trim();
  return l === "date" || l === "trans date" || l === "transaction date";
}
function isSourceCol(s: string): boolean {
  const l = s.toLowerCase().trim();
  return l === "source" || l === "type" || l === "source type";
}
function isContactCol(s: string): boolean {
  const l = s.toLowerCase().trim();
  return (
    l === "contact" ||
    l === "name" ||
    l === "contact name" ||
    l === "payee"
  );
}
function isDescCol(s: string): boolean {
  const l = s.toLowerCase().trim();
  return (
    l === "description" ||
    l === "details" ||
    l === "particular" ||
    l === "particulars" ||
    l === "memo" ||
    l === "narration"
  );
}
function isRefCol(s: string): boolean {
  const l = s.toLowerCase().trim();
  return l === "reference" || l === "ref" || l === "ref." || l === "invoice number";
}
function isDebitCol(s: string): boolean {
  const l = s.toLowerCase().trim();
  return l === "debit" || l === "dr" || l === "dr.";
}
function isCreditCol(s: string): boolean {
  const l = s.toLowerCase().trim();
  return l === "credit" || l === "cr" || l === "cr.";
}

interface ColMap {
  date: number;
  source?: number;
  contact?: number;
  description?: number;
  reference?: number;
  debit?: number;
  credit?: number;
}

/** Try to detect column headers from a single row. Returns null if not a header row. */
function detectHeaders(row: unknown[]): ColMap | null {
  if (!row || row.length < 3) return null;

  const cells = row.map((c) => String(c ?? "").trim());

  let dateIdx = -1;
  let debitIdx = -1;
  let creditIdx = -1;

  for (let j = 0; j < cells.length; j++) {
    if (isDateCol(cells[j])) dateIdx = j;
    if (isDebitCol(cells[j])) debitIdx = j;
    if (isCreditCol(cells[j])) creditIdx = j;
  }

  // Need at least Date + one of Debit/Credit
  if (dateIdx === -1 || (debitIdx === -1 && creditIdx === -1)) return null;

  const map: ColMap = { date: dateIdx };
  if (debitIdx !== -1) map.debit = debitIdx;
  if (creditIdx !== -1) map.credit = creditIdx;

  for (let j = 0; j < cells.length; j++) {
    if (j === dateIdx || j === debitIdx || j === creditIdx) continue;
    if (isSourceCol(cells[j])) map.source = j;
    else if (isContactCol(cells[j])) map.contact = j;
    else if (isDescCol(cells[j])) map.description = j;
    else if (isRefCol(cells[j])) map.reference = j;
  }

  return map;
}

export function parseGLReport(buffer: Buffer): GLParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
  });

  // Phase 1: Scan ALL rows for a header row (not just first 30)
  // Xero repeats headers under each account section, so the first header
  // might be well past row 30 in a file with a long preamble.
  let col: ColMap | null = null;
  let headerIdx = -1;

  for (let i = 0; i < rawRows.length; i++) {
    const detected = detectHeaders(rawRows[i]);
    if (detected) {
      col = detected;
      headerIdx = i;
      break;
    }
  }

  if (!col || headerIdx === -1) {
    // Build a diagnostic preview of the first 15 rows
    const preview = rawRows
      .slice(0, 15)
      .map(
        (row, i) =>
          `Row ${i}: [${(row || []).map((c) => JSON.stringify(c)).join(", ")}]`
      )
      .join("\n");

    throw new Error(
      `Could not find column headers (looked for a row with 'Date' + 'Debit'/'Credit').\n\nFirst 15 rows:\n${preview}`
    );
  }

  // Phase 2: Walk rows, detect account headers and transactions.
  // The header row pattern may repeat per-section — re-detect and skip those.
  const rows: GLRow[] = [];
  let curCode = "";
  let curName = "";
  const accountSet = new Set<string>();
  let dateFrom: string | null = null;
  let dateTo: string | null = null;

  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row) continue;

    // Blank row?
    const allEmpty = row.every(
      (c) => c === null || c === undefined || String(c).trim() === ""
    );
    if (allEmpty) continue;

    // Skip repeated header rows
    if (detectHeaders(row)) {
      continue;
    }

    const firstCell = String(row[0] ?? "").trim();

    // Account header?
    const acctMatch = firstCell.match(ACCOUNT_HEADER_RE);
    if (acctMatch && !parseDate(row[0])) {
      curCode = acctMatch[1];
      curName = acctMatch[2].trim();
      accountSet.add(`${curCode} - ${curName}`);
      continue;
    }

    // Total/summary row?
    if (firstCell.toLowerCase().startsWith("total")) continue;

    // Transaction row — must have a parseable date
    const dateVal = row[col.date];
    const dateStr = parseDate(dateVal);
    if (!dateStr) continue;
    if (!curCode) continue; // haven't seen an account header yet

    const debit = parseNumber(
      col.debit !== undefined ? row[col.debit] : null
    );
    const credit = parseNumber(
      col.credit !== undefined ? row[col.credit] : null
    );

    // Skip zero-value rows (opening balance lines with no movement)
    if (debit === 0 && credit === 0) continue;

    rows.push({
      accountCode: curCode,
      accountName: curName,
      date: dateStr,
      source: str(col.source !== undefined ? row[col.source] : null),
      description: str(
        col.description !== undefined ? row[col.description] : null
      ),
      reference: str(col.reference !== undefined ? row[col.reference] : null),
      contact: str(col.contact !== undefined ? row[col.contact] : null),
      debit,
      credit,
    });

    if (!dateFrom || dateStr < dateFrom) dateFrom = dateStr;
    if (!dateTo || dateStr > dateTo) dateTo = dateStr;
  }

  return {
    rows,
    dateFrom,
    dateTo,
    accountCount: accountSet.size,
    accounts: [...accountSet].sort(),
  };
}

// ── Helpers ──

function str(val: unknown): string {
  if (val === null || val === undefined) return "";
  return String(val).trim();
}

function parseDate(val: unknown): string | null {
  if (val === null || val === undefined) return null;

  // JS Date object (from cellDates: true)
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString().split("T")[0];
  }

  const s = String(val).trim();
  if (!s) return null;

  // ISO: 2026-02-01
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // UK: 01/02/2026 or 1/2/2026
  const ukMatch = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (ukMatch) {
    return `${ukMatch[3]}-${ukMatch[2].padStart(2, "0")}-${ukMatch[1].padStart(2, "0")}`;
  }

  // Short UK: 01/02/26
  const ukShortMatch = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2})$/);
  if (ukShortMatch) {
    const yr = parseInt(ukShortMatch[3]);
    const fullYear = yr >= 50 ? `19${ukShortMatch[3]}` : `20${ukShortMatch[3]}`;
    return `${fullYear}-${ukShortMatch[2].padStart(2, "0")}-${ukShortMatch[1].padStart(2, "0")}`;
  }

  // Text: 1 Feb 2026, 01 February 2026
  const textMatch = s.match(/^(\d{1,2})\s+(\w{3,9})\s+(\d{2,4})$/);
  if (textMatch) {
    const m = monthNum(textMatch[2]);
    if (m) {
      let yr = textMatch[3];
      if (yr.length === 2) {
        const n = parseInt(yr);
        yr = n >= 50 ? `19${yr}` : `20${yr}`;
      }
      return `${yr}-${m}-${textMatch[1].padStart(2, "0")}`;
    }
  }

  // Excel serial number (days since 1899-12-30)
  const num = Number(s);
  if (!isNaN(num) && num > 30000 && num < 100000) {
    const epoch = new Date(1899, 11, 30);
    const d = new Date(epoch.getTime() + num * 86400000);
    return d.toISOString().split("T")[0];
  }

  return null;
}

function monthNum(name: string): string | null {
  const map: Record<string, string> = {
    jan: "01", january: "01",
    feb: "02", february: "02",
    mar: "03", march: "03",
    apr: "04", april: "04",
    may: "05",
    jun: "06", june: "06",
    jul: "07", july: "07",
    aug: "08", august: "08",
    sep: "09", september: "09",
    oct: "10", october: "10",
    nov: "11", november: "11",
    dec: "12", december: "12",
  };
  return map[name.toLowerCase()] ?? null;
}

function parseNumber(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return val;
  const s = String(val)
    .replace(/[,£$€\s]/g, "")
    .trim();
  if (!s || s === "-") return 0;
  // Handle parentheses for negatives: (500.00) → -500.00
  const parenMatch = s.match(/^\((.+)\)$/);
  if (parenMatch) {
    const n = parseFloat(parenMatch[1]);
    return isNaN(n) ? 0 : -n;
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
