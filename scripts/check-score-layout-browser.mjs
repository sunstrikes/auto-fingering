import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const appUrl = new URL(process.env.STUDIO_URL || "https://localhost:5173/");
const browser = await chromium.launch(
  process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: "chrome" },
);

// Many repeated passages and retrieval landmarks, without relying on a private score.
function longScoreXml() {
  const measures = Array.from({ length: 168 }, (_, index) => `
    <measure number="${index + 1}">
      ${index === 0 ? `<attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction><sound tempo="120"/></direction>` : ""}
      ${index % 4 === 0 ? `<direction><direction-type><rehearsal>Section ${index / 4 + 1}</rehearsal></direction-type></direction>` : ""}
      ${["C", "D", "E", "G", "F", "E", "D", "C"].map((step, noteIndex) => `
        <note><pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type>
        ${noteIndex === 7 && index % 4 === 3 ? "<notations><fermata/></notations>" : ""}
        </note>`).join("")}
    </measure>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
    <score-partwise version="4.0"><work><work-title>Long score layout regression</work-title></work>
    <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
    <part id="P1">${measures}</part></score-partwise>`;
}

try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  // Keep this check local and deterministic; no MIDI, model, or audio downloads.
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === appUrl.origin
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__layoutMessageCount = 0;
    window.onmessage = (event) => {
      if (event.data?.type === "layout-smoke") window.__layoutMessageCount += 1;
    };
    window.__layoutMessageHandler = window.onmessage;
  });
  await page.goto(appUrl.href);
  await page.locator('input[accept=".musicxml,.xml,.mxl"]').setInputFiles(
    process.env.SCORE_PATH
      ? process.env.SCORE_PATH
      : {
          name: "long-layout.musicxml",
          mimeType: "application/xml",
          buffer: Buffer.from(longScoreXml()),
        },
  );
  await page.getByTestId("motor-chunk-strip").waitFor({ state: "attached" });
  await page.getByTestId("performance-cue-bar").waitFor({ state: "attached" });
  await page.getByTestId("passage-cluster-ribbon").waitFor();
  await page.getByTestId("osmd-canvas-surface").locator("svg").first().waitFor();

  async function checkLayout(label, editorOpen = false) {
    const metrics = await page.evaluate(() => {
      const rect = (testId) => {
        const element = document.querySelector(`[data-testid="${testId}"]`);
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: element.clientHeight };
      };
      const score = document.querySelector('[data-testid="score-scroll-container"]');
      const box = score.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        score: rect("score-scroll-container"),
        pane: rect("top-score-pane"),
        transport: rect("transport-practice-bar"),
        piano: rect("bottom-piano-pane"),
        chunks: rect("motor-chunk-strip"),
        cues: rect("performance-cue-bar"),
        clusters: rect("passage-cluster-ribbon"),
        chunkCount: document.querySelectorAll('[data-testid^="motor-chunk-pill-"]').length,
        scoreHit: score.contains(hit),
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
      };
    });
    console.log(label, JSON.stringify(metrics));
    assert.ok(metrics.score.height >= 120, "Long score canvas must retain usable height");
    assert.ok(metrics.score.top >= metrics.pane.top, "Canvas must remain inside its pane");
    assert.ok(metrics.score.bottom <= metrics.transport.top, "Score must not overlap transport");
    assert.ok(metrics.pane.bottom <= metrics.transport.top, "Pane must not overlap transport");
    assert.ok(metrics.transport.bottom <= metrics.piano.top, "Transport must not overlap piano");
    assert.ok(metrics.piano.bottom <= metrics.viewportHeight + 1, "Piano must remain in viewport");
    assert.ok(metrics.clusters.height <= 56, "Passage Cluster list must not wrap into many rows");
    assert.ok(metrics.documentHeight <= metrics.viewportHeight, "Workspace must not overflow viewport");
    if (!editorOpen) assert.ok(metrics.scoreHit, "Score canvas must not be covered by another panel");
  }

  await checkLayout("default");
  if (process.env.SCREENSHOT_PREFIX) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_PREFIX}-score.png` });
  }
  const editorToggle = page.getByTestId("chunk-cue-editor-toggle");
  assert.equal(await editorToggle.getAttribute("aria-expanded"), "false");
  await editorToggle.click();
  await page.getByTestId("chunk-cue-editor-panel").waitFor();
  await checkLayout("editor open", true);
  if (process.env.SCREENSHOT_PREFIX) {
    await page.screenshot({ path: `${process.env.SCREENSHOT_PREFIX}-editor.png` });
  }
  const dialogMetrics = await page.getByTestId("chunk-cue-editor-scroll").evaluate((scroll) => {
    const dialog = scroll.closest("dialog");
    const box = dialog.getBoundingClientRect();
    return {
      top: box.top, bottom: box.bottom, height: box.height,
      scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
    };
  });
  assert.ok(dialogMetrics.height <= 722, "Editor dialog must respect 80dvh");
  assert.ok(dialogMetrics.top >= 0 && dialogMetrics.bottom <= 900, "Editor must fit viewport");
  assert.ok(dialogMetrics.scrollHeight > dialogMetrics.clientHeight, "Long editor must scroll internally");
  // Last controls remain reachable; edits do not close the dialog or consume score height.
  await page.locator('[data-testid^="chunk-barline-split-"]').last().click();
  await page.locator('[data-testid^="cue-edit-label-btn-"]').last().click();
  await page.locator('[data-testid^="cue-label-input-"]').fill("Layout regression cue");
  await page.locator('[data-testid^="cue-label-save-btn-"]').click();
  await checkLayout("after edits", true);
  await page.getByTestId("chunk-cue-editor-close").click();
  await page.getByTestId("chunk-cue-editor-panel").waitFor({ state: "hidden" });
  await editorToggle.click();
  await page.keyboard.press("Escape");
  await page.getByTestId("chunk-cue-editor-panel").waitFor({ state: "hidden" });
  assert.equal(await editorToggle.evaluate((button) => document.activeElement === button), true);
  await page.getByTestId("layout-horizontal-btn").click();
  await checkLayout("horizontal");
  await page.getByTestId("layout-page-btn").click();
  await checkLayout("page");
  assert.equal(
    await page.evaluate(() => window.onmessage === window.__layoutMessageHandler),
    true,
    "Worker imports must not overwrite the main-thread message handler",
  );
  await page.evaluate(() => window.postMessage({ type: "layout-smoke" }, window.location.origin));
  await page.waitForFunction(() => window.__layoutMessageCount === 1);
  assert.deepEqual(pageErrors, [], "No uncaught main-thread errors");
  console.log("Long score layout regression passed.");
  await context.close();
} finally {
  await browser.close();
}
