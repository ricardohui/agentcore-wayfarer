import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

// Budget breakdown's category axis (issue #18): flights vs hotels, the two
// kinds of hold Gateway's booking target produces.
export const BUDGET_CATEGORIES = ["FLIGHT", "HOTEL"] as const;

export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];

export function parseBudgetCategory(value: string): Result<BudgetCategory, ValidationError> {
  if ((BUDGET_CATEGORIES as readonly string[]).includes(value)) {
    return ok(value as BudgetCategory);
  }
  return err(validationError("budgetCategory", `must be one of ${BUDGET_CATEGORIES.join(", ")}`));
}
