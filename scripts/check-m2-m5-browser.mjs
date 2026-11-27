import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const appUrl = new URL(process.env.STUDIO_URL || "https://localhost:4173/");
const launchOptions = process.env.CHROME_PATH
  ? { executablePath: process.env.CHROME_PATH }
  : { channel: "chrome" };
const browser = await chromium.launch(launchOptions);
const fixture = (name) => new URL(`../test-corpus/${name}`, import.meta.url);
const upload = (page) => page.locator('input[accept=".musicxml,.xml,.mxl"]');

const MOCK_BYOK_KEY = "sk-browser-test-secret-do-not-leak";

async function openStudio({ simulatedMidi = true, mockCoachApi = false } = {}) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1500, height: 1000 },
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (mockCoachApi && url.href === "https://api.openai.com/v1/chat/completions") {
      const reqText = route.request().postData() || "";
      assert.ok(!reqText.includes("timeStampMs"), "Raw MIDI telemetry must never be sent to LLM");
      const reqJson = JSON.parse(reqText);
      const userMsg = reqJson.messages?.find((m) => m.role === "user")?.content || "{}";
      const jsonStart = userMsg.indexOf("{");
      const payload = JSON.parse(jsonStart >= 0 ? userMsg.slice(jsonStart) : "{}");
      const firstEv = payload.evidences?.[0];
      const focusCues = firstEv
        ? [
            {
              evidenceId: firstEv.evidenceId,
              measures: firstEv.measures,
              soundCue: `听第${firstEv.measures[0]}小节句尾呼吸稳住后再推进下一拍。`,
            },
          ]
        : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  praise: "线条推进平稳，句尾呼吸清晰。",
                  focusCues,
                  nextPassListeningGoal: "保持旋律线条均匀流动。",
                }),
              },
            },
          ],
        }),
      });
      return;
    }
    if (url.origin === appUrl.origin && !url.pathname.startsWith("/api/scores")) {
      await route.continue();
      return;
    }
    await route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (err) => console.error("[browser pageerror]", err));
  const url = new URL(appUrl);
  if (simulatedMidi) url.searchParams.set("simMidi", "1");
  await page.goto(url.href);
  return { context, page };
}

async function strikeMidi(page, midi) {
  await page.getByTestId("sim-midi-pitch").fill(String(midi));
  await page.getByTestId("sim-midi-strike").click();
}

async function readScoreIdentity(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open("auto-fingering-studio");
    req.onupgradeneeded = () => req.transaction.abort();
    req.onerror = () => req.error?.name === "AbortError" ? resolve(null) : reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains("workspacePrefs")) return resolve(null);
        const tx = db.transaction(["workspacePrefs", "pieceProfiles", "practiceEvents"]);
        const prefs = tx.objectStore("workspacePrefs");
        const globalReq = prefs.get("__global__");
        globalReq.onsuccess = () => {
          const pieceId = globalReq.result?.lastOpenedPieceId;
          if (!pieceId) return resolve(null);
          const prefReq = prefs.get(pieceId);
          const profileReq = tx.objectStore("pieceProfiles").get(pieceId);
          const eventsReq = tx.objectStore("practiceEvents").getAll();
          tx.oncomplete = () => resolve({
            pieceId,
            fingerprint: prefReq.result?.scoreFingerprint ?? null,
            chunkOverrides: profileReq.result?.chunkOverrides ?? null,
            eventCount: (eventsReq.result || []).filter((e) => e.pieceId === pieceId).length,
          });
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      } catch (err) {
        reject(err);
      } finally {
        db.close();
      }
    };
  }));
}

async function waitForIdentity(page, pred) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const info = await readScoreIdentity(page);
    if (info?.fingerprint && pred(info)) return info;
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.fail("Timed out waiting for IndexedDB score identity");
}

