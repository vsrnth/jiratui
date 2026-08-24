/** Renderer-neutral, validated Jira values. */

export type IssueId = string & { readonly __issueId: unique symbol };
export type IssueKey = string & { readonly __issueKey: unique symbol };

export class DomainValidationError extends Error {
  readonly code = "invalid_input" as const;

  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

export const MAX_TEAM_ACCOUNT_ID_BYTES = 256;
export const MAX_TEAM_DISPLAY_NAME_BYTES = 255;
export const MAX_TEAM_DISPLAY_NAME_CHARS = 255;

/** A resolved, renderer-neutral Jira team identity. */
export type TeamMember = Readonly<{
  accountId: string;
  displayName: string;
}>;

/** Validate the stable Jira account identifier used in team JQL. */
export function parseTeamAccountId(value: string): string {
  if (typeof value !== "string") throw new DomainValidationError("team account id is invalid");
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    new TextEncoder().encode(normalized).length > MAX_TEAM_ACCOUNT_ID_BYTES ||
    [...normalized].some((char) => /\p{Cc}/u.test(char)) ||
    normalized.includes('"') ||
    normalized.includes("'") ||
    normalized.includes("\\")
  ) throw new DomainValidationError("team account id is invalid");
  return normalized;
}

/** Validate an Atlassian email identifier without retaining it in an error. */
export function parseTeamEmail(value: string): string {
  if (typeof value !== "string") throw new DomainValidationError("team email is invalid");
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    new TextEncoder().encode(normalized).length > 320 ||
    [...normalized].some((char) => /\p{Cc}/u.test(char)) ||
    normalized.includes('"') ||
    normalized.includes("\\") ||
    !/^[^@\s]+@[^@\s]+$/u.test(normalized)
  ) throw new DomainValidationError("team email is invalid");
  return normalized;
}

/** Bound user-facing text by UTF-8 bytes as well as display characters. */
export function safeDisplayBytes(value: unknown, fallback: string, maxBytes: number, maxChars = maxBytes): string {
  const candidate = typeof value === "string" && value.length > 0 ? value : fallback;
  const clean = [...candidate].filter((char) => !/\p{Cc}/u.test(char)).slice(0, maxChars).join("");
  let output = "";
  let bytes = 0;
  for (const char of clean) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > maxBytes) break;
    output += char;
    bytes += size;
  }
  if (output.length > 0) return output;
  if (candidate === fallback) return output;
  return safeDisplayBytes(fallback, "", maxBytes, maxChars);
}

export function parseIssueId(value: string): IssueId {
  if (!isSafeText(value, 255) || value.length === 0) {
    throw new DomainValidationError("invalid Jira issue id");
  }
  return value as IssueId;
}

export function parseIssueKey(value: string): IssueKey {
  const normalized = value.trim().toUpperCase();
  const separator = normalized.indexOf("-");
  const project = separator >= 0 ? normalized.slice(0, separator) : "";
  const number = separator >= 0 ? normalized.slice(separator + 1) : "";
  if (
    normalized.length === 0 ||
    normalized.length > 255 ||
    !/^[A-Z0-9_]+$/.test(project) ||
    !/^\d+$/.test(number)
  ) {
    throw new DomainValidationError("issue key must look like PROJECT-123");
  }
  return normalized as IssueKey;
}

export function isIssueKey(value: string): value is IssueKey {
  try {
    parseIssueKey(value);
    return true;
  } catch {
    return false;
  }
}

function isSafeText(value: string, maxBytes: number): boolean {
  return value.length > 0 && new TextEncoder().encode(value).length <= maxBytes && ![...value].some((char) => /[\u0000-\u001f\u007f]/u.test(char));
}

export type StatusCategory = "to_do" | "in_progress" | "done" | "uncategorized";

export type UserIdentity = {
  accountId: string;
  displayName: string;
  email?: string;
};

export type IssueSummary = {
  id: IssueId;
  key: IssueKey;
  summary: string;
  status: string;
  statusCategory: StatusCategory;
  priority: string;
  assignee: string;
  updated: string;
  /** Jira's created timestamp is requested for detail views; search may leave it unknown. */
  created?: string;
  /** Compatibility label used by the presentation protocol. */
  updatedAt?: string;
};

export type IssueComment = {
  id: string;
  author: string;
  created: string;
  updated: string;
  body: string;
};

export type AttachmentMetadata = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

export type IssueDetail = {
  issue: IssueSummary;
  issueType: string;
  reporter: string;
  project: string;
  parent: string | null;
  labels: string[];
  dueDate: string | null;
  created: string;
  description: string;
  comments: IssueComment[];
  attachments: AttachmentMetadata[];
  remote: boolean;
};

export function safeDisplay(value: unknown, fallback: string, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return [...value].filter((char) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(char)).slice(0, maxChars).join("");
}
