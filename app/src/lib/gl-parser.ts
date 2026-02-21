/**
 * Parse a Xero General Ledger (Detailed) Excel report.
 *
 * Xero's GL export has account sections with transaction rows:
 *   "620 - Prepayments"       ← account header
 *   Date | Source | Contact | Description | Reference | Debit | Credit | ...
 *   01/02/2026 | MJ | ... | Prepayment release | ... | | 41.58 | ...
 *   ...
 *   Total 620 - Prepayments   ← skip
 *   (blank)                    ← skip
 *   "485 - Software"           ← next account header
 *
 * The parser auto-detects column positions from the header row.
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

// Account header pattern: "620 - Prepayments" or "620 – Prepayments"
const ACCOUNT_HEADER_RE = /^(\d{2,4})\s*[-–—]\s*(.+)$/;

// Column name aliases
const DATE_ALIASES = ["date"];
const SOURCE_ALIASES = ["source", "type"];
const CONTACT_ALIASES = ["contact", "name", "contact name"];
const DESC_ALIASES = ["description", "details", "particular", "particulars"];
const REF_ALIASES = ["reference", "ref", "ref."];
const DEBIT_ALIASES = ["debit"];
const CREDIT_ALIASES = ["credit"];

function matchAlias(cell: string, aliases: string[]): boolean {
  const lower = cell.toLowerCase().trim();
  return aliases.includes(lower);
}

export function parseGLReport(buffer: Buffer): GLParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
  });

  // Step 1: Find column header row
  let headerIdx = -1;
  const col: Record<string, number> = {};

  for (let i = 0; i < Math.min(rawRows.length, 30); i++) {
    const row = rawRows[i];
    if (!row) continue;

    const cells = row.map((c) => String(c ?? ""));
    const hasDate = cells.some((c) => matchAlias(c, DATE_ALIASES));
    const hasDebit = cells.some((c) => matchAlias(c, DEBIT_ALIASES));
    const hasCredit = cells.some((c) => matchAlias(c, CREDIT_ALIASES));

    if (hasDate && (hasDebit || hasCredit)) {
      headerIdx = i;
      for (let j = 0; j < cells.length; j++) {
        const c = cells[j];
        if (matchAlias(c, DATE_ALIASES)) col.date = j;
        else if (matchAlias(c, SOURCE_ALIASES)) col.source = j;
        else if (matchAlias(c, CONTACT_ALIASES)) col.contact = j;
        else if (matchAlias(c, DESC_ALIASES)) col.description = j;
        else if (matchAlias(c, REF_ALIASES)) col.reference = j;
        else if (matchAlias(c, DEBIT_ALIASES)) col.debit = j;
        else if (matchAlias(c, CREDIT_ALIASES)) col.credit = j;
      }
      break;
    }
  }

  if (headerIdx === -1) {
    throw new Error(
      "Could not find column headers. Expected a row with 'Date', 'Debit', and/or 'Credit'."
    );
  }

  // Step 2: Walk rows, detect account headers and transactions
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

    const firstCell = String(row[0] ?? "").trim();

    // Account header?
    const acctMatch = firstCell.match(ACCOUNT_HEADER_RE);
    if (acctMatch && !parseDate(row[0])) {
      curCode = acctMatch[1];
      curName = acctMatch[2].trim();
      accountSet.add(`${curCode} - ${curName}`);
      continue;
    }

    // Total row?
    if (firstCell.toLowerCase().startsWith("total")) continue;

    // Transaction row — must have a parseable date
    const dateVal = col.date !== undefined ? row[col.date] : row[0];
    const dateStr = parseDate(dateVal);
    if (!dateStr) continue;
    if (!curCode) continue; // haven't seen an account header yet

    const debit = parseNumber(col.debit !== undefined ? row[col.debit] : null);
    const credit = parseNumber(
      col.credit !== undefined ? row[col.credit] : null
    );

    // Skip zero-value rows (e.g. opening balance lines with no movement)
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

  // Text: 1 Feb 2026, 01 February 2026
  const textMatch = s.match(/^(\d{1,2})\s+(\w{3,9})\s+(\d{4})$/);
  if (textMatch) {
    const m = monthNum(textMatch[2]);
    if (m)
      return `${textMatch[3]}-${m}-${textMatch[1].padStart(2, "0")}`;
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
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
