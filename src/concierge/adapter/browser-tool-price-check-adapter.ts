import { PlaywrightBrowser } from "bedrock-agentcore/browser/playwright";
import type { FlightCandidateId } from "../domain/flight-candidate";
import type { HotelCandidateId } from "../domain/hotel-candidate";
import { LocalPrice } from "../domain/local-price";
import type { PriceCheckError } from "../domain/price-check-error";
import { err, ok, type Result } from "../domain/result";
import type { ScenarioCity } from "../domain/scenario-city";
import type { PriceCheckPort } from "../usecase/ports";

const LIVE_PRICE_SELECTOR = "#live-price-json";

// Browser Tool's price-check (issue #19 / ADR-0005): one-shot session per
// candidate (navigate, read price, close) — unlike Code Interpreter's
// persistent-per-conversation sandbox (issue #18), a price-check never
// outlives the single hold call it gates, so this adapter starts and tears
// down a fresh Browser Tool session on every call rather than caching one.
export class BrowserToolPriceCheckAdapter implements PriceCheckPort {
  constructor(
    private readonly region: string,
    private readonly browserIdentifier: string,
    private readonly priceCheckSiteUrl: string,
  ) {}

  async checkPrice(
    candidateId: FlightCandidateId | HotelCandidateId,
    city: ScenarioCity,
  ): Promise<Result<LocalPrice, PriceCheckError>> {
    const browser = new PlaywrightBrowser({ region: this.region, identifier: this.browserIdentifier });
    try {
      await browser.navigate({ url: this.buildUrl(candidateId, city) });
      const rawPrice = await browser.getText({ selector: LIVE_PRICE_SELECTOR });
      return parsePrice(rawPrice);
    } catch (error) {
      return err({ type: "NavigationFailed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      try {
        await browser.stopSession();
      } catch {
        // Best-effort cleanup — a torn-down or never-started session's own
        // stop failure must not mask the real navigate/getText outcome above.
      }
    }
  }

  private buildUrl(candidateId: string, city: ScenarioCity): string {
    const url = new URL(this.priceCheckSiteUrl);
    url.searchParams.set("candidateId", candidateId);
    url.searchParams.set("city", city);
    return url.toString();
  }
}

function parsePrice(rawPrice: string): Result<LocalPrice, PriceCheckError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPrice);
  } catch {
    return err({ type: "MalformedPrice", message: `price-check page returned non-JSON content: ${rawPrice}` });
  }
  const record = parsed as { amount?: unknown; currency?: unknown };
  const price = LocalPrice.parse(Number(record.amount), String(record.currency ?? ""));
  if (!price.ok) {
    return err({ type: "MalformedPrice", message: price.error.message });
  }
  return ok(price.value);
}
