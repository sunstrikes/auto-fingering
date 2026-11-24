import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import JSZip from "jszip";

// Run against a locally served build (real rendering, Web MIDI decoding and IndexedDB).
const appUrl = new URL(process.env.STUDIO_URL || "https://localhost:5173/");
const launchOptions = process.env.CHROME_PATH
  ? { executablePath: process.env.CHROME_PATH }
  : { channel: "chrome" };
const browser = await chromium.launch(launchOptions);
const fixture = (name) => new URL(`../test-corpus/${name}`, import.meta.url);
const upload = (page) => page.locator('input[accept=".musicxml,.xml,.mxl"]');

async function openStudio(simulatedMidi = false) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1500, height: 1000 },
  });
  // Exercise the same static-only deployment as production. No dev library or remote sample loads.
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === appUrl.origin && !url.pathname.startsWith("/api/scores")
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const url = new URL(appUrl);
  if (simulatedMidi) url.searchParams.set("simMidi", "1");
  await page.goto(url.href);
  return { context, page };
}

async function checkWaitingMode() {
  const { context, page } = await openStudio(true);
  try {
    await upload(page).setInputFiles({
      name: "02-grand-staff-arpeggio-chord.musicxml",
      mimeType: "application/xml",
      buffer: await readFile(fixture("02-grand-staff-arpeggio-chord.musicxml")),
    });
    await page.getByTestId("practice-mode-rh-only").click();
    await page.getByTestId("waiting-mode-toggle-btn").click();
    const pitch = page.getByTestId("sim-midi-pitch");
    const strike = async (midi) => {
      await pitch.fill(String(midi));
      await page.getByTestId("sim-midi-strike").click();
    };
    function key(midi, state) {
      return page.locator(`[data-testid="piano-key-${midi}"][data-${state}-note="true"]`);
    }
    const start = () => page.getByTestId("audio-play-btn").click();
    const stop = () => page.getByTestId("audio-stop-btn").click();
    const hit = (midi) => key(midi, "hit").waitFor();
    const verifyWrongNote = async (keepHit) => {
      await pitch.fill("61");
      // Record the transient red state in the page; polling can miss an 85ms MIDI strike.
      await page.evaluate(() => {
        const wrong = document.querySelector('[data-testid="piano-key-61"]');
        const correct = document.querySelector('[data-testid="piano-key-60"]');
        if (!wrong || !correct) throw new Error("Missing piano keys");
        wrong.removeAttribute("data-browser-check-hit-retained");
        const observer = new MutationObserver(() => {
          if (wrong.getAttribute("data-wrong-note") !== "true") return;
          wrong.setAttribute("data-browser-check-hit-retained", String(correct.getAttribute("data-hit-note") === "true"));
          observer.disconnect();
        });
        observer.observe(wrong, { attributes: true, attributeFilter: ["data-wrong-note"] });
      });
      await page.getByTestId("sim-midi-strike").click();
      await page.locator(`[data-testid="piano-key-61"][data-browser-check-hit-retained="${keepHit}"]`).waitFor();
    };
    await start();
    await strike(60);
    await hit(60);
    await verifyWrongNote(true);
    await strike(64);
    await hit(64);
    await strike(67);
    await key(60, "hit").waitFor({ state: "detached" });
    await stop();

    await page.getByTestId("practice-settings-btn").click();
    await page.getByTestId("absolute-strictness-toggle").check();
    await page.getByTestId("practice-settings-close-btn").click();
    await page.getByTestId("transport-jump-start-btn").click();
    await start();
    await strike(60);
    await hit(60);
    await verifyWrongNote(false);
    await stop();
  } finally {
    await context.close();
  }
}

async function repairFixture() {
  const zip = await JSZip.loadAsync(await readFile(fixture("04-tie-cross-staff-compressed.mxl")));
  const xml = await zip.file("score.musicxml").async("string");
  // The original is playable. Add one wide chord note so the real panel offers a pitch repair.
  const revised = xml.replace("<!-- C5 tied", `<note><chord/><pitch><step>G</step><octave>3</octave></pitch>
      <duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>\n      <!-- C5 tied`);
  assert.notEqual(xml, revised);
  zip.file("score.musicxml", revised, { compression: "DEFLATE" });
  return {
    name: "04-tie-cross-staff-compressed.mxl",
    mimeType: "application/vnd.recordare.musicxml",
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
  };
}

