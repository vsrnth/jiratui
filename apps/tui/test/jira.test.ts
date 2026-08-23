import { describe, expect, test } from "bun:test";
import { parseIssueKey } from "../src/domain/index";
import {
  ApiTokenCredentials,
  JiraError,
  JiraHttpClient,
  JiraHttpConfig,
  MAX_JSON_BYTES,
  MAX_SEARCH_RESULTS,
  adfToText,
  assignedOrWatchedJql,
  discoverCloudId,
  mapIssueDetail,
} from "../src/jira/index";

const issue = {
  id: "10001",
  key: "DEV-123",
  fields: {
    summary: "A bounded issue",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    priority: { name: "High" },
    assignee: { displayName: "Ada" },
    updated: "2026-08-23T00:00:00.000Z",
    description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
  },
};

describe("pure Jira mapping", () => {
  test("normalizes complete issue keys without truncation", () => {
    expect(parseIssueKey(" dev-123 ") as string).toBe("DEV-123");
    expect(() => parseIssueKey("DEV nope")).toThrow();
  });

  test("builds assigned-or-watched JQL and rejects user ordering", () => {
    expect(assignedOrWatchedJql("project = DEV")).toBe("(project = DEV) AND (assignee = currentUser() OR watcher = currentUser()) ORDER BY updated DESC");
    expect(() => assignedOrWatchedJql("project = DEV ORDER BY created")).toThrow(JiraError);
  });

  test("keeps unsupported ADF visible and links inert", () => {
    expect(adfToText({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Jira", marks: [{ type: "link", attrs: { href: "https://example.test" } }] },
      { type: "mystery" },
    ] }] })).toBe("Jira [link: inert][unsupported Jira content]");
  });

  test("maps detail into normalized renderer-neutral values", () => {
    const result = mapIssueDetail(issue, [], true);
    expect(result.issue.key as string).toBe("DEV-123");
    expect(result.issue.statusCategory).toBe("in_progress");
    expect(result.remote).toBe(true);
  });

  test("requires an authenticated account identity", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ displayName: "Ada" }), { status: 200 })) as unknown as typeof fetch;
    try {
      await expect(JiraHttpClient.from("https://example.atlassian.net", "ada@example.test", "token", "cloud-123").myself()).rejects.toMatchObject({ category: "authentication" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Jira HTTP boundary", () => {
  test("accepts only HTTPS single-site Atlassian Cloud origins", () => {
    expect(new JiraHttpConfig("https://example.atlassian.net").baseUrl.href).toBe("https://example.atlassian.net/");
    expect(new JiraHttpConfig("https://example.atlassian.net", "cloud-123").baseUrl.href).toBe("https://api.atlassian.com/ex/jira/cloud-123/");
    for (const url of ["http://example.atlassian.net", "https://example.atlassian.net.evil.test", "https://example.atlassian.net/path", "https://atlassian.net"]) {
      expect(() => new JiraHttpConfig(url)).toThrow(JiraError);
    }
  });

  test("validates Cloud IDs before constructing the gateway path", () => {
    for (const cloudId of ["", "../escape", "a/b", "a\\b", "a".repeat(129)]) {
      expect(() => new JiraHttpConfig("https://example.atlassian.net", cloudId)).toThrow(JiraError);
    }
  });

  test("discovers Cloud ID through the unauthenticated bounded tenant endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let request: Request | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ cloudId: "cloud-123" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(discoverCloudId("https://example.atlassian.net")).resolves.toBe("cloud-123");
      expect(request?.url).toBe("https://example.atlassian.net/_edge/tenant_info");
      expect(request?.headers.has("authorization")).toBe(false);
      expect(request?.redirect).toBe("error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("redacts credentials when serialized", () => {
    const credentials = new ApiTokenCredentials("ada@example.test", "secret-token");
    expect(JSON.stringify(credentials)).not.toContain("secret-token");
    expect(credentials.toString()).not.toContain("secret-token");
  });

  test("rejects an oversized JSON response before mapping", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array(MAX_JSON_BYTES + 1), { status: 200 })) as unknown as typeof fetch;
    try {
      await expect(JiraHttpClient.from("https://example.atlassian.net", "ada@example.test", "token", "cloud-123").myself()).rejects.toMatchObject({ category: "response_too_large" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses read-only bounded search and comment pagination", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const body = request.url.endsWith("/search/jql")
        ? { issues: [issue], isLast: true }
        : request.url.includes("/comment?")
          ? { startAt: 0, total: 2, comments: [
            { id: "c1", author: { displayName: "Ada" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "old" }] }] }, created: "2026-08-01T00:00:00.000Z", updated: "2026-08-01T00:00:00.000Z" },
            { id: "c2", author: { displayName: "Ada" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "new" }] }] }, created: "2026-08-02T00:00:00.000Z", updated: "2026-08-02T00:00:00.000Z" },
          ] }
          : issue;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const client = JiraHttpClient.from("https://example.atlassian.net", "ada@example.test", "secret-token", "cloud-123");
      const summaries = await client.searchAssignedOrWatched({ scope: "project = DEV" });
      const detail = await client.issueDetail("DEV-123");
      expect(summaries).toHaveLength(1);
      expect(detail.comments).toHaveLength(2);
      expect(detail.comments[0]?.id).toBe("c2");
      expect(requests.every((request) => request.method === "GET" || request.method === "POST")).toBe(true);
      expect(requests[0]?.url).toStartWith("https://api.atlassian.com/ex/jira/cloud-123/");
      expect(requests.find((request) => request.url.endsWith("/search/jql"))?.method).toBe("POST");
      expect(requests.find((request) => request.url.includes("/issue/"))?.url).toContain("created");
      expect(requests.find((request) => request.url.includes("/comment?"))?.url).toContain("maxResults=100");
      expect(requests.some((request) => request.method === "PUT" || request.method === "DELETE")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects search totals beyond the bounded cached view", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ issues: [], total: MAX_SEARCH_RESULTS + 1, isLast: true }), { status: 200 })) as unknown as typeof fetch;
    try {
      await expect(JiraHttpClient.from("https://example.atlassian.net", "ada@example.test", "token", "cloud-123").searchAssignedOrWatched()).rejects.toMatchObject({ category: "pagination" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
