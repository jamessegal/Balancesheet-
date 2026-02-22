/**
 * Seed script: 3 bank accounts across 2 companies for bank recon testing.
 *
 * Company D (Delta Trading Ltd)
 *   - GBP Current Account: balances match exactly (happy path)
 *   - USD Dollar Account: balances match exactly (multi-currency)
 *
 * Company E (Echo Imports Ltd)
 *   - GBP Current Account: balances differ (unpresented cheque scenario)
 *
 * Run:  npx tsx src/lib/db/seed-bank-recon.ts
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import {
  users,
  clients,
  reconciliationPeriods,
  reconciliationAccounts,
  accountReconConfig,
} from "./schema";

async function seedBankReconData() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const client = postgres(connectionString);
  const db = drizzle(client);

  // Get admin user
  const [adminUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, "james@fin-house.co.uk"))
    .limit(1);

  if (!adminUser) {
    console.error("Admin user not found. Run the base seed first.");
    await client.end();
    process.exit(1);
  }

  const userId = adminUser.id;
  console.log(`Using admin user: ${adminUser.name} (${adminUser.id})`);

  // ════════════════════════════════════════════════════════════════
  // COMPANY D: Delta Trading Ltd — GBP & USD accounts that match
  // ════════════════════════════════════════════════════════════════
  console.log("\n── Company D: Delta Trading Ltd (bank accounts match) ──");

  const [deltaClient] = await db
    .insert(clients)
    .values({
      name: "Delta Trading Ltd",
      code: "DELTA",
      createdBy: userId,
    })
    .onConflictDoNothing()
    .returning();

  if (!deltaClient) {
    console.log("  Client DELTA already exists, skipping.");
  } else {
    console.log(`  Created client: Delta Trading Ltd (${deltaClient.id})`);

    // Create periods: Jan and Feb 2026
    for (const month of [1, 2]) {
      const [period] = await db
        .insert(reconciliationPeriods)
        .values({
          clientId: deltaClient.id,
          periodYear: 2026,
          periodMonth: month,
          status: "in_progress",
          openedBy: userId,
        })
        .returning();

      // GBP Current Account
      const gbpBalances: Record<number, string> = {
        1: "45230.67",
        2: "52841.33",
      };
      const gbpPrior: Record<number, string | null> = {
        1: null,
        2: "45230.67",
      };

      await db.insert(reconciliationAccounts).values({
        periodId: period.id,
        xeroAccountId: "test-bank-delta-gbp",
        accountCode: "090",
        accountName: "Business Current Account",
        accountType: "BANK",
        balance: gbpBalances[month],
        priorBalance: gbpPrior[month],
        status: "in_progress",
      });

      // USD Dollar Account
      const usdBalances: Record<number, string> = {
        1: "18500.00",
        2: "22150.50",
      };
      const usdPrior: Record<number, string | null> = {
        1: null,
        2: "18500.00",
      };

      await db.insert(reconciliationAccounts).values({
        periodId: period.id,
        xeroAccountId: "test-bank-delta-usd",
        accountCode: "091",
        accountName: "USD Dollar Account",
        accountType: "BANK",
        balance: usdBalances[month],
        priorBalance: usdPrior[month],
        status: "in_progress",
      });

      const monthLabel = `2026-${String(month).padStart(2, "0")}`;
      console.log(
        `    ${monthLabel}: GBP=${gbpBalances[month]}, USD=${usdBalances[month]}`
      );
    }

    // Set recon config for bank accounts
    await db.insert(accountReconConfig).values([
      {
        clientId: deltaClient.id,
        xeroAccountId: "test-bank-delta-gbp",
        accountName: "Business Current Account",
        reconModule: "bank",
      },
      {
        clientId: deltaClient.id,
        xeroAccountId: "test-bank-delta-usd",
        accountName: "USD Dollar Account",
        reconModule: "bank",
      },
    ]);
  }

  // ════════════════════════════════════════════════════════════════
  // COMPANY E: Echo Imports Ltd — Bank with mismatches
  // ════════════════════════════════════════════════════════════════
  console.log("\n── Company E: Echo Imports Ltd (bank with mismatches) ──");

  const [echoClient] = await db
    .insert(clients)
    .values({
      name: "Echo Imports Ltd",
      code: "ECHO",
      createdBy: userId,
    })
    .onConflictDoNothing()
    .returning();

  if (!echoClient) {
    console.log("  Client ECHO already exists, skipping.");
  } else {
    console.log(`  Created client: Echo Imports Ltd (${echoClient.id})`);

    // Create periods: Jan and Feb 2026
    for (const month of [1, 2]) {
      const [period] = await db
        .insert(reconciliationPeriods)
        .values({
          clientId: echoClient.id,
          periodYear: 2026,
          periodMonth: month,
          status: "in_progress",
          openedBy: userId,
        })
        .returning();

      // GBP Current Account — GL balance intentionally different from what
      // the bank statement would show. In Jan the difference is an unpresented
      // cheque of £1,250.00. In Feb, two unpresented items totalling £3,420.00.
      const balances: Record<number, string> = {
        1: "67890.50", // GL says 67890.50; bank statement will say 69140.50 (+1250 unpresented)
        2: "71250.00", // GL says 71250.00; bank statement will say 74670.00 (+3420 unpresented)
      };
      const prior: Record<number, string | null> = {
        1: null,
        2: "67890.50",
      };

      await db.insert(reconciliationAccounts).values({
        periodId: period.id,
        xeroAccountId: "test-bank-echo-gbp",
        accountCode: "090",
        accountName: "Business Current Account",
        accountType: "BANK",
        balance: balances[month],
        priorBalance: prior[month],
        status: "in_progress",
      });

      const monthLabel = `2026-${String(month).padStart(2, "0")}`;
      console.log(
        `    ${monthLabel}: GL balance=${balances[month]}`
      );
    }

    // Set recon config
    await db.insert(accountReconConfig).values({
      clientId: echoClient.id,
      xeroAccountId: "test-bank-echo-gbp",
      accountName: "Business Current Account",
      reconModule: "bank",
    });
  }

  console.log("\n\u2713 Bank recon test data seeded successfully.");
  console.log("  2 companies, 4 bank accounts across 2 periods each");
  console.log("\n  Scenarios:");
  console.log("    Delta GBP — balances match (happy path, enter statement balance = GL)");
  console.log("    Delta USD — balances match (multi-currency, USD)");
  console.log("    Echo GBP  — balances differ (user enters different statement balance,");
  console.log("                needs to add reconciling items to explain the variance)");
  console.log("\n  All February periods are ready for reconciliation.");

  await client.end();
}

seedBankReconData().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
