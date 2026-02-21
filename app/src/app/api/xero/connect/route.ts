import { auth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";

const XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.transactions.read",
  "accounting.contacts.read",
  "accounting.settings.read",
  "offline_access",
].join(" ");

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = request.nextUrl.searchParams.get("clientId");
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  const xeroClientId = process.env.XERO_CLIENT_ID;
  if (!xeroClientId) {
    return NextResponse.json({ error: "Xero not configured" }, { status: 500 });
  }

  // State encodes clientId + CSRF token
  const csrfToken = randomBytes(16).toString("hex");
  const state = `${clientId}:${csrfToken}`;

  // Build the callback URL from the request
  const baseUrl = `${request.nextUrl.protocol}//${request.nextUrl.host}`;
  const redirectUri = `${baseUrl}/api/xero/callback`;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: xeroClientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  });

  const authUrl = `${XERO_AUTH_URL}?${params.toString()}`;

  // Store CSRF token in a cookie for validation on callback
  const response = NextResponse.redirect(authUrl);
  response.cookies.set("xero_csrf", csrfToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });

  return response;
}
