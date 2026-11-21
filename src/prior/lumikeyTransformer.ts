/**
 * Pure TypeScript forward pass for `@lumikey/piano-fingering-model`
 * (`d_model=64`, `nhead=4`, `num_layers=3`, `dim_feedforward=128`, `seq_len=26`).
 *
 * Matches the exported ONNX graph (`fingering_transformer_{left,right}.onnx`) to `< 1e-5`
 * max logit difference without requiring `onnxruntime-web` or WASM.
 */
import type { Finger, Hand } from "../domain/types";
import {
  argmax5,
  buildLumikeyTokens,
  logitsToLogProbs,
  type LookaheadTokenNote,
} from "./lumikeyAdapter";
import type { FingeringPrior, PriorNoteInput } from "./types";

const SEQ_LEN = 26;
const D_MODEL = 64;
const N_HEADS = 4;
const HEAD_DIM = 16;
const D_FF = 128;
const NUM_LAYERS = 3;
const LAYER_NORM_EPS = 1e-5;
export const EXPECTED_WEIGHT_FLOATS = 101125;
export const EXPECTED_WEIGHT_BIN_BYTES = 8 + EXPECTED_WEIGHT_FLOATS * 4;

export interface LumikeyLayerWeights {
  inProjWeight: Float32Array; // [64, 192]
  inProjWeightT: Float32Array; // [192, 64] transposed for cache-friendly dot products
  inProjBias: Float32Array; // [192]
  outProjWeight: Float32Array; // [64, 64] (out, in) - Gemm transB=1
  outProjBias: Float32Array; // [64]
  norm1Weight: Float32Array; // [64]
  norm1Bias: Float32Array; // [64]
  ff1Weight: Float32Array; // [64, 128]
  ff1WeightT: Float32Array; // [128, 64] transposed
  ff1Bias: Float32Array; // [128]
  ff2Weight: Float32Array; // [128, 64]
  ff2WeightT: Float32Array; // [64, 128] transposed
  ff2Bias: Float32Array; // [64]
  norm2Weight: Float32Array; // [64]
  norm2Bias: Float32Array; // [64]
}

export interface LumikeyHandWeights {
  inputProjWeight: Float32Array; // [5, 64]
  inputProjBias: Float32Array; // [64]
  posEncoding: Float32Array; // [26, 64]
  layers: [LumikeyLayerWeights, LumikeyLayerWeights, LumikeyLayerWeights];
  outputHeadWeight: Float32Array; // [5, 64] (out, in) - Gemm transB=1
  outputHeadBias: Float32Array; // [5]
}

const CACHED_POS_ENCODING: Float32Array = (() => {
  const pe = new Float32Array(SEQ_LEN * D_MODEL);
  const log10000 = Math.log(10000.0);
  for (let pos = 0; pos < SEQ_LEN; pos++) {
    for (let i = 0; i < D_MODEL; i += 2) {
      const divTerm = Math.exp(i * (-log10000 / D_MODEL));
      pe[pos * D_MODEL + i] = Math.sin(pos * divTerm);
      pe[pos * D_MODEL + i + 1] = Math.cos(pos * divTerm);
    }
  }
  return pe;
})();

function transposeMatrix(src: Float32Array, rows: number, cols: number): Float32Array {
  const dst = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const rOff = r * cols;
    for (let c = 0; c < cols; c++) {
      dst[c * rows + r] = src[rOff + c];
    }
  }
  return dst;
}

/**
 * Parse a compact binary weight file (`LKP1` + uint32 version + 101,125 float32 values)
 * into structured `LumikeyHandWeights`.
 */
