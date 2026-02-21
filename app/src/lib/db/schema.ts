import {
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  pgEnum,
  integer,
  numeric,
  unique,
} from "drizzle-orm/pg-core";

export const xeroConnectionStatusEnum = pgEnum("xero_connection_status", [
  "active",
  "expired",
  "revoked",
]);

export const userRoleEnum = pgEnum("user_role", [
  "admin",
  "manager",
  "junior",
]);

export const periodStatusEnum = pgEnum("period_status", [
  "draft",
  "in_progress",
  "ready_for_review",
  "approved",
  "reopened",
]);

export const accountStatusEnum = pgEnum("account_status", [
  "draft",
  "in_progress",
  "ready_for_review",
  "approved",
  "reopened",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("junior"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const clients = pgTable("clients", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  contactEmail: varchar("contact_email", { length: 255 }),
  contactName: varchar("contact_name", { length: 255 }),
  notes: text("notes"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const xeroConnections = pgTable("xero_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id)
    .unique(),
  xeroTenantId: text("xero_tenant_id").notNull(),
  xeroTenantName: text("xero_tenant_name"),
  accessToken: text("access_token").notNull(), // encrypted at rest
  refreshToken: text("refresh_token").notNull(), // encrypted at rest
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
  scopes: text("scopes"),
  connectedBy: uuid("connected_by").references(() => users.id),
  connectedAt: timestamp("connected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  status: xeroConnectionStatusEnum("status").notNull().default("active"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ============================================================
// RECONCILIATION PERIODS & ACCOUNTS
// ============================================================

export const reconciliationPeriods = pgTable(
  "reconciliation_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    periodYear: integer("period_year").notNull(),
    periodMonth: integer("period_month").notNull(),
    status: periodStatusEnum("status").notNull().default("draft"),
    openedBy: uuid("opened_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.clientId, table.periodYear, table.periodMonth)]
);

export const reconciliationAccounts = pgTable(
  "reconciliation_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    periodId: uuid("period_id")
      .notNull()
      .references(() => reconciliationPeriods.id),
    xeroAccountId: text("xero_account_id").notNull(),
    accountCode: text("account_code"),
    accountName: text("account_name").notNull(),
    accountType: text("account_type").notNull(),
    balance: numeric("balance", { precision: 18, scale: 2 }).notNull(),
    priorBalance: numeric("prior_balance", { precision: 18, scale: 2 }),
    status: accountStatusEnum("status").notNull().default("draft"),
    preparedBy: uuid("prepared_by").references(() => users.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.periodId, table.xeroAccountId)]
);

// ============================================================
// TYPES
// ============================================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type XeroConnection = typeof xeroConnections.$inferSelect;
export type NewXeroConnection = typeof xeroConnections.$inferInsert;
export type ReconciliationPeriod = typeof reconciliationPeriods.$inferSelect;
export type NewReconciliationPeriod = typeof reconciliationPeriods.$inferInsert;
export type ReconciliationAccount = typeof reconciliationAccounts.$inferSelect;
export type NewReconciliationAccount = typeof reconciliationAccounts.$inferInsert;
