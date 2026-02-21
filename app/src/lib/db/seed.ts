import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { hash } from "bcryptjs";
import { users } from "./schema";

async function seed() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const client = postgres(connectionString);
  const db = drizzle(client);

  console.log("Seeding database...");

  const passwordHash = await hash("changeme123", 12);

  await db
    .insert(users)
    .values({
      email: "james@fin-house.co.uk",
      name: "James",
      passwordHash,
      role: "admin",
    })
    .onConflictDoNothing({ target: users.email });

  console.log("Admin user created: james@fin-house.co.uk / changeme123");
  console.log("Done. Change this password after first login.");

  await client.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
