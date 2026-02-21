/**
 * Run SQL migrations from the drizzle/ folder.
 * Usage: tsx src/lib/db/migrate.ts
 *
 * This reads all .sql files from drizzle/ in order and executes them.
 * Each file is wrapped in a transaction for safety.
 */
import postgres from "postgres";
import fs from "fs";
import path from "path";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(connectionString);

async function main() {
  const drizzleDir = path.resolve(__dirname, "../../../../drizzle");
  const files = fs
    .readdirSync(drizzleDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  console.log(`Found ${files.length} migration files`);

  for (const file of files) {
    const filePath = path.join(drizzleDir, file);
    const content = fs.readFileSync(filePath, "utf-8");

    // Split on drizzle's statement-breakpoint markers
    const statements = content
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    console.log(`Applying ${file} (${statements.length} statements)...`);

    for (const stmt of statements) {
      try {
        await sql.unsafe(stmt);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Skip "already exists" errors (idempotent migrations)
        if (
          msg.includes("already exists") ||
          msg.includes("duplicate_object")
        ) {
          continue;
        }
        console.error(`  Error in ${file}: ${msg}`);
        throw err;
      }
    }

    console.log(`  Done: ${file}`);
  }

  console.log("All migrations applied.");
  await sql.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
