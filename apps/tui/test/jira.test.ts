import { describe, expect, test } from "bun:test";
import { parseIssueKey } from "../src/domain/index";
import {
  ApiTokenCredentials,
  JiraError,
  JiraHttpClient,
  JiraHttpConfig,
  MAX_ADF_CHILDREN,
  MAX_JSON_BYTES,
  MAX_SEARCH_RESULTS,
  adfToText,
  assignedOrWatchedJql,
  discoverCloudId,
  mapComment,
  mapIssueDetail,
  mapTeamMember,
  teamIssuesJql,
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

  test("builds fixed team JQL with stable account-ID deduplication", () => {
    expect(teamIssuesJql(["acct-a", "acct-a", "acct-b"])).toBe(
      'statusCategory = "In Progress" AND assignee IN ("acct-a", "acct-b") ORDER BY updated DESC',
    );
    expect(() => teamIssuesJql([])).toThrow(JiraError);
    expect(() => teamIssuesJql(["acct\"unsafe"])).toThrow(JiraError);
    expect(() => teamIssuesJql(Array.from({ length: 101 }, (_, index) => `acct-${index}`))).toThrow(JiraError);
  });

  test("keeps unsupported ADF visible and links inert", () => {
    expect(adfToText({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Jira", marks: [{ type: "link", attrs: { href: "https://example.test" } }] },
      { type: "mystery" },
    ] }] })).toBe("Jira [link: inert][unsupported Jira content]");
  });

  test("projects ADF tables as readable ASCII-separated rows", () => {
    const output = adfToText({
      type: "doc",
      content: [{
        type: "table",
        content: [
          { type: "tableRow", content: [
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Criterion" }] }] },
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Evidence" }] }] },
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Notes" }] }] },
          ] },
          { type: "tableRow", content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Pass\tcheck\u0001\r\nverified" }, { type: "hardBreak" }, { type: "text", text: "done\u001b now" }] }, { type: "paragraph", content: [{ type: "text", text: "second paragraph" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "See docs", marks: [{ type: "link", attrs: { href: "https://example.test" } }] }] }] },
            { type: "tableCell", content: [] },
          ] },
        ],
      }],
    });
    expect(output).toBe("Criterion | Evidence | Notes\nPass check\nverified\ndone now\nsecond paragraph | See docs [link: inert] |");
    expect(output).not.toContain("[unsupported Jira content]");
    expect(output).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
  });

  test("bounds table structural children like other ADF content", () => {
    const output = adfToText({
      type: "table",
      content: Array.from({ length: MAX_ADF_CHILDREN + 1 }, (_, index) => ({
        type: "tableRow",
        content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: String(index) }] }] }],
      })),
    });
    expect(output.split("\n")).toHaveLength(MAX_ADF_CHILDREN);
  });

  test("maps Jira's comment shape and projects ADF bodies to inert text", () => {
    const result = mapComment({
      id: "10000",
      author: { accountId: "acct-1", active: true, displayName: "Ada" },
      created: "2021-01-17T12:34:00.000+0000",
      updated: "2021-01-18T23:45:00.000+0000",
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "A comment" }] }] },
    });
    expect(result).toEqual({ id: "10000", author: "Ada", created: "2021-01-17T12:34:00.000+0000", updated: "2021-01-18T23:45:00.000+0000", body: "A comment" });
    expect(() => mapComment({ id: "", body: { type: "doc" } })).toThrow(JiraError);
  });

  test("maps detail into normalized renderer-neutral values", () => {
    const result = mapIssueDetail(issue, [], true);
    expect(result.issue.key as string).toBe("DEV-123");
    expect(result.issue.statusCategory).toBe("in_progress");
    expect(result.remote).toBe(true);
  });

  test("bounds resolved display names by characters and UTF-8 bytes", () => {
    const result = mapTeamMember({ accountId: "acct-1", active: true, displayName: "😀".repeat(500) });
    expect([...result.displayName]).toHaveLength(63);
    expect(new TextEncoder().encode(result.displayName).length).toBeLessThanOrEqual(255);
    expect(mapTeamMember({ accountId: "acct-1", active: true, displayName: "a".repeat(500) }).displayName).toHaveLength(255);
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
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const body = request.url.endsWith("/search/jql")
        ? { issues: [issue], isLast: true }
        : request.url.includes("/comment?")
          ? (() => {
            const startAt = Number(new URL(request.url).searchParams.get("startAt"));
            const count = startAt === 0 ? 100 : 1;
            return {
              startAt,
              total: 101,
              comments: Array.from({ length: count }, (_, offset) => {
                const index = startAt + offset;
                const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
                return {
                  id: String(10_000 + index),
                  author: { accountId: "acct-1", active: true, displayName: "Ada" },
                  body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `comment-${index}` }] }] },
                  created: timestamp,
                  updated: timestamp,
                };
              }),
            };
          })()
          : issue;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const client = JiraHttpClient.from("https://example.atlassian.net", "ada@example.test", "secret-token", "cloud-123");
      const summaries = await client.searchAssignedOrWatched({ scope: "project = DEV" });
      const detail = await client.issueDetail("DEV-123");
      expect(summaries).toHaveLength(1);
      expect(detail.comments).toHaveLength(101);
      expect(detail.comments[0]?.id).toBe("10100");
      expect(detail.comments[0]?.body).toBe("comment-100");
      expect(requests.every((request) => request.method === "GET" || request.method === "POST")).toBe(true);
      expect(requests[0]?.url).toStartWith("https://api.atlassian.com/ex/jira/cloud-123/");
      expect(requests.find((request) => request.url.endsWith("/search/jql"))?.method).toBe("POST");
      expect(requests.find((request) => request.url.includes("/issue/"))?.url).toContain("created");
      expect(requests.find((request) => request.url.includes("/comment?"))?.url).toContain("maxResults=100");
      expect(requests.filter((request) => request.url.includes("/comment?")).map((request) => new URL(request.url).searchParams.get("startAt"))).toEqual(["0", "100"]);
      expect(requests.some((request) => request.method === "PUT" || request.method === "DELETE")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects absent or invalid Cloud comment arrays instead of silently returning zero", async () => {
    const originalFetch = globalThis.fetch;
    const payloads: unknown[] = [{ startAt: 0, total: 0 }, { startAt: 0, total: 0, comments: {} }];
    globalThis.fetch = (async () => new Response(JSON.stringify(payloads.shift()), { status: 200 })) as unknown as typeof fetch;
    try {
      const client = JiraHttpClient.from("https://example.atlassian.net", "ada@example.test", "token", "cloud-123");
      await expect(client.comments("DEV-123")).rejects.toMatchObject({ category: "upstream" });
      await expect(client.comments("DEV-123")).rejects.toMatchObject({ category: "upstream" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("continues startAt pagination when Jira serves short nonempty pages", async () => {
    const originalFetch = globalThis.fetch;
    const starts: number[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const startAt = Number(new URL(request.url).searchParams.get("startAt"));
      starts.push(startAt);
      const count = Math.min(2, 5 - startAt);
      const comments = Array.from({ length: count }, (_, offset) => {
        const index = startAt + offset;
        const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
        return {
          id: String(20_000 + index),
          author: { displayName: "Ada" },
          body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `short-${index}` }] }] },
          created: timestamp,
          updated: timestamp,
        };
      });
      return new Response(JSON.stringify({ comments, startAt, total: 5, maxResults: 2 }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const client = JiraHttpClient.from("https://example.atlassian.net", "ada@example.test", "token", "cloud-123");
      const result = await client.comments("DEV-123");
      expect(result).toHaveLength(5);
      expect(starts).toEqual([0, 2, 4]);
      expect(result[0]?.id).toBe("20004");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("resolves active account IDs and unique active email matches without writes", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes("/user/search?")) {
        return new Response(JSON.stringify([{ accountId: "acct-email", displayName: "Email User", active: true }]), { status: 200 });
      }
      const inactive = request.url.includes("acct%2Finactive");
      return new Response(JSON.stringify({ accountId: inactive ? "acct-inactive" : "acct-id", displayName: "ID User", active: !inactive }), { status: 200 });
    }) as typeof fetch;
    try {
      const client = JiraHttpClient.from("https://example.atlassian.net", "ada@example.test", "secret-token", "cloud-123");
      await expect(client.resolveTeamMember("acct/id")).resolves.toEqual({ accountId: "acct-id", displayName: "ID User" });
      await expect(client.resolveTeamMember("acct/inactive")).rejects.toMatchObject({ category: "not_found" });
      await expect(client.resolveTeamMember("email@example.test")).resolves.toEqual({ accountId: "acct-email", displayName: "Email User" });
      expect(requests[0]?.method).toBe("GET");
      expect(requests[0]?.url).toContain("accountId=acct%2Fid");
      expect(requests[2]?.url).toContain("query=email%40example.test");
      expect(requests[2]?.url).toContain("maxResults=2");
      expect(requests.every((request) => request.method === "GET")).toBe(true);
      await expect(client.resolveTeamMember("bad\"id")).rejects.toMatchObject({ category: "invalid_input" });
      await expect(client.resolveTeamMember("bad@example.test\u0000")).rejects.toMatchObject({ category: "invalid_input" });
      expect(requests).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("requires exactly one active email result and reuses bounded team search pagination", async () => {
    const originalFetch = globalThis.fetch;
    let emailMode: "multiple" | "mixed" | "inactive" | "unique" = "multiple";
    let searchCalls = 0;
    const searchRequests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("/user/search?")) {
        const result = emailMode === "multiple"
          ? [{ accountId: "a", active: true }, { accountId: "b", active: true }]
          : emailMode === "mixed"
            ? [{ accountId: "a", displayName: "A", active: true }, { accountId: "inactive", active: false }]
          : emailMode === "inactive"
            ? [{ accountId: "a", active: false }]
            : [{ accountId: "a", displayName: "A", active: true }];
        return new Response(JSON.stringify(result), { status: 200 });
      }
      searchRequests.push(request);
      searchCalls += 1;
      const body = searchCalls === 1 ? { issues: [issue], nextPageToken: "next" } : { issues: [], isLast: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const client = JiraHttpClient.from("https://example.atlassian.net", "ada@example.test", "token", "cloud-123");
      await expect(client.resolveTeamMember("team@example.test")).rejects.toMatchObject({ category: "not_found" });
      emailMode = "mixed";
      await expect(client.resolveTeamMember("team@example.test")).resolves.toEqual({ accountId: "a", displayName: "A" });
      emailMode = "inactive";
      await expect(client.resolveTeamMember("team@example.test")).rejects.toMatchObject({ category: "not_found" });
      emailMode = "unique";
      await expect(client.resolveTeamMember("team@example.test")).resolves.toEqual({ accountId: "a", displayName: "A" });
      await expect(client.searchTeamIssues(["a", "b"])).resolves.toHaveLength(1);
      expect(searchCalls).toBe(2);
      expect(searchRequests.every((request) => request.method === "POST")).toBe(true);
      const firstSearch = JSON.parse(await searchRequests[0]!.clone().text()) as { jql: string; nextPageToken?: string; fields: string[] };
      expect(firstSearch.jql).toBe('statusCategory = "In Progress" AND assignee IN ("a", "b") ORDER BY updated DESC');
      expect(firstSearch.jql).not.toContain("watcher");
      const secondSearch = JSON.parse(await searchRequests[1]!.clone().text()) as { nextPageToken?: string };
      expect(secondSearch.nextPageToken).toBe("next");
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
