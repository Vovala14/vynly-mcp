import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertAddressesPublic,
  assertFetchableUrl,
  decodeImageBase64,
  encodeResourceId,
  fetchPublicImage,
  isBlockedIp,
  readLocalImage,
  resolveRedirect,
} from "../dist/safety.js";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from("GIF89a", "ascii");
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
]);

function rejects(fn, pattern) {
  return assert.rejects(fn, pattern);
}

test("encodeResourceId accepts post ids and encodes them", () => {
  assert.equal(encodeResourceId("mtlyzskjh84bmr", "postId"), "mtlyzskjh84bmr");
  assert.equal(
    encodeResourceId("abc-DEF_09", "postId"),
    encodeURIComponent("abc-DEF_09"),
  );
});

test("encodeResourceId rejects path injection", () => {
  for (const bad of [
    "../../follow/x",
    "..",
    "../posts",
    "abc/def",
    "a b",
    "%2e%2e%2f",
    "posts/../../follow/x",
    "",
    ".",
    "id.with.dots",
    "/etc/passwd",
  ]) {
    assert.throws(() => encodeResourceId(bad, "postId"), /postId/);
  }
  assert.throws(() => encodeResourceId(undefined, "postId"), /postId/);
  assert.throws(() => encodeResourceId(12, "postId"), /postId/);
});

test("isBlockedIp covers loopback, private, and link-local ranges", () => {
  const blocked = [
    "127.0.0.1",
    "127.0.0.2",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "169.254.169.254",
    "100.64.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "::ffff:808:808"]) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test("assertFetchableUrl blocks private literals, including rewritten forms", () => {
  const blocked = [
    "https://127.0.0.1/secret",
    "https://127.0.0.1:22/id_rsa",
    "http://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/admin",
    "https://192.168.0.1/",
    "https://172.16.5.5/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:169.254.169.254]/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://0177.0.0.1/",
    "https://127.1/",
    "https://0xA9FEA9FE/",
    "https://localhost/x",
    "https://localhost./x",
    "https://foo.localhost/x",
    "https://printer.local/x",
    "https://metadata.google.internal/",
    "https://something.internal/x",
    "file:///etc/passwd",
    "https://user:pass@cdn.example.com/a.png",
    "gopher://127.0.0.1/",
  ];
  for (const raw of blocked) {
    assert.throws(() => assertFetchableUrl(raw), /Refusing|Only https|credentials|Invalid URL/, raw);
  }
});

test("assertFetchableUrl allows public https URLs", () => {
  const url = assertFetchableUrl("https://cdn.example.com/render/abc.png");
  assert.equal(url.hostname, "cdn.example.com");
  assert.equal(assertFetchableUrl("https://8.8.8.8/a.png").hostname, "8.8.8.8");
  assert.equal(assertFetchableUrl("https://134744072/a.png").hostname, "8.8.8.8");
});

test("http is rejected for uploads and allowed for the provenance check", () => {
  assert.throws(
    () => assertFetchableUrl("http://cdn.example.com/a.png"),
    /Only https/,
  );
  const check = assertFetchableUrl("http://cdn.example.com/a.png", { httpsOnly: false });
  assert.equal(check.protocol, "http:");
  assert.throws(
    () => assertFetchableUrl("http://127.0.0.1/a.png", { httpsOnly: false }),
    /non-public/,
  );
});

test("redirects cannot hop to a private or downgraded URL", () => {
  assert.throws(
    () => resolveRedirect("https://cdn.example.com/a.png", "https://169.254.169.254/latest/meta-data"),
    /non-public/,
  );
  assert.throws(
    () => resolveRedirect("https://cdn.example.com/a.png", "http://127.0.0.1/"),
    /non-public|Only https/,
  );
  assert.throws(
    () => resolveRedirect("https://cdn.example.com/a.png", "http://cdn.example.com/b.png"),
    /Only https/,
  );
  const next = resolveRedirect("https://cdn.example.com/a.png", "/b.png");
  assert.equal(next.href, "https://cdn.example.com/b.png");
  const absolute = resolveRedirect(
    "https://cdn.example.com/a.png",
    "https://images.example.org/c.jpg",
  );
  assert.equal(absolute.hostname, "images.example.org");
});

test("DNS answers that include a private address are refused", () => {
  assert.throws(
    () => assertAddressesPublic("cdn.example.com", ["1.2.3.4", "127.0.0.1"]),
    /127\.0\.0\.1/,
  );
  assert.throws(
    () => assertAddressesPublic("cdn.example.com", ["10.0.0.5"]),
    /non-public/,
  );
  assert.throws(() => assertAddressesPublic("cdn.example.com", []), /resolve/);
  assert.doesNotThrow(() => assertAddressesPublic("cdn.example.com", ["1.2.3.4", "8.8.8.8"]));
});

test("fetchPublicImage does not connect to loopback", async () => {
  await rejects(
    () => fetchPublicImage("https://127.0.0.1/secret.png"),
    /non-public/,
  );
  await rejects(
    () => fetchPublicImage("https://2130706433/id_rsa"),
    /non-public/,
  );
  await rejects(
    () => fetchPublicImage("http://169.254.169.254/latest/meta-data/"),
    /non-public|Only https/,
  );
});

test("readLocalImage rejects non-images even if the caller names them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vynly-mcp-"));
  await writeFile(path.join(dir, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  await writeFile(path.join(dir, ".env"), "VYNLY_TOKEN=vln_secret\n");
  await writeFile(path.join(dir, "notes.png"), "not really a png");
  await rejects(() => readLocalImage(path.join(dir, "id_rsa")), /Only PNG, JPEG/);
  await rejects(() => readLocalImage(path.join(dir, ".env")), /Only PNG, JPEG/);
  await rejects(() => readLocalImage(path.join(dir, "notes.png")), /not a PNG, JPEG/);
});

