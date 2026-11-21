/**
 * Export @lumikey/piano-fingering-model ONNX initializers into compact Float32
 * binary files (`public/models/lumikey-prior-{left,right}.bin`) for the pure-TS
 * Transformer forward pass (`src/prior/lumikeyTransformer.ts`).
 *
 * Usage:
 *   node scripts/export-lumikey-weights.mjs [path/to/models/dir]
 */
import fs from "node:fs";
import path from "node:path";

const EXPECTED_TENSORS = [
  ["onnx::MatMul_570", 5 * 64],
  ["input_proj.bias", 64],
  // Layer 0
  ["onnx::MatMul_574", 64 * 192],
  ["transformer.layers.0.self_attn.in_proj_bias", 192],
  ["transformer.layers.0.self_attn.out_proj.weight", 64 * 64],
  ["transformer.layers.0.self_attn.out_proj.bias", 64],
  ["transformer.layers.0.norm1.weight", 64],
  ["transformer.layers.0.norm1.bias", 64],
  ["onnx::MatMul_582", 64 * 128],
  ["transformer.layers.0.linear1.bias", 128],
  ["onnx::MatMul_583", 128 * 64],
  ["transformer.layers.0.linear2.bias", 64],
  ["transformer.layers.0.norm2.weight", 64],
  ["transformer.layers.0.norm2.bias", 64],
  // Layer 1
  ["onnx::MatMul_584", 64 * 192],
  ["transformer.layers.1.self_attn.in_proj_bias", 192],
  ["transformer.layers.1.self_attn.out_proj.weight", 64 * 64],
  ["transformer.layers.1.self_attn.out_proj.bias", 64],
  ["transformer.layers.1.norm1.weight", 64],
  ["transformer.layers.1.norm1.bias", 64],
  ["onnx::MatMul_592", 64 * 128],
  ["transformer.layers.1.linear1.bias", 128],
  ["onnx::MatMul_593", 128 * 64],
  ["transformer.layers.1.linear2.bias", 64],
  ["transformer.layers.1.norm2.weight", 64],
  ["transformer.layers.1.norm2.bias", 64],
  // Layer 2
  ["onnx::MatMul_594", 64 * 192],
  ["transformer.layers.2.self_attn.in_proj_bias", 192],
  ["transformer.layers.2.self_attn.out_proj.weight", 64 * 64],
  ["transformer.layers.2.self_attn.out_proj.bias", 64],
  ["transformer.layers.2.norm1.weight", 64],
  ["transformer.layers.2.norm1.bias", 64],
  ["onnx::MatMul_602", 64 * 128],
  ["transformer.layers.2.linear1.bias", 128],
  ["onnx::MatMul_603", 128 * 64],
  ["transformer.layers.2.linear2.bias", 64],
  ["transformer.layers.2.norm2.weight", 64],
  ["transformer.layers.2.norm2.bias", 64],
  // Output head
  ["output_head.weight", 5 * 64],
  ["output_head.bias", 5],
];

function readVarint(buf, pos) {
  let res = 0;
  let shift = 0;
  while (true) {
    const b = buf[pos++];
    res += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [res, pos];
    shift += 7;
  }
}

function parseFields(buf, start = 0, end = buf.length) {
  let pos = start;
  const fields = [];
  while (pos < end) {
    const [tag, nextPos] = readVarint(buf, pos);
    pos = nextPos;
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (wireType === 0) {
      const [val, p2] = readVarint(buf, pos);
      pos = p2;
      fields.push([fieldNum, wireType, val]);
    } else if (wireType === 1) {
      fields.push([fieldNum, wireType, buf.subarray(pos, pos + 8)]);
      pos += 8;
    } else if (wireType === 2) {
      const [len, p2] = readVarint(buf, pos);
      pos = p2;
      fields.push([fieldNum, wireType, buf.subarray(pos, pos + len)]);
      pos += len;
    } else if (wireType === 5) {
      fields.push([fieldNum, wireType, buf.subarray(pos, pos + 4)]);
      pos += 4;
    } else {
      throw new Error(`Unsupported wireType ${wireType}`);
    }
  }
  return fields;
}

export function extractOnnxInitializers(onnxBuffer) {
  const top = parseFields(onnxBuffer);
  const graphEntry = top.find(([fn]) => fn === 7);
  if (!graphEntry) throw new Error("Missing GraphProto in ONNX buffer");
  const graphFields = parseFields(graphEntry[2]);
  const inits = graphFields.filter(([fn]) => fn === 5).map(([, , v]) => v);
  const tensors = new Map();
  for (const ib of inits) {
    const tf = parseFields(ib);
    let name = "";
    let rawData = null;
    for (const [fn, , v] of tf) {
      if (fn === 8) name = Buffer.from(v).toString("utf8");
      if (fn === 9) rawData = v;
    }
    if (name && rawData) {
      tensors.set(name, rawData);
    }
  }
  return tensors;
}

export function buildLumikeyWeightBin(onnxBuffer) {
  const tensors = extractOnnxInitializers(onnxBuffer);
  const chunks = [];
  const header = Buffer.alloc(8);
  header.write("LKP1", 0, "ascii");
  header.writeUInt32LE(1, 4);
  chunks.push(header);

  for (const [name, floatCount] of EXPECTED_TENSORS) {
    const raw = tensors.get(name);
    if (!raw) throw new Error(`Missing initializer ${name}`);
    if (raw.length !== floatCount * 4) {
      throw new Error(`Initializer ${name} size mismatch: ${raw.length} != ${floatCount * 4}`);
    }
    chunks.push(Buffer.from(raw));
  }
  return Buffer.concat(chunks);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const srcDir = process.argv[2] || "/tmp/lk/package/models";
  const outDir = path.resolve(process.cwd(), "public/models");
  fs.mkdirSync(outDir, { recursive: true });
  for (const hand of ["left", "right"]) {
    const onnxPath = path.join(srcDir, `fingering_transformer_${hand}.onnx`);
    const onnxBuf = fs.readFileSync(onnxPath);
    const binBuf = buildLumikeyWeightBin(onnxBuf);
    const outPath = path.join(outDir, `lumikey-prior-${hand}.bin`);
    fs.writeFileSync(outPath, binBuf);
    console.log(`Exported ${outPath} (${binBuf.length} bytes)`);
  }
}
