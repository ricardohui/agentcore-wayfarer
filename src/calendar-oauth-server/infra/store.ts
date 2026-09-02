import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

export type AuthorizationCodeRecord = {
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly sub: string;
};

export type RefreshTokenRecord = {
  readonly sub: string;
};

export type CalendarEventRecord = {
  readonly eventId: string;
  readonly holdId: string;
  readonly title: string;
  readonly sub: string;
};

// An authorization code is single-use and minutes-lived at most (ADR-0003) —
// this is generous only because the mock authorize step and the token
// exchange are two separate HTTP round trips.
const CODE_TTL_SECONDS = 300;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// Single-table store for the mock OAuth2 authorization server (issue #17 /
// ADR-0003) — one DynamoDB table, item kind distinguished by the `pk`
// prefix, TTL-expired codes/refresh tokens are also explicitly re-checked
// here since DynamoDB's TTL sweep isn't instantaneous.
export class CalendarOAuthStore {
  constructor(
    private readonly tableName: string,
    private readonly documentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({})),
  ) {}

  async putAuthorizationCode(code: string, record: AuthorizationCodeRecord): Promise<void> {
    await this.documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: codeKey(code), ...record, ttl: nowPlusSeconds(CODE_TTL_SECONDS) },
      }),
    );
  }

  // Single-use: deletes the code as part of taking it, so a replayed code
  // (or a second token exchange for the same code) always misses.
  async takeAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    return this.takeItem<AuthorizationCodeRecord>(codeKey(code));
  }

  async putRefreshToken(token: string, record: RefreshTokenRecord): Promise<void> {
    await this.documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: refreshTokenKey(token), ...record, ttl: nowPlusSeconds(REFRESH_TOKEN_TTL_SECONDS) },
      }),
    );
  }

  // Rotates on use — a refresh token is single-use, like the code it
  // descends from; the caller issues and stores a fresh one on success.
  async takeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    return this.takeItem<RefreshTokenRecord>(refreshTokenKey(token));
  }

  async putEvent(record: CalendarEventRecord): Promise<void> {
    await this.documentClient.send(
      new PutCommand({ TableName: this.tableName, Item: { pk: eventKey(record.sub, record.holdId), ...record } }),
    );
  }

  async getEvent(sub: string, holdId: string): Promise<CalendarEventRecord | undefined> {
    const response = await this.documentClient.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: eventKey(sub, holdId) } }),
    );
    return response.Item as CalendarEventRecord | undefined;
  }

  // A single conditional delete-and-return, not a Get followed by a
  // separate Delete — two concurrent takes of the same code/refresh token
  // (a client retry, a replayed intercepted code) would otherwise both pass
  // a Get before either Delete lands, defeating "single-use" under a race.
  private async takeItem<TRecord>(pk: string): Promise<TRecord | undefined> {
    try {
      const response = await this.documentClient.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk },
          ConditionExpression: "attribute_exists(pk)",
          ReturnValues: "ALL_OLD",
        }),
      );
      if (!response.Attributes || isExpired(response.Attributes.ttl)) {
        return undefined;
      }
      return response.Attributes as TRecord;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return undefined;
      }
      throw error;
    }
  }
}

function codeKey(code: string): string {
  return `CODE#${code}`;
}

function refreshTokenKey(token: string): string {
  return `REFRESH#${token}`;
}

function eventKey(sub: string, holdId: string): string {
  return `EVENT#${sub}#${holdId}`;
}

function nowPlusSeconds(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function isExpired(ttl: unknown): boolean {
  return typeof ttl === "number" && ttl < Math.floor(Date.now() / 1000);
}
