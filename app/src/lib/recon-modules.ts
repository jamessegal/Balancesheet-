export const RECON_MODULES = [
  { value: "simple_list", label: "Simple List" },
  { value: "pensions_payable", label: "Pensions Payable" },
  { value: "wages_payable", label: "Wages Payable" },
  { value: "accounts_receivable", label: "Accounts Receivable" },
  { value: "accounts_payable", label: "Accounts Payable" },
  { value: "bank", label: "Bank" },
  { value: "prepayments", label: "Prepayments" },
  { value: "accruals", label: "Accruals" },
  { value: "share_capital", label: "Share Capital" },
  { value: "other_debtors", label: "Other Debtors" },
  { value: "directors_loan", label: "Directors Loan" },
] as const;

export type ReconModuleType = (typeof RECON_MODULES)[number]["value"];
