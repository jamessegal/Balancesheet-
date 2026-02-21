import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { xeroConnections } from "@/lib/db/schema";
import { encrypt } from "@/lib/xero/crypto";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONNECTIONS_URL = "https://api.xero.com/connections";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface XeroTenant {
  id: string;
  authEventId: string;
  tenantId: string;
  tenantType: string;
  tenantName: string;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    console.error("Xero OAuth error:", error);
    return NextResponse.redirect(
      new URL("/clients?error=xero_denied", request.url)
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/clients?error=xero_invalid", request.url)
    );
  }

  // Parse state: clientId:csrfToken
  const [clientId, csrfToken] = state.split(":");

  // Validate CSRF
  const storedCsrf = request.cookies.get("xero_csrf")?.value;
  if (!storedCsrf || storedCsrf !== csrfToken) {
    return NextResponse.redirect(
      new URL("/clients?error=xero_csrf", request.url)
    );
  }

  const xeroClientId = process.env.XERO_CLIENT_ID!;
  const xeroClientSecret = process.env.XERO_CLIENT_SECRET!;
  const baseUrl = process.env.APP_URL || `${request.nextUrl.protocol}//${request.nextUrl.host}`;
  const redirectUri = `${baseUrl}/api/xero/callback`;

  // Exchange code for tokens
  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${xeroClientId}:${xeroClientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    console.error("Xero token exchange failed:", tokenResponse.status, body);
    return NextResponse.redirect(
      new URL(`/clients/${clientId}?error=xero_token_failed`, request.url)
    );
  }

  const tokens: TokenResponse = await tokenResponse.json();

  // Get the connected Xero tenant(s)
  const connectionsResponse = await fetch(CONNECTIONS_URL, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
    },
  });

  if (!connectionsResponse.ok) {
    console.error("Failed to get Xero connections:", connectionsResponse.status);
    return NextResponse.redirect(
      new URL(`/clients/${clientId}?error=xero_connections_failed`, request.url)
    );
  }

  const tenants: XeroTenant[] = await connectionsResponse.json();

  if (tenants.length === 0) {
    return NextResponse.redirect(
      new URL(`/clients/${clientId}?error=xero_no_tenants`, request.url)
    );
  }

  // Use the first tenant (most common case — one org per connection)
  const tenant = tenants[0];

  // Upsert the Xero connection (one per client)
  const [existing] = await db
    .select()
    .from(xeroConnections)
    .where(eq(xeroConnections.clientId, clientId))
    .limit(1);

  const connectionData = {
    xeroTenantId: tenant.tenantId,
    xeroTenantName: tenant.tenantName,
    accessToken: encrypt(tokens.access_token),
    refreshToken: encrypt(tokens.refresh_token),
    tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    scopes: tokens.scope,
    connectedBy: session.user.id,
    status: "active" as const,
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(xeroConnections)
      .set(connectionData)
      .where(eq(xeroConnections.id, existing.id));
  } else {
    await db.insert(xeroConnections).values({
      clientId,
      connectedAt: new Date(),
      ...connectionData,
    });
  }

  // Clear the CSRF cookie and redirect to client page
  const response = NextResponse.redirect(
    new URL(`/clients/${clientId}?xero=connected`, request.url)
  );
  response.cookies.delete("xero_csrf");

  return response;
}
