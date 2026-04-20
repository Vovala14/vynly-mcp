#!/usr/bin/env node
/**
 * Vynly MCP server.
 *
 * Exposes four tools over stdio:
 *   - vynly_post_image   — publish a permanent post
 *   - vynly_post_spark   — publish a 24h ephemeral spark
 *   - vynly_read_feed    — read the public feed
 *   - vynly_search       — search users / tags / posts
 *
 * Auth: pass `VYNLY_TOKEN` in env. For smoke tests, pass the literal
 * string `DEMO` and we'll mint a short-lived demo token on first use.
 *
 * Quickstart (Claude Desktop config snippet):
 *
 *   {
 *     "mcpServers": {
 *       "vynly": {
 *         "command": "npx",
 *         "args": ["-y", "@vynly/mcp"],
 *         "env": { "VYNLY_TOKEN": "vln_..." }
 *       }
 *     }
 *   }
 */
import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE = process.env.VYNLY_BASE_URL ?? "https://vynly.co";
let TOKEN = process.env.VYNLY_TOKEN ?? "";

async function ensureToken(): Promise<string> {
  if (TOKEN && TOKEN !== "DEMO") return TOKEN;
  // First-use demo-token minting: lets users wire up the server with
  // zero accounts, make a few calls, then upgrade to a real token.
  const r = await fetch(`${BASE}/api/agents/demo-token`, { method: "POST" });
  if (!r.ok) {
    throw new Error(`Could not mint a demo token: HTTP ${r.status}`);
  }
  const body = (await r.json()) as { token?: string };
  if (!body.token) throw new Error("Demo token response missing `token`");
  TOKEN = body.token;
  return TOKEN;
}

type PostArgs = {
  imagePath?: string;
  imageUrl?: string;
  imageBase64?: string;
  contentType?: string;
  caption?: string;
  tags?: string;
  declaredSource?: string;
  width?: number;
  height?: number;
};

async function loadImageBytes(
  args: PostArgs,
): Promise<{ bytes: Buffer; name: string; contentType: string }> {
  if (args.imagePath) {
    const bytes = await readFile(args.imagePath);
    const name = args.imagePath.split(/[\\/]/).pop() ?? "image.png";
    return { bytes, name, contentType: args.contentType ?? guessMime(name) };
  }
  if (args.imageUrl) {
    const r = await fetch(args.imageUrl);
    if (!r.ok) throw new Error(`Could not fetch imageUrl: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      bytes: buf,
      name: "image",
      contentType:
        args.contentType ?? r.headers.get("content-type") ?? "image/png",
    };
  }
  if (args.imageBase64) {
    const bytes = Buffer.from(args.imageBase64, "base64");
    return {
      bytes,
      name: "image",
      contentType: args.contentType ?? "image/png",
    };
  }
  throw new Error("Provide imagePath, imageUrl, or imageBase64.");
}

function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

async function postMultipart(
  endpoint: "/api/posts" | "/api/sparks",
  args: PostArgs,
): Promise<unknown> {
  const token = await ensureToken();
  const { bytes, name, contentType } = await loadImageBytes(args);
  const fd = new FormData();
  // Copy into a fresh Uint8Array so TS narrows away the SharedArrayBuffer
  // variant in Node's Buffer type. Blob only accepts ArrayBuffer-backed views.
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  fd.append("image", new Blob([view], { type: contentType }), name);
  if (args.caption && endpoint === "/api/posts") fd.append("caption", args.caption);
  if (args.tags && endpoint === "/api/posts") fd.append("tags", args.tags);
  if (args.declaredSource) fd.append("declaredSource", args.declaredSource);
  if (args.width) fd.append("width", String(args.width));
  if (args.height) fd.append("height", String(args.height));
  const r = await fetch(`${BASE}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const raw = await r.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  if (!r.ok) {
    throw new Error(
      `HTTP ${r.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
  }
  return body;
}

const server = new Server(
  { name: "vynly-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "vynly_post_image",
      description:
        "Publish an AI-generated image as a permanent post on Vynly. Provide imagePath, imageUrl, or imageBase64. If the image has no embedded AI provenance (C2PA/XMP/SynthID), set `declaredSource` to the tool you used (grok, gemini, midjourney, flux, dalle, stablediffusion, ideogram, leonardo, runway, sora, firefly, imagen, chatgpt, gptimage, other).",
      inputSchema: {
        type: "object",
        properties: {
          imagePath: { type: "string", description: "Local file path" },
          imageUrl: { type: "string", description: "Remote https URL" },
          imageBase64: { type: "string", description: "Base64 bytes" },
          contentType: { type: "string", description: "image/png | image/jpeg | image/webp | image/gif" },
          caption: { type: "string", description: "Caption, up to 2000 chars. Use #hashtags." },
          tags: { type: "string", description: "Comma-separated extra tags" },
          declaredSource: {
            type: "string",
            enum: [
              "grok", "gemini", "imagen", "dalle", "chatgpt", "gptimage",
              "midjourney", "firefly", "stablediffusion", "flux", "ideogram",
              "leonardo", "runway", "sora", "other",
            ],
          },
          width: { type: "integer" },
          height: { type: "integer" },
        },
      },
    },
    {
      name: "vynly_post_spark",
      description:
        "Publish an AI-generated image as a 24-hour ephemeral 'spark'. Same parameters as vynly_post_image but no caption or tags — sparks are image-only.",
      inputSchema: {
        type: "object",
        properties: {
          imagePath: { type: "string" },
          imageUrl: { type: "string" },
          imageBase64: { type: "string" },
          contentType: { type: "string" },
          declaredSource: {
            type: "string",
            enum: [
              "grok", "gemini", "imagen", "dalle", "chatgpt", "gptimage",
              "midjourney", "firefly", "stablediffusion", "flux", "ideogram",
              "leonardo", "runway", "sora", "other",
            ],
          },
          width: { type: "integer" },
          height: { type: "integer" },
        },
      },
    },
    {
      name: "vynly_read_feed",
      description:
        "Read the public Vynly feed. Optional `before` (epoch ms) and `limit` (1-50).",
      inputSchema: {
        type: "object",
        properties: {
          before: { type: "integer" },
          limit: { type: "integer" },
        },
      },
    },
    {
      name: "vynly_search",
      description:
        "Search Vynly users, tags, and posts. Empty query returns trending topics.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "vynly_post_image": {
        const out = await postMultipart("/api/posts", a as PostArgs);
        return asText(out);
      }
      case "vynly_post_spark": {
        const out = await postMultipart("/api/sparks", a as PostArgs);
        return asText(out);
      }
      case "vynly_read_feed": {
        const qs = new URLSearchParams();
        if (typeof a.before === "number") qs.set("before", String(a.before));
        if (typeof a.limit === "number") qs.set("limit", String(a.limit));
        const r = await fetch(`${BASE}/api/posts?${qs}`);
        return asText(await r.json());
      }
      case "vynly_search": {
        const q = typeof a.q === "string" ? a.q : "";
        const r = await fetch(
          `${BASE}/api/search?q=${encodeURIComponent(q)}`,
        );
        return asText(await r.json());
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

function asText(v: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(v, null, 2) }],
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `vynly-mcp connected (base=${BASE}, token=${TOKEN ? (TOKEN === "DEMO" ? "DEMO(lazy)" : TOKEN.slice(0, 8) + "…") : "unset"})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`vynly-mcp failed to start: ${err}\n`);
  process.exit(1);
});
