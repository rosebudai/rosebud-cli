export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type RosebudErrorKind = "input" | "api" | "transport" | "response";
export type PublishOutcome = "not_sent" | "rejected" | "unknown";

/** An upload is never automatically retried, including when its outcome is unknown. */
export class RosebudError extends Error {
  readonly kind: RosebudErrorKind;
  readonly code: string;
  readonly outcome: PublishOutcome;
  readonly status: number | undefined;
  /** The actual API error body, parsed as JSON when possible, otherwise text. */
  readonly body: JsonValue | undefined;

  constructor(
    message: string,
    options: {
      kind: RosebudErrorKind;
      code: string;
      outcome: PublishOutcome;
      status?: number;
      body?: JsonValue;
    },
  ) {
    super(message);
    this.name = "RosebudError";
    this.kind = options.kind;
    this.code = options.code;
    this.outcome = options.outcome;
    this.status = options.status;
    this.body = options.body;
  }
}

export function inputError(code: string, message: string): RosebudError {
  return new RosebudError(message, {
    kind: "input",
    code,
    outcome: "not_sent",
  });
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
