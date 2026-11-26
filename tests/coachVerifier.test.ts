import { describe, expect, it } from "vitest";
import type { AcousticProfileResult } from "../src/guided/acousticProfile";
import { buildCoachTelemetryPayload } from "../src/coach/payload";
import {
  buildFreeStudioOfflineTip,
  buildOfflineExternalFocusCueLabel,
  generateOfflineCoachFeedback,
} from "../src/coach/templates";
import {
  BODY_MECHANICS_BLACKLIST_REGEX,
  MAX_COACH_CHINESE_CHARS,
  countChineseChars,
  verifyCoachResponse,
  verifyPerformanceCueLabel,
} from "../src/coach/verifier";

function makeSampleProfile(overrides?: Partial<AcousticProfileResult>): AcousticProfileResult {
  return {
    timingEvennessStatus: "green",
    timingNormNpvi: 3.4,
    secondaryDimension: "voicing",
    voicingDeltaDb: 0.9,
    melodyRankDominance: 0.54,
    voicingStatus: "red",
    tertiaryDimension: "pedal",
    pedalClarityRate: 0.65,
    pedalStatus: "amber",
    bleQuantizationRelaxed: false,
    pedalHardware: "continuous",
    capsules: [
      { id: "timing", label: "节奏均匀", valueText: "nPVI 3.4", status: "green" },
      { id: "voicing", label: "声部层次", valueText: "+0.9 dB · 主位 54%", status: "red" },
      { id: "pedal", label: "踏板清音", valueText: "65% (半踏)", status: "amber" },
    ],
    troubleMeasures: [
      { measureIndex: 9, severity: "red", reasons: ["声部层次偏平"] },
      { measureIndex: 10, severity: "amber", reasons: ["踏板换音浑浊"] },
    ],
    ...overrides,
  };
}

