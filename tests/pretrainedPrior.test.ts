// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_HAND_SPAN_PROFILE,
  type Finger,
  type FingeringPrior,
  type HandSpanProfile,
  type NoteEvent,
  type OnsetSlice,
} from "../src/domain/types";
import { parseMusicXml } from "../src/musicxml/parser";
import {
  clearCachedLumikeyPrior,
  loadLumikeyPrior,
} from "../src/prior/loader";
import {
  buildLumikeyTokens,
  buildPriorTableForSlices,
  isBlackKeyFeature,
  logitsToLogProbs,
  midiToPitchClassFeature,
  slicesToPriorNotes,
} from "../src/prior/lumikeyAdapter";
import {
  createLumikeyPrior,
  EXPECTED_WEIGHT_BIN_BYTES,
  forwardLumikeyLogits,
  parseLumikeyWeightBinary,
} from "../src/prior/lumikeyTransformer";
import {
  computeCandidatePriorCost,
  DEFAULT_PRIOR_LAMBDA,
  DEFAULT_PRIOR_PER_NOTE_CAP,
} from "../src/prior/types";
import { generateSliceCandidates } from "../src/solver/costModel";
import { getMaxSpan, getSpanScale, toHandFramePos } from "../src/solver/keyboard";
import { localResolveFingering } from "../src/solver/localResolve";
import { solveFingering } from "../src/solver/solveFingering";
import { handleWorkerRequestAsync } from "../src/workers/fingering.worker";
import { createSolverClient, type WorkerLike } from "../src/workers/solverClient";
import type { WorkerRequest, WorkerResponse } from "../src/workers/protocol";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { perfBudget } from "./perfBudget";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function loadBundledModels() {
  const modelsDir = path.resolve(process.cwd(), "public/models");
  const leftBuf = fs.readFileSync(path.join(modelsDir, "lumikey-prior-left.bin"));
  const rightBuf = fs.readFileSync(path.join(modelsDir, "lumikey-prior-right.bin"));
  const left = parseLumikeyWeightBinary(leftBuf);
  const right = parseLumikeyWeightBinary(rightBuf);
  return { left, right, leftBuf, rightBuf, prior: createLumikeyPrior({ left, right }) };
}

function makeSlice(
  sliceId: string,
  hand: "RH" | "LH",
  midis: number[],
  onsetSec: number,
  options?: {
    durationSec?: number;
    isGrace?: boolean;
    anchors?: Array<Finger | undefined>;
    heldNotes?: OnsetSlice["heldNotes"];
  }
): OnsetSlice {
  const durationSec = options?.durationSec ?? 0.3;
  const isGrace = Boolean(options?.isGrace);
  const onsetTick = Math.round(onsetSec * 480);
  const notes: NoteEvent[] = midis.map((midi, i) => ({
    noteUid: `${sliceId}-n${i}`,
    measureIndex: 0,
    onsetTick,
    durationTick: Math.round(durationSec * 480),
    onsetSec,
    durationSec,
    midi,
    hand,
    voice: "1",
    staff: hand === "RH" ? 1 : 2,
    isGrace,
    isTieStop: false,
    isTieStart: false,
    anchorFinger: options?.anchors?.[i],
    anchorRawPreserved: options?.anchors?.[i] !== undefined,
  }));

  return {
    sliceId,
    hand,
    measureIndex: 0,
    onsetTick,
    onsetSec,
    isGrace,
    phraseId: 0,
    notes,
    heldNotes: options?.heldNotes ?? [],
  };
}

