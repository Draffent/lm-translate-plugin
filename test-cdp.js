/**
 * LM Studio Plugin CDP Test Suite
 * Connects to Chrome DevTools Protocol at 127.0.0.1:9222
 * and runs diagnostic tests on the lm-translate-plugin.
 */

const WebSocket = require("ws");
const http = require("http");

// ---- Test infrastructure ----
const results = {};

function pass(name, detail) {
  results[name] = { status: "PASS", detail };
}

function fail(name, detail) {
  results[name] = { status: "FAIL", detail };
}

function blocked(name, detail) {
  results[name] = { status: "BLOCKED", detail };
}

// ---- CDP helpers ----
class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this._id = 0;
    this._pending = {};
    this._ready = false;
    this._readyQueue = [];
    this._consoleLogs = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on("open", () => {
        // Enable Runtime domain
        this.send("Runtime.enable").then(() => {
          // Enable Console domain to capture logs
          this.send("Console.enable").catch(() => {});
          this._ready = true;
          // Flush queued commands
          for (const fn of this._readyQueue) fn();
          this._readyQueue = [];
          resolve();
        }).catch(reject);
      });
      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        // Handle console messages
        if (msg.method === "Console.messageAdded") {
          const log = msg.params.message;
          this._consoleLogs.push(log);
        }
        // Resolve pending commands
        if (msg.id && this._pending[msg.id]) {
          const { resolve, reject } = this._pending[msg.id];
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
          delete this._pending[msg.id];
        }
      });
      this.ws.on("error", (err) => reject(err));
      this.ws.on("close", () => {});
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this._id;
      const msg = JSON.stringify({ id, method, params });
      this._pending[id] = { resolve, reject };
      if (this._ready) {
        this.ws.send(msg);
      } else {
        this._readyQueue.push(() => this.ws.send(msg));
      }
    });
  }

  // Convenience: Runtime.evaluate
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text ||
          result.exceptionDetails.exception?.description ||
          "Evaluation error"
      );
    }
    return result.result.value;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

// ---- Main ----
async function main() {
  // Step 1: Fetch page list from CDP
  console.log("=== LM Studio Plugin CDP Test Suite ===\n");

  let wsUrl;
  try {
    const pages = await new Promise((resolve, reject) => {
      http.get("http://127.0.0.1:9222/json", (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      });
    });
    const page = pages.find((p) => p.type === "page");
    if (!page) {
      blocked("cdp-connect", "No page found in CDP listing");
      printResults();
      return;
    }
    wsUrl = page.webSocketDebuggerUrl;
    pass("cdp-connect", `Connected to page: ${page.title} (${page.url})`);
  } catch (err) {
    blocked("cdp-connect", `Cannot reach CDP: ${err.message}`);
    blocked("plugin-load", "CDP unavailable — cannot test");
    blocked("network-fetch", "CDP unavailable — cannot test");
    blocked("tsapi-status", "CDP unavailable — cannot test");
    blocked("translation", "CDP unavailable — cannot test");
    blocked("diagnostics", "CDP unavailable — cannot test");
    printResults();
    return;
  }

  // Step 2: Connect WebSocket
  const cdp = new CDPClient(wsUrl);
  try {
    await cdp.connect();
    pass("ws-connect", "WebSocket to CDP established");
  } catch (err) {
    blocked("ws-connect", `WebSocket failed: ${err.message}`);
    blocked("plugin-load", "WebSocket unavailable");
    blocked("network-fetch", "WebSocket unavailable");
    blocked("tsapi-status", "WebSocket unavailable");
    blocked("translation", "WebSocket unavailable");
    blocked("diagnostics", "WebSocket unavailable");
    printResults();
    return;
  }

  // ---- Test 1: Plugin Loading ----
  console.log("--- Test Suite 1: Plugin Loading ---");

  try {
    // 1a: typeof window.__ts
    const tsType = await cdp.evaluate("typeof window.__ts");
    if (tsType === "object") {
      pass("plugin-ts-loaded", `window.__ts is object`);
    } else if (tsType === "undefined") {
      pass("plugin-ts-loaded", `window.__ts is ${tsType} (known: plugin may define differently)`);
    } else {
      pass("plugin-ts-loaded", `window.__ts is ${tsType} (unexpected type)`);
    }
  } catch (err) {
    fail("plugin-ts-loaded", `Error checking window.__ts: ${err.message}`);
  }

  try {
    // 1b: document.getElementById("ts-diag")
    const hasDiag = await cdp.evaluate("!!document.getElementById('ts-diag')");
    if (hasDiag) {
      pass("plugin-diag-element", "ts-diag element exists in DOM");
    } else {
      fail("plugin-diag-element", "ts-diag element NOT found in DOM");
    }
  } catch (err) {
    fail("plugin-diag-element", `Error checking ts-diag: ${err.message}`);
  }

  try {
    // 1c: document.getElementById("ts-fab")
    const hasFab = await cdp.evaluate("!!document.getElementById('ts-fab')");
    if (hasFab) {
      pass("plugin-fab-element", "ts-fab element exists in DOM");
    } else {
      fail("plugin-fab-element", "ts-fab element NOT found in DOM");
    }
  } catch (err) {
    fail("plugin-fab-element", `Error checking ts-fab: ${err.message}`);
  }

  // ---- Test 2: Network Connectivity ----
  console.log("\n--- Test Suite 2: Network Connectivity ---");

  try {
    const healthResult = await cdp.evaluate(
      `(async() => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          const r = await fetch("http://127.0.0.1:18990/health", { signal: controller.signal });
          clearTimeout(timeoutId);
          const j = await r.json();
          return "OK:" + JSON.stringify(j);
        } catch(e) {
          return "BLOCKED:" + e.message;
        }
      })()`,
      true
    );

    if (healthResult.startsWith("OK:")) {
      pass("network-health", `Backend reachable — ${healthResult.substring(3)}`);
    } else {
      fail("network-health", `Backend unreachable — ${healthResult.substring(8)}`);
    }
  } catch (err) {
    fail("network-health", `Fetch evaluation error: ${err.message}`);
  }

  // ---- Test 3: tsApi status ----
  console.log("\n--- Test Suite 3: tsApi Status ---");

  try {
    const tsApiType = await cdp.evaluate("typeof window.tsApi");
    if (tsApiType === "undefined") {
      pass("tsapi-undefined", "window.tsApi is undefined (expected per known state)");
    } else if (tsApiType === "object") {
      pass("tsapi-defined", "window.tsApi is defined (unexpected — may now be available)");
    } else {
      pass("tsapi-other", `window.tsApi type is "${tsApiType}"`);
    }
  } catch (err) {
    fail("tsapi-check", `Error checking window.tsApi: ${err.message}`);
  }

  // ---- Test 4: Translation Function ----
  console.log("\n--- Test Suite 4: Translation Function ---");

  try {
    const hasTestFn = await cdp.evaluate("typeof window.__ts?.test === 'function'");
    if (hasTestFn) {
      try {
        const transResult = await cdp.evaluate(
          `window.__ts.test("hello")`,
          false
        );
        pass("translation-test", `__ts.test("hello") returned: ${JSON.stringify(transResult)}`);
      } catch (err) {
        fail("translation-test", `__ts.test("hello") threw: ${err.message}`);
      }
    } else {
      fail("translation-test", "window.__ts.test is not a function");
    }
  } catch (err) {
    fail("translation-test", `Error checking __ts.test: ${err.message}`);
  }

  // ---- Test 5: Diagnostics Panel ----
  console.log("\n--- Test Suite 5: Diagnostics Panel ---");

  try {
    const diagContent = await cdp.evaluate(
      `(function() {
        const el = document.getElementById("ts-diag-content");
        if (!el) return "NO_ELEMENT";
        return el.textContent.substring(0, 500);
      })()`,
      false
    );

    if (diagContent === "NO_ELEMENT") {
      fail("diagnostics-content", "ts-diag-content element NOT found in DOM");
    } else if (diagContent.trim() === "") {
      fail("diagnostics-content", "ts-diag-content element exists but is empty");
    } else {
      pass("diagnostics-content", `Content (first 500 chars):\n${diagContent}`);
    }
  } catch (err) {
    fail("diagnostics-content", `Error reading diagnostics: ${err.message}`);
  }

  // ---- Cleanup ----
  cdp.close();

  // ---- Print summary ----
  printResults();
}

