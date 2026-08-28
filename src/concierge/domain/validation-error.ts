export type ValidationError = {
  readonly type: "ValidationError";
  readonly field: string;
  readonly message: string;
};

export function validationError(field: string, message: string): ValidationError {
  return { type: "ValidationError", field, message };
}