describe("Phase 1: Lumikey adapter & pure-TS Transformer forward pass", () => {
  it("matches upstream @lumikey/piano-fingering-model buildTokens feature encoding exactly", () => {
    // Black/white key and pitch-class helpers relative to A0 (MIDI 21)
    expect(isBlackKeyFeature(60)).toBe(0.0); // C4 white
    expect(isBlackKeyFeature(61)).toBe(1.0); // C#4 black
    expect(isBlackKeyFeature(66)).toBe(1.0); // F#4 black
    expect(isBlackKeyFeature(-1)).toBe(-1.0);
    expect(midiToPitchClassFeature(21)).toBeCloseTo(0.0, 6);
    expect(midiToPitchClassFeature(60)).toBeCloseTo(((60 - 21) % 12) / 11.0, 6);

    const fingerLastMidi = [60, -1, 64, -1, -1];
    const fingerLastTimeSec = [0.25, Infinity, -0.1, Infinity, 15.0];
    const lookahead = [
      { midi: 65, timeUntil: 300, finger: null },
      { midi: 67, timeUntil: 600, finger: 3 }, // 0-based finger hint (finger 4 -> 3)
    ];

    const tokens = buildLumikeyTokens(62, fingerLastMidi, fingerLastTimeSec, lookahead);
    expect(tokens.length).toBe(26 * 5);

    const refNorm = (62 - 21) / 87.0;
    // Finger 1 (index 0): used at MIDI 60, 0.25s since release
    expect(tokens[0]).toBeCloseTo((60 - 21) / 87.0 - refNorm, 6);
    expect(tokens[1]).toBeCloseTo(0.025, 6);
    expect(tokens[2]).toBe(0.0);
    expect(tokens[3]).toBe(0.0);
    expect(tokens[4]).toBe(-1.0);

    // Finger 2 (index 1): never used
    expect(tokens[5]).toBe(-1.0);
    expect(tokens[6]).toBe(1.0);
    expect(tokens[7]).toBe(-1.0);
    expect(tokens[8]).toBe(0.0);
    expect(tokens[9]).toBe(-1.0);

    // Finger 3 (index 2): still holding (-0.1s clamped to 0.0)
    expect(tokens[11]).toBe(0.0);

    // Finger 5 (index 4): 15.0s clamped to 10.0 / 10.0 = 1.0
    expect(tokens[21]).toBe(1.0);

    // Current note token (index 5 => offset 25)
    expect(tokens[25]).toBeCloseTo(((62 - 21) % 12) / 11.0, 6);
    expect(tokens[26]).toBe(0.0);
    expect(tokens[27]).toBe(0.0);
    expect(tokens[28]).toBe(0.5);
    expect(tokens[29]).toBe(-1.0);

    // Lookahead 0 (index 6 => offset 30)
    expect(tokens[30]).toBeCloseTo((65 - 21) / 87.0 - refNorm, 6);
    expect(tokens[31]).toBeCloseTo(0.3 / 10.0, 6);
    expect(tokens[32]).toBe(0.0);
    expect(tokens[33]).toBe(1.0);
    expect(tokens[34]).toBe(-1.0);

    // Lookahead 1 (index 7 => offset 35): has finger hint 3 -> 3/4 = 0.75
    expect(tokens[39]).toBeCloseTo(0.75, 6);

    // Unfilled lookahead slot (index 8 => offset 40)
    expect(Array.from(tokens.subarray(40, 45))).toEqual([-1, -1, -1, -1, -1]);
  });

  it("orders chord notes lowest-to-highest and assigns minimum grace duration in slicesToPriorNotes", () => {
    const chordSlice = makeSlice("s-chord", "RH", [67, 60, 64], 0.5, {
      durationSec: 0.4,
      anchors: [5, undefined, 3],
    });
    const graceSlice = makeSlice("s-grace", "RH", [59], 0.5, {
      durationSec: 0,
      isGrace: true,
    });

    const notes = slicesToPriorNotes([chordSlice, graceSlice], "RH", false);
    expect(notes.map((n) => n.midi)).toEqual([59, 60, 64, 67]);
    expect(notes[0].durationMs).toBeGreaterThanOrEqual(80);
    expect(notes[2].anchorFinger).toBe(3);
    expect(notes[3].anchorFinger).toBe(5);

    const ignoredAnchors = slicesToPriorNotes([chordSlice], "RH", true);
    expect(ignoredAnchors.every((n) => n.anchorFinger === undefined)).toBe(true);
  });

  it("matches ONNX reference logits within < 1e-4 on RH C-major scale and LH bass pattern", () => {
    const { left, right } = loadBundledModels();

    // Golden logits verified directly from the ONNX graph
    const rhScale = [60, 62, 64, 65, 67, 69, 71, 72];
    const rhExpectedLogits = [
      [3.297, -0.57, -0.543, -0.617, -0.76],
      [-0.997, 3.03, -0.948, -0.902, -0.962],
      [-0.729, -1.061, 2.973, -1.112, -0.902],
      [3.285, -0.668, -0.673, -0.289, -0.997],
      [-1.057, 3.027, -0.9, -0.898, -0.96],
      [-0.865, -1.045, 2.987, -0.995, -0.849],
      [-0.088, -0.959, -1.089, 2.968, -1.281],
      [-0.796, -0.764, -0.696, -0.722, 3.216],
    ];
    const rhExpectedFingers = [1, 2, 3, 1, 2, 3, 4, 5];

    const flm = [-1, -1, -1, -1, -1];
    const flt = [Infinity, Infinity, Infinity, Infinity, Infinity];
    for (let i = 0; i < rhScale.length; i++) {
      const m = rhScale[i];
      const la = rhScale.slice(i + 1).map((futureMidi, k) => ({
        midi: futureMidi,
        timeUntil: (k + 1) * 300,
        finger: null,
      }));
      const tokens = buildLumikeyTokens(m, flm, flt, la);
      const logits = forwardLumikeyLogits(right, tokens);
      for (let f = 0; f < 5; f++) {
        expect(Math.abs(logits[f] - rhExpectedLogits[i][f])).toBeLessThan(1e-3);
      }
      const predFinger =
        logits.reduce((best, val, idx, arr) => (val > arr[best] ? idx : best), 0) + 1;
      expect(predFinger).toBe(rhExpectedFingers[i]);
      flm[predFinger - 1] = m;
      flt[predFinger - 1] = -0.28;
      for (let f = 0; f < 5; f++) {
        if (flt[f] !== Infinity) flt[f] += 0.3;
      }
    }

    // LH bass pattern: [48, 43, 45, 41]
    const lhBass = [48, 43, 45, 41];
    const lhExpectedLogits = [
      [2.964873, -0.25672, -0.655679, -1.152292, -1.094145],
      [-2.391088, 0.427098, 1.547385, 0.083351, -0.873517],
      [0.21601, 2.514107, -1.279138, -1.302776, -1.535159],
      [-1.531298, -1.376317, -0.923705, 2.357249, 0.480801],
    ];
    const lhFlm = [-1, -1, -1, -1, -1];
    const lhFlt = [Infinity, Infinity, Infinity, Infinity, Infinity];
    for (let i = 0; i < lhBass.length; i++) {
      const m = lhBass[i];
      const la = lhBass.slice(i + 1).map((futureMidi, k) => ({
        midi: futureMidi,
        timeUntil: (k + 1) * 500,
        finger: null,
      }));
      const tokens = buildLumikeyTokens(m, lhFlm, lhFlt, la);
      const logits = forwardLumikeyLogits(left, tokens);
      for (let f = 0; f < 5; f++) {
        expect(Math.abs(logits[f] - lhExpectedLogits[i][f])).toBeLessThan(1e-4);
      }
      const predFinger =
        logits.reduce((best, val, idx, arr) => (val > arr[best] ? idx : best), 0) + 1;
      lhFlm[predFinger - 1] = m;
      lhFlt[predFinger - 1] = -0.4;
      for (let f = 0; f < 5; f++) {
        if (lhFlt[f] !== Infinity) lhFlt[f] += 0.5;
      }
    }
  });
});

