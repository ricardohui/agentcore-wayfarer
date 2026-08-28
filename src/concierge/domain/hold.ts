import { parseNonBlankId } from "./non-blank-id";
import { err, ok, type Result } from "./result";
import { validationError, type ValidationError } from "./validation-error";

export type HoldId = string & { readonly __brand: "HoldId" };

export type HoldStatus = "held";

const HOLD_STATUSES: readonly HoldStatus[] = ["held"];

export class Hold {
  constructor(
    public readonly holdId: HoldId,
    public readonly status: HoldStatus,
    public readonly expiresAt: Date,
  ) {}

  static parse(raw: unknown): Result<Hold, ValidationError> {
    if (typeof raw !== "object" || raw === null) {
      return err(validationError("hold", "must be an object"));
    }
    const record = raw as Record<string, unknown>;

    const holdId = parseNonBlankId<"HoldId">("hold.holdId", String(record.holdId ?? ""));
    if (!holdId.ok) {
      return holdId;
    }

    const status = String(record.status ?? "");
    if (!HOLD_STATUSES.includes(status as HoldStatus)) {
      return err(validationError("hold.status", `must be one of ${HOLD_STATUSES.join(", ")}`));
    }

    const expiresAt = new Date(String(record.expiresAt ?? ""));
    if (Number.isNaN(expiresAt.getTime())) {
      return err(validationError("hold.expiresAt", "must be a valid ISO 8601 date"));
    }

    return ok(new Hold(holdId.value, status as HoldStatus, expiresAt));
  }
}
