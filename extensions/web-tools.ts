import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const SEARXNG_BASE_URL = "http://localhost:17080";
const BROWSERLESS_BASE_URL = "http://localhost:17081";

const DOCKER_COMPOSE_FILE = "docker-compose.yml";

/**
 * Check if a URL is reachable (returns true if HTTP 200 or any valid response).
 * Supports both GET and POST requests for services that require POST health checks.
 */
async function isServiceReachable(
  url: string,
  timeout = 3000,
  method = "GET",
  body?: string
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body } : {}),
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve the package root directory (where docker-compose.yml lives).
 * Works both when loaded from npm packages and local development.
 */
function getPackageRoot(): string {
  // import.meta.url is available via jiti; points to this file in extensions/
  const selfPath = typeof (globalThis as any).__piExtensionPath__ !== "undefined"
    ? (globalThis as any).__piExtensionPath__
    : import.meta.url.replace(/^file:\/\//, "");
  const resolved = selfPath.startsWith("/") ? selfPath : path.resolve(selfPath);
  return path.dirname(path.dirname(resolved));
}

/**
 * Find the docker-compose.yml file.
 * Priority: 1) ctx.cwd  2) ctx.cwd parents  3) package root (bundled)
 */
function findDockerComposeFile(cwd: string): string | null {
  // 1) Check cwd first
  const cwdCompose = path.join(cwd, DOCKER_COMPOSE_FILE);
  if (fs.existsSync(cwdCompose)) return cwdCompose;

  // 2) Walk up from cwd looking for .pi/extensions marker
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, ".pi", "extensions");
    if (fs.existsSync(candidate)) {
      const composeFile = path.join(current, DOCKER_COMPOSE_FILE);
      if (fs.existsSync(composeFile)) return composeFile;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // 3) Fall back to bundled docker-compose.yml in the package
  const pkgRoot = getPackageRoot();
  const bundledCompose = path.join(pkgRoot, DOCKER_COMPOSE_FILE);
  if (fs.existsSync(bundledCompose)) return bundledCompose;

  return null;
}

/**
 * Start Docker Compose services from the project directory.
 */
async function startDockerServices(pi: ExtensionAPI, projectDir: string): Promise<void> {
  const result = await pi.exec(
    "docker",
    ["compose", "-f", path.join(projectDir, DOCKER_COMPOSE_FILE), "up", "-d"],
    { timeout: 60000 }
  );

  if (result.code !== 0) {
    throw new Error(`docker compose up failed (exit ${result.code}): ${result.stderr}`);
  }
}

/**
 * Wait for services to become healthy with retries.
 */
type ServiceDef = {
  name: string;
  url: string;
  method?: "GET" | "POST";
  body?: string;
};

async function waitForServices(
  services: ServiceDef[],
  maxRetries = 15,
  interval = 2000
): Promise<Map<string, boolean>> {
  const status = new Map<string, boolean>();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let allReady = true;
    for (const svc of services) {
      if (status.has(svc.name)) continue;
      const ok = await isServiceReachable(svc.url, 3000, svc.method || "GET", svc.body);
      if (ok) {
        status.set(svc.name, true);
      } else {
        allReady = false;
      }
    }
    if (allReady) return status;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  // Mark remaining as failed
  for (const svc of services) {
    if (!status.has(svc.name)) status.set(svc.name, false);
  }
  return status;
}

export default function (pi: ExtensionAPI) {
  // ── 1. SearXNG Search ─────────────────────────────────────────
  pi.registerTool({
    name: "searxng_search",
    label: "SearXNG Search",
    description:
      "Search the web using the local SearXNG instance. Returns titles, URLs, and snippets from search results.",
    promptSnippet:
      "searxng_search(query, lang?, timeRange?, categories?): Search the web via local SearXNG on port 17080",
    parameters: Type.Object({
      query: Type.String({
        description:
          "The search query string. Can include keywords in any language.",
      }),
      lang: Type.Optional(
        Type.String({
          description:
            "Language code for search results (e.g., 'ko-KR', 'en-US'). Defaults to 'all'.",
        })
      ),
      timeRange: Type.Optional(
        Type.String({
          description:
            "Time range filter: 'day', 'week', 'month', 'year'. Defaults to no filter.",
        })
      ),
      categories: Type.Optional(
        Type.String({
          description:
            "Comma-separated categories: general, images, videos, news, music, it, science, files, social media. Defaults to 'general'.",
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const { query, lang, timeRange, categories } = params;

      const url = new URL(`${SEARXNG_BASE_URL}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      if (lang) url.searchParams.set("lang", lang);
      if (timeRange) url.searchParams.set("time_range", timeRange);
      if (categories) url.searchParams.set("categories", categories);

      const response = await fetch(url.toString(), { signal });

      if (!response.ok) {
        return {
          content: [
            {
              type: "text",
              text: `SearXNG search failed: HTTP ${response.status} ${response.statusText}`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const data = (await response.json()) as {
        query: string;
        number_of_results: number;
        results: Array<{
          title: string;
          url: string;
          content: string;
          engine: string;
          publishedDate?: string;
        }>;
      };

      const results = data.results || [];
      const lines: string[] = [];
      lines.push(`Search: "${data.query}"`);
      lines.push(`Total results: ${data.number_of_results}`);
      lines.push("");

      if (results.length === 0) {
        lines.push("No results found.");
      } else {
        results.forEach((r, i) => {
          lines.push(`[${i + 1}] ${r.title}`);
          lines.push(`    URL: ${r.url}`);
          if (r.publishedDate) {
            lines.push(`    Date: ${r.publishedDate}`);
          }
          if (r.content) {
            const snippet =
              r.content.length > 300
                ? r.content.slice(0, 300) + "..."
                : r.content;
            lines.push(`    ${snippet}`);
          }
          lines.push("");
        });
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { resultCount: results.length },
      };
    },
  });

  // ── 2. Jina Reader ─────────────────────────────────────────────
  pi.registerTool({
    name: "jina_reader",
    label: "Jina Reader",
    description:
      "Extract clean Markdown content from any URL via Jina Reader. No API key required. Handles static pages and simple JS-rendered content well. Use this as the first attempt before Browserless.",
    promptSnippet:
      "jina_reader(url): Extract clean Markdown from any URL via Jina Reader (no setup needed)",
    parameters: Type.Object({
      url: Type.String({
        description: "The URL of the webpage to extract content from.",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const { url } = params;
      const jinaUrl = `https://r.jina.ai/${url}`;

      const response = await fetch(jinaUrl, {
        signal,
        headers: {
          Accept: "text/markdown",
          "X-Return-Format": "markdown",
        },
      });

      if (!response.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Jina Reader failed for ${url}: HTTP ${response.status} ${response.statusText}`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const markdown = await response.text();

      return {
        content: [
          {
            type: "text",
            text: `---\nSource: ${url}\n---\n\n${markdown}`,
          },
        ],
        details: { sourceUrl: url, length: markdown.length },
      };
    },
  });

  // ── 3. Browserless Scrape ───────────────────────────────────────
  pi.registerTool({
    name: "browserless_scrape",
    label: "Browserless Scrape",
    description:
      "Extract content from a webpage using Browserless (headless Chrome in Docker). Extracts text content from specified CSS selectors. Use this for SPAs or pages that require full JavaScript rendering when Jina Reader fails. Provide CSS selectors to target specific elements, or use 'body' for full page content.",
    promptSnippet:
      "browserless_scrape(url, selectors?): Extract text from specific CSS selectors on a page via Browserless Chromium (port 17081)",
    parameters: Type.Object({
      url: Type.String({
        description: "The URL of the webpage to scrape.",
      }),
      selectors: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "CSS selectors to extract text from. Defaults to ['body'] if not specified. Examples: ['body'], ['.article-content'], ['#main', '.post']",
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const { url, selectors } = params;
      const targetSelectors = selectors || ["body"];

      const elements = targetSelectors.map((sel) => ({ selector: sel }));

      const response = await fetch(`${BROWSERLESS_BASE_URL}/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({ url, elements }),
      });

      if (!response.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Browserless scrape failed for ${url}: HTTP ${response.status} ${response.statusText}`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const data = (await response.json()) as {
        data?: Array<{ selector: string; results: Array<{ text?: string; html?: string }> }>;
        error?: string;
      };

      if (data.error) {
        return {
          content: [
            {
              type: "text",
              text: `Browserless error for ${url}: ${data.error}`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const lines: string[] = [`---\nSource: ${url}\n---\n`];

      if (data.data) {
        for (const item of data.data) {
          lines.push(`\n### Selector: ${item.selector}`);
          for (const result of item.results) {
            if (result.text) {
              lines.push(result.text);
            }
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: lines.join("\n"),
          },
        ],
        details: { sourceUrl: url, selectors: targetSelectors },
      };
    },
  });

  // ── 4. Browserless Screenshot ───────────────────────────────────
  pi.registerTool({
    name: "browserless_screenshot",
    label: "Browserless Screenshot",
    description:
      "Take a screenshot of a webpage using Browserless (headless Chrome). Returns the screenshot as a base64-encoded PNG. Useful for visual verification of pages.",
    promptSnippet:
      "browserless_screenshot(url): Take a screenshot of a URL via Browserless Chromium (port 17081)",
    parameters: Type.Object({
      url: Type.String({
        description: "The URL of the webpage to screenshot.",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const { url } = params;

      const response = await fetch(`${BROWSERLESS_BASE_URL}/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          url,
        }),
      });

      if (!response.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Browserless screenshot failed for ${url}: HTTP ${response.status} ${response.statusText}`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");

      return {
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: base64,
            },
          },
        ],
        details: { sourceUrl: url },
      };
    },
  });

  // ── Session lifecycle: auto-start Docker services ──────────────
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") {
      ctx.ui.setStatus("web-tools", "web-tools ready");
      return;
    }

    const services = [
      { name: "SearXNG", url: `${SEARXNG_BASE_URL}/search?q=test&format=json` },
      { name: "Browserless", url: `${BROWSERLESS_BASE_URL}/scrape`, method: "POST" as const, body: JSON.stringify({ url: "https://example.com", elements: [{ selector: "title" }] }) },
    ];

    // Check current status
    const searxngOk = await isServiceReachable(services[0].url, 3000, services[0].method, services[0].body);
    const browserlessOk = await isServiceReachable(services[1].url, 3000, services[1].method, services[1].body);

    if (searxngOk && browserlessOk) {
      ctx.ui.setStatus("web-tools", "web-tools ready");
      return;
    }

    // Find docker-compose.yml
    const composeFile = findDockerComposeFile(ctx.cwd);
    if (!composeFile) {
      ctx.ui.setStatus("web-tools", "web-tools error");
      ctx.ui.notify(
        `Search tools: docker-compose.yml not found. Services unreachable: ${!searxngOk ? "SearXNG " : ""}${!browserlessOk ? "Browserless" : ""}`,
        "warning"
      );
      return;
    }

    const projectDir = path.dirname(composeFile);
    ctx.ui.setStatus("web-tools", "web-tools starting...");
    ctx.ui.notify("Starting search services via docker-compose...", "info");

    try {
      await startDockerServices(pi, projectDir);
      const status = await waitForServices(services);

      const started: string[] = [];
      const failed: string[] = [];
      for (const svc of services) {
        if (status.get(svc.name)) {
          started.push(svc.name);
        } else {
          failed.push(svc.name);
        }
      }

      if (failed.length === 0) {
        ctx.ui.setStatus("web-tools", "web-tools ready");
      } else {
        ctx.ui.setStatus("web-tools", "web-tools error");
        ctx.ui.notify(
          `Search tools: ${started.join(", ") || "none"} ✅ ${failed.join(", ")} ❌. Use /search-services to retry.`,
          "warning"
        );
      }
    } catch (err) {
      ctx.ui.setStatus("web-tools", "web-tools error");
      ctx.ui.notify(
        `Failed to start search services: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    }
  });

  // ── Command: /search-services ───────────────────────────────────
  pi.registerCommand("search-services", {
    description: "Check status or restart search services (SearXNG, Browserless)",
    handler: async (_args, ctx) => {
      const services: ServiceDef[] = [
        { name: "SearXNG", url: `${SEARXNG_BASE_URL}/search?q=test&format=json` },
        { name: "Browserless", url: `${BROWSERLESS_BASE_URL}/scrape`, method: "POST", body: JSON.stringify({ url: "https://example.com", elements: [{ selector: "title" }] }) },
      ];

      // Check status
      const statuses = new Map<string, string>();
      for (const svc of services) {
        const ok = await isServiceReachable(svc.url, 3000, svc.method, svc.body);
        statuses.set(svc.name, ok ? "✅ Running" : "❌ Not reachable");
      }

      const lines = [
        "Search Services Status:",
        `  SearXNG (17080): ${statuses.get("SearXNG")}`,
        `  Browserless (17081): ${statuses.get("Browserless")}`,
        `  Jina Reader: ✅ External API (no local service)`,
      ];
      ctx.ui.setWidget("search-services", lines);

      const allRunning = [...statuses.values()].every((s) => s.includes("✅"));
      if (!allRunning) {
        const composeFile = findDockerComposeFile(ctx.cwd);
        if (composeFile) {
          const ok = await ctx.ui.confirm(
            "Services not running",
            "Start services via docker-compose?"
          );
          if (ok) {
            try {
              const projectDir = path.dirname(composeFile);
              ctx.ui.setStatus("search-services", "Starting services...");
              await startDockerServices(pi, projectDir);
              const status = await waitForServices(services);
              const restarted: string[] = [];
              for (const svc of services) {
                if (status.get(svc.name)) restarted.push(svc.name);
              }
              ctx.ui.notify(
                `Services started: ${restarted.join(", ")} ✅`,
                "info"
              );
            } catch (err) {
              ctx.ui.notify(
                `Failed: ${err instanceof Error ? err.message : String(err)}`,
                "error"
              );
            }
          }
        }
      }
    },
  });
}