describe("External-Focus Coach payload, offline templates & closed-world verifier", () => {
  it("builds a ~250-500 token closed-world CoachTelemetryPayload without raw MIDI arrays", () => {
    const profile = makeSampleProfile();
    const payload = buildCoachTelemetryPayload({
      profile,
      pieceTitle: "Chopin Nocturne Op.9 No.2",
      practiceMode: "both",
      speedMultiplier: 0.85,
      startMeasureIndex: 8,
      endMeasureIndex: 11,
      timeSignature: "12/8",
      passIndexInSegment: 3,
      midiSource: "midi",
      transitionCues: [{ measureIndex: 10, kind: "position-shift" }],
    });

    expect(payload.schemaVersion).toBe("1.0");
    expect(payload.piece.measureRange).toEqual([9, 12]);
    expect(payload.evidences.length).toBeGreaterThanOrEqual(2);
    expect(payload.evidences.map((e) => e.id)).toEqual([
      "ev-m10-voicing",
      "ev-m11-pedalClarity",
    ]);
    expect(payload.evidences[0].measures).toEqual([10]);
    expect(payload.evidences[1].measures).toEqual([11]);
    expect(payload.evidences[1].cues).toEqual(["position-shift"]);
    expect(payload.strengthAnchor.id).toBe("ev-seg-evenness");

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("timeStampMs");
    expect(serialized).not.toContain("rawMidi");
    expect(serialized).not.toContain("noteEvents");
    expect(serialized.length).toBeGreaterThanOrEqual(350);
    expect(serialized.length).toBeLessThanOrEqual(1800);
  });

  it("renders deterministic 0 ms offline Chinese external-focus templates that pass closed-world verification", () => {
    const profile = makeSampleProfile();
    const payload = buildCoachTelemetryPayload({
      profile,
      pieceTitle: "Nocturne",
      practiceMode: "both",
      speedMultiplier: 0.85,
      startMeasureIndex: 8,
      endMeasureIndex: 11,
    });

    const t0 = performance.now();
    const response = generateOfflineCoachFeedback(payload);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(20);
    expect(response.focusCues.length).toBe(2);
    expect(response.praise.length).toBeGreaterThan(0);
    expect(response.nextPassListeningGoal.length).toBeGreaterThan(0);

    const check = verifyCoachResponse(response, payload);
    expect(check).toEqual({ ok: true, violations: [] });

    const totalCjk = countChineseChars(
      response.praise +
        response.focusCues.map((c) => c.soundCue).join("") +
        response.nextPassListeningGoal,
    );
    expect(totalCjk).toBeLessThanOrEqual(MAX_COACH_CHINESE_CHARS);

    const freeTip = buildFreeStudioOfflineTip(payload);
    expect(freeTip.length).toBeGreaterThan(0);
    expect(BODY_MECHANICS_BLACKLIST_REGEX.test(freeTip)).toBe(false);

    const cueLabel = buildOfflineExternalFocusCueLabel("switch", 10);
    expect(verifyPerformanceCueLabel(cueLabel).ok).toBe(true);
  });

  it("handles clean performances with empty evidences cleanly", () => {
    const cleanProfile = makeSampleProfile({
      timingEvennessStatus: "green",
      voicingStatus: "green",
      voicingDeltaDb: 5.2,
      melodyRankDominance: 0.92,
      pedalStatus: "green",
      pedalClarityRate: 0.95,
      troubleMeasures: [],
    });
    const payload = buildCoachTelemetryPayload({
      profile: cleanProfile,
      pieceTitle: "Minuet",
      practiceMode: "both",
      speedMultiplier: 1.0,
      startMeasureIndex: 0,
      endMeasureIndex: 3,
    });

    expect(payload.evidences).toEqual([]);
    const offline = generateOfflineCoachFeedback(payload);
    expect(offline.focusCues).toEqual([]);
    expect(verifyCoachResponse(offline, payload)).toEqual({ ok: true, violations: [] });
  });

  it("rejects every blacklisted body-mechanics word, unknown evidenceId, out-of-range measure, and >140 Chinese chars", () => {
    const payload = buildCoachTelemetryPayload({
      profile: makeSampleProfile(),
      pieceTitle: "Etude",
      practiceMode: "both",
      speedMultiplier: 0.9,
      startMeasureIndex: 8,
      endMeasureIndex: 11,
    });

    const forbiddenWords = [
      "手腕",
      "手指",
      "指尖",
      "四指",
      "五指",
      "虎口",
      "小臂",
      "肩膀",
      "肌肉",
      "抬指",
      "塌指",
      "发力",
      "僵硬",
    ];
    for (const word of forbiddenWords) {
      const bad = {
        praise: "第9到12小节节奏很稳。",
        focusCues: [
          {
            evidenceId: "ev-m10-voicing",
            measures: [10],
            soundCue: `第10小节注意${word}状态。`,
          },
        ],
        nextPassListeningGoal: "听清高声部旋律线。",
      };
      const res = verifyCoachResponse(bad, payload);
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.includes("body-mechanics"))).toBe(true);
    }

    // Unknown evidenceId
    const badEvidence = verifyCoachResponse(
      {
        praise: "节奏很稳。",
        focusCues: [
          {
            evidenceId: "ev-m99-hallucinated",
            measures: [10],
            soundCue: "让高音浮在伴奏上方。",
          },
        ],
        nextPassListeningGoal: "听见和声清澈转换。",
      },
      payload,
    );
    expect(badEvidence.ok).toBe(false);
    expect(badEvidence.violations.some((v) => v.includes("evidenceId"))).toBe(true);

    // Out-of-range measure number
    const badMeasure = verifyCoachResponse(
      {
        praise: "节奏很稳。",
        focusCues: [
          {
            evidenceId: "ev-m10-voicing",
            measures: [99],
            soundCue: "让高音浮在伴奏上方。",
          },
        ],
        nextPassListeningGoal: "听见和声清澈转换。",
      },
      payload,
    );
    expect(badMeasure.ok).toBe(false);
    expect(badMeasure.violations.some((v) => v.includes("measure"))).toBe(true);

    // > 140 Chinese characters
    const longResponse = verifyCoachResponse(
      {
        praise: "旋律线条非常连贯清晰稳定。",
        focusCues: [
          {
            evidenceId: "ev-m10-voicing",
            measures: [10],
            soundCue: "一".repeat(120),
          },
        ],
        nextPassListeningGoal: "听见结尾和声逐渐融化在空气中保持空间感与歌唱性。",
      },
      payload,
    );
    expect(longResponse.ok).toBe(false);
    expect(longResponse.violations.some((v) => v.includes("140"))).toBe(true);
  });

  it("validates PerformanceCue external-focus labels against body-mechanics blacklist", () => {
    expect(verifyPerformanceCueLabel("听见高音像独唱浮起").ok).toBe(true);
    expect(verifyPerformanceCueLabel("四指抬指不要僵硬").ok).toBe(false);
    expect(verifyPerformanceCueLabel("").ok).toBe(false);
  });
});
