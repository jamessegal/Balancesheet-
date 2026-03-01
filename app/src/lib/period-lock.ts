import { db } from "@/lib/db";
import { reconciliationAccounts, reconciliationPeriods } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Check if an account's period is locked (all accounts approved).
 * Returns an error message if locked, null if modifications are allowed.
 *
 * An account is locked when:
 * - The period status is "approved", OR
 * - The individual account status is "approved"
 *
 * Approved accounts cannot be modified — they must be reopened first.
 */
export async function checkAccountLocked(
  accountId: string
): Promise<string | null> {
  const [account] = await db
    .select({
      status: reconciliationAccounts.status,
      periodId: reconciliationAccounts.periodId,
    })
    .from(reconciliationAccounts)
    .where(eq(reconciliationAccounts.id, accountId))
    .limit(1);

  if (!account) return "Account not found";

  if (account.status === "approved") {
    return "This account is approved. Reopen it before making changes.";
  }

  // Also check if the period itself is approved
  const [period] = await db
    .select({ status: reconciliationPeriods.status })
    .from(reconciliationPeriods)
    .where(eq(reconciliationPeriods.id, account.periodId))
    .limit(1);

  if (period?.status === "approved") {
    return "This period is approved and locked. Reopen the period before making changes.";
  }

  return null;
}