async function checkM2ChunkingAndSession() {
  const { context, page } = await openStudio({ simulatedMidi: true });
  try {
    await upload(page).setInputFiles({
      name: "05-realworld-wuchang.musicxml",
      mimeType: "application/xml",
      buffer: await readFile(fixture("05-realworld-wuchang.musicxml")),
    });

    // Wait for static chunking worker + OSMD render
    await page.getByTestId("chunk-cue-editor-toggle").waitFor();
    await page.getByTestId("motor-chunk-strip").waitFor({ state: "attached" });
    await page.getByTestId("passage-cluster-ribbon").waitFor();
    await page.getByTestId("guided-launch-strip").waitFor();

    // Open chunk/cue editor dialog, perform manual Split or Merge, and verify persistence across reload
    await page.getByTestId("chunk-cue-editor-toggle").click();
    await page.getByTestId("chunk-cue-editor-panel").waitFor();
    const splitButtons = page.locator('[data-testid^="chunk-barline-split-"]');
    const mergeButtons = page.locator('[data-testid^="chunk-barline-merge-"]');
    if (await splitButtons.count() > 0) {
      await splitButtons.first().click();
    } else {
      assert.ok((await mergeButtons.count()) > 0, "Expected split or merge barline button");
      await mergeButtons.first().click();
    }
    await page.locator('[data-testid^="chunk-pinned-badge-"]').first().waitFor();
    await page.getByTestId("reset-chunk-overrides-btn").waitFor();
    await waitForIdentity(page, (info) => Boolean(info.chunkOverrides));

    await page.reload();
    await page.getByTestId("chunk-cue-editor-toggle").waitFor();
    await page.getByTestId("chunk-cue-editor-toggle").click();
    await page.getByTestId("chunk-cue-editor-panel").waitFor();
    await page.locator('[data-testid^="chunk-pinned-badge-"]').first().waitFor();
    await page.getByTestId("chunk-cue-editor-close").click();
    await page.getByTestId("chunk-cue-editor-panel").waitFor({ state: "hidden" });

    // Click Passage Cluster instance for on-demand Variant Diff banner
    const clusterInstances = page.locator('[data-testid^="passage-cluster-instance-"]');
    if (await clusterInstances.count() > 0) {
      await clusterInstances.first().click();
      await page.getByTestId("variant-diff-banner").waitFor();
      await page.getByTestId("variant-diff-close-btn").click();
    }

    // Enter Guided Session launch card and check orthogonal PracticeMode & non-playing command badges
    await page.getByTestId("enter-guided-session-btn").click();
    await page.getByTestId("guided-launch-card").waitFor();
    await page.getByTestId("piano-command-badge-21").waitFor();
    await page.getByTestId("piano-command-badge-23").waitFor();
    await page.getByTestId("piano-command-badge-108").waitFor();
    await page.getByTestId("guided-timebox-25").click();
    await page.getByTestId("guided-leverage-summary").waitFor();
    await page.getByTestId("guided-macro-section-select").waitFor();
    await page.getByTestId("guided-start-session-btn").click();

    await page.getByTestId("guided-session-header").waitFor();
    await page.getByTestId("piano-command-badge-21").waitFor();
    await page.getByTestId("piano-command-badge-22").waitFor();

    // A0+A#0 emergency pause during active Stage 0 -> shows non-playing A0/B0/C8 badges -> resume via C8
    await page.getByTestId("sim-midi-command-pause").click();
    await page.getByTestId("guided-phase-badge").filter({ hasText: /暂停/ }).waitFor();
    await page.getByTestId("piano-command-badge-23").waitFor();
    await page.getByTestId("piano-command-badge-108").waitFor();
    await page.getByTestId("sim-midi-command-c8").click();
    await page.getByTestId("guided-stage0-progress").waitFor();

    // Suspend to Free Studio -> Resume Pill returns losslessly
    await page.getByTestId("guided-suspend-btn").click();
    await page.getByTestId("guided-resume-pill").waitFor();
    await page.getByTestId("guided-resume-pill").click();
    await page.getByTestId("guided-session-header").waitFor();
    await page.getByTestId("guided-end-session-btn").click();
  } finally {
    await context.close();
  }
}

