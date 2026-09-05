import { parseBudgetCategory, type BudgetCategory } from "./budget-category";
import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

// The Running total and Budget breakdown (CONTEXT.md) after a hold, in Home
// currency (USD) — issue #18. Produced by parsing Code Interpreter's
// structured stdout, so this is the boundary type that untrusted sandbox
// output gets validated into.
export class BudgetSnapshot {
  private constructor(
    public readonly runningTotal: number,
    public readonly breakdownByCity: Readonly<Record<string, number>>,
    public readonly breakdownByCategory: Readonly<Partial<Record<BudgetCategory, number>>>,
  ) {}

  static parse(raw: unknown): Result<BudgetSnapshot, ValidationError> {
    if (typeof raw !== "object" || raw === null) {
      return err(validationError("budgetSnapshot", "must be an object"));
    }
    const record = raw as Record<string, unknown>;

    const runningTotal = Number(record.runningTotal);
    if (!Number.isFinite(runningTotal) || runningTotal < 0) {
      return err(validationError("budgetSnapshot.runningTotal", "must be a non-negative number"));
    }

    const breakdownByCity = parseAmountRecord(record.breakdownByCity, "budgetSnapshot.breakdownByCity");
    if (!breakdownByCity.ok) {
      return breakdownByCity;
    }

    const breakdownByCategory = parseCategoryAmountRecord(
      record.breakdownByCategory,
      "budgetSnapshot.breakdownByCategory",
    );
    if (!breakdownByCategory.ok) {
      return breakdownByCategory;
    }

    return ok(new BudgetSnapshot(runningTotal, breakdownByCity.value, breakdownByCategory.value));
  }

  toJSON(): {
    runningTotal: number;
    breakdownByCity: Record<string, number>;
    breakdownByCategory: Partial<Record<BudgetCategory, number>>;
  } {
    return {
      runningTotal: this.runningTotal,
      breakdownByCity: { ...this.breakdownByCity },
      breakdownByCategory: { ...this.breakdownByCategory },
    };
  }
}

function parseAmountRecord(
  raw: unknown,
  field: string,
): Result<Readonly<Record<string, number>>, ValidationError> {
  if (typeof raw !== "object" || raw === null) {
    return err(validationError(field, "must be an object"));
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) {
      return err(validationError(field, `value for "${key}" must be a finite number`));
    }
    result[key] = amount;
  }
  return ok(result);
}

function parseCategoryAmountRecord(
  raw: unknown,
  field: string,
): Result<Readonly<Partial<Record<BudgetCategory, number>>>, ValidationError> {
  if (typeof raw !== "object" || raw === null) {
    return err(validationError(field, "must be an object"));
  }
  const result: Partial<Record<BudgetCategory, number>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const category = parseBudgetCategory(key);
    if (!category.ok) {
      return err(validationError(field, `key "${key}" ${category.error.message}`));
    }
    const amount = Number(value);
    if (!Number.isFinite(amount)) {
      return err(validationError(field, `value for "${key}" must be a finite number`));
    }
    result[category.value] = amount;
  }
  return ok(result);
}
