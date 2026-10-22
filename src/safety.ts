/**
 * Guards for local file reads and outbound fetches.
 *
 * imagePath used to upload whatever was on disk. Image URLs used to be
 * fetched by this process, including loopback and link-local targets.
 * User-supplied ids used to be interpolated into URL paths raw.
 */
import { lookup } from "node:dns/promises";
import { realpath, readFile, stat } from "node:fs/promises";
import { isIP, BlockList } from "node:net";
import path from "node:path";

/** Matches the image cap documented by vynly.co (10MB). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const REQUEST_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 60_000;
/** Video posts wait on the server while it transcodes, up to ~60s of source. */
export const VIDEO_TIMEOUT_MS = 180_000;

const REDIRECT_LIMIT = 5;

const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
} as const;

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.internal",
]);

const v4Block = new BlockList();
const v6Block = new BlockList();

function block4(address: string, prefix: number) {
  v4Block.addSubnet(address, prefix, "ipv4");
}
function block6(address: string, prefix: number) {
  v6Block.addSubnet(address, prefix, "ipv6");
}

block4("0.0.0.0", 8);
block4("10.0.0.0", 8);
block4("100.64.0.0", 10); // CGNAT
block4("127.0.0.0", 8);
block4("169.254.0.0", 16); // link-local, includes 169.254.169.254
block4("172.16.0.0", 12);
block4("192.0.0.0", 24);
block4("192.0.2.0", 24);
block4("192.168.0.0", 16);
block4("198.18.0.0", 15);
block4("198.51.100.0", 24);
block4("203.0.113.0", 24);
block4("224.0.0.0", 4); // multicast
block4("240.0.0.0", 4); // reserved, includes broadcast

v6Block.addAddress("::", "ipv6");
v6Block.addAddress("::1", "ipv6");
block6("fc00::", 7); // unique local
block6("fe80::", 10); // link-local
block6("ff00::", 8); // multicast
block6("2001:db8::", 32);

/** Ids that are safe to place in a single URL path segment. */
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type LoadedImage = {
  bytes: Buffer;
  name: string;
  contentType: string;
};

export function detectImageMime(
  bytes: Buffer,
): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 6) {
    const sig = bytes.toString("ascii", 0, 6);
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  return null;
}

/**
 * Validate a caller-supplied id and return it percent-encoded for a path
 * segment. Rejects traversal (`../../follow/x`) instead of interpolating it.
 */
export function encodeResourceId(id: unknown, label = "id"): string {
  if (typeof id !== "string" || !RESOURCE_ID.test(id)) {
    throw new Error(
      `${label} must be 1-128 characters of letters, digits, "_" or "-", and must not contain slashes or "."`,
    );
  }
  return encodeURIComponent(id);
}

export function isBlockedIp(ip: string): boolean {
  if (isIP(ip) === 4) return v4Block.check(ip, "ipv4");
  if (isIP(ip) === 6) {
    const mapped = ipv4FromMapped(ip);
    if (mapped) return v4Block.check(mapped, "ipv4");
    return v6Block.check(ip, "ipv6");
  }
  return false;
}

/** IPv4 embedded in ::ffff:a.b.c.d or ::ffff:hhhh:hhhh. */
function ipv4FromMapped(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function bareHostname(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  return host;
}

function isBlockedHostname(host: string): boolean {
  if (BLOCKED_HOSTS.has(host)) return true;
  return (
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localdomain")
  );
}

/**
 * Reject schemes, credentials, and hosts that are already a private,
 * loopback, or link-local address (including the decimal / hex / octal
 * forms the URL parser rewrites, and IPv4-mapped IPv6). Does not resolve
 * DNS; call `assertResolvedHostPublic` before connecting.
 */
export function assertFetchableUrl(
  raw: string,
  opts?: { httpsOnly?: boolean },
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  const httpsOnly = opts?.httpsOnly !== false;
  const allowed = httpsOnly ? ["https:"] : ["http:", "https:"];
  if (!allowed.includes(url.protocol)) {
    throw new Error(
      httpsOnly
        ? "Only https URLs can be fetched"
        : "Only http and https URLs can be fetched",
    );
  }
  if (url.username || url.password) {
    throw new Error("URLs must not contain credentials");
  }
  const host = bareHostname(url.hostname);
  if (!host) throw new Error("URL is missing a host");
  if (isBlockedHostname(host) || isBlockedIp(host)) {
    throw new Error(`Refusing to fetch non-public host ${host}`);
  }
  return url;
}

/** Used for every redirect hop, so a public URL cannot bounce to loopback. */
export function resolveRedirect(
  from: string,
  location: string,
  opts?: { httpsOnly?: boolean },
): URL {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new Error("Redirect Location is not a valid URL");
  }
  return assertFetchableUrl(next.href, opts);
}

export function assertAddressesPublic(hostname: string, addresses: readonly string[]): void {
  if (addresses.length === 0) {
    throw new Error(`Could not resolve ${hostname}`);
  }
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new Error(
        `Refusing to fetch ${hostname}: it resolves to a non-public address (${address})`,
      );
    }
  }
}

