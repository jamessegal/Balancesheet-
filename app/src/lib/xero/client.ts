import { db } from "@/lib/db";
import { xeroConnections } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { decrypt, encrypt } from "./crypto";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const TOKEN_URL = "https://identity.xero.com/connect/token";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

/**
 * Refresh the Xero access token if it's expired or about to expire (within 5 min).
 * Returns the decrypted access token ready to use.
 */
export async function getValidAccessToken(connectionId: string): Promise<string> {
  const [connection] = await db
    .select()
    .from(xeroConnections)
    .where(eq(xeroConnections.id, connectionId))
    .limit(1);

  if (!connection) {
    throw new Error("Xero connection not found");
  }

  if (connection.status !== "active") {
    throw new Error(`Xero connection is ${connection.status}`);
  }

  const now = new Date();
  const expiresAt = new Date(connection.tokenExpiresAt);
  const fiveMinFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  // Token still valid
  if (expiresAt > fiveMinFromNow) {
    return decrypt(connection.accessToken);
  }

  // Token expired or about to expire — refresh it
  const refreshToken = decrypt(connection.refreshToken);
  const clientId = process.env.XERO_CLIENT_ID!;
  const clientSecret = process.env.XERO_CLIENT_SECRET!;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    // Token refresh failed — mark connection as expired
    await db
      .update(xeroConnections)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(xeroConnections.id, connectionId));

    throw new Error(`Xero token refresh failed: ${response.status}`);
  }

  const tokens: TokenResponse = await response.json();

  // Store new encrypted tokens
  await db
    .update(xeroConnections)
    .set({
      accessToken: encrypt(tokens.access_token),
      refreshToken: encrypt(tokens.refresh_token),
      tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      updatedAt: new Date(),
    })
    .where(eq(xeroConnections.id, connectionId));

  return tokens.access_token;
}

/**
 * Make an authenticated GET request to the Xero API.
 */
export async function xeroGet<T>(
  connectionId: string,
  tenantId: string,
  path: string
): Promise<T> {
  const accessToken = await getValidAccessToken(connectionId);

  const response = await fetch(`${XERO_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Xero-Tenant-Id": tenantId,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Xero API error ${response.status}: ${body}`);
  }

  return response.json();
}
