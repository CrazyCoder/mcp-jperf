#!/usr/bin/env node
// Smoke test for IDE-identity refresh in getIdeBridge().
//
// The handle is cached for the process lifetime, but an IDE restart keeps the
// port while changing everything else about it (build number, project keys).
// A stale handle makes every tool response report a pre-restart IDE.
//
// We cannot restart an IDE from a test, so we simulate the drift: mutate the
// cached handle (the object the first call returns IS the cache), then ask for
// it again. A handle that still carries the poisoned values was never
// re-probed.
//
// Requires a running IDE with mcp-steroid. Skips (exit 0) when none answers.
//
// Usage: node scripts/_smoke-bridge-refresh.mjs

import { getIdeBridge } from "../dist/utils/ide-bridge.js";

const POISON = "IU-000.STALE";

const first = await getIdeBridge();
if (!first) {
  console.log("SKIP  no IDE reachable via mcp-steroid — nothing to refresh");
  process.exit(0);
}

const real = {
  ideBuild: first.bridge.ideBuild,
  ideName: first.bridge.ideName,
  projectName: first.bridge.projectName,
};
console.log(`live IDE: ${real.ideName} ${real.ideBuild} project=${real.projectName} port=${first.bridge.port}`);

first.bridge.ideBuild = POISON;
first.bridge.ideName = "Stale IDE";

const second = await getIdeBridge();
if (!second) {
  console.log("FAIL  second getIdeBridge() returned null");
  process.exit(1);
}

const failures = [];
if (second.bridge.ideBuild === POISON) failures.push(`ideBuild still ${POISON}`);
if (second.bridge.ideName === "Stale IDE") failures.push("ideName still poisoned");
if (second.bridge.ideBuild !== real.ideBuild) failures.push(`ideBuild=${second.bridge.ideBuild}, expected ${real.ideBuild}`);
if (second.bridge.projectName !== real.projectName) failures.push(`projectName=${second.bridge.projectName}, expected ${real.projectName}`);
if (second.bridge.port !== first.bridge.port) failures.push(`port=${second.bridge.port}, expected ${first.bridge.port}`);

if (failures.length) {
  console.log(`FAIL  ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`PASS  identity re-probed: ${second.bridge.ideName} ${second.bridge.ideBuild}`);