test("readLocalImage accepts an image whose extension matches its magic bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vynly-mcp-"));
  const file = path.join(dir, "cat.png");
  await writeFile(file, PNG);
  const image = await readLocalImage(file);
  assert.equal(image.contentType, "image/png");
  assert.equal(image.name, "cat.png");
  assert.ok(image.bytes.length > 0);
});

test("readLocalImage rejects an extension that does not match the bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vynly-mcp-"));
  const file = path.join(dir, "cat.png");
  await writeFile(file, JPEG);
  await rejects(() => readLocalImage(file), /does not match image contents \(image\/jpeg\)/);
});

test("readLocalImage enforces the size cap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vynly-mcp-"));
  const file = path.join(dir, "big.jpg");
  await writeFile(file, Buffer.concat([JPEG, Buffer.alloc(64)]));
  await rejects(() => readLocalImage(file, { maxBytes: 16 }), /max is 16/);
});

test("VYNLY_UPLOAD_DIR confines reads, including symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vynly-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "vynly-out-"));
  const inside = path.join(root, "ok.jpg");
  const secret = path.join(outside, "secret.jpg");
  await writeFile(inside, JPEG);
  await writeFile(secret, JPEG);
  await symlink(secret, path.join(root, "linked.jpg"));

  const allowed = await readLocalImage(inside, { root });
  assert.equal(allowed.contentType, "image/jpeg");

  await rejects(() => readLocalImage(secret, { root }), /outside the allowed upload directory/);
  await rejects(
    () => readLocalImage(path.join(root, "linked.jpg"), { root }),
    /outside the allowed upload directory/,
  );
  await rejects(
    () => readLocalImage(path.join(root, "..", path.basename(outside), "secret.jpg"), { root }),
    /outside the allowed upload directory/,
  );
});

