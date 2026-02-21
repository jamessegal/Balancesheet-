/**
 * Parse a Xero General Ledger / Account Transactions Excel report.
 *
 * Supports two Xero export flavours:
 *
 * A) "General Ledger (Detailed)" — account headers like "620 - Prepayments"
 * B) "Account Transactions" — account headers like "Accounts Payable"
 *    with columns: Date | Source | Description | Reference | Currency |
 *    Debit (Source) | Credit (Source) | Debit (GBP) | Credit (GBP) | Running Balance (GBP)
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
  accounts: string[]; // "620 - Prepayments", "Accounts Payable", etc.
}

// ── Column detection ──

// "Debit (GBP)" → true, "Debit (Source)" → true, "Debit" → true, "Dr" → true
function isDebitCol(s: string): boolean {
  const l = s.toLowerCase().trim();
  return l === "debit" || l === "dr" || l === "dr." || l.startsWith("debit");
}
function isCreditCol(s: string): boolean {
  const l = s.toLowerCase().trim();
  return l === "credit" || l === "cr" || l === "cr." || l.startsWith("credit");
}
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
    l === "contact" || l === "name" || l === "contact name" || l === "payee"
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
  return (
    l === "reference" || l === "ref" || l === "ref." || l === "invoice number"
  );
}

/** Returns true if the column header looks like a local/reporting currency amount. */
function isLocalCurrency(header: string): boolean {
  const l = header.toLowerCase();
  // "Debit (GBP)", "Credit (GBP)", "Debit (NZD)", etc.
  // Prefer these over "(Source)" columns
  return /\([a-z]{3}\)/.test(l) && !l.includes("source");
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

/**
 * Detect column headers from a single row.
 * When there are both (Source) and (GBP) columns, prefer the local currency.
 */
function detectHeaders(row: unknown[]): ColMap | null {
  if (!row || row.length < 3) return null;

  const cells = row.map((c) => String(c ?? "").trim());

  let dateIdx = -1;
  // Track multiple debit/credit columns so we can pick the best one
  const debitCols: { idx: number; local: boolean }[] = [];
  const creditCols: { idx: number; local: boolean }[] = [];

  for (let j = 0; j < cells.length; j++) {
    const c = cells[j];
    if (isDateCol(c)) dateIdx = j;
    if (isDebitCol(c)) debitCols.push({ idx: j, local: isLocalCurrency(c) });
    if (isCreditCol(c)) creditCols.push({ idx: j, local: isLocalCurrency(c) });
  }

  if (dateIdx === -1 || (debitCols.length === 0 && creditCols.length === 0)) {
    return null;
  }

  // Prefer local currency columns; fall back to first match
  const pickBest = (cols: { idx: number; local: boolean }[]) => {
    const local = cols.find((c) => c.local);
    return (local ?? cols[0])?.idx;
  };

  const map: ColMap = { date: dateIdx };
  const debitIdx = pickBest(debitCols);
  const creditIdx = pickBest(creditCols);
  if (debitIdx !== undefined) map.debit = debitIdx;
  if (creditIdx !== undefined) map.credit = creditIdx;

  const usedIdxs = new Set([dateIdx, debitIdx, creditIdx]);

  for (let j = 0; j < cells.length; j++) {
    if (usedIdxs.has(j)) continue;
    const c = cells[j];
    if (isSourceCol(c)) map.source = j;
    else if (isContactCol(c)) map.contact = j;
    else if (isDescCol(c)) map.description = j;
    else if (isRefCol(c)) map.reference = j;
  }

  return map;
}

// ── Account header detection ──

// Format A: "620 - Prepayments", "Account: 620 - Prepayments"
const CODED_ACCOUNT_RE = /^(?:Account:?\s*)?(\d{2,5})\s*[-–—]\s*(.+)$/;

// Rows to skip (never treat as account headers)
const SKIP_PREFIXES = [
  "total",
  "opening balance",
  "closing balance",
  "net movement",
];

/**
 * Check if a row is an account section header.
 * Returns { code, name } or null.
 *
 * An account header row has text only in the first cell.
 */
function detectAccountHeader(
  row: unknown[]
): { code: string; name: string } | null {
  if (!row || row.length === 0) return null;

  const firstCell = String(row[0] ?? "").trim();
  if (!firstCell) return null;

  // Must not be a date
  if (parseDate(row[0])) return null;

  const lower = firstCell.toLowerCase();

  // Must not be a skip keyword
  for (const prefix of SKIP_PREFIXES) {
    if (lower.startsWith(prefix)) return null;
  }

  // All other cells must be empty/null (account header = single-cell label row)
  const otherCellsEmpty = row.slice(1).every((c) => {
    if (c === null || c === undefined) return true;
    const s = String(c).trim();
    return s === "" || s === "0" || s === "null";
  });
  if (!otherCellsEmpty) return null;

  // Format A: coded — "620 - Prepayments"
  const coded = firstCell.match(CODED_ACCOUNT_RE);
  if (coded) {
    return { code: coded[1], name: coded[2].trim() };
  }

  // Format B: name-only — "Accounts Payable"
  // Use the full name as the code (the DB field is text, not integer)
  return { code: firstCell, name: firstCell };
}

// ── Main parser ──

export function parseGLReport(buffer: Buffer): GLParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
  });

  // Phase 1: Find the header row
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
    const preview = rawRows
      .slice(0, 20)
      .map(
        (row, i) =>
          `Row ${i}: [${(row || []).map((c) => JSON.stringify(c)).join(", ")}]`
      )
      .join("\n");

    throw new Error(
      `Could not find column headers (looked for a row containing 'Date' plus 'Debit'/'Credit').\n\nFirst 20 rows:\n${preview}`
    );
  }

  // Phase 2: Walk rows — detect account sections and extract transactions
  const rows: GLRow[] = [];
  let curCode = "";
  let curName = "";
  const accountSet = new Set<string>();
  let dateFrom: string | null = null;
  let dateTo: string | null = null;

  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row) continue;

    // Blank row
    const allEmpty = row.every(
      (c) => c === null || c === undefined || String(c).trim() === ""
    );
    if (allEmpty) continue;

    // Skip repeated header rows
    if (detectHeaders(row)) continue;

    const firstCell = String(row[0] ?? "").trim();
    const lower = firstCell.toLowerCase();

    // Skip totals / opening / closing balance rows
    if (
      SKIP_PREFIXES.some((p) => lower.startsWith(p))
    ) {
      continue;
    }

    // Account header?
    const acct = detectAccountHeader(row);
    if (acct) {
      curCode = acct.code;
      curName = acct.name;
      accountSet.add(curCode === curName ? curName : `${curCode} - ${curName}`);
      continue;
    }

    // Transaction row — must have a parseable date
    const dateVal = row[col.date];
    const dateStr = parseDate(dateVal);
    if (!dateStr) continue;
    if (!curCode) continue; // no account header seen yet

    const debit = parseNumber(
      col.debit !== undefined ? row[col.debit] : null
    );
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

  // ISO datetime: "2025-03-01T00:00:00.000Z" or "2026-02-01"
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
