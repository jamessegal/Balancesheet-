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
  date,
  jsonb,
  index,
  boolean,
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

export const noteTypeEnum = pgEnum("note_type", [
  "prep",
  "review",
  "general",
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
// TRANSACTIONS, NOTES, RECONCILIATION ITEMS
// ============================================================

export const accountTransactions = pgTable(
  "account_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reconAccountId: uuid("recon_account_id")
      .notNull()
      .references(() => reconciliationAccounts.id),
    xeroLineItemId: text("xero_line_item_id"),
    xeroJournalId: text("xero_journal_id"),
    transactionDate: date("transaction_date").notNull(),
    description: text("description"),
    reference: text("reference"),
    contactName: text("contact_name"),
    debit: numeric("debit", { precision: 18, scale: 2 }).default("0"),
    credit: numeric("credit", { precision: 18, scale: 2 }).default("0"),
    sourceType: text("source_type"),
    rawData: jsonb("raw_data"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_account_transactions_recon").on(table.reconAccountId),
    index("idx_account_transactions_xero").on(table.xeroJournalId),
  ]
);

export const reconciliationItems = pgTable(
  "reconciliation_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reconAccountId: uuid("recon_account_id")
      .notNull()
      .references(() => reconciliationAccounts.id),
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    itemDate: date("item_date"),
    glTransactionId: uuid("gl_transaction_id").references(
      () => glTransactions.id
    ),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_reconciliation_items_recon").on(table.reconAccountId),
  ]
);

export const accountNotes = pgTable("account_notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  reconAccountId: uuid("recon_account_id")
    .notNull()
    .references(() => reconciliationAccounts.id),
  noteType: noteTypeEnum("note_type").notNull(),
  content: text("content").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ============================================================
// ACCOUNT RECONCILIATION CONFIG
// ============================================================

export const accountReconConfig = pgTable(
  "account_recon_config",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    xeroAccountId: text("xero_account_id"),
    accountName: text("account_name").notNull(),
    reconModule: text("recon_module").notNull().default("simple_list"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.clientId, table.xeroAccountId),
    index("idx_recon_config_client").on(table.clientId),
  ]
);

// ============================================================
// GENERAL LEDGER UPLOADS
// ============================================================

export const glUploads = pgTable("gl_uploads", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  fileName: text("file_name").notNull(),
  uploadedBy: uuid("uploaded_by")
    .notNull()
    .references(() => users.id),
  rowCount: integer("row_count").notNull().default(0),
  accountCount: integer("account_count").notNull().default(0),
  dateFrom: date("date_from"),
  dateTo: date("date_to"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const glTransactions = pgTable(
  "gl_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => glUploads.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    accountCode: text("account_code").notNull(),
    accountName: text("account_name").notNull(),
    transactionDate: date("transaction_date").notNull(),
    source: text("source"),
    description: text("description"),
    reference: text("reference"),
    contact: text("contact"),
    debit: numeric("debit", { precision: 18, scale: 2 }).default("0"),
    credit: numeric("credit", { precision: 18, scale: 2 }).default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_gl_transactions_client").on(table.clientId),
    index("idx_gl_transactions_account").on(table.clientId, table.accountCode),
    index("idx_gl_transactions_date").on(
      table.clientId,
      table.transactionDate
    ),
  ]
);

// ============================================================
// BANK RECONCILIATION
// ============================================================

export const bankReconStatements = pgTable("bank_recon_statements", {
  id: uuid("id").defaultRandom().primaryKey(),
  reconAccountId: uuid("recon_account_id")
    .notNull()
    .references(() => reconciliationAccounts.id)
    .unique(),
  statementDate: date("statement_date").notNull(),
  statementBalance: numeric("statement_balance", { precision: 18, scale: 2 }).notNull(),
  glBalance: numeric("gl_balance", { precision: 18, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("GBP"),
  documentFileName: text("document_file_name"),
  documentFileKey: text("document_file_key"),
  documentData: text("document_data"),
  documentMimeType: text("document_mime_type"),
  status: text("status").notNull().default("pending"),
  toleranceUsed: numeric("tolerance_used", { precision: 18, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  confirmedBy: uuid("confirmed_by").references(() => users.id),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
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

export const bankReconItems = pgTable(
  "bank_recon_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reconAccountId: uuid("recon_account_id")
      .notNull()
      .references(() => reconciliationAccounts.id),
    itemType: text("item_type").notNull().default("other"),
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    transactionDate: date("transaction_date"),
    reference: text("reference"),
    xeroTransactionId: text("xero_transaction_id"),
    source: text("source").notNull().default("manual"),
    isTicked: boolean("is_ticked").notNull().default(false),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_bank_recon_items_account").on(table.reconAccountId),
  ]
);

// ============================================================
// PREPAYMENTS
// ============================================================

export const prepaymentStatusEnum = pgEnum("prepayment_status", [
  "active",
  "fully_amortised",
  "cancelled",
]);

export const prepaymentSpreadMethodEnum = pgEnum("prepayment_spread_method", [
  "equal",
  "daily_proration",
  "half_month",
]);

export const prepayments = pgTable(
  "prepayments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    vendorName: text("vendor_name").notNull(),
    description: text("description").notNull(),
    nominalAccount: text("nominal_account").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("GBP"),
    numberOfMonths: integer("number_of_months").notNull(),
    monthlyAmount: numeric("monthly_amount", { precision: 18, scale: 2 }).notNull(),
    spreadMethod: prepaymentSpreadMethodEnum("spread_method").notNull().default("equal"),
    status: prepaymentStatusEnum("status").notNull().default("active"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_prepayments_client").on(table.clientId)]
);

export const prepaymentScheduleLines = pgTable(
  "prepayment_schedule_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    prepaymentId: uuid("prepayment_id")
      .notNull()
      .references(() => prepayments.id, { onDelete: "cascade" }),
    monthEndDate: date("month_end_date").notNull(),
    openingBalance: numeric("opening_balance", { precision: 18, scale: 2 }).notNull(),
    monthlyExpense: numeric("monthly_expense", { precision: 18, scale: 2 }).notNull(),
    closingBalance: numeric("closing_balance", { precision: 18, scale: 2 }).notNull(),
    originalAmount: numeric("original_amount", { precision: 18, scale: 2 }).notNull(),
    overrideAmount: numeric("override_amount", { precision: 18, scale: 2 }),
    isOverridden: boolean("is_overridden").notNull().default(false),
    auditNotes: text("audit_notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.prepaymentId, table.monthEndDate),
    index("idx_prepayment_schedule_prepayment").on(table.prepaymentId),
    index("idx_prepayment_schedule_month").on(table.monthEndDate),
  ]
);

// ============================================================
// DEFERRED INCOME
// ============================================================

export const deferredIncomeStatusEnum = pgEnum("deferred_income_status", [
  "active",
  "fully_recognised",
  "cancelled",
]);

export const deferredIncomeSpreadMethodEnum = pgEnum("deferred_income_spread_method", [
  "equal",
  "daily_proration",
  "half_month",
]);

export const deferredIncomeItems = pgTable(
  "deferred_income_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    customerName: text("customer_name").notNull(),
    description: text("description").notNull(),
    nominalAccount: text("nominal_account").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("GBP"),
    numberOfMonths: integer("number_of_months").notNull(),
    monthlyAmount: numeric("monthly_amount", { precision: 18, scale: 2 }).notNull(),
    spreadMethod: deferredIncomeSpreadMethodEnum("spread_method").notNull().default("equal"),
    status: deferredIncomeStatusEnum("status").notNull().default("active"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_deferred_income_client").on(table.clientId)]
);

export const deferredIncomeScheduleLines = pgTable(
  "deferred_income_schedule_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deferredIncomeId: uuid("deferred_income_id")
      .notNull()
      .references(() => deferredIncomeItems.id, { onDelete: "cascade" }),
    monthEndDate: date("month_end_date").notNull(),
    openingBalance: numeric("opening_balance", { precision: 18, scale: 2 }).notNull(),
    monthlyRecognition: numeric("monthly_recognition", { precision: 18, scale: 2 }).notNull(),
    closingBalance: numeric("closing_balance", { precision: 18, scale: 2 }).notNull(),
    originalAmount: numeric("original_amount", { precision: 18, scale: 2 }).notNull(),
    overrideAmount: numeric("override_amount", { precision: 18, scale: 2 }),
    isOverridden: boolean("is_overridden").notNull().default(false),
    auditNotes: text("audit_notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.deferredIncomeId, table.monthEndDate),
    index("idx_deferred_income_schedule_item").on(table.deferredIncomeId),
    index("idx_deferred_income_schedule_month").on(table.monthEndDate),
  ]
);

// ============================================================
// ACCOUNTS RECEIVABLE RECONCILIATION
// ============================================================

export const arReconStatusEnum = pgEnum("ar_recon_status", [
  "draft",
  "complete",
  "reviewed",
]);

export const arRiskFlagEnum = pgEnum("ar_risk_flag", [
  "none",
  "watch",
  "high",
]);

export const arAgingBucketEnum = pgEnum("ar_aging_bucket", [
  "current",
  "1_30",
  "31_60",
  "61_90",
  "90_plus",
]);

export const arReconciliations = pgTable(
  "ar_reconciliations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reconAccountId: uuid("recon_account_id")
      .notNull()
      .references(() => reconciliationAccounts.id)
      .unique(),
    monthEndDate: date("month_end_date").notNull(),
    ledgerBalance: numeric("ledger_balance", { precision: 18, scale: 2 }).notNull(),
    agedReportTotal: numeric("aged_report_total", { precision: 18, scale: 2 }),
    variance: numeric("variance", { precision: 18, scale: 2 }),
    status: arReconStatusEnum("status").notNull().default("draft"),
    signedOffBy: uuid("signed_off_by").references(() => users.id),
    signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_ar_recon_account").on(table.reconAccountId),
  ]
);

export const arInvoiceSnapshots = pgTable(
  "ar_invoice_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reconciliationId: uuid("reconciliation_id")
      .notNull()
      .references(() => arReconciliations.id, { onDelete: "cascade" }),
    xeroInvoiceId: text("xero_invoice_id"),
    invoiceNumber: text("invoice_number"),
    contactName: text("contact_name").notNull(),
    invoiceDate: date("invoice_date"),
    dueDate: date("due_date"),
    originalAmount: numeric("original_amount", { precision: 18, scale: 2 }).notNull(),
    outstandingAmount: numeric("outstanding_amount", { precision: 18, scale: 2 }).notNull(),
    currentAmountDue: numeric("current_amount_due", { precision: 18, scale: 2 }),
    agingBucket: arAgingBucketEnum("aging_bucket").notNull().default("current"),
    daysOverdue: integer("days_overdue").notNull().default(0),
    requiresComment: boolean("requires_comment").notNull().default(false),
    commentText: text("comment_text"),
    riskFlag: arRiskFlagEnum("risk_flag").notNull().default("none"),
    reviewed: boolean("reviewed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_ar_snapshots_recon").on(table.reconciliationId),
    index("idx_ar_snapshots_bucket").on(table.agingBucket),
  ]
);

export const arAuditLog = pgTable(
  "ar_audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    invoiceSnapshotId: uuid("invoice_snapshot_id")
      .notNull()
      .references(() => arInvoiceSnapshots.id, { onDelete: "cascade" }),
    changeType: text("change_type").notNull(),
    previousValue: text("previous_value"),
    newValue: text("new_value"),
    timestamp: timestamp("timestamp", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_ar_audit_snapshot").on(table.invoiceSnapshotId),
    index("idx_ar_audit_user").on(table.userId),
  ]
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
export type AccountTransaction = typeof accountTransactions.$inferSelect;
export type NewAccountTransaction = typeof accountTransactions.$inferInsert;
export type AccountNote = typeof accountNotes.$inferSelect;
export type NewAccountNote = typeof accountNotes.$inferInsert;
export type ReconciliationItem = typeof reconciliationItems.$inferSelect;
export type NewReconciliationItem = typeof reconciliationItems.$inferInsert;
export type GLUpload = typeof glUploads.$inferSelect;
export type NewGLUpload = typeof glUploads.$inferInsert;
export type GLTransaction = typeof glTransactions.$inferSelect;
export type NewGLTransaction = typeof glTransactions.$inferInsert;
export type AccountReconConfig = typeof accountReconConfig.$inferSelect;
export type NewAccountReconConfig = typeof accountReconConfig.$inferInsert;
export type BankReconStatement = typeof bankReconStatements.$inferSelect;
export type NewBankReconStatement = typeof bankReconStatements.$inferInsert;
export type BankReconItem = typeof bankReconItems.$inferSelect;
export type NewBankReconItem = typeof bankReconItems.$inferInsert;
export type Prepayment = typeof prepayments.$inferSelect;
export type NewPrepayment = typeof prepayments.$inferInsert;
export type PrepaymentScheduleLine = typeof prepaymentScheduleLines.$inferSelect;
export type NewPrepaymentScheduleLine = typeof prepaymentScheduleLines.$inferInsert;
export type ARReconciliation = typeof arReconciliations.$inferSelect;
export type NewARReconciliation = typeof arReconciliations.$inferInsert;
export type ARInvoiceSnapshot = typeof arInvoiceSnapshots.$inferSelect;
export type NewARInvoiceSnapshot = typeof arInvoiceSnapshots.$inferInsert;
export type ARAuditLog = typeof arAuditLog.$inferSelect;
export type NewARAuditLog = typeof arAuditLog.$inferInsert;
export type DeferredIncomeItem = typeof deferredIncomeItems.$inferSelect;
export type NewDeferredIncomeItem = typeof deferredIncomeItems.$inferInsert;
export type DeferredIncomeScheduleLine = typeof deferredIncomeScheduleLines.$inferSelect;
export type NewDeferredIncomeScheduleLine = typeof deferredIncomeScheduleLines.$inferInsert;
