import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export class LocalPrice {
  private constructor(
    public readonly amount: number,
    public readonly currency: string,
  ) {}

  static parse(amount: number, currency: string): Result<LocalPrice, ValidationError> {
    if (!Number.isFinite(amount) || amount <= 0) {
      return err(validationError("localPrice.amount", "must be a positive number"));
    }
    if (!CURRENCY_CODE_PATTERN.test(currency)) {
      return err(
        validationError("localPrice.currency", "must be a 3-letter uppercase ISO currency code"),
      );
    }
    return ok(new LocalPrice(amount, currency));
  }

  toJSON(): { amount: number; currency: string } {
    return { amount: this.amount, currency: this.currency };
  }
}