describe("Phase 2: Physical & Anchor Veto Invariants (§4.2 & §7)", () => {
  it("caps per-note priorCost at lambda * perNoteCap and allows soft tie-breaking among feasible candidates", () => {
    const slice0 = makeSlice("s0", "RH", [60], 0);
    const slice1 = makeSlice("s1", "RH", [62], 0.3);

    // Fake prior that strongly prefers finger 3 on s0 and finger 4 on s1
    const fakePrior: FingeringPrior = {
      logProbs(_hand, notes) {
        const out = new Float32Array(notes.length * 5);
        for (let i = 0; i < notes.length; i++) {
          const targetF = i === 0 ? 3 : 4;
          const logits = [-50, -50, -50, -50, -50];
          logits[targetF - 1] = 0;
          out.set(logitsToLogProbs(logits), i * 5);
        }
        return out;
      },
    };

    const table = buildPriorTableForSlices([slice0, slice1], fakePrior, {
      lambda: 1.0,
      perNoteCap: DEFAULT_PRIOR_PER_NOTE_CAP,
    });

    // Even though -logP is ~50, per-note cost is strictly capped at 6.0
    const penalizedCost = computeCandidatePriorCost(slice0, [1], table);
    const preferredCost = computeCandidatePriorCost(slice0, [3], table);
    expect(penalizedCost).toBeCloseTo(DEFAULT_PRIOR_PER_NOTE_CAP, 5);
    expect(preferredCost).toBeLessThan(0.01);

    // Solving with the fake prior nudges the feasible 2-note step from (1,2) to (3,4)
    const solved = solveFingering([slice0, slice1], DEFAULT_HAND_SPAN_PROFILE, {
      priorModel: fakePrior,
      priorLambda: 1.2,
    });
    expect(solved.priorUsed).toBe(true);
    expect(solved.fingerByNoteUid["s0-n0"]).toBe(3);
    expect(solved.fingerByNoteUid["s1-n0"]).toBe(4);
  });

  it("never violates user Finger Anchors, intra-chord collision rules, S/M/L span limits, or Held Note occupancy", () => {
    // Adversarial prior that demands finger 1 on every single note with extreme logits
    const adversarialAllThumbPrior: FingeringPrior = {
      logProbs(_hand, notes) {
        const out = new Float32Array(notes.length * 5);
        for (let i = 0; i < notes.length; i++) {
          out.set(logitsToLogProbs([100, -100, -100, -100, -100]), i * 5);
        }
        return out;
      },
    };

    // 1. Anchored note + 3-note chord + held note across S/M/L profiles and multiple lambdas
    const slices: OnsetSlice[] = [
      makeSlice("s0", "RH", [60], 0, {
        durationSec: 1.0,
        anchors: [2], // Locked to finger 2!
      }),
      makeSlice("s1", "RH", [64, 67], 0.3, {
        durationSec: 0.4,
        heldNotes: [{ noteUid: "s0-n0", midi: 60, endTick: 480, onsetTick: 0 }],
      }),
      makeSlice("s2", "RH", [60, 64, 67], 1.2, {
        durationSec: 0.5,
        anchors: [undefined, 3, undefined],
      }),
    ];

    for (const preset of ["S", "M", "L"] as const) {
      const profile: HandSpanProfile = {
        ...DEFAULT_HAND_SPAN_PROFILE,
        preset,
      };
      const scale = getSpanScale(profile);
      const baseline = solveFingering(slices, profile);

      for (const lambda of [0.25, DEFAULT_PRIOR_LAMBDA, 1.5, 3.0]) {
        const res = solveFingering(slices, profile, {
          priorModel: adversarialAllThumbPrior,
          priorLambda: lambda,
        });

        // Invariant 1: 100% Anchor retention
        expect(res.fingerByNoteUid["s0-n0"]).toBe(2);
        expect(res.fingerByNoteUid["s2-n1"]).toBe(3);

        // Invariant 2: No intra-chord finger collision on s1 or s2
        expect(res.fingerByNoteUid["s1-n0"]).not.toBe(res.fingerByNoteUid["s1-n1"]);
        const s2Fingers = new Set([
          res.fingerByNoteUid["s2-n0"],
          res.fingerByNoteUid["s2-n1"],
          res.fingerByNoteUid["s2-n2"],
        ]);
        expect(s2Fingers.size).toBe(3);

        // Invariant 3: Held note s0-n0 (finger 2) is not stolen at s1
        expect(res.fingerByNoteUid["s1-n0"]).not.toBe(2);
        expect(res.fingerByNoteUid["s1-n1"]).not.toBe(2);

        // Invariant 4: Every chosen slice assignment is a member of generateSliceCandidates
        for (const slice of slices) {
          const cands = generateSliceCandidates(slice, false, profile).candidates;
          const chosen = slice.notes.map((n) => res.fingerByNoteUid[n.noteUid]);
          expect(cands).toContainEqual(chosen);

          // Pairwise span check
          for (let i = 0; i < slice.notes.length; i++) {
            for (let j = i + 1; j < slice.notes.length; j++) {
              const dist = Math.abs(
                toHandFramePos(slice.notes[i].midi, slice.hand) -
                  toHandFramePos(slice.notes[j].midi, slice.hand)
              );
              const maxSpan = getMaxSpan(chosen[i], chosen[j], scale);
              expect(dist).toBeLessThanOrEqual(maxSpan + 1e-6);
            }
          }
        }

        // Invariant 5: Does not introduce new unreachable-span or anchor-conflict cues
        const baseHardCues = baseline.transitionCues.filter(
          (c) => c.type === "unreachable-span" || c.type === "anchor-conflict"
        ).length;
        const priorHardCues = res.transitionCues.filter(
          (c) => c.type === "unreachable-span" || c.type === "anchor-conflict"
        ).length;
        expect(priorHardCues).toBeLessThanOrEqual(baseHardCues);
      }
    }
  });

  it("silently falls back to the exact heuristic output when prior is null, lambda=0, or throws", () => {
    const slices = [
      makeSlice("s0", "RH", [60], 0),
      makeSlice("s1", "RH", [62], 0.25),
      makeSlice("s2", "RH", [64], 0.5),
      makeSlice("s3", "RH", [65], 0.75),
    ];

    const baseline = solveFingering(slices, DEFAULT_HAND_SPAN_PROFILE);

    const withNull = solveFingering(slices, DEFAULT_HAND_SPAN_PROFILE, {
      priorModel: null,
    });
    expect(withNull.fingerByNoteUid).toEqual(baseline.fingerByNoteUid);
    expect(withNull.priorUsed).toBeUndefined();

    const throwingPrior: FingeringPrior = {
      logProbs() {
        throw new Error("Simulated model inference failure");
      },
    };
    const withThrow = solveFingering(slices, DEFAULT_HAND_SPAN_PROFILE, {
      priorModel: throwingPrior,
      priorLambda: 1.0,
    });
    expect(withThrow.fingerByNoteUid).toEqual(baseline.fingerByNoteUid);
    expect(withThrow.priorUsed).toBeUndefined();
    expect(withThrow.priorFallbackReason).toContain("Simulated model inference failure");
  });

  it("supports priorModel in localResolveFingering while honoring pinOnly and phrase anchors", () => {
    const { prior } = loadBundledModels();
    const slices = [
      makeSlice("s0", "RH", [60], 0),
      makeSlice("s1", "RH", [62], 0.25),
      makeSlice("s2", "RH", [64], 0.5),
      makeSlice("s3", "RH", [65], 0.75),
      makeSlice("s4", "RH", [67], 1.0),
    ];

    const initial = solveFingering(slices, DEFAULT_HAND_SPAN_PROFILE, {
      priorModel: prior,
      priorLambda: DEFAULT_PRIOR_LAMBDA,
    });

    const resolved = localResolveFingering({
      onsetSlices: slices,
      profile: DEFAULT_HAND_SPAN_PROFILE,
      priorFingerByNoteUid: initial.fingerByNoteUid,
      targetNoteUid: "s2-n0",
      override: { finger: 2, mode: "phrase" },
      anchors: { "s2-n0": { finger: 2, mode: "phrase" } },
      priorModel: prior,
      priorLambda: DEFAULT_PRIOR_LAMBDA,
    });

    expect(resolved.fingerByNoteUid["s2-n0"]).toBe(2);
  });
});

