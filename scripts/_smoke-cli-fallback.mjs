#!/usr/bin/env node
// Smoke test for the CLI-only fallback paths. Forces bridge=null by stubbing
// the discoverIde cache, then exercises each tool against an existing snapshot
// and prints a one-line summary per tool.
//
// Usage: node scripts/_smoke-cli-fallback.mjs <path-to.jfr>

import { _resetBridgeCache } from "../dist/utils/ide-bridge.js";
import { profileHeapHealth } from "../dist/tools/profile_heap_health.js";
import { profileEnv } from "../dist/tools/profile_env.js";
import { profileDescribeSnapshot } from "../dist/tools/profile_describe_snapshot.js";
import { profileListThreads } from "../dist/tools/profile_list_threads.js";
import { profilePerThread } from "../dist/tools/profile_per_thread.js";
import { profileSubsystemScan } from "../dist/tools/profile_subsystem_scan.js";
import { profileEdtHotspot } from "../dist/tools/profile_edt_hotspot.js";
import { profileCallTree } from "../dist/tools/profile_call_tree.js";

const filepath = process.argv[2];
if (!filepath) {
  console.error("Usage: node scripts/_smoke-cli-fallback.mjs <path-to.jfr>");
  process.exit(2);
}

// Force CLI mode: stub out the bridge module so getIdeBridge() returns null.
// We do this by overriding the dynamic-import resolver via env hint — the
// simpler way is to point the bridge-path resolver at a missing file. Since
// the bridge module reads `scripts/lib/ide-bridge.js` relative to its own
// location and exists() returns true in this repo, we instead override the
// internal `cached` state to {bridge:null,runner:null} after one reset, then
// short-circuit by deleting the file (no — too invasive). Easier: just set
// JAVAPERF_DISABLE_BRIDGE=1 and check it in ide-bridge.ts. We add that hook.
process.env.JAVAPERF_DISABLE_BRIDGE = "1";
_resetBridgeCache();

async function run(name, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    const parsed = JSON.parse(out);
    const ms = Date.now() - t0;
    const src = parsed.source ?? "?";
    const summary = summarize(name, parsed);
    console.log(`[${ms.toString().padStart(5)} ms] ${name.padEnd(30)} source=${src.padEnd(12)} ${summary}`);
  } catch (err) {
    console.log(`[FAIL   ms] ${name.padEnd(30)} ${err?.message ?? err}`);
  }
}

function summarize(name, p) {
  if (p.error) return `error=${p.error}`;
  switch (name) {
    case "profile_heap_health":
      return `xmxMb=${p.xmxMb} afterGcCount=${p.afterGcCount} assessment=${p.assessment}`;
    case "profile_env":
      return `jvm=${p.jvm?.name?.slice(0, 40)} cores=${p.cpu?.cores} systemProperties=${p.systemPropertyCount}`;
    case "profile_describe_snapshot":
      return `mode=${p.mode} types=${p.totalEventTypes ?? "?"} events=${p.totalEvents ?? "?"}`;
    case "profile_list_threads":
      return `threads=${p.totalThreadsInSnapshot} groups=${p.groupSummary?.length} top=${p.threads?.[0]?.name?.slice(0, 40)}`;
    case "profile_per_thread":
      return `matched=${p.matchedThreadCount} groups=${p.groupsSortedByValue?.length}`;
    case "profile_subsystem_scan":
      return `subsystems=${p.totalSubsystems} headline=${(p.headlineSubsystems ?? []).join(",").slice(0, 60)}`;
    case "profile_edt_hotspot":
      return `edtThreads=${p.edtThreads?.length} hotPathDepth=${p.hotPath?.length} totalEdt=${p.totalEdtValue}`;
    case "profile_call_tree:flat":
      return `methods=${p.methods?.length} grandTotal=${p.grandTotalValue} top=${p.methods?.[0]?.method?.slice(0, 40)}`;
    case "profile_call_tree:hierarchical":
      return `code=${p.code} (expected BRIDGE_REQUIRED)`;
    default:
      return "(ok)";
  }
}

await run("profile_describe_snapshot", () => profileDescribeSnapshot({ filepath }));
await run("profile_heap_health", () => profileHeapHealth({ filepath }));
await run("profile_env", () => profileEnv({ filepath }));
await run("profile_list_threads", () => profileListThreads({ filepath, treeId: "wallClockCpu", topN: 5 }));
await run("profile_per_thread", () => profilePerThread({ filepath, treeId: "wallClockCpu", threadFilter: "*", topN: 5 }));
await run("profile_subsystem_scan", () => profileSubsystemScan({
  filepath, treeId: "wallClockCpu", packageDepth: 3, topSubsystems: 10, topPerBucket: 5, highlightThresholdPct: 20,
}));
await run("profile_edt_hotspot", () => profileEdtHotspot({ filepath, treeId: "wallClockCpu", topN: 5 }));
await run("profile_call_tree:flat", () => profileCallTree({
  filepath, treeId: "wallClockCpu", mode: "flat", root: "", threadFilter: "*", topN: 5, depth: 3, minPct: 0, sortBy: "total",
}));
await run("profile_call_tree:hierarchical", () => profileCallTree({
  filepath, treeId: "wallClockCpu", mode: "hierarchical", root: "", threadFilter: "*", topN: 5, depth: 3, minPct: 0, sortBy: "total",
}));
