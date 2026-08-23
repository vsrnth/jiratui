/** Renderer-facing aliases. Backend adapters project bounded domain values;
 * raw response, credential, and transport objects never cross this seam. */
export type {
  AttachmentMetadata,
  IssueComment,
  IssueDetail,
  IssueId,
  IssueKey,
  IssueSummary,
  StatusCategory,
  UserIdentity,
} from "./domain";
export { isIssueKey, parseIssueKey, safeDisplay } from "./domain";
