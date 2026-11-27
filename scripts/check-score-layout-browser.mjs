import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const appUrl = new URL(process.env.STUDIO_URL || "https://localhost:5173/");
const browser = await chromium.launch(
  process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: "chrome" },
);

// Many repeated passages and retrieval landmarks on a 2-staff piano grand staff.
function longScoreXml() {
  const measures = Array.from({ length: 168 }, (_, index) => `
    <measure number="${index + 1}">
      ${
        index === 0
          ? `<attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><direction><sound tempo="120"/></direction>`
          : ""
      }
      ${
        index % 4 === 0
          ? `<direction><direction-type><rehearsal>Section ${index / 4 + 1}</rehearsal></direction-type></direction>`
          : ""
      }
      ${["C", "D", "E", "G", "F", "E", "D", "C"]
        .map(
          (step, noteIndex) => `
        <note><pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type><staff>1</staff>
        ${noteIndex === 7 && index % 4 === 3 ? "<notations><fermata/></notations>" : ""}
        </note>`,
        )
        .join("")}
      <backup><duration>8</duration></backup>
      ${["C", "G", "E", "G"]
        .map(
          (step) => `
        <note><pitch><step>${step}</step><octave>3</octave></pitch><duration>2</duration><type>quarter</type><staff>2</staff></note>`,
        )
        .join("")}
    </measure>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
    <score-partwise version="4.0"><work><work-title>Long score layout regression</work-title></work>
    <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
    <part id="P1">${measures}</part></score-partwise>`;
}

const VIEWPORTS = [
  { name: "27in-2560x1320", width: 2560, height: 1320, minScoreH: 720, screenshot: "27in" },
  { name: "27in-1920x950", width: 1920, height: 950, minScoreH: 420, screenshot: "1920" },
  { name: "desktop-1440x900", width: 1440, height: 900, minScoreH: 400 },
  { name: "ipad10-land-1080x740", width: 1080, height: 740, minScoreH: 260, screenshot: "ipad10-land" },
  { name: "ipad10-land-1024x680", width: 1024, height: 680, minScoreH: 260, screenshot: "ipad10-land-compact" },
  { name: "ipad10-port-810x980", width: 810, height: 980, minScoreH: 440, screenshot: "ipad10-port" },
  { name: "ipad10-port-768x940", width: 768, height: 940, minScoreH: 440 },
];

try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1920, height: 950 },
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
  await page.getByTestId("passage-cluster-toggle").waitFor();
  await page.getByTestId("osmd-canvas-surface").locator("svg").first().waitFor();

  async function collectMetrics() {
    return page.evaluate(() => {
      const rect = (testId) => {
        const element = document.querySelector(`[data-testid="${testId}"]`);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: element.clientHeight };
      };
      const score = document.querySelector('[data-testid="score-scroll-container"]');
      const box = score.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const header = document.querySelector("header");
      const headerInner = header?.firstElementChild;
      const viewerHeader = document.querySelector('[data-testid="score-viewer-header"]');
      const titleEl = Array.from(viewerHeader?.querySelectorAll("span") ?? []).find(
        (el) => el.textContent?.trim() === "乐谱画布",
      );
      const toggleEl = document.querySelector('[data-testid="chunk-cue-editor-toggle"]');
      const titleBox = titleEl?.getBoundingClientRect();
      const toggleBox = toggleEl?.getBoundingClientRect();
      const pianoSvg = document.querySelector('[data-testid="unified-piano-88"] svg');
      const pianoScroller = pianoSvg?.parentElement;
      const measureEls = Array.from(document.querySelectorAll('[data-testid="osmd-canvas-surface"] .vf-measure'));
      let firstGrandStaffH = null;
      if (measureEls.length > 0) {
        const m0Box = measureEls[0].getBoundingClientRect();
        const m0Col = measureEls
          .filter((el) => Math.abs(el.getBoundingClientRect().left - m0Box.left) < 30)
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
          .slice(0, 2);
        if (m0Col.length > 0) {
          const minT = Math.min(...m0Col.map((el) => el.getBoundingClientRect().top));
          const maxB = Math.max(...m0Col.map((el) => el.getBoundingClientRect().bottom));
          firstGrandStaffH = Math.round(maxB - minT);
        }
      }
      return {
        score: rect("score-scroll-container"),
        pane: rect("top-score-pane"),
        transport: rect("transport-practice-bar"),
        piano: rect("bottom-piano-pane"),
        chunks: rect("motor-chunk-strip"),
        cues: rect("performance-cue-bar"),
        clusters: rect("passage-cluster-ribbon"),
        clusterRibbonCount: document.querySelectorAll('[data-testid="passage-cluster-ribbon"]').length,
        headerHeight: header ? Math.round(header.getBoundingClientRect().height) : 0,
        headerOverflowX: headerInner ? Math.round(headerInner.scrollWidth - headerInner.clientWidth) : 0,
        viewerHeaderHeight: viewerHeader ? Math.round(viewerHeader.getBoundingClientRect().height) : 0,
        titleTop: titleBox ? Math.round(titleBox.top) : null,
        toggleTop: toggleBox ? Math.round(toggleBox.top) : null,
        pianoScrollOverflowX: pianoScroller ? Math.round(pianoScroller.scrollWidth - pianoScroller.clientWidth) : 0,
        firstGrandStaffH,
        scoreHit: score.contains(hit),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
      };
    });
  }

  async function checkLayout(label, { editorOpen = false, minScoreH = 120, expectHorizontalFit = false } = {}) {
    const metrics = await collectMetrics();
    console.log(label, JSON.stringify(metrics));
    assert.ok(metrics.score.height >= minScoreH, `${label}: score height ${metrics.score.height} < ${minScoreH}`);
    assert.ok(metrics.score.top >= metrics.pane.top - 1, `${label}: canvas top outside pane`);
    assert.ok(metrics.score.bottom <= metrics.transport.top + 1, `${label}: score overlaps transport`);
    assert.ok(metrics.pane.bottom <= metrics.transport.top + 1, `${label}: pane overlaps transport`);
    assert.ok(metrics.transport.bottom <= metrics.piano.top + 1, `${label}: transport overlaps piano`);
    assert.ok(metrics.piano.bottom <= metrics.viewportHeight + 1, `${label}: piano overflows viewport`);
    assert.equal(metrics.headerOverflowX, 0, `${label}: header horizontal overflow`);
    assert.ok(metrics.pianoScrollOverflowX <= 1, `${label}: piano horizontal overflow ${metrics.pianoScrollOverflowX}`);
    assert.ok(metrics.titleTop !== null && metrics.toggleTop !== null, `${label}: header title and chunk toggle present`);
    assert.ok(
      Math.abs(metrics.toggleTop - metrics.titleTop) <= 8,
      `${label}: chunk toggle (${metrics.toggleTop}) not aligned with 乐谱画布 (${metrics.titleTop})`,
    );
    assert.ok(metrics.documentHeight <= metrics.viewportHeight, `${label}: workspace overflows viewport`);
    if (expectHorizontalFit && metrics.firstGrandStaffH !== null) {
      assert.ok(
        metrics.firstGrandStaffH <= metrics.score.height,
        `${label}: grand staff height (${metrics.firstGrandStaffH}) exceeds visible score height (${metrics.score.height})`,
      );
    }
    if (!editorOpen) assert.ok(metrics.scoreHit, `${label}: score canvas covered by another panel`);
    return metrics;
  }

  // Cluster ribbon must be collapsed by default and expand/collapse cleanly on toggle.
  assert.equal(await page.getByTestId("passage-cluster-ribbon").count(), 0, "Passage Cluster ribbon collapsed by default");
  await page.getByTestId("passage-cluster-toggle").click();
  await page.getByTestId("passage-cluster-ribbon").waitFor();
  const expandedClusterMetrics = await collectMetrics();
  assert.ok(expandedClusterMetrics.clusters.height <= 56, "Passage Cluster list must not wrap into many rows");
  await page.getByTestId("passage-cluster-toggle").click();
  await page.getByTestId("passage-cluster-ribbon").waitFor({ state: "hidden" });

  // Verify editor dialog behavior and internal scroll at 1440x900
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(250);
  await checkLayout("desktop-1440x900-page", { minScoreH: 400 });
  const editorToggle = page.getByTestId("chunk-cue-editor-toggle");
  assert.equal(await editorToggle.getAttribute("aria-expanded"), "false");
  await editorToggle.click();
  await page.getByTestId("chunk-cue-editor-panel").waitFor();
  await checkLayout("editor open", { editorOpen: true, minScoreH: 400 });
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
  await page.locator('[data-testid^="chunk-barline-split-"]').last().click();
  await page.locator('[data-testid^="cue-edit-label-btn-"]').last().click();
  await page.locator('[data-testid^="cue-label-input-"]').fill("Layout regression cue");
  await page.locator('[data-testid^="cue-label-save-btn-"]').click();
  await checkLayout("after edits", { editorOpen: true, minScoreH: 400 });
  await page.getByTestId("chunk-cue-editor-close").click();
  await page.getByTestId("chunk-cue-editor-panel").waitFor({ state: "hidden" });
  await editorToggle.click();
  await page.keyboard.press("Escape");
  await page.getByTestId("chunk-cue-editor-panel").waitFor({ state: "hidden" });
  assert.equal(await editorToggle.evaluate((button) => document.activeElement === button), true);

  // Check all target viewports in horizontal mode (full single-row grand staff visibility)
  await page.getByTestId("layout-horizontal-btn").click();
  await page.waitForFunction(() => {
    const viewer = document.querySelector('[data-testid="score-viewer"]');
    const svg = document.querySelector('[data-testid="osmd-canvas-surface"] svg');
    const scroller = document.querySelector('[data-testid="score-scroll-container"]');
    return (
      viewer?.getAttribute("data-layout-mode") === "horizontal" &&
      svg &&
      scroller &&
      svg.getBoundingClientRect().width > scroller.clientWidth + 200
    );
  }, { timeout: 30000 });
  await page.waitForTimeout(300);

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(250);
    await checkLayout(`${vp.name}-horizontal`, {
      minScoreH: vp.minScoreH,
      expectHorizontalFit: true,
    });
    if (process.env.SCREENSHOT_PREFIX && vp.screenshot) {
      await page.screenshot({ path: `${process.env.SCREENSHOT_PREFIX}-${vp.screenshot}-horiz.png` });
    }
  }

  // Check key viewports in multi-line page mode as well
  await page.getByTestId("layout-page-btn").click();
  await page.waitForTimeout(400);
  for (const vp of VIEWPORTS.filter((v) => v.screenshot)) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(250);
    await checkLayout(`${vp.name}-page`, { minScoreH: vp.minScoreH });
    if (process.env.SCREENSHOT_PREFIX && vp.screenshot) {
      await page.screenshot({ path: `${process.env.SCREENSHOT_PREFIX}-${vp.screenshot}-page.png` });
    }
  }

  assert.equal(
    await page.evaluate(() => window.onmessage === window.__layoutMessageHandler),
    true,
    "Worker imports must not overwrite the main-thread message handler",
  );
  await page.evaluate(() => window.postMessage({ type: "layout-smoke" }, window.location.origin));
  await page.waitForFunction(() => window.__layoutMessageCount === 1);
  assert.deepEqual(pageErrors, [], "No uncaught main-thread errors");
  console.log("Long score layout regression passed across all desktop and 10.1-inch iPad viewports.");
  await context.close();
} finally {
  await browser.close();
}
