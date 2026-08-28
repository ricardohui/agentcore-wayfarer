import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

export function parseNonBlankId<TBrand extends string>(
  field: string,
  value: string,
): Result<string & { readonly __brand: TBrand }, ValidationError> {
  if (value.trim().length === 0) {
    return err(validationError(field, "must not be blank"));
  }
  return ok(value as string & { readonly __brand: TBrand });
}