export async function assertResolvedHostPublic(url: URL): Promise<void> {
  const host = bareHostname(url.hostname);
  if (isBlockedHostname(host) || isBlockedIp(host)) {
    throw new Error(`Refusing to fetch non-public host ${host}`);
  }
  if (isIP(host)) return;
  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve ${host}`);
  }
  assertAddressesPublic(host, records.map((record) => record.address));
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = res.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    await res.body?.cancel();
    throw new Error(`Image exceeds ${maxBytes} bytes`);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`Image exceeds ${maxBytes} bytes`);
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Image exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * GET an image ourselves. Used for spark URLs and carousel extras, which
 * `POST /api/posts/from-url` cannot accept. Every hop is checked, including
 * addresses the name resolves to.
 */
export async function fetchPublicImage(
  rawUrl: string,
  timeoutMs = UPLOAD_TIMEOUT_MS,
): Promise<LoadedImage> {
  let current = assertFetchableUrl(rawUrl, { httpsOnly: true });
  for (let hop = 0; hop <= REDIRECT_LIMIT; hop++) {
    await assertResolvedHostPublic(current);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "vynly-mcp" },
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new Error(`Timed out fetching image after ${timeoutMs}ms`);
      }
      throw err;
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new Error("Redirect had no Location header");
      if (hop === REDIRECT_LIMIT) throw new Error("Too many redirects fetching image");
      current = resolveRedirect(current.href, location, { httpsOnly: true });
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Could not fetch image URL: HTTP ${res.status}`);
    }
    const bytes = await readCapped(res, MAX_IMAGE_BYTES);
    const contentType = detectImageMime(bytes);
    if (!contentType) {
      throw new Error("URL did not return a PNG, JPEG, WebP, or GIF");
    }
    return {
      bytes,
      name: filenameFromUrl(current, contentType),
      contentType,
    };
  }
  throw new Error("Too many redirects fetching image");
}

function filenameFromUrl(url: URL, contentType: string): string {
  const base = path.posix.basename(url.pathname);
  if (base && base !== "." && base !== "/" && !base.includes("..")) {
    return base.slice(0, 128);
  }
  const ext = contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
  return `image.${ext}`;
}

export function decodeImageBase64(b64: string, declaredType?: string): LoadedImage {
  if (typeof b64 !== "string" || b64.trim() === "") {
    throw new Error("Image base64 is empty");
  }
  const cleaned = b64.replace(/^data:[^,]*,/, "").trim();
  const maxChars = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8;
  if (cleaned.length > maxChars) {
    throw new Error(`Base64 image exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  const bytes = Buffer.from(cleaned, "base64");
  if (bytes.length === 0) throw new Error("Image base64 decoded to empty");
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`Base64 image exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  const contentType = detectImageMime(bytes);
  if (!contentType) {
    throw new Error("Base64 data is not a PNG, JPEG, WebP, or GIF");
  }
  if (declaredType && declaredType !== contentType) {
    throw new Error(
      `contentType ${declaredType} does not match image bytes (${contentType})`,
    );
  }
  const ext = contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
  return { bytes, name: `image.${ext}`, contentType };
}

/**
 * Read a local image. Extension and magic bytes must agree, the file must
 * be under the size cap, and when `VYNLY_UPLOAD_DIR` (or `root`) is set the
 * real path must stay inside that directory.
 */
export async function readLocalImage(
  inputPath: string,
  options?: { root?: string; maxBytes?: number },
): Promise<LoadedImage> {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new Error("Image path is empty");
  }
  const ext = path.extname(inputPath).toLowerCase();
  const expected = IMAGE_MIME[ext as keyof typeof IMAGE_MIME];
  if (!expected) {
    throw new Error(
      `Only PNG, JPEG, WebP, and GIF files can be uploaded (got "${ext || "no extension"}")`,
    );
  }
  const maxBytes = options?.maxBytes ?? MAX_IMAGE_BYTES;
  const root =
    options && "root" in options ? options.root : process.env.VYNLY_UPLOAD_DIR;
  let real: string;
  try {
    real = await realpath(path.resolve(inputPath));
  } catch {
    throw new Error(`Cannot read image path: ${inputPath}`);
  }
  if (root) {
    let rootReal: string;
    try {
      rootReal = await realpath(path.resolve(root));
    } catch {
      throw new Error(`VYNLY_UPLOAD_DIR does not exist: ${root}`);
    }
    const rel = path.relative(rootReal, real);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Image path is outside the allowed upload directory (${rootReal})`);
    }
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error("Image path is not a file");
  if (info.size === 0) throw new Error("Image file is empty");
  if (info.size > maxBytes) {
    throw new Error(`Image is ${info.size} bytes; max is ${maxBytes}`);
  }
  const bytes = await readFile(real);
  if (bytes.length > maxBytes) {
    throw new Error(`Image is ${bytes.length} bytes; max is ${maxBytes}`);
  }
  const contentType = detectImageMime(bytes);
  if (!contentType) {
    throw new Error("File content is not a PNG, JPEG, WebP, or GIF");
  }
  if (contentType !== expected) {
    throw new Error(
      `Extension ${ext} does not match image contents (${contentType})`,
    );
  }
  return { bytes, name: path.basename(real), contentType };
}