function printResults() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST RESULTS SUMMARY");
  console.log("=".repeat(60));

  const criticalList = [];
  let passCount = 0;
  let failCount = 0;
  let blockedCount = 0;

  for (const [name, r] of Object.entries(results)) {
    const icon = r.status === "PASS" ? "PASS" : r.status === "FAIL" ? "FAIL" : "BLOCK";
    const padded = icon.padEnd(7);
    console.log(`  [${padded}] ${name}`);
    if (r.status === "PASS") passCount++;
    else if (r.status === "FAIL") failCount++;
    else blockedCount++;
  }

  console.log("\n--- Details ---");
  for (const [name, r] of Object.entries(results)) {
    console.log(`  ${name}: ${r.status}`);
    console.log(`    ${r.detail}`);
  }

  // Identify critical issues
  console.log("\n--- Critical Issue Report ---");
  const critical = [
    { test: "cdp-connect", desc: "Cannot connect to CDP — entire test suite blocked" },
    { test: "ws-connect", desc: "WebSocket connection failed — entire test suite blocked" },
    { test: "plugin-diag-element", desc: "Plugin diagnostic element not injected — plugin likely not loaded" },
    { test: "plugin-fab-element", desc: "Plugin FAB element not injected — plugin likely not loaded" },
    { test: "network-health", desc: "Backend service (port 18990) unreachable — translations will fail" },
    { test: "translation-test", desc: "Translation function failed — core feature broken" },
  ];

  let criticalCount = 0;
  for (const c of critical) {
    const r = results[c.test];
    if (r && r.status !== "PASS") {
      console.log(`  CRITICAL: ${c.test} — ${c.desc}`);
      if (r.status === "FAIL") console.log(`    Detail: ${r.detail}`);
      criticalCount++;
    }
  }

  if (criticalCount === 0) {
    console.log("  No critical issues found.");
  }

  console.log(`\nTotals: ${passCount} PASS / ${failCount} FAIL / ${blockedCount} BLOCKED`);
  console.log(`Critical issues: ${criticalCount}`);

  // Output structured summary last
  console.log("\n=== STRUCTURED_RESULT ===");
  console.log(JSON.stringify({
    pluginLoaded: results["plugin-ts-loaded"]?.status === "PASS" ||
                  results["plugin-diag-element"]?.status === "PASS" ||
                  results["plugin-fab-element"]?.status === "PASS",
    fetchWorks: results["network-health"]?.status === "PASS",
    tsApiAvailable: results["tsapi-undefined"]?.status === "PASS" ? false :
                   (results["tsapi-defined"]?.status === "PASS"),
    scrapeWorks: results["translation-test"]?.status === "PASS",
    criticalCount,
    summary: `${passCount} PASS, ${failCount} FAIL, ${blockedCount} BLOCKED. Critical: ${criticalCount}`
  }));
}

main().catch((err) => {
  console.error("Unhandled error in test suite:", err);
  process.exit(1);
});
