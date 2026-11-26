import type {
  CoachResponse,
  CoachTelemetryPayload,
  CoachVerificationResult,
} from "./types";

export const MAX_COACH_CHINESE_CHARS = 140;

/**
 * Internal body-mechanics directive blacklist banned from all External-Focus Coach
 * responses and polished PerformanceCue labels (Duke et al. 2011; Mornell & Wulf 2019).
 */
export const BODY_MECHANICS_BLACKLIST_REGEX =
  /(手腕|手指|指尖|指关节|掌关节|虎口|小臂|手臂|肩膀|肌肉|四指|五指|大拇指|抬指|塌指|发力|僵硬)/;

export function countChineseChars(text: string): number {
  const matches = text.match(/[\u4e00-\u9fff]/g);
  return matches ? matches.length : 0;
}

function findInlineOutOfRangeMeasures(
  text: string,
  minM: number,
  maxM: number,
): number[] {
  const bad: number[] = [];
  const patterns = [/第\s*(\d+)\s*小节/g, /\bm\.\s*(\d+)\b/gi];
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const m = Number.parseInt(match[1], 10);
      if (Number.isFinite(m) && (m < minM || m > maxM)) {
        bad.push(m);
      }
    }
  }
  return bad;
}

/**
 * Closed-world deterministic verifier enforcing:
 * - { praise, focusCues[0..2], nextPassListeningGoal } shape
 * - total <= 140 Chinese characters
 * - evidenceId whitelist (empty evidences => focusCues must be empty)
 * - 1-based measure-number whitelist within payload.piece.measureRange and evidence.measures
 * - body-mechanics blacklist rejection
 */
export function verifyCoachResponse(
  candidate: unknown,
  payload: CoachTelemetryPayload,
): CoachVerificationResult {
  const violations: string[] = [];

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, violations: ["invalid-shape: response must be an object"] };
  }

  const obj = candidate as Record<string, unknown>;
  const praise = typeof obj.praise === "string" ? obj.praise.trim() : "";
  const nextGoal =
    typeof obj.nextPassListeningGoal === "string" ? obj.nextPassListeningGoal.trim() : "";
  const rawCues = obj.focusCues;

  if (!praise) violations.push("invalid-praise: empty");
  if (!nextGoal) violations.push("invalid-nextPassListeningGoal: empty");
  if (!Array.isArray(rawCues) || rawCues.length > 2) {
    violations.push("invalid-focusCues: must be array of 0..2 items");
    return { ok: false, violations };
  }

  if (payload.evidences.length === 0 && rawCues.length > 0) {
    violations.push("invalid-evidenceId: evidences is empty so focusCues must be empty");
  }

  const evidenceById = new Map(payload.evidences.map((ev) => [ev.id, ev]));
  const [minM, maxM] = payload.piece.measureRange;
  const allTexts: string[] = [praise, nextGoal];

  for (let i = 0; i < rawCues.length; i++) {
    const item = rawCues[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      violations.push(`invalid-focusCue[${i}]: must be object`);
      continue;
    }
    const cue = item as Record<string, unknown>;
    const evidenceId = typeof cue.evidenceId === "string" ? cue.evidenceId : "";
    const soundCue = typeof cue.soundCue === "string" ? cue.soundCue.trim() : "";
    const measures = cue.measures;

    if (!soundCue) {
      violations.push(`invalid-focusCue[${i}]: empty soundCue`);
    } else {
      allTexts.push(soundCue);
    }

    const matchedEvidence = evidenceById.get(evidenceId);
    if (!matchedEvidence) {
      violations.push(`unknown-evidenceId: "${evidenceId}"`);
    }

    if (!Array.isArray(measures) || measures.length === 0 || measures.length > 2) {
      violations.push(`invalid-measure-array[${i}]`);
    } else {
      for (const m of measures) {
        if (typeof m !== "number" || !Number.isInteger(m) || m < minM || m > maxM) {
          violations.push(`out-of-range-measure: ${String(m)} outside [${minM}, ${maxM}]`);
        } else if (
          matchedEvidence &&
          matchedEvidence.measures.length > 0 &&
          !matchedEvidence.measures.includes(m)
        ) {
          violations.push(
            `unanchored-measure: ${m} not in evidence ${evidenceId} [${matchedEvidence.measures.join(",")}]`,
          );
        }
      }
    }
  }

  const combinedText = allTexts.join("");
  const cjkCount = countChineseChars(combinedText);
  if (cjkCount > MAX_COACH_CHINESE_CHARS) {
    violations.push(`exceeds-max-chinese-chars: ${cjkCount} > ${MAX_COACH_CHINESE_CHARS}`);
  }

  for (const text of allTexts) {
    const bodyMatch = text.match(BODY_MECHANICS_BLACKLIST_REGEX);
    if (bodyMatch) {
      violations.push(`body-mechanics-blacklist: "${bodyMatch[1]}"`);
    }
    const inlineOutOfRange = findInlineOutOfRangeMeasures(text, minM, maxM);
    for (const m of inlineOutOfRange) {
      violations.push(`out-of-range-measure-text: ${m} outside [${minM}, ${maxM}]`);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

/**
 * Verifies a polished or user-entered external-focus PerformanceCue label.
 */
export function verifyPerformanceCueLabel(label: string): CoachVerificationResult {
  const violations: string[] = [];
  const trimmed = label.trim();
  if (!trimmed) {
    violations.push("empty-cue-label");
  }
  if (trimmed.length > 32 || countChineseChars(trimmed) > 24) {
    violations.push("cue-label-too-long");
  }
  const match = trimmed.match(BODY_MECHANICS_BLACKLIST_REGEX);
  if (match) {
    violations.push(`body-mechanics-blacklist: "${match[1]}"`);
  }
  return {
    ok: violations.length === 0,
    violations,
  };
}

export function normalizeCoachResponse(candidate: CoachResponse): CoachResponse {
  return {
    praise: candidate.praise.trim(),
    focusCues: candidate.focusCues.slice(0, 2).map((c) => ({
      evidenceId: c.evidenceId,
      measures: c.measures.slice(0, 2),
      soundCue: c.soundCue.trim(),
    })),
    nextPassListeningGoal: candidate.nextPassListeningGoal.trim(),
  };
}
