// Runs tests/ in a headless Chrome against tools/mock_server.py and fails if any test fails. Used by GitHub
// Actions. No dependencies: Chrome's debug port lists each page with its title, and the tests write their
// failures and the final DONE line in the title.
//
//   python tools/mock_server.py &
//   node tools/ci_tests.mjs /path/to/chrome
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome = process.argv[2] || process.env.CHROME || "google-chrome";
const PORT = 9333;
const URL = "http://localhost:8090/tests/";
const LIMIT_MS = 10 * 60 * 1000;

const browser = spawn(chrome, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--window-size=1920,1080",
  "--autoplay-policy=no-user-gesture-required", "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + mkdtempSync(join(tmpdir(), "streamiso-tests-")), URL
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function title() {
  try {
    const pages = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
    const page = pages.find((p) => p.type === "page" && p.url.startsWith(URL));
    return page ? page.title : "";
  } catch (e) {
    return "";
  }
}

// The title only grows: each poll prints the lines added since the last one.
let last = "", shownLines = 0, code = 1;
const end = Date.now() + LIMIT_MS;
while (Date.now() < end) {
  const now = await title();
  if (now !== last) {
    last = now;
    const lines = now.split(" || ");
    lines.slice(shownLines).forEach((line) => { if (!/^DONE/.test(line)) console.log(line); });
    shownLines = lines.length;
  }
  const done = /DONE passed=(\d+) failed=(\d+)(?: :: (.*))?$/.exec(now);
  if (done) {
    console.log("\nPassed: " + done[1] + ", failed: " + done[2]);
    if (done[3]) done[3].split(" | ").forEach((name) => console.log("  FAIL " + name));
    code = done[2] === "0" && done[1] !== "0" ? 0 : 1;
    break;
  }
  await sleep(500);
}
if (!/DONE/.test(last)) console.log("The tests did not finish in " + LIMIT_MS / 1000 + " s.");
browser.kill();
process.exit(code);