async function pinBassNotes(page) {
  const heads = page.getByTestId("osmd-canvas-surface").locator(".vf-stavenote .vf-notehead");
  await heads.last().waitFor();
  for (const [offset, note, finger, count] of [[-1, "C3", 4, 1], [-2, "G2", 2, 2]]) {
    const head = heads.nth(offset);
    await head.scrollIntoViewIfNeeded();
    const box = await head.boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.match(await page.getByTestId("note-anchor-popover").innerText(), new RegExp(`第 2 小节 · ${note}`));
    await page.getByTestId(`finger-btn-${finger}`).click();
    await page.getByTestId("anchor-indicators").getByRole("button").nth(count - 1).waitFor();
    if (await page.getByTestId("popover-close-btn").isVisible()) {
      await page.getByTestId("popover-close-btn").click();
    }
  }
}

async function verifyBassAnchors(page) {
  const indicators = page.getByTestId("anchor-indicators");
  await indicators.getByRole("button", { name: /第2小节 C3.*: 4/ }).waitFor();
  await indicators.getByRole("button", { name: /第2小节 G2.*: 2/ }).waitFor();
  assert.equal(await indicators.getByRole("button").count(), 2);
}

async function verifyPracticePreferences(page) {
  await page.locator('[data-testid="speed-preset-0.75"][aria-pressed="true"]').waitFor();
  await page.locator('[data-testid="practice-mode-lh-only"][aria-pressed="true"]').waitFor();
  await page.getByTestId("ab-loop-toggle-btn").filter({ hasText: "循环中 1-2" }).waitFor();
}

async function applyPitchRepair(page) {
  await page.getByTestId("score-repair-toggle-btn").click();
  await page.getByRole("button", { name: /八度折叠/ }).click();
  await page.getByRole("button", { name: "同意替换" }).click();
  await page.getByTestId("score-repair-toggle-btn").waitFor({ state: "detached" });
}

async function readIdentity(page) {
  // Read only logical identity records; all writes happen through the browser UI.
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("auto-fingering-studio");
    // A check may race startup; leave schema creation exclusively to the app.
    request.onupgradeneeded = () => request.transaction.abort();
    request.onerror = () => request.error?.name === "AbortError" ? resolve(null) : reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      try {
        if (!db.objectStoreNames.contains("workspacePrefs")) return resolve(null);
        const transaction = db.transaction(["workspacePrefs", "pieceProfiles"]);
        const prefs = transaction.objectStore("workspacePrefs");
        const globalRequest = prefs.get("__global__");
        globalRequest.onsuccess = () => {
          const pieceId = globalRequest.result?.lastOpenedPieceId;
          if (!pieceId) return resolve(null);
          const prefsRequest = prefs.get(pieceId);
          const profileRequest = transaction.objectStore("pieceProfiles").get(pieceId);
          transaction.oncomplete = () => resolve({
            pieceId,
            fingerprint: prefsRequest.result?.scoreFingerprint,
            aliases: profileRequest.result?.fingerprints,
          });
        };
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => resolve(null);
        transaction.onabort = () => reject(transaction.error);
      } catch (error) {
        reject(error);
      } finally {
        db.close();
      }
    };
  }));
}

async function waitForIdentity(page, verify) {
  const deadline = Date.now() + 6000;
  do {
    const identity = await readIdentity(page);
    if (identity?.fingerprint && verify(identity)) return identity;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail("Could not observe the expected cached score identity");
}

async function downloadBackup(page, includeScores) {
  await page.getByTestId("practice-backup-include-scores").setChecked(includeScores);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("practice-backup-download").click(),
  ]);
  const buffer = await readFile(await download.path());
  return { name: download.suggestedFilename(), mimeType: "application/json", buffer };
}

