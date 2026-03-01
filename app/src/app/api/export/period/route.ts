import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasMinRole } from "@/lib/authorization";
import { db } from "@/lib/db";
import {
  clients,
  reconciliationPeriods,
  reconciliationAccounts,
  reconciliationItems,
  users,
} from "@/lib/db/schema";
import { eq, asc, sql } from "drizzle-orm";
import ExcelJS from "exceljs";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function classifyAccount(accountType: string): string {
  const lower = accountType.toLowerCase();
  if (lower.includes("fixed") || (lower.includes("non") && lower.includes("asset")))
    return "Fixed Assets";
  if (lower.includes("asset") || lower === "bank" || lower === "inventory" || lower === "prepayment")
    return "Current Assets";
  if (lower.includes("non") && lower.includes("liabilit"))
    return "Non-current Liabilities";
  if (lower.includes("liabilit"))
    return "Current Liabilities";
  if (lower.includes("equity") || lower.includes("retained") || lower.includes("capital"))
    return "Equity";
  return "Other";
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasMinRole(session.user.role as "admin" | "manager" | "junior", "junior")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const periodId = request.nextUrl.searchParams.get("periodId");
  if (!periodId) {
    return NextResponse.json({ error: "periodId is required" }, { status: 400 });
  }

  // Load data
  const [period] = await db
    .select()
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.id, periodId))
    .limit(1);

  if (!period) {
    return NextResponse.json({ error: "Period not found" }, { status: 404 });
  }

  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, period.clientId))
    .limit(1);

  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  const accounts = await db
    .select()
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.periodId, periodId))
    .orderBy(reconciliationAccounts.accountCode);

  // Load recon items for all accounts
  const accountItemsMap: Record<string, { description: string; amount: string; itemDate: string | null; createdByName: string | null }[]> = {};
  for (const acc of accounts) {
    const items = await db
      .select({
        description: reconciliationItems.description,
        amount: reconciliationItems.amount,
        itemDate: reconciliationItems.itemDate,
        createdByName: users.name,
      })
      .from(reconciliationItems)
      .leftJoin(users, eq(reconciliationItems.createdBy, users.id))
      .where(eq(reconciliationItems.reconAccountId, acc.id))
      .orderBy(asc(reconciliationItems.createdAt));
    accountItemsMap[acc.id] = items;
  }

  // Create workbook
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Fin-House Reconciliation";
  workbook.created = new Date();

  const periodLabel = `${MONTH_NAMES[period.periodMonth - 1]} ${period.periodYear}`;

  // ── Sheet 1: Summary ──
  const summarySheet = workbook.addWorksheet("Summary");

  // Header
  summarySheet.mergeCells("A1:F1");
  const titleCell = summarySheet.getCell("A1");
  titleCell.value = `${client.name} — Balance Sheet Reconciliation — ${periodLabel}`;
  titleCell.font = { bold: true, size: 14 };

  summarySheet.mergeCells("A2:F2");
  summarySheet.getCell("A2").value = `Status: ${period.status} | Exported: ${new Date().toLocaleDateString("en-GB")}`;
  summarySheet.getCell("A2").font = { size: 10, color: { argb: "FF666666" } };

  // Column headers
  const headerRow = summarySheet.addRow([]);
  summarySheet.addRow([]);
  const colHeaders = summarySheet.addRow([
    "Account Code", "Account Name", "Section", "Balance", "Prior Balance", "Movement", "Recon Items Total", "Variance", "Status",
  ]);
  colHeaders.font = { bold: true };
  colHeaders.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
    cell.border = { bottom: { style: "thin" } };
  });

  summarySheet.getColumn(1).width = 14;
  summarySheet.getColumn(2).width = 35;
  summarySheet.getColumn(3).width = 22;
  summarySheet.getColumn(4).width = 16;
  summarySheet.getColumn(5).width = 16;
  summarySheet.getColumn(6).width = 16;
  summarySheet.getColumn(7).width = 18;
  summarySheet.getColumn(8).width = 16;
  summarySheet.getColumn(9).width = 16;

  const currencyFormat = "£#,##0.00;[Red]-£#,##0.00";

  for (const acc of accounts) {
    const balance = parseFloat(acc.balance);
    const prior = acc.priorBalance ? parseFloat(acc.priorBalance) : 0;
    const movement = balance - prior;
    const items = accountItemsMap[acc.id] || [];
    const itemsTotal = items.reduce((s, i) => s + parseFloat(i.amount), 0);
    const variance = balance - itemsTotal;
    const section = classifyAccount(acc.accountType);

    const row = summarySheet.addRow([
      acc.accountCode || "",
      acc.accountName,
      section,
      balance,
      prior,
      movement,
      itemsTotal,
      variance,
      acc.status,
    ]);

    // Format currency columns
    for (const col of [4, 5, 6, 7, 8]) {
      row.getCell(col).numFmt = currencyFormat;
    }

    // Highlight variance
    if (Math.abs(variance) > 0.01) {
      row.getCell(8).font = { color: { argb: "FFDC2626" }, bold: true };
    } else {
      row.getCell(8).font = { color: { argb: "FF16A34A" } };
    }
  }

  // Totals row
  const totalRow = summarySheet.addRow([]);
  summarySheet.addRow([]);
  const reconciledCount = accounts.filter((a) => {
    const items = accountItemsMap[a.id] || [];
    const total = items.reduce((s, i) => s + parseFloat(i.amount), 0);
    return Math.abs(parseFloat(a.balance) - total) < 0.01;
  }).length;
  summarySheet.addRow([
    `Reconciled: ${reconciledCount}/${accounts.length} (${accounts.length > 0 ? Math.round((reconciledCount / accounts.length) * 100) : 0}%)`,
  ]).font = { bold: true, size: 11 };

  // ── Sheet 2: Per-account detail ──
  const detailSheet = workbook.addWorksheet("Account Details");

  detailSheet.getColumn(1).width = 14;
  detailSheet.getColumn(2).width = 35;
  detailSheet.getColumn(3).width = 14;
  detailSheet.getColumn(4).width = 16;
  detailSheet.getColumn(5).width = 20;

  let currentRow = 1;

  for (const acc of accounts) {
    const balance = parseFloat(acc.balance);
    const items = accountItemsMap[acc.id] || [];
    const itemsTotal = items.reduce((s, i) => s + parseFloat(i.amount), 0);
    const variance = balance - itemsTotal;

    // Account header
    const accHeader = detailSheet.getRow(currentRow);
    accHeader.getCell(1).value = acc.accountCode || "";
    accHeader.getCell(2).value = acc.accountName;
    accHeader.getCell(3).value = `Balance: `;
    accHeader.getCell(4).value = balance;
    accHeader.getCell(4).numFmt = currencyFormat;
    accHeader.font = { bold: true, size: 11 };
    accHeader.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
    accHeader.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
    accHeader.getCell(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
    accHeader.getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
    accHeader.getCell(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
    currentRow++;

    if (items.length > 0) {
      // Item column headers
      const itemHeaderRow = detailSheet.getRow(currentRow);
      itemHeaderRow.getCell(1).value = "Date";
      itemHeaderRow.getCell(2).value = "Description";
      itemHeaderRow.getCell(3).value = "Amount";
      itemHeaderRow.getCell(4).value = "Prepared By";
      itemHeaderRow.font = { bold: true };
      currentRow++;

      for (const item of items) {
        const itemRow = detailSheet.getRow(currentRow);
        itemRow.getCell(1).value = item.itemDate || "";
        itemRow.getCell(2).value = item.description;
        itemRow.getCell(3).value = parseFloat(item.amount);
        itemRow.getCell(3).numFmt = currencyFormat;
        itemRow.getCell(4).value = item.createdByName || "";
        currentRow++;
      }

      // Subtotal
      const subRow = detailSheet.getRow(currentRow);
      subRow.getCell(2).value = "Total Items";
      subRow.getCell(3).value = itemsTotal;
      subRow.getCell(3).numFmt = currencyFormat;
      subRow.font = { bold: true };
      subRow.getCell(3).border = { top: { style: "thin" } };
      currentRow++;

      // Variance
      const varRow = detailSheet.getRow(currentRow);
      varRow.getCell(2).value = "Variance";
      varRow.getCell(3).value = variance;
      varRow.getCell(3).numFmt = currencyFormat;
      varRow.font = {
        bold: true,
        color: { argb: Math.abs(variance) < 0.01 ? "FF16A34A" : "FFDC2626" },
      };
      currentRow++;
    } else {
      const noItems = detailSheet.getRow(currentRow);
      noItems.getCell(2).value = "No reconciliation items";
      noItems.font = { italic: true, color: { argb: "FF999999" } };
      currentRow++;
    }

    // Blank row between accounts
    currentRow++;
  }

  // Generate buffer
  const buffer = await workbook.xlsx.writeBuffer();

  const fileName = `${client.code}_${period.periodYear}_${String(period.periodMonth).padStart(2, "0")}_reconciliation.xlsx`;

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