test("decodeImageBase64 uses magic bytes, not a default of PNG", () => {
  const jpeg = decodeImageBase64(JPEG.toString("base64"));
  assert.equal(jpeg.contentType, "image/jpeg");
  assert.equal(jpeg.name, "image.jpg");

  const webp = decodeImageBase64(WEBP.toString("base64"));
  assert.equal(webp.contentType, "image/webp");

  const gif = decodeImageBase64(GIF.toString("base64"));
  assert.equal(gif.contentType, "image/gif");

  const prefixed = decodeImageBase64(`data:image/png;base64,${PNG.toString("base64")}`);
  assert.equal(prefixed.contentType, "image/png");

  assert.throws(() => decodeImageBase64(Buffer.from("not an image").toString("base64")), /not a PNG/);
  assert.throws(
    () => decodeImageBase64(JPEG.toString("base64"), "image/png"),
    /does not match/,
  );
});

test("version is read from package.json, not hardcoded in src", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
  const plugin = JSON.parse(
    readFileSync(new URL("../plugins/vynly/.claude-plugin/plugin.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.version, "0.6.0");
  assert.equal(src.includes(`version: "${pkg.version}"`), false);
  assert.match(src, /package\.json/);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].version, pkg.version);
  assert.equal(server.remotes[0].url, "https://vynly.co/api/mcp");
  assert.equal(server.remotes[0].type, "streamable-http");
  assert.equal(plugin.version, pkg.version);
  assert.ok(plugin.mcpServers.vynly.args.includes(`@vynly/mcp@${pkg.version}`));
});

test("stdio server advertises instructions, titles, and annotations", async () => {
  const { spawn } = await import("node:child_process");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, VYNLY_TOKEN: "vln_supersecretvalue", VYNLY_BASE_URL: "https://vynly.co" },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const frames = [];
  let buf = "";
  const pending = [];
  function pushFrame(message) {
    if (pending.length > 0) pending.shift()(message);
    else frames.push(message);
  }
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) pushFrame(JSON.parse(line));
    }
  });

  function nextFrame() {
    if (frames.length) return Promise.resolve(frames.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for frame\nstderr:${stderr}`)), 5000);
      pending.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vynly-mcp-test", version: "0" },
      },
    });
    const init = await nextFrame();
    assert.equal(init.result.serverInfo.version, pkg.version);
    assert.match(init.result.instructions, /VYNLY_UPLOAD_DIR/);
    assert.match(init.result.instructions, /from-url/);

    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await nextFrame();
    const tools = listed.result.tools;
    const names = tools.map((tool) => tool.name);
    for (const name of [
      "vynly_post_image",
      "vynly_post_video",
      "vynly_post_spark",
      "vynly_read_feed",
      "vynly_read_flares",
      "vynly_read_sparks",
      "vynly_list_trails",
      "vynly_check_provenance",
      "vynly_like",
      "vynly_comment",
      "vynly_follow",
      "vynly_edit_post",
      "vynly_delete_post",
      "vynly_search",
    ]) {
      assert.ok(names.includes(name), name);
    }
    for (const tool of tools) {
      assert.equal(typeof tool.title, "string", tool.name);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        assert.equal(typeof tool.annotations[hint], "boolean", `${tool.name} ${hint}`);
      }
      assert.equal(tool.annotations.openWorldHint, true, tool.name);
    }
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.vynly_read_feed.annotations.readOnlyHint, true);
    assert.equal(byName.vynly_delete_post.annotations.destructiveHint, true);
    assert.equal(byName.vynly_edit_post.annotations.destructiveHint, true);
    assert.equal(byName.vynly_check_provenance.annotations.readOnlyHint, true);
    assert.equal(byName.vynly_like.annotations.idempotentHint, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(stderr, /vynly-mcp connected/);
    assert.match(stderr, /token=set/);
    assert.doesNotMatch(stderr, /supersecret/);
    assert.doesNotMatch(stderr, /vln_/);
  } finally {
    child.kill();
  }
});