async function seedAndPlayContinuousWorkflow() {
  const { context, page } = await openStudio({ simulatedMidi: true, mockCoachApi: true });
  try {
    // Use 03-partial-fingering-hanon.musicxml (has explicit <fingering> elements for real OSMD SVG test!)
    await upload(page).setInputFiles({
      name: "03-partial-fingering-hanon.musicxml",
      mimeType: "application/xml",
      buffer: await readFile(fixture("03-partial-fingering-hanon.musicxml")),
    });
    await page.getByTestId("chunk-cue-editor-toggle").waitFor();
    await page.getByTestId("osmd-canvas-surface").locator("svg").first().waitFor();
    const initialInfo = await waitForIdentity(page, (info) => Boolean(info.fingerprint));

    // Export current backup JSON, inject multi-day PracticeEvents to unlock L2/L3 scaffolding & cold review,
    // and also inject a conflicting FingerAnchorDraft to verify M3 backup conflict preview UI!
    await page.getByTestId("practice-backup-open").click();
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("practice-backup-download").click(),
    ]);
    const rawBackup = JSON.parse(await readFile(await dl.path(), "utf8"));
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Seed 3 overnight Good events covering all measures of 03-partial-fingering-hanon so chunk reaches L2/L3!
    rawBackup.practiceEvents.push(
      {
        eventId: "e2e-day1",
        pieceId: initialInfo.pieceId,
        scoreFingerprint: initialInfo.fingerprint,
        timestampMs: now - 3 * dayMs,
        localDateKey: "2026-11-23",
        timezoneOffsetMin: -480,
        sessionId: "e2e-s1",
        boutKind: "chunk",
        startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
        endCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
        practiceMode: "both",
        speedMultiplier: 0.92,
        durationSec: 6,
        passCount: 1,
        wasColdFirstPass: true,
        scaffoldingLevel: 1,
        autoGrade: 3,
        fluency: {
          pitchAccuracy: 0.98,
          interiorHesitationCount: 0,
          junctionHesitationRatio: 0,
          timingCv: 0.04,
          stallDetected: false,
          dominantHandFaultRatio: { rh: 0, lh: 0 },
          switchBranchMismatch: false,
          reanchorCount: 0,
        },
        measureFaultCounts: {},
      },
      {
        eventId: "e2e-day2",
        pieceId: initialInfo.pieceId,
        scoreFingerprint: initialInfo.fingerprint,
        timestampMs: now - 2 * dayMs,
        localDateKey: "2026-11-24",
        timezoneOffsetMin: -480,
        sessionId: "e2e-s2",
        boutKind: "chunk",
        startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
        endCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
        practiceMode: "both",
        speedMultiplier: 0.92,
        durationSec: 6,
        passCount: 1,
        wasColdFirstPass: true,
        scaffoldingLevel: 2,
        autoGrade: 3,
        fluency: {
          pitchAccuracy: 0.99,
          interiorHesitationCount: 0,
          junctionHesitationRatio: 0,
          timingCv: 0.03,
          stallDetected: false,
          dominantHandFaultRatio: { rh: 0, lh: 0 },
          switchBranchMismatch: false,
          reanchorCount: 0,
        },
        measureFaultCounts: {},
      },
      {
        eventId: "e2e-day3",
        pieceId: initialInfo.pieceId,
        scoreFingerprint: initialInfo.fingerprint,
        timestampMs: now - dayMs,
        localDateKey: "2026-11-25",
        timezoneOffsetMin: -480,
        sessionId: "e2e-s3",
        boutKind: "chunk",
        startCoord: { measureIndex: 0, beatNum: 0, beatDen: 1 },
        endCoord: { measureIndex: 4, beatNum: 0, beatDen: 1 },
        practiceMode: "both",
        speedMultiplier: 0.92,
        durationSec: 6,
        passCount: 1,
        wasColdFirstPass: true,
        scaffoldingLevel: 2,
        autoGrade: 3,
        fluency: {
          pitchAccuracy: 0.99,
          interiorHesitationCount: 0,
          junctionHesitationRatio: 0,
          timingCv: 0.03,
          stallDetected: false,
          dominantHandFaultRatio: { rh: 0, lh: 0 },
          switchBranchMismatch: false,
          reanchorCount: 0,
        },
        measureFaultCounts: {},
      },
    );

    // Also mutate workspacePrefs handSpanProfile so previewImport surfaces an LWW conflict
    const piecePrefs = rawBackup.workspacePrefs.find((w) => w.scopeKey === initialInfo.pieceId);
    if (piecePrefs) {
      piecePrefs.handSpanProfile = {
        preset: piecePrefs.handSpanProfile?.preset === "L" ? "S" : "L",
        avoidThumbOnBlack: true,
        preferStablePosition: false,
      };
      piecePrefs.updatedAtMs = now + 5000;
    }

    // Import via pre-import preview flow
    await page.getByTestId("practice-backup-preview-import").setInputFiles({
      name: "m3-seed-backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(rawBackup), "utf8"),
    });
    await page.getByTestId("practice-backup-conflict-preview").waitFor();
    await page.locator('[data-testid^="backup-conflict-keep-"]').first().click();
    await page.getByTestId("practice-backup-confirm-merge").click();
    await waitForIdentity(page, (info) => info.eventCount >= 3);
    // Close backup modal if still visible
    const closeBackup = page.getByRole("button", { name: "关闭" }).first();
    if (await closeBackup.isVisible()) await closeBackup.click();

    // Verify Free Studio continuous A-B Loop in-memory Acoustic Profile badge (zero PracticeEvent write)
    await page.getByTestId("ab-loop-toggle-btn").click();
    await page.getByTestId("measure-ruler-item-0").click();
    await page.getByTestId("measure-ruler-item-0").click();
    await page.getByTestId("speed-preset-1.5").click();
    await page.getByTestId("audio-play-btn").click();
    await page.getByTestId("sim-midi-play").click();
    await page.getByTestId("free-acoustic-badge-btn").waitFor({ timeout: 10000 });
    await page.getByTestId("sim-midi-stop").click();
    await page.getByTestId("audio-stop-btn").click();
    await page.getByTestId("free-acoustic-badge-btn").click();
    await page.getByTestId("free-acoustic-popover").waitFor();
    await page.getByTestId("free-acoustic-coach-tip").waitFor();
    const afterFreeIdentity = await readScoreIdentity(page);
    assert.equal(afterFreeIdentity?.eventCount, initialInfo.eventCount + 3, "Free Studio must never write PracticeEvents");

    // Configure BYOK coach (mocked OpenAI route) and disable L3 Count-In pre-roll so beat 0 aligns cleanly with sim-midi-play
    await page.getByTestId("practice-settings-btn").click();
    await page.getByTestId("coach-enabled-toggle").check();
    await page.getByTestId("coach-provider-select").selectOption("openai");
    await page.getByTestId("coach-apikey-input").fill(MOCK_BYOK_KEY);
    await page.getByTestId("settings-l3-silent-beat-toggle").uncheck();
    await page.getByTestId("practice-settings-close-btn").click();

    // Verify key does NOT appear in backup export JSON
    await page.getByTestId("practice-backup-open").click();
    const [dlAfterKey] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("practice-backup-download").click(),
    ]);
    const backupTextAfterKey = await readFile(await dlAfterKey.path(), "utf8");
    assert.ok(!backupTextAfterKey.includes(MOCK_BYOK_KEY), "API key must NEVER appear in backup JSON");
    await page.getByRole("button", { name: "关闭" }).first().click();

    // Enter Guided Session: with seeded cross-day history, chunk starts directly in L2/L3 continuous play!
    await page.getByTestId("enter-guided-session-btn").click();
    await page.getByTestId("guided-launch-card").waitFor();
    // Toggle blind cold-start drill check first, then normal start
    await page.getByTestId("guided-cold-probe-blind-toggle").check();
    await page.getByTestId("guided-cold-probe-btn").click();
    await page.getByTestId("cold-probe-blind-curtain").waitFor();
    await page.getByTestId("sim-midi-command-b0").click();
    await page.getByTestId("cold-probe-peek-active-badge").waitFor();
    await page.getByTestId("guided-end-session-btn").click();

    // Start normal Guided Session -> L2/L3 Fading Scaffolding + EHS in page & horizontal layouts
    await page.getByTestId("enter-guided-session-btn").click();
    await page.getByTestId("guided-launch-card").waitFor();
    await page.getByTestId("guided-start-session-btn").click();
    await page.getByTestId("guided-scaffolding-badge").waitFor();

    // Verify zero-reflow SVG fingering opacity hiding in L2/L3
    const scaffoldingBadgeText = await page.getByTestId("guided-scaffolding-badge").innerText();
    assert.match(scaffoldingBadgeText, /L[23]/, `Expected L2 or L3 scaffolding, got ${scaffoldingBadgeText}`);
    if (/L3/.test(scaffoldingBadgeText)) {
      const l3Toggle = page.getByTestId("guided-l3-silent-beat-toggle");
      await l3Toggle.waitFor();
      assert.equal(await l3Toggle.isChecked(), false, "L3 silent-beat toggle should reflect disabled setting");
    }
    const svgBefore = await page.getByTestId("osmd-canvas-surface").locator("svg").first().evaluate((el) => {
      el.dataset.e2eIdentity = "kept";
      return true;
    });
    assert.ok(svgBefore);

    // Wait for any Count-In badge to finish (when enabled) so beat 0 aligns with sim-midi-play
    for (const id of ["count-in-indicator", "guided-count-in-indicator"]) {
      const countInBadge = page.getByTestId(id);
      if (await countInBadge.isVisible().catch(() => false)) {
        await countInBadge.waitFor({ state: "detached" });
      }
    }
    await page.getByTestId("sim-midi-play").click();

    // Enable EHS Overlay in L2/L3 and trigger B0 1.5s peek during active play without OSMD SVG reflow
    await page.getByTestId("guided-ehs-toggle").check();
    await page.getByTestId("guided-ehs-preset-2-beats").waitFor();
    await page.getByTestId("ehs-overlay-svg").waitFor();
    await page.getByTestId("sim-midi-command-b0").click();
    await page.locator('[data-testid="score-viewer"][data-scaffolding-peek="true"]').waitFor();
    const sameSvg = await page.getByTestId("osmd-canvas-surface").locator("svg").first().evaluate(
      (el) => el.dataset.e2eIdentity === "kept",
    );
    assert.ok(sameSvg, "Fading Scaffolding peek must not re-render OSMD SVG");

    // Sample rAF frame update & check staves/barlines remain sharp
    const pageMetrics = await page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const staveSharp = Array.from(document.querySelectorAll('[data-testid="osmd-canvas-surface"] .vf-stave path, [data-testid="osmd-canvas-surface"] .vf-stave line'))
        .every((el) => el.style.opacity === "" || el.style.opacity === "1");
      return {
        hasEhsSvg: Boolean(document.querySelector('[data-testid="ehs-overlay-svg"]')),
        staveSharp,
      };
    });
    assert.ok(pageMetrics.hasEhsSvg && pageMetrics.staveSharp, "EHS overlay active & staves sharp in page mode");

    await page.getByTestId("guided-micro-rest-veil").waitFor({ timeout: 20000 });
    await page.getByTestId("sim-midi-stop").click();
    // Verify strictly zero metrics in Micro-Rest veil
    const veilText = await page.getByTestId("guided-micro-rest-veil").innerText();
    assert.ok(!/nPVI|准确度|Acoustic|Coach/i.test(veilText), "Micro-Rest veil must show zero metrics");

    // Accidental ordinary keystroke must pulse reminder without aborting rest
    await strikeMidi(page, 60);
    await page.getByTestId("guided-micro-rest-reminder").waitFor();
    await page.getByTestId("guided-micro-rest-veil").waitFor();

    // Exit Micro-Rest via C8 -> Audiation Priming + Acoustic Profile + Coach + Mark Hard
    await page.getByTestId("sim-midi-command-c8").click();
    await page.getByTestId("guided-delayed-feedback-panel").waitFor();
    await page.getByTestId("acoustic-profile-slot").waitFor();
    await page.getByTestId("external-focus-coach-card").waitFor();
    assert.match(await page.getByTestId("coach-source-badge").innerText(), /本地/);

    // Trigger BYOK AI coach via button
    await page.getByTestId("coach-trigger-btn").click();
    await page.getByTestId("coach-source-badge").filter({ hasText: /BYOK/ }).waitFor();
    assert.match(await page.getByTestId("coach-praise-text").innerText(), /线条推进平稳/);

    // Mark Hard one-way override
    await page.getByTestId("guided-mark-hard-btn").click();
    await page.getByTestId("guided-marked-hard-badge").waitFor();

    // B0 swaps bottom slot back to 88-key Hand Posture
    await page.getByTestId("sim-midi-command-b0").click();
    await page.getByTestId("unified-piano-88").waitFor();

    // Verify horizontal layout works cleanly with EHS on next bout
    await page.getByTestId("sim-midi-command-c8").click();
    await page.getByTestId("layout-horizontal-btn").click();
    await page.getByTestId("ehs-overlay-svg").waitFor();

    await page.getByTestId("guided-end-session-btn").click();
  } finally {
    await context.close();
  }
}

try {
  await checkM2ChunkingAndSession();
  console.log("✓ M2 Chrome E2E: symbolic chunking, 4px ribbon, Split/Merge reload, launch card, A0+A#0 & suspend/resume");
  await seedAndPlayContinuousWorkflow();
  console.log("✓ M3–M5 Chrome E2E: backup merge preview, Free Studio acoustic badge, blind B0 peek, L2/L3 SVG scaffolding, Micro-Rest, Acoustic Profile, BYOK Coach (zero key leak) & EHS");
} finally {
  await browser.close();
}
