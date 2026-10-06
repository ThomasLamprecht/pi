#!/usr/bin/env node
// Generate the package.json for the isolated production install tree used by
// debian/rules. Direct dependencies pin all locally built workspace tarballs
// instead of resolving workspace packages from the registry.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const installRoot = process.argv[2];
if (!installRoot) {
	console.error("usage: gen-install-root.mjs <install-root-dir>");
	process.exit(1);
}

const version = JSON.parse(readFileSync("packages/coding-agent/package.json", "utf8")).version;
const names = ["chord", "pi-telemetry", "pi-ai", "pi-tui", "pi-agent-core", "pi-codemode", "pi-mcp", "pi-coding-agent"];
const deps = Object.fromEntries(
	names.map((name) => [`@earendil-works/${name}`, `file:../tarballs/earendil-works-${name}-${version}.tgz`]),
);

// Undici 8.x requires Node 22.19. Pin the production closure to the Node 20
// release with the corresponding HTTP and WebSocket security fixes.
// Compilation still uses upstream's development dependencies.
//
// Only plain version specifiers may appear in "overrides": Debian's npm (9.x)
// rejects a "file:" target there ("Invalid comparator"). The workspace packages
// are therefore pinned through "dependencies" alone. Overrides in dependency
// manifests are ignored by npm, so preserve upstream's protobufjs pin here.
const overrides = { protobufjs: "7.6.6", undici: "7.29.1" };

const manifest = { private: true, dependencies: deps, overrides };
writeFileSync(join(installRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
