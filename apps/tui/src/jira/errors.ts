export type JiraErrorCategory =
  | "authentication"
  | "authorization"
  | "rate_limited"
  | "offline"
  | "upstream"
  | "not_found"
  | "invalid_input"
  | "response_too_large"
  | "pagination"
  | "cancelled";

/** Safe error: it intentionally does not retain response bodies, URLs, or headers. */
export class JiraError extends Error {
  readonly name = "JiraError";

  constructor(
    readonly category: JiraErrorCategory,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function isJiraError(error: unknown): error is JiraError {
  return error instanceof JiraError;
}