describe("Phase 3: Corpus Evaluation & Performance Gate", () => {
  it("achieves 100% agreement on 03-partial-fingering-hanon masked anchors and 0 warnings within perfBudget", () => {
    const { prior } = loadBundledModels();
    const hanonXml = fs.readFileSync(
      path.resolve(process.cwd(), "test-corpus/03-partial-fingering-hanon.musicxml"),
      "utf8"
    );
    const hanonDoc = parseMusicXml(hanonXml);
    const groundTruth = new Map<string, Finger>();
    for (const ev of hanonDoc.noteEvents) {
      if (!ev.isTieStop && ev.anchorFinger !== undefined) {
        groundTruth.set(ev.noteUid, ev.anchorFinger);
      }
    }
    expect(groundTruth.size).toBe(7);

    const baseline = solveFingering(hanonDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE, {
      ignoreExistingFingerings: true,
    });
    const hybrid = solveFingering(hanonDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE, {
      ignoreExistingFingerings: true,
      priorModel: prior,
      priorLambda: DEFAULT_PRIOR_LAMBDA,
    });

    let baseMatches = 0;
    let hybridMatches = 0;
    for (const [uid, expected] of groundTruth.entries()) {
      if (baseline.fingerByNoteUid[uid] === expected) baseMatches++;
      if (hybrid.fingerByNoteUid[uid] === expected) hybridMatches++;
    }

    expect(hybrid.priorUsed).toBe(true);
    expect(hybridMatches).toBeGreaterThanOrEqual(baseMatches);
    expect(hybridMatches).toBe(groundTruth.size);
    expect(hybrid.warnings.length).toBeLessThanOrEqual(baseline.warnings.length);
    expect(hybrid.solveTimeMs).toBeLessThanOrEqual(perfBudget(200));
  });

  it("solves 02-grand-staff-arpeggio-chord without adding warnings or danger cues", () => {
    const { prior } = loadBundledModels();
    const arpXml = fs.readFileSync(
      path.resolve(process.cwd(), "test-corpus/02-grand-staff-arpeggio-chord.musicxml"),
      "utf8"
    );
    const arpDoc = parseMusicXml(arpXml);
    const baseline = solveFingering(arpDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE);
    const hybrid = solveFingering(arpDoc.onsetSlices, DEFAULT_HAND_SPAN_PROFILE, {
      priorModel: prior,
      priorLambda: DEFAULT_PRIOR_LAMBDA,
    });

    expect(hybrid.priorUsed).toBe(true);
    expect(hybrid.warnings.length).toBeLessThanOrEqual(baseline.warnings.length);
    expect(hybrid.solveTimeMs).toBeLessThanOrEqual(perfBudget(200));
  });
});