export function parseLumikeyWeightBinary(buffer: ArrayBuffer | Uint8Array): LumikeyHandWeights {
  const bytes =
    buffer instanceof Uint8Array
      ? buffer
      : new Uint8Array(buffer);

  if (bytes.byteLength < EXPECTED_WEIGHT_BIN_BYTES) {
    throw new Error(
      `Invalid Lumikey weight binary size: expected ${EXPECTED_WEIGHT_BIN_BYTES} bytes, got ${bytes.byteLength}`
    );
  }

  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "LKP1") {
    throw new Error(`Invalid Lumikey weight binary magic: expected "LKP1", got "${magic}"`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version !== 1) {
    throw new Error(`Unsupported Lumikey weight binary version: ${version}`);
  }

  // Copy payload into an aligned Float32Array
  const aligned = new Float32Array(EXPECTED_WEIGHT_FLOATS);
  for (let i = 0; i < EXPECTED_WEIGHT_FLOATS; i++) {
    aligned[i] = view.getFloat32(8 + i * 4, true);
  }

  let offset = 0;
  const take = (count: number): Float32Array => {
    const slice = aligned.subarray(offset, offset + count);
    offset += count;
    return slice;
  };

  const inputProjWeight = take(5 * D_MODEL);
  const inputProjBias = take(D_MODEL);

  const layers: LumikeyLayerWeights[] = [];
  for (let l = 0; l < NUM_LAYERS; l++) {
    const inProjWeight = take(D_MODEL * 3 * D_MODEL);
    const inProjBias = take(3 * D_MODEL);
    const outProjWeight = take(D_MODEL * D_MODEL);
    const outProjBias = take(D_MODEL);
    const norm1Weight = take(D_MODEL);
    const norm1Bias = take(D_MODEL);
    const ff1Weight = take(D_MODEL * D_FF);
    const ff1Bias = take(D_FF);
    const ff2Weight = take(D_FF * D_MODEL);
    const ff2Bias = take(D_MODEL);
    const norm2Weight = take(D_MODEL);
    const norm2Bias = take(D_MODEL);

    layers.push({
      inProjWeight,
      inProjWeightT: transposeMatrix(inProjWeight, D_MODEL, 3 * D_MODEL),
      inProjBias,
      outProjWeight,
      outProjBias,
      norm1Weight,
      norm1Bias,
      ff1Weight,
      ff1WeightT: transposeMatrix(ff1Weight, D_MODEL, D_FF),
      ff1Bias,
      ff2Weight,
      ff2WeightT: transposeMatrix(ff2Weight, D_FF, D_MODEL),
      ff2Bias,
      norm2Weight,
      norm2Bias,
    });
  }

  const outputHeadWeight = take(5 * D_MODEL);
  const outputHeadBias = take(5);

  return {
    inputProjWeight,
    inputProjBias,
    posEncoding: CACHED_POS_ENCODING,
    layers: layers as [LumikeyLayerWeights, LumikeyLayerWeights, LumikeyLayerWeights],
    outputHeadWeight,
    outputHeadBias,
  };
}

function layerNormInPlace(
  x: Float32Array,
  weight: Float32Array,
  bias: Float32Array
): void {
  for (let t = 0; t < SEQ_LEN; t++) {
    const off = t * D_MODEL;
    let sum = 0;
    for (let i = 0; i < D_MODEL; i++) {
      sum += x[off + i];
    }
    const mean = sum / D_MODEL;
    let varSum = 0;
    for (let i = 0; i < D_MODEL; i++) {
      const diff = x[off + i] - mean;
      varSum += diff * diff;
    }
    const invStd = 1.0 / Math.sqrt(varSum / D_MODEL + LAYER_NORM_EPS);
    for (let i = 0; i < D_MODEL; i++) {
      x[off + i] = (x[off + i] - mean) * invStd * weight[i] + bias[i];
    }
  }
}

export interface ForwardScratchBuffers {
  x: Float32Array;
  qkv: Float32Array;
  attnConcat: Float32Array;
  scores: Float32Array;
  ffHidden: Float32Array;
}

export function createForwardScratchBuffers(): ForwardScratchBuffers {
  return {
    x: new Float32Array(SEQ_LEN * D_MODEL),
    qkv: new Float32Array(SEQ_LEN * 3 * D_MODEL),
    attnConcat: new Float32Array(SEQ_LEN * D_MODEL),
    scores: new Float32Array(SEQ_LEN),
    ffHidden: new Float32Array(D_FF),
  };
}

/**
 * Run a single 26x5 token tensor through the Lumikey Transformer and return the 5 finger logits.
 */
