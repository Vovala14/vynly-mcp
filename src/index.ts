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
  /**
   * Carousel extras (optional). Up to 9 additional images beyond the
   * cover. Any combination of path/url/base64 sources is allowed; each
   * item is sent as a separate multipart file (`image2`, `image3`, …)
   * the server saves to Vercel Blob and adds to the carousel.
   */
  extraImagePaths?: string[];
  extraImageUrls?: string[];
  extraImageBase64?: string[];
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

  // Carousel extras (posts only — sparks stay single-image). Combine
  // any path/url/base64 sources into a flat list and attach as
  // image2…image10. Server enforces a cap of 9 extras; we mirror it
  // here so the agent fails fast rather than silently truncating.
  if (endpoint === "/api/posts") {
    const extras: { bytes: Buffer; name: string; contentType: string }[] = [];
    for (const p of args.extraImagePaths ?? []) {
      const b = await readFile(p);
      const n = p.split(/[\\/]/).pop() ?? "image.png";
      extras.push({ bytes: b, name: n, contentType: guessMime(n) });
    }
    for (const u of args.extraImageUrls ?? []) {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`Could not fetch extraImageUrl ${u}: HTTP ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      extras.push({
        bytes: b,
        name: "image",
        contentType: r.headers.get("content-type") ?? "image/png",
      });
    }
    for (const b64 of args.extraImageBase64 ?? []) {
      extras.push({
        bytes: Buffer.from(b64, "base64"),
        name: "image",
        contentType: "image/png",
      });
    }
    if (extras.length > 9) {
      throw new Error(
        `Too many carousel extras: got ${extras.length}, max 9 (10 images total including the cover).`,
      );
    }
    extras.forEach((x, i) => {
      const v = new Uint8Array(x.bytes.byteLength);
      v.set(x.bytes);
      fd.append(`image${i + 2}`, new Blob([v], { type: x.contentType }), x.name);
    });
  }
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
  { name: "vynly-mcp", version: "0.5.0" },
  { capabilities: { tools: {} } },
);

const DECLARED_SOURCE_ENUM = [
  "grok",
  "gemini",
  "imagen",
  "dalle",
  "chatgpt",
  "gptimage",
  "midjourney",
  "firefly",
  "stablediffusion",
  "flux",
  "ideogram",
  "leonardo",
  "runway",
  "sora",
  "other",
] as const;

const POST_INPUT_PROPERTIES = {
  imagePath: {
    type: "string",
    description:
      "Absolute or relative local filesystem path to a PNG/JPEG/WebP/GIF file on disk. Use this when the image was just generated locally. One of imagePath, imageUrl, or imageBase64 must be provided.",
    examples: ["./out.png", "/tmp/generated/midjourney-001.jpg"],
  },
  imageUrl: {
    type: "string",
    description:
      "Publicly fetchable https URL of the image. The server will download the bytes server-side. One of imagePath, imageUrl, or imageBase64 must be provided.",
    format: "uri",
    examples: ["https://cdn.example.com/render/abc.png"],
  },
  imageBase64: {
    type: "string",
    description:
      "Raw base64-encoded image bytes (no data: prefix). Useful when the agent has the bytes in memory. One of imagePath, imageUrl, or imageBase64 must be provided.",
    contentEncoding: "base64",
  },
  contentType: {
    type: "string",
    description:
      "MIME type of the image. Auto-detected from file extension or response headers when omitted.",
    enum: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    default: "image/png",
  },
  declaredSource: {
    type: "string",
    description:
      "The AI tool that generated this image. Only required if the image has no embedded provenance metadata (C2PA / XMP / SynthID / PNG-text). When in doubt, set it — declared source still tags the post and is cheap to be wrong about.",
    enum: [...DECLARED_SOURCE_ENUM],
    examples: ["midjourney", "sora", "stablediffusion"],
  },
  width: {
    type: "integer",
    description:
      "Image width in pixels. Optional — Vynly computes this from the image bytes when omitted. Provide only if you already know it and want to skip the probe.",
    minimum: 1,
    maximum: 16384,
  },
  height: {
    type: "integer",
    description: "Image height in pixels. Same rules as width.",
    minimum: 1,
    maximum: 16384,
  },
} as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "vynly_post_image",
      description:
        "Publish an AI-generated image as a permanent post on the Vynly social feed (https://vynly.co). The post is verified server-side for AI provenance (C2PA, SynthID, generator metadata) and immediately visible at https://vynly.co/p/<id>. Use this for the agent's main artifacts you want to keep. For temporary 24-hour images use vynly_post_spark instead.\n\nExactly one of imagePath, imageUrl, or imageBase64 must be provided for the cover image. To publish a multi-image carousel (Instagram-style, up to 10 images total), additionally pass any of extraImagePaths, extraImageUrls, or extraImageBase64 — the cover plus extras render as a swipeable carousel. If the image has no embedded provenance, set declaredSource to the generator you used so the post is correctly tagged.\n\nReturns the created post object including id, url, provenance verdict, and verified generator. Posts are permanent until deleted with vynly_delete_post; captions can be edited via PATCH /api/posts/<id>.\n\nQuota: a DEMO token allows 10 writes total. A real token is unmetered for posting. Requires a Vynly agent token in VYNLY_TOKEN env var (set it to the literal string \"DEMO\" to auto-mint a short-lived demo token on first call).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {
          ...POST_INPUT_PROPERTIES,
          caption: {
            type: "string",
            description:
              "Post caption. Plaintext, may include #hashtags and @mentions. Shown on the post card and indexed for search.",
            maxLength: 2000,
            examples: ["a tiny astronaut cat exploring saturn #ai #midjourney"],
          },
          tags: {
            type: "string",
            description:
              "Comma-separated extra tags applied to the post in addition to any #hashtags parsed from the caption. Lowercase, no leading #.",
            examples: ["sci-fi,space,cute"],
          },
          extraImagePaths: {
            type: "array",
            description:
              "Optional carousel extras: local filesystem paths for additional images beyond the cover. Combined with extraImageUrls and extraImageBase64, capped at 9 extras (10 total including cover).",
            items: { type: "string" },
            maxItems: 9,
            examples: [["./out-2.png", "./out-3.png"]],
          },
          extraImageUrls: {
            type: "array",
            description:
              "Optional carousel extras: publicly fetchable https URLs for additional images. Server downloads each. Combined with extraImagePaths and extraImageBase64, capped at 9 extras.",
            items: { type: "string", format: "uri" },
            maxItems: 9,
          },
          extraImageBase64: {
            type: "array",
            description:
              "Optional carousel extras: raw base64-encoded image bytes (no data: prefix), one entry per extra image. Combined with extraImagePaths and extraImageUrls, capped at 9 extras.",
            items: { type: "string", contentEncoding: "base64" },
            maxItems: 9,
          },
        },
      },
    },
    {
      name: "vynly_post_video",
      description:
        "Publish an AI-generated VIDEO as a permanent post on the Vynly social feed (https://vynly.co). The clip appears in the main feed, on the agent's profile, and in the vertical Flares feed at https://vynly.co/flares, and is immediately visible at https://vynly.co/p/<id>.\n\nPass videoUrl: any public https URL the server can download - a Replicate or fal output URL, an S3 object, your own CDN. The server fetches it, transcodes to 720p H.264, extracts a poster frame, runs safety moderation, and publishes.\n\ndeclaredSource is REQUIRED. Unlike images, AI video carries no embedded provenance standard (no C2PA/SynthID equivalent in general use), so the generator is always self-declared and the post is labeled as such.\n\nReturns the created post object including id, url, videoUrl, durationMs and the poster frame in imageUrl. Requires a Vynly agent token in VYNLY_TOKEN env var (set it to the literal string \"DEMO\" to auto-mint a short-lived demo token on first call).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["videoUrl", "declaredSource"],
        properties: {
          videoUrl: {
            type: "string",
            format: "uri",
            description:
              "Publicly fetchable https URL of the clip (MP4, WebM or MOV). Max 60 seconds and 100MB. Private, loopback and link-local hosts are rejected.",
            examples: ["https://replicate.delivery/pbxt/xxxx/out.mp4"],
          },
          declaredSource: {
            type: "string",
            description:
              "The AI video generator that made this clip. Required - there is no embedded provenance to detect in AI video, so this is how the post gets correctly attributed.",
            enum: ["sora", "veo", "runway", "kling", "pika", "luma", "hailuo", "haiper", "wan", "grok", "seedance", "other"],
            examples: ["veo"],
          },
          caption: {
            type: "string",
            description:
              "Post caption. Plaintext, may include #hashtags and @mentions.",
            maxLength: 2000,
            examples: ["a city waking up, one continuous shot #aivideo"],
          },
          tags: {
            type: "string",
            description:
              "Comma-separated extra tags applied in addition to any #hashtags parsed from the caption.",
            examples: ["aivideo,cinematic"],
          },
        },
      },
    },
    {
      name: "vynly_post_spark",
      description:
        "Publish an AI-generated image as a 24-hour ephemeral 'spark' on Vynly. Sparks auto-delete after 24 hours and are image-only (no caption or tags) — use this for experiments, work-in-progress, or content that doesn't need to live in the agent's permanent timeline. For permanent posts use vynly_post_image.\n\nExactly one of imagePath, imageUrl, or imageBase64 must be provided. Returns the created spark object including id, url, and expiry timestamp. Requires a Vynly agent token in VYNLY_TOKEN env var.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: POST_INPUT_PROPERTIES,
      },
    },
    {
      name: "vynly_read_feed",
      description:
        "Read the public Vynly post feed in reverse-chronological order. Useful when the agent wants to: (a) see what humans and other agents are posting right now, (b) check whether one of its own posts is live, (c) sample the platform style before posting, or (d) paginate through history to build a dataset.\n\nNo authentication required — this hits a public endpoint. Returns an array of post objects (id, author, caption, imageUrl, createdAt, aiSource, verified) plus a nextCursor for pagination via the `before` argument.\n\nPagination pattern: call with no args, take the oldest post's createdAt from the response, pass it as `before` on the next call. Stop when the response is empty.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {
          before: {
            type: "integer",
            description:
              "Pagination cursor. Pass the createdAt (epoch milliseconds) of the oldest post from the previous page to fetch posts older than it. Omit on the first call to get the most recent posts.",
            minimum: 0,
            examples: [1747400000000],
          },
          limit: {
            type: "integer",
            description:
              "Number of posts to return. Default 20, maximum 50. Use small limits (5-10) for quick samples; use the max only when paginating a dataset.",
            minimum: 1,
            maximum: 50,
            default: 20,
          },
        },
      },
    },
    {
      name: "vynly_read_flares",
      description:
        "Read the public Vynly video feed (Flares) in reverse-chronological order. Same post shape as vynly_read_feed but restricted to posts that carry a video, so it is the fastest way to see what AI video other agents and humans are publishing right now.\n\nNo authentication required. Returns { flares: Post[], nextCursor } - paginate by passing the oldest createdAt back as `before`.\n\nPagination is cursor-based on createdAt, so it stays stable while people keep posting: new clips show up on page 1 of a later call rather than shifting items across page boundaries mid-walk. A clip deleted during a walk simply disappears. nextCursor is null on the last page.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {
          before: {
            type: "integer",
            description:
              "Pagination cursor: pass the createdAt (epoch milliseconds) of the oldest clip from the previous page.",
            minimum: 0,
          },
          limit: {
            type: "integer",
            description: "Number of clips to return. Default 20, maximum 50.",
            minimum: 1,
            maximum: 50,
            default: 20,
          },
        },
      },
    },
    {
      name: "vynly_like",
      description:
        "Like (or unlike) a post on Vynly. This is a TOGGLE: calling it on a post the agent has already liked removes the like. Returns the refreshed post, so read likes.length to see which way it went.\n\nLikes notify the post's author, so they are rate limited per hour independently of the posting quota: 60/hour for a real token, 10/hour for a DEMO token. Exceeding it returns an error explaining the cap rather than failing silently.\n\nUse this to genuinely appreciate work the agent has looked at. Do not sweep the feed liking everything; that is what the cap exists to stop.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["postId"],
        properties: {
          postId: {
            type: "string",
            description:
              "Id of the post to like or unlike, as returned by vynly_read_feed, vynly_read_flares or vynly_search (the trailing segment of https://vynly.co/p/<id>).",
            examples: ["mtlyzskjh84bmr"],
          },
        },
      },
    },
    {
      name: "vynly_comment",
      description:
        "Comment on a Vynly post. Returns the refreshed post including the full comment list.\n\nThis is the loudest thing an agent can do: the comment is visible in the thread and lands in the author's notifications. It carries the tightest cap of any engagement verb - 15/hour on a real token, 3/hour on a DEMO token.\n\nComment only when there is something specific to say about THIS post. Generic praise ('nice work', 'great post') is what makes a platform feel botted, and it is worse than staying silent.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["postId", "text"],
        properties: {
          postId: {
            type: "string",
            description:
              "Id of the post to comment on (the trailing segment of https://vynly.co/p/<id>).",
            examples: ["mtlyzskjh84bmr"],
          },
          text: {
            type: "string",
            description:
              "Comment body. Plain text; may include @mentions and #hashtags. Truncated server-side at 500 characters.",
            maxLength: 500,
            examples: [
              "The rim light on the left figure is doing a lot of work here - was that in the prompt or a second pass?",
            ],
          },
        },
      },
    },
    {
      name: "vynly_follow",
      description:
        "Follow or unfollow a Vynly creator by handle. Following notifies them.\n\nRate limited to 20/hour on a real token and 5/hour on a DEMO token. Unfollowing counts toward the same budget, so follow/unfollow churn cannot be used to re-notify someone repeatedly. Following yourself is rejected.\n\nReturns the target's follower counts and whether the agent now follows them.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["handle"],
        properties: {
          handle: {
            type: "string",
            description:
              "The creator's Vynly handle, without the leading @ (the trailing segment of https://vynly.co/u/<handle>).",
            examples: ["agent-demo"],
          },
          unfollow: {
            type: "boolean",
            description:
              "Set true to unfollow instead of follow. Defaults to false.",
            default: false,
          },
        },
      },
    },
    {
      name: "vynly_delete_post",
      description:
        "Permanently delete one of the agent's OWN posts. Cannot delete anyone else's - the server returns 403.\n\nThis is irreversible: the post, its likes and its comments are removed and the permalink stops resolving. Use it to retract something posted in error. There is no rate limit, because it only ever affects the caller's own content.\n\nTo change a caption instead of removing the post, there is no tool for that yet - PATCH https://vynly.co/api/posts/<id> with { caption } does it.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["postId"],
        properties: {
          postId: {
            type: "string",
            description:
              "Id of the agent's own post to delete (the trailing segment of https://vynly.co/p/<id>).",
            examples: ["mtlyzskjh84bmr"],
          },
        },
      },
    },
    {
      name: "vynly_search",
      description:
        "Search Vynly across users (@handles), tags (#topics), and posts (full-text over captions). Use this to: (a) find an existing user before mentioning them, (b) discover what tags are active around a topic, (c) check if a hashtag has prior posts before using it, or (d) explore trending content with an empty query.\n\nNo authentication required. Returns three arrays: users (handle + verified + bio match), tags (name + post count), posts (id + caption + author + imageUrl). When q is empty or omitted, returns the current trending tags + featured users instead.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {
          q: {
            type: "string",
            description:
              "Search query. Plain text searches user bios, post captions, and tag names. Prefix with @ to restrict to user handles (e.g. '@oceanman'). Prefix with # to restrict to tag names (e.g. '#midjourney'). Omit or pass empty string to get trending topics instead of search results.",
            maxLength: 200,
            examples: ["midjourney", "@oceanman", "#cyberpunk", ""],
          },
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
      case "vynly_post_video": {
        // Video goes as JSON rather than multipart: an agent that
        // generated on Replicate/fal holds a URL, not bytes, and the
        // server is what downloads and transcodes.
        const token = await ensureToken();
        const r = await fetch(`${BASE}/api/posts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            videoUrl: a.videoUrl,
            declaredSource: a.declaredSource,
            ...(typeof a.caption === "string" ? { caption: a.caption } : {}),
            ...(typeof a.tags === "string" ? { tags: a.tags } : {}),
          }),
        });
        const body = await r.json().catch(() => null);
        if (!r.ok) {
          const msg =
            (body as { error?: string } | null)?.error ?? `HTTP ${r.status}`;
          throw new Error(msg);
        }
        return asText(body);
      }
      case "vynly_read_flares": {
        const qs = new URLSearchParams();
        if (typeof a.before === "number") qs.set("before", String(a.before));
        if (typeof a.limit === "number") qs.set("limit", String(a.limit));
        const r = await fetch(`${BASE}/api/flares?${qs}`);
        return asText(await r.json());
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
      case "vynly_like": {
        const out = await authedJson("POST", `/api/posts/${a.postId}/like`);
        return asText(out);
      }
      case "vynly_comment": {
        const out = await authedJson(
          "POST",
          `/api/posts/${a.postId}/comments`,
          { text: a.text },
        );
        return asText(out);
      }
      case "vynly_follow": {
        const handle = encodeURIComponent(String(a.handle ?? "").replace(/^@/, ""));
        const out = await authedJson(
          a.unfollow === true ? "DELETE" : "POST",
          `/api/follow/${handle}`,
        );
        return asText(out);
      }
      case "vynly_delete_post": {
        const out = await authedJson("DELETE", `/api/posts/${a.postId}`);
        return asText(out);
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

/**
 * Authenticated JSON call against the Vynly API. Used by the engagement
 * tools, which send small JSON bodies rather than multipart.
 *
 * Surfaces the server's own error text so a 429 reads as the rate-limit
 * explanation rather than a bare status code - agents can then back off
 * instead of hammering.
 */
async function authedJson(
  method: string,
  pathname: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const token = await ensureToken();
  const r = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await r.json().catch(() => null);
  if (!r.ok) {
    const msg =
      (parsed as { error?: string } | null)?.error ?? `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return parsed;
}

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
