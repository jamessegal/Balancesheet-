import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { bankReconStatements } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ statementId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { statementId } = await params;

  const [statement] = await db
    .select({
      documentFileName: bankReconStatements.documentFileName,
      documentData: bankReconStatements.documentData,
      documentMimeType: bankReconStatements.documentMimeType,
    })
    .from(bankReconStatements)
    .where(eq(bankReconStatements.id, statementId))
    .limit(1);

  if (!statement || !statement.documentData || !statement.documentFileName) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const buffer = Buffer.from(statement.documentData, "base64");
  const mimeType = statement.documentMimeType || "application/octet-stream";

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": `inline; filename="${statement.documentFileName}"`,
      "Content-Length": String(buffer.length),
    },
  });
}