export function forwardLumikeyLogits(
  weights: LumikeyHandWeights,
  tokens: Float32Array,
  scratch: ForwardScratchBuffers = createForwardScratchBuffers()
): Float32Array {
  const { x, qkv, attnConcat, scores, ffHidden } = scratch;
  const { inputProjWeight, inputProjBias, posEncoding } = weights;

  // 1. Input projection [26, 5] @ [5, 64] + bias + positional encoding
  for (let t = 0; t < SEQ_LEN; t++) {
    const tIn = t * 5;
    const tOut = t * D_MODEL;
    const t0 = tokens[tIn + 0];
    const t1 = tokens[tIn + 1];
    const t2 = tokens[tIn + 2];
    const t3 = tokens[tIn + 3];
    const t4 = tokens[tIn + 4];
    for (let j = 0; j < D_MODEL; j++) {
      x[tOut + j] =
        inputProjBias[j] +
        posEncoding[tOut + j] +
        t0 * inputProjWeight[0 * D_MODEL + j] +
        t1 * inputProjWeight[1 * D_MODEL + j] +
        t2 * inputProjWeight[2 * D_MODEL + j] +
        t3 * inputProjWeight[3 * D_MODEL + j] +
        t4 * inputProjWeight[4 * D_MODEL + j];
    }
  }

  const attnScale = 1.0 / Math.sqrt(HEAD_DIM); // 0.25

  // 2. Transformer encoder layers (3 layers)
  for (let l = 0; l < NUM_LAYERS; l++) {
    const layer = weights.layers[l];
    const {
      inProjWeight,
      inProjBias,
      outProjWeight,
      outProjBias,
      norm1Weight,
      norm1Bias,
      ff1WeightT,
      ff1Bias,
      ff2Weight,
      ff2Bias,
      norm2Weight,
      norm2Bias,
    } = layer;

    const isLastLayer = l === NUM_LAYERS - 1;
    const tStart = isLastLayer ? 5 : 0;
    const tEnd = isLastLayer ? 6 : SEQ_LEN;

    // QKV projection: x [26, 64] @ inProjWeight [64, 192] + inProjBias [192]
    // Using outer-k accumulation with 4-way j unrolling for vector-friendly sequential memory access
    for (let t = 0; t < SEQ_LEN; t++) {
      const xOff = t * D_MODEL;
      const qkvOff = t * 192;
      const jStart = isLastLayer && t !== 5 ? 64 : 0;
      for (let j = jStart; j < 192; j++) {
        qkv[qkvOff + j] = inProjBias[j];
      }
      for (let k = 0; k < D_MODEL; k++) {
        const xk = x[xOff + k];
        if (xk === 0) continue;
        const wOff = k * 192;
        for (let j = jStart; j < 192; j += 8) {
          qkv[qkvOff + j] += xk * inProjWeight[wOff + j];
          qkv[qkvOff + j + 1] += xk * inProjWeight[wOff + j + 1];
          qkv[qkvOff + j + 2] += xk * inProjWeight[wOff + j + 2];
          qkv[qkvOff + j + 3] += xk * inProjWeight[wOff + j + 3];
          qkv[qkvOff + j + 4] += xk * inProjWeight[wOff + j + 4];
          qkv[qkvOff + j + 5] += xk * inProjWeight[wOff + j + 5];
          qkv[qkvOff + j + 6] += xk * inProjWeight[wOff + j + 6];
          qkv[qkvOff + j + 7] += xk * inProjWeight[wOff + j + 7];
        }
      }
    }

    // Multi-head self-attention (4 heads, dim 16)
    for (let h = 0; h < N_HEADS; h++) {
      const hOff = h * HEAD_DIM;
      for (let tq = tStart; tq < tEnd; tq++) {
        const qBase = tq * 192 + hOff;
        let maxScore = -Infinity;
        for (let tk = 0; tk < SEQ_LEN; tk++) {
          const kBase = tk * 192 + 64 + hOff;
          let dot = 0;
          for (let d = 0; d < HEAD_DIM; d += 4) {
            dot +=
              qkv[qBase + d] * qkv[kBase + d] +
              qkv[qBase + d + 1] * qkv[kBase + d + 1] +
              qkv[qBase + d + 2] * qkv[kBase + d + 2] +
              qkv[qBase + d + 3] * qkv[kBase + d + 3];
          }
          const s = dot * attnScale;
          scores[tk] = s;
          if (s > maxScore) maxScore = s;
        }

        let sumExp = 0;
        for (let tk = 0; tk < SEQ_LEN; tk++) {
          const e = Math.exp(scores[tk] - maxScore);
          scores[tk] = e;
          sumExp += e;
        }
        const invSum = 1.0 / sumExp;

        const outBase = tq * D_MODEL + hOff;
        for (let d = 0; d < HEAD_DIM; d++) {
          attnConcat[outBase + d] = 0;
        }
        for (let tv = 0; tv < SEQ_LEN; tv++) {
          const prob = scores[tv] * invSum;
          const vBase = tv * 192 + 128 + hOff;
          for (let d = 0; d < HEAD_DIM; d += 4) {
            attnConcat[outBase + d] += prob * qkv[vBase + d];
            attnConcat[outBase + d + 1] += prob * qkv[vBase + d + 1];
            attnConcat[outBase + d + 2] += prob * qkv[vBase + d + 2];
            attnConcat[outBase + d + 3] += prob * qkv[vBase + d + 3];
          }
        }
      }
    }

    // Output projection (Gemm transB=1): x += attnConcat @ outProjWeight^T + outProjBias
    for (let t = tStart; t < tEnd; t++) {
      const aOff = t * D_MODEL;
      for (let j = 0; j < D_MODEL; j++) {
        let sum = outProjBias[j];
        const wOff = j * D_MODEL;
        for (let k = 0; k < D_MODEL; k += 4) {
          sum +=
            attnConcat[aOff + k] * outProjWeight[wOff + k] +
            attnConcat[aOff + k + 1] * outProjWeight[wOff + k + 1] +
            attnConcat[aOff + k + 2] * outProjWeight[wOff + k + 2] +
            attnConcat[aOff + k + 3] * outProjWeight[wOff + k + 3];
        }
        x[aOff + j] += sum;
      }
    }

    // LayerNorm 1
    if (isLastLayer) {
      const off = 5 * D_MODEL;
      let sum = 0;
      for (let i = 0; i < D_MODEL; i++) sum += x[off + i];
      const mean = sum / D_MODEL;
      let varSum = 0;
      for (let i = 0; i < D_MODEL; i++) {
        const diff = x[off + i] - mean;
        varSum += diff * diff;
      }
      const invStd = 1.0 / Math.sqrt(varSum / D_MODEL + LAYER_NORM_EPS);
      for (let i = 0; i < D_MODEL; i++) {
        x[off + i] = (x[off + i] - mean) * invStd * norm1Weight[i] + norm1Bias[i];
      }
    } else {
      layerNormInPlace(x, norm1Weight, norm1Bias);
    }

    // Feed-forward: ReLU(x @ ff1Weight + ff1Bias) @ ff2Weight + ff2Bias
    for (let t = tStart; t < tEnd; t++) {
      const xOff = t * D_MODEL;
      for (let j = 0; j < D_FF; j++) {
        let sum = ff1Bias[j];
        const wOff = j * D_MODEL;
        for (let k = 0; k < D_MODEL; k += 4) {
          sum +=
            x[xOff + k] * ff1WeightT[wOff + k] +
            x[xOff + k + 1] * ff1WeightT[wOff + k + 1] +
            x[xOff + k + 2] * ff1WeightT[wOff + k + 2] +
            x[xOff + k + 3] * ff1WeightT[wOff + k + 3];
        }
        ffHidden[j] = sum > 0 ? sum : 0;
      }

      for (let j = 0; j < D_MODEL; j++) {
        x[xOff + j] += ff2Bias[j];
      }
      for (let k = 0; k < D_FF; k++) {
        const hk = ffHidden[k];
        if (hk === 0) continue;
        const wOff = k * D_MODEL;
        for (let j = 0; j < D_MODEL; j += 4) {
          x[xOff + j] += hk * ff2Weight[wOff + j];
          x[xOff + j + 1] += hk * ff2Weight[wOff + j + 1];
          x[xOff + j + 2] += hk * ff2Weight[wOff + j + 2];
          x[xOff + j + 3] += hk * ff2Weight[wOff + j + 3];
        }
      }
    }

    // LayerNorm 2
    if (l === NUM_LAYERS - 1) {
      const off = 5 * D_MODEL;
      let sum = 0;
      for (let i = 0; i < D_MODEL; i++) sum += x[off + i];
      const mean = sum / D_MODEL;
      let varSum = 0;
      for (let i = 0; i < D_MODEL; i++) {
        const diff = x[off + i] - mean;
        varSum += diff * diff;
      }
      const invStd = 1.0 / Math.sqrt(varSum / D_MODEL + LAYER_NORM_EPS);
      for (let i = 0; i < D_MODEL; i++) {
        x[off + i] = (x[off + i] - mean) * invStd * norm2Weight[i] + norm2Bias[i];
      }
    } else {
      layerNormInPlace(x, norm2Weight, norm2Bias);
    }
  }

  // 3. Gather current note token (index 5) and run output head (Gemm transB=1)
  const curOff = 5 * D_MODEL;
  const logits = new Float32Array(5);
  const { outputHeadWeight, outputHeadBias } = weights;
  for (let j = 0; j < 5; j++) {
    let sum = outputHeadBias[j];
    const wOff = j * D_MODEL;
    for (let k = 0; k < D_MODEL; k++) {
      sum += x[curOff + k] * outputHeadWeight[wOff + k];
    }
    logits[j] = sum;
  }

  return logits;
}

