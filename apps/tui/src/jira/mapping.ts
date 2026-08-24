import {
  type AttachmentMetadata,
  type IssueComment,
  type IssueDetail,
  type IssueSummary,
  type TeamMember,
  parseTeamAccountId,
  parseIssueId,
  parseIssueKey,
  type StatusCategory,
  type UserIdentity,
  MAX_TEAM_DISPLAY_NAME_BYTES,
  MAX_TEAM_DISPLAY_NAME_CHARS,
  safeDisplay,
  safeDisplayBytes,
} from "../domain/index";
import { JiraError } from "./errors";

export const MAX_ADF_BYTES = 1_000_000;
export const MAX_ADF_DEPTH = 64;
export const MAX_ADF_NODES = 10_000;
export const MAX_ADF_CHILDREN = 1_024;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown, key: string): string | undefined {
  const candidate = record(value)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function arrayValue(value: unknown, key: string): unknown[] {
  const candidate = record(value)[key];
  return Array.isArray(candidate) ? candidate : [];
}

export function mapMyself(value: unknown): UserIdentity {
  const item = record(value);
  const accountId = stringValue(item, "accountId");
  if (accountId === undefined || accountId.length === 0) throw new JiraError("authentication", "Jira did not return an account identity");
  const email = stringValue(item, "emailAddress");
  const normalizedAccountId = safeDisplay(accountId, "", 320);
  if (normalizedAccountId.length === 0) throw new JiraError("authentication", "Jira did not return an account identity");
  return {
    accountId: normalizedAccountId,
    displayName: safeDisplay(stringValue(item, "displayName"), "Unknown user", 255),
    ...(email ? { email: safeDisplay(email, "", 320) } : {}),
  };
}

/** Map the minimal active-user response used for Team member resolution. */
export function mapTeamMember(value: unknown): TeamMember {
  const item = record(value);
  if (item.active !== true) throw new JiraError("not_found", "Jira team member is not active or unavailable");
  const rawAccountId = stringValue(item, "accountId");
  if (rawAccountId === undefined) throw new JiraError("upstream", "Jira returned an invalid team member");
  let accountId: string;
  try {
    accountId = parseTeamAccountId(rawAccountId);
  } catch {
    throw new JiraError("upstream", "Jira returned an invalid team member");
  }
  return {
    accountId,
    displayName: safeDisplayBytes(stringValue(item, "displayName"), "Unknown user", MAX_TEAM_DISPLAY_NAME_BYTES, MAX_TEAM_DISPLAY_NAME_CHARS),
  };
}

export function mapIssueSummary(value: unknown): IssueSummary {
  const item = record(value);
  const fields = record(item.fields);
  const id = stringValue(item, "id");
  const key = stringValue(item, "key");
  if (id === undefined || key === undefined) throw new JiraError("upstream", "Jira returned an invalid issue");
  const status = record(fields.status);
  const categoryKey = stringValue(status.statusCategory, "key");
  const statusCategory: StatusCategory = categoryKey === "new" ? "to_do" : categoryKey === "indeterminate" ? "in_progress" : categoryKey === "done" ? "done" : "uncategorized";
  return {
    id: parseIssueId(id),
    key: parseIssueKey(key),
    summary: safeDisplay(stringValue(fields, "summary"), "No summary", 16_384),
    status: safeDisplay(stringValue(status, "name"), "Unknown status", 255),
    statusCategory,
    priority: safeDisplay(stringValue(record(fields.priority), "name"), "No priority", 255),
    assignee: safeDisplay(stringValue(record(fields.assignee), "displayName"), "Unassigned", 255),
    updated: safeDisplay(stringValue(fields, "updated"), "Unknown", 128),
    ...(stringValue(fields, "created") ? { created: safeDisplay(stringValue(fields, "created"), "", 128) } : {}),
    ...(stringValue(fields, "updated") ? { updatedAt: safeDisplay(stringValue(fields, "updated"), "", 128) } : {}),
  };
}

export function mapComment(value: unknown): IssueComment {
  const item = record(value);
  const id = stringValue(item, "id");
  if (id === undefined) throw new JiraError("upstream", "Jira returned an invalid comment");
  return {
    id: safeDisplay(id, "", 255),
    author: safeDisplay(stringValue(record(item.author), "displayName"), "Unknown author", 255),
    created: safeDisplay(stringValue(item, "created"), "Unknown", 128),
    updated: safeDisplay(stringValue(item, "updated"), "Unknown", 128),
    body: item.body === undefined ? "[unsupported Jira content]" : adfToText(item.body),
  };
}

export function mapIssueDetail(value: unknown, comments: IssueComment[], remote = true): IssueDetail {
  const item = record(value);
  const fields = record(item.fields);
  const issue = mapIssueSummary(value);
  const attachments: AttachmentMetadata[] = arrayValue(fields, "attachment").slice(0, 1_000).flatMap((candidate) => {
    const attachment = record(candidate);
    const id = stringValue(attachment, "id");
    if (id === undefined || id.length > 255) return [];
    return [{
      id,
      filename: safeDisplay(stringValue(attachment, "filename"), "attachment", 512),
      mimeType: safeDisplay(stringValue(attachment, "mimeType"), "application/octet-stream", 255),
      sizeBytes: typeof attachment.size === "number" && Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? attachment.size : 0,
    }];
  });
  return {
    issue,
    issueType: nestedName(fields.issuetype, "Unknown type"),
    reporter: nestedName(fields.reporter, "Unknown user", "displayName"),
    project: nestedName(fields.project, "Unknown project"),
    parent: stringValue(record(fields.parent), "key") ? safeDisplay(stringValue(record(fields.parent), "key"), "", 255) : null,
    labels: arrayValue(fields, "labels").filter((label): label is string => typeof label === "string").slice(0, 100).map((label) => safeDisplay(label, "", 255)),
    dueDate: stringValue(fields, "duedate") ? safeDisplay(stringValue(fields, "duedate"), "", 128) : null,
    created: safeDisplay(stringValue(fields, "created"), "Unknown", 128),
    description: fields.description === undefined || fields.description === null ? "No description" : adfToText(fields.description),
    comments,
    attachments,
    remote,
  };
}

function nestedName(value: unknown, fallback: string, preferred = "name"): string {
  const item = record(value);
  return safeDisplay(stringValue(item, preferred) ?? stringValue(item, "displayName"), fallback, 255);
}

function cleanText(value: string): string {
  return [...value].filter((char) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(char)).join("");
}

/** Convert Jira ADF to bounded plain text. Links are deliberately inert and visible. */
export function adfToText(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    throw new JiraError("upstream", "Jira rich text is malformed");
  }
  if (new TextEncoder().encode(serialized).length > MAX_ADF_BYTES) throw new JiraError("upstream", "Jira rich text exceeded safe limits");
  let nodes = 0;
  const chunks: string[] = [];

  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_ADF_DEPTH || ++nodes > MAX_ADF_NODES) throw new JiraError("upstream", "Jira rich text exceeded safe limits");
    if (typeof node === "string") {
      chunks.push(cleanText(node));
      return;
    }
    const item = record(node);
    const kind = stringValue(item, "type") ?? "";
    if (kind === "text") {
      chunks.push(cleanText(stringValue(item, "text") ?? ""));
      if (arrayValue(item, "marks").some((mark) => stringValue(mark, "type") === "link")) chunks.push(" [link: inert]");
    } else if (kind === "hardBreak") chunks.push("\n");
    else if (kind === "mention") chunks.push(safeDisplay(stringValue(record(item.attrs), "text"), "@Unknown user", 512));
    else if (kind === "media" || kind === "mediaSingle" || kind === "mediaGroup") chunks.push("[image/attachment]");
    else if (kind === "rule") chunks.push("---\n");
    else if (!["doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "blockquote", "codeBlock", "panel"].includes(kind)) chunks.push("[unsupported Jira content]");
    const content = Array.isArray(item.content) ? item.content.slice(0, MAX_ADF_CHILDREN) : [];
    for (const child of content) visit(child, depth + 1);
    if (["paragraph", "heading", "codeBlock", "blockquote", "panel", "listItem"].includes(kind) && !chunks.at(-1)?.endsWith("\n")) chunks.push("\n");
  };
  visit(value, 0);
  const output = chunks.join("").trim();
  if (new TextEncoder().encode(output).length > MAX_ADF_BYTES) throw new JiraError("upstream", "Jira rich text exceeded safe limits");
  return output || "No description";
}
