#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2]);
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const entry of [metadata.bin.pi, metadata.exports["./rpc-entry"].import]) {
	assert.ok(existsSync(join(root, entry)), `Missing entrypoint: ${entry}`);
}
for (const [provider, id] of [
	["openai", "gpt-6-astra"],
	["openai", "gpt-6-sol"],
	["openai", "gpt-6-luna"],
	["anthropic", "claude-opus-5-5"],
	["xai", "grok-4.7"],
	["openai-codex", "gpt-6-astra"],
	["meta", "muse-spark-1.3"],
	["radius", "balanced"],
]) {
	const catalog = JSON.parse(
		readFileSync(join(root, "node_modules/@earendil-works/pi-ai/dist/providers/data", `${provider}.json`), "utf8"),
	);
	assert.ok(
		Object.values(catalog).some((models) => Object.hasOwn(models, `chat:${id}`)),
		`${provider}: missing ${id}`,
	);
}
const options = { cwd: root, encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1" }, timeout: 30000 };
const cli = join(root, metadata.bin.pi);
assert.equal(execFileSync(process.execPath, [cli, "--version"], options).trim(), metadata.version);
assert.match(execFileSync(process.execPath, [cli, "--help"], options), /Usage:/);
console.log("Packaged CLI startup, entrypoints, and model catalogs: PASS");