/**
 * Create a `FingeringPrior` instance backed by parsed left & right hand Lumikey weights.
 */
export function createLumikeyPrior(models: {
  left: LumikeyHandWeights;
  right: LumikeyHandWeights;
}): FingeringPrior {
  const scratch = createForwardScratchBuffers();

  return {
    logProbs(
      hand: Hand,
      notes: readonly PriorNoteInput[],
      history?: Readonly<Record<string, Finger>>
    ): Float32Array {
      const weights = hand === "LH" ? models.left : models.right;
      const out = new Float32Array(notes.length * 5);
      if (notes.length === 0) return out;

      const fingerLastMidi = [-1, -1, -1, -1, -1];
      const fingerLastTimeSec = [Infinity, Infinity, Infinity, Infinity, Infinity];

      for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        const currentTime = note.timeMs;
        const currentMidi = note.midi;

        // Build lookahead from next 20 notes
        const lookahead: LookaheadTokenNote[] = [];
        const end = Math.min(i + 21, notes.length);
        for (let k = i + 1; k < end; k++) {
          const futureNote = notes[k];
          const timeUntil = futureNote.timeMs - currentTime;
          // Only explicit user/score anchors act as lookahead hints (matches upstream semantics)
          const futureAnchor = futureNote.anchorFinger;
          const fingerHint =
            futureAnchor !== undefined && futureAnchor >= 1 && futureAnchor <= 5
              ? futureAnchor - 1
              : null;
          lookahead.push({
            midi: futureNote.midi,
            timeUntil,
            finger: fingerHint,
          });
        }

        const tokens = buildLumikeyTokens(
          currentMidi,
          fingerLastMidi,
          fingerLastTimeSec,
          lookahead
        );
        const logits = forwardLumikeyLogits(weights, tokens, scratch);
        const logP = logitsToLogProbs(logits);
        out.set(logP, i * 5);

        // Determine finger used to advance per-finger state:
        // 1. Explicit anchorFinger takes priority
        // 2. Teacher-forced `history[noteUid]` (round 2) if provided
        // 3. Otherwise greedy argmax(logits) (round 1)
        const historyFinger = history?.[note.noteUid];
        const chosenFinger: Finger =
          note.anchorFinger ??
          (historyFinger !== undefined && historyFinger >= 1 && historyFinger <= 5
            ? historyFinger
            : argmax5(logits));

        const fingerIdx = chosenFinger - 1;
        fingerLastMidi[fingerIdx] = currentMidi;
        const durationSec = (note.durationMs ?? 100) / 1000.0;
        fingerLastTimeSec[fingerIdx] = -durationSec; // negative = still holding

        if (i + 1 < notes.length) {
          const dtSec = (notes[i + 1].timeMs - currentTime) / 1000.0;
          for (let f = 0; f < 5; f++) {
            if (fingerLastTimeSec[f] !== Infinity) {
              fingerLastTimeSec[f] += dtSec;
            }
          }
        }
      }

      return out;
    },
  };
}