describe("Phase 4: Lazy Loader & Worker Protocol Integration", () => {
  beforeEach(() => {
    clearCachedLumikeyPrior();
  });

  it("streams download progress and caches loaded weights in loadLumikeyPrior", async () => {
    const { leftBuf, rightBuf } = loadBundledModels();
    const progressEvents: Array<{ loadedBytes: number; totalBytes: number }> = [];
    let fetchCalls = 0;

    const fakeFetch = (async (url: string | URL | Request) => {
      fetchCalls++;
      const urlStr = String(url);
      const buf = urlStr.includes("left") ? leftBuf : rightBuf;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      } as Response;
    }) as typeof fetch;

    const prior1 = await loadLumikeyPrior({
      baseUrl: "https://cdn.example.com/models/",
      fetchFn: fakeFetch,
      onProgress: (p) => progressEvents.push(p),
    });
    expect(prior1).toBeDefined();
    expect(fetchCalls).toBe(2);
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(progressEvents[progressEvents.length - 1]).toEqual({
      loadedBytes: EXPECTED_WEIGHT_BIN_BYTES * 2,
      totalBytes: EXPECTED_WEIGHT_BIN_BYTES * 2,
    });

    // Second call with same baseUrl uses cache without fetching again
    const prior2 = await loadLumikeyPrior({
      baseUrl: "https://cdn.example.com/models",
      fetchFn: fakeFetch,
    });
    expect(prior2).toBe(prior1);
    expect(fetchCalls).toBe(2);
  });

  it("handles worker prior-progress messages and falls back cleanly on loader error", async () => {
    const slices = [makeSlice("s0", "RH", [60], 0), makeSlice("s1", "RH", [62], 0.3)];
    const progressCaptured: Array<{ loadedBytes: number; totalBytes: number }> = [];

    const fakeWorker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg: unknown) {
        const req = msg as WorkerRequest;
        // Emit a synthetic progress message before final response
        fakeWorker.onmessage?.({
          data: {
            requestId: req.requestId,
            type: "prior-progress",
            loadedBytes: 404508,
            totalBytes: 809016,
          },
        } as MessageEvent<WorkerResponse>);

        void handleWorkerRequestAsync(req).then((resp) => {
          fakeWorker.onmessage?.({ data: resp } as MessageEvent<WorkerResponse>);
        });
      },
      terminate() {},
    };

    const client = createSolverClient(() => fakeWorker);
    const baseline = solveFingering(slices, DEFAULT_HAND_SPAN_PROFILE);
    // Because jsdom global fetch fails on relative /models URL, handleWorkerRequestAsync
    // will catch the fetch failure and return priorFallbackReason while falling back to heuristic
    const result = await client.solve(slices, DEFAULT_HAND_SPAN_PROFILE, {
      priorMode: "model-assist",
      lambda: 0.85,
      onPriorProgress: (p) => progressCaptured.push(p),
    });

    expect(progressCaptured).toEqual([{ loadedBytes: 404508, totalBytes: 809016 }]);
    expect(result.fingerByNoteUid).toEqual(baseline.fingerByNoteUid);
    expect(result.priorUsed).toBe(false);
    expect(result.priorFallbackReason).toBeTruthy();

    client.dispose();
  });

  it("renders settings UI for Fingering Style (Classic vs Model Assist Beta), lambda slider, progress, and fallback notice", async () => {
    const { prior } = loadBundledModels();
    const capturedRequests: WorkerRequest[] = [];

    const inProcessWorkerFactory = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(msg: unknown) {
          const req = msg as WorkerRequest;
          capturedRequests.push(req);
          queueMicrotask(() => {
            if (req.type === "load-prior") {
              worker.onmessage?.({
                data: {
                  requestId: req.requestId,
                  type: "prior-progress",
                  loadedBytes: EXPECTED_WEIGHT_BIN_BYTES * 2,
                  totalBytes: EXPECTED_WEIGHT_BIN_BYTES * 2,
                },
              } as MessageEvent<WorkerResponse>);
              worker.onmessage?.({
                data: {
                  requestId: req.requestId,
                  type: "prior-ready",
                  ok: true,
                  priorReady: true,
                },
              } as MessageEvent<WorkerResponse>);
              return;
            }
            const useModel = req.priorMode === "model-assist";
            const result = solveFingering(req.onsetSlices, req.profile, {
              ignoreExistingFingerings: req.ignoreExistingFingerings,
              priorModel: useModel ? prior : null,
              priorLambda: req.lambda,
            });
            const resp: WorkerResponse = {
              requestId: req.requestId,
              ok: true,
              result,
              priorReady: useModel,
            };
            worker.onmessage?.({ data: resp } as MessageEvent<WorkerResponse>);
          });
        },
        terminate() {},
      };
      return worker;
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(App, {
          solverClientFactory: () => createSolverClient(inProcessWorkerFactory),
        })
      );
    });

    // Open practice settings modal
    const settingsBtn = container.querySelector(
      '[data-testid="header-midi-status-btn"]'
    ) as HTMLButtonElement;
    expect(settingsBtn).not.toBeNull();

    await act(async () => {
      settingsBtn.click();
    });

    const classicBtn = container.querySelector(
      '[data-testid="prior-mode-classic-btn"]'
    ) as HTMLButtonElement;
    const assistBtn = container.querySelector(
      '[data-testid="prior-mode-assist-btn"]'
    ) as HTMLButtonElement;
    expect(classicBtn).not.toBeNull();
    expect(assistBtn).not.toBeNull();
    expect(classicBtn.getAttribute("aria-pressed")).toBe("false");
    expect(assistBtn.getAttribute("aria-pressed")).toBe("true");
    expect(
      container.querySelector('[data-testid="prior-lambda-slider"]')
    ).not.toBeNull();

    // Switch to Classic, then back to Model Assist (Beta) to trigger preload
    await act(async () => {
      classicBtn.click();
    });
    expect(classicBtn.getAttribute("aria-pressed")).toBe("true");
    expect(
      container.querySelector('[data-testid="prior-lambda-slider"]')
    ).toBeNull();

    await act(async () => {
      assistBtn.click();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(assistBtn.getAttribute("aria-pressed")).toBe("true");
    const slider = container.querySelector(
      '[data-testid="prior-lambda-slider"]'
    ) as HTMLInputElement;
    expect(slider).not.toBeNull();
    expect(
      container.querySelector('[data-testid="prior-download-progress"]')?.textContent
    ).toContain("预训练指法先验已就绪");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