async function checkPersistence() {
  const scoreFile = await repairFixture();
  const active = await openStudio();
  let original, repaired, fullBackup, metadataBackup;
  try {
    const { page } = active;
    assert.equal(await page.getByTestId("sim-midi-bar").count(), 0);
    await upload(page).setInputFiles(scoreFile);
    await pinBassNotes(page);
    await page.getByTestId("practice-mode-lh-only").click();
    await page.getByTestId("speed-preset-0.75").click();
    await page.getByTestId("ab-loop-toggle-btn").click();
    await page.getByTestId("measure-ruler-item-0").click();
    await page.getByTestId("measure-ruler-item-1").click();
    await verifyPracticePreferences(page);
    original = await waitForIdentity(page, ({ aliases }) => aliases.length === 1);
    await applyPitchRepair(page);
    await verifyBassAnchors(page);
    repaired = await waitForIdentity(page, ({ fingerprint }) => fingerprint !== original.fingerprint);
    assert.equal(repaired.pieceId, original.pieceId);
    assert.deepEqual(new Set(repaired.aliases), new Set([original.fingerprint, repaired.fingerprint]));

    await page.reload();
    await verifyBassAnchors(page);
    await verifyPracticePreferences(page);
    assert.deepEqual(await readIdentity(page), repaired);
    await page.getByTestId("undo-btn").click();
    await waitForIdentity(page, ({ fingerprint }) => fingerprint === original.fingerprint);
    await verifyBassAnchors(page);
    await page.getByTestId("redo-btn").click();
    await waitForIdentity(page, ({ fingerprint }) => fingerprint === repaired.fingerprint);
    await verifyBassAnchors(page);

    await page.getByTestId("practice-backup-open").click();
    assert.ok(await page.getByTestId("practice-backup-include-scores").isChecked());
    await page.getByTestId("practice-backup-full-size").waitFor();
    await page.getByTestId("practice-backup-data-size").waitFor();
    fullBackup = await downloadBackup(page, true);
    metadataBackup = await downloadBackup(page, false);
    assert.ok(fullBackup.buffer.length > metadataBackup.buffer.length);
  } finally {
    await active.context.close();
  }

  // Each browser context has a fresh IndexedDB, as after clearing site data.
  for (const [backup, containsScore] of [[fullBackup, true], [metadataBackup, false]]) {
    const { page, context } = await openStudio();
    try {
      await page.getByTestId("practice-backup-open").click();
      await page.getByTestId("practice-backup-import").setInputFiles(backup);
      if (!containsScore) {
        // Wait for the import to commit before uploading; it may not set a last-opened cache key.
        await page.waitForFunction(async (pieceId) => {
          const db = await new Promise((resolve, reject) => {
            const open = indexedDB.open("auto-fingering-studio");
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
          });
          try {
            return await new Promise((resolve, reject) => {
              const profile = db.transaction("pieceProfiles").objectStore("pieceProfiles").get(pieceId);
              profile.onsuccess = () => resolve(Boolean(profile.result));
              profile.onerror = () => reject(profile.error);
            });
          } finally {
            db.close();
          }
        }, original.pieceId);
        assert.equal(await page.getByTestId("anchor-indicators").count(), 0);
        // Metadata-only backup attaches when the original fingerprint (an alias) is re-opened.
        await upload(page).setInputFiles(scoreFile);
      }
      await verifyBassAnchors(page);
      await verifyPracticePreferences(page);
      const restored = await waitForIdentity(page, ({ fingerprint }) =>
        fingerprint === (containsScore ? repaired.fingerprint : original.fingerprint));
      assert.equal(restored.pieceId, original.pieceId);
      assert.deepEqual(new Set(restored.aliases), new Set(repaired.aliases));
    } finally {
      await context.close();
    }
  }
}

try {
  await checkWaitingMode();
  console.log("✓ Web MIDI: cumulative chord hits and opt-in strict reset");
  await checkPersistence();
  console.log("✓ IndexedDB: coordinate anchors, cache resume, repair undo/redo and both backup modes");
} finally {
  await browser.close();
}
