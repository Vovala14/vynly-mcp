#!/usr/bin/env node
/**
 * package.json "version" is the only place a release number is chosen.
 * This copies it into server.json and the Claude plugin manifest.
 * src/index.ts reads package.json at runtime, so it is not rewritten.
 *
 *   node scripts/sync-version.mjs          # write
 *   node scripts/sync-version.mjs --check  # fail if those files drifted
 */
import { readFileSync, writeFileSync } from "node:fs";

const check = process.argv.includes("--check");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+([-.][\w.]+)?$/.test(version)) {
  console.error(`Unexpected package.json version: ${version}`);
  process.exit(1);
}

let failed = false;

function sync(rel, mutate) {
  const fileUrl = new URL(rel, import.meta.url);
  const raw = readFileSync(fileUrl, "utf8");
  const data = JSON.parse(raw);
  mutate(data);
  const next = `${JSON.stringify(data, null, 2)}\n`;
  if (next === raw) return;
  const label = rel.replace(/^\.\.\//, "");
  if (check) {
    console.error(`${label} does not match package.json version ${version}. Run: node scripts/sync-version.mjs`);
    failed = true;
    return;
  }
  writeFileSync(fileUrl, next);
  console.log(`updated ${label} -> ${version}`);
}

sync("../server.json", (data) => {
  data.version = version;
  if (Array.isArray(data.packages)) {
    for (const entry of data.packages) {
      if (entry && typeof entry === "object" && "version" in entry) {
        entry.version = version;
      }
    }
  }
});

sync("../plugins/vynly/.claude-plugin/plugin.json", (data) => {
  data.version = version;
  const args = data?.mcpServers?.vynly?.args;
  if (Array.isArray(args)) {
    data.mcpServers.vynly.args = args.map((arg) =>
      typeof arg === "string" && arg.startsWith("@vynly/mcp@")
        ? `@vynly/mcp@${version}`
        : arg,
    );
  }
});

if (failed) process.exit(1);
