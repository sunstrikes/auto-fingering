import type {
  BuildAttributes,
  BuildMeasure,
  BuildNote,
  ScoreBuildModel,
} from "./types";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderAttributes(attrs: BuildAttributes, staves: 1 | 2): string[] {
  const lines: string[] = ["      <attributes>"];
  if (attrs.divisions !== undefined) {
    lines.push(`        <divisions>${attrs.divisions}</divisions>`);
  }
  if (attrs.fifths !== undefined) {
    lines.push("        <key>");
    lines.push(`          <fifths>${attrs.fifths}</fifths>`);
    if (attrs.mode) {
      lines.push(`          <mode>${attrs.mode}</mode>`);
    }
    lines.push("        </key>");
  }
  if (attrs.beats !== undefined && attrs.beatType !== undefined) {
    lines.push("        <time>");
    lines.push(`          <beats>${attrs.beats}</beats>`);
    lines.push(`          <beat-type>${attrs.beatType}</beat-type>`);
    lines.push("        </time>");
  }
  if (attrs.staves !== undefined) {
    lines.push(`        <staves>${attrs.staves}</staves>`);
    lines.push('        <clef number="1">');
    lines.push("          <sign>G</sign>");
    lines.push("          <line>2</line>");
    lines.push("        </clef>");
    if ((attrs.staves ?? staves) >= 2) {
      lines.push('        <clef number="2">');
      lines.push("          <sign>F</sign>");
      lines.push("          <line>4</line>");
      lines.push("        </clef>");
    }
  }
  lines.push("      </attributes>");
  return lines;
}

function renderTempoDirection(bpm: number): string[] {
  const rounded = Math.round(bpm * 100) / 100;
  return [
    '      <direction placement="above">',
    "        <direction-type>",
    "          <metronome>",
    "            <beat-unit>quarter</beat-unit>",
    `            <per-minute>${rounded}</per-minute>`,
    "          </metronome>",
    "        </direction-type>",
    `        <sound tempo="${rounded}"/>`,
    "      </direction>",
  ];
}

function renderPedalDirection(type: "start" | "change" | "stop", staff: 1 | 2): string[] {
  return [
    '      <direction placement="below">',
    "        <direction-type>",
    `          <pedal type="${type}" line="yes"/>`,
    "        </direction-type>",
    `        <staff>${staff}</staff>`,
    "      </direction>",
  ];
}

function renderWedgeDirection(type: "crescendo" | "diminuendo" | "stop", staff: 1 | 2): string[] {
  return [
    '      <direction placement="below">',
    "        <direction-type>",
    `          <wedge type="${type}"/>`,
    "        </direction-type>",
    `        <staff>${staff}</staff>`,
    "      </direction>",
  ];
}

/**
 * Serializes a `<note>` element strictly respecting MusicXML 4.0 child-element ordering:
 * grace -> chord -> pitch|rest -> duration -> tie -> voice -> type -> dot -> stem -> staff -> notations.
 */
function renderNote(note: BuildNote, includeStaff: boolean): string[] {
  const lines: string[] = ["      <note>"];

  if (note.isGrace) {
    lines.push("        <grace/>");
  }
  if (note.isChord) {
    lines.push("        <chord/>");
  }

  if (note.kind === "rest" || !note.pitch) {
    lines.push(note.measureRest ? '        <rest measure="yes"/>' : "        <rest/>");
  } else {
    lines.push("        <pitch>");
    lines.push(`          <step>${note.pitch.step}</step>`);
    if (note.pitch.alter !== undefined && note.pitch.alter !== 0) {
      lines.push(`          <alter>${note.pitch.alter}</alter>`);
    }
    lines.push(`          <octave>${note.pitch.octave}</octave>`);
    lines.push("        </pitch>");
  }

  if (!note.isGrace) {
    lines.push(`        <duration>${note.duration}</duration>`);
  }

  if (note.tieStop) {
    lines.push('        <tie type="stop"/>');
  }
  if (note.tieStart) {
    lines.push('        <tie type="start"/>');
  }

  lines.push(`        <voice>${escapeXml(note.voice)}</voice>`);

  if (note.type) {
    lines.push(`        <type>${note.type}</type>`);
  }

  const dots = note.dots ?? 0;
  for (let d = 0; d < dots; d++) {
    lines.push("        <dot/>");
  }

  if (note.stem) {
    lines.push(`        <stem>${note.stem}</stem>`);
  }

  if (includeStaff) {
    lines.push(`        <staff>${note.staff}</staff>`);
  }

  const hasNotations =
    note.tieStop ||
    note.tieStart ||
    note.slurStop ||
    note.slurStart ||
    note.arpeggiate ||
    note.fingering !== undefined;
  if (hasNotations) {
    lines.push("        <notations>");
    if (note.tieStop) {
      lines.push('          <tied type="stop"/>');
    }
    if (note.tieStart) {
      lines.push('          <tied type="start"/>');
    }
    if (note.slurStop) {
      lines.push(`          <slur type="stop" number="${note.slurNumber ?? 1}"/>`);
    }
    if (note.slurStart) {
      lines.push(`          <slur type="start" number="${note.slurNumber ?? 1}"/>`);
    }
    if (note.arpeggiate) {
      lines.push("          <arpeggiate/>");
    }
    if (note.fingering !== undefined) {
      lines.push("          <technical>");
      lines.push(`            <fingering>${escapeXml(String(note.fingering))}</fingering>`);
      lines.push("          </technical>");
    }
    lines.push("        </notations>");
  }

  lines.push("      </note>");
  return lines;
}

interface MeasureDirection {
  tickOffset: number;
  lines: string[];
}

function renderMeasure(measure: BuildMeasure, staves: 1 | 2): string[] {
  const implicitAttr = measure.implicit ? ' implicit="yes"' : "";
  const lines: string[] = [`    <measure number="${escapeXml(measure.number)}"${implicitAttr}>`];

  if (measure.attributes) {
    lines.push(...renderAttributes(measure.attributes, staves));
  }

  const pendingDirections: MeasureDirection[] = [];
  for (const t of measure.tempos ?? []) {
    pendingDirections.push({
      tickOffset: t.tickOffset,
      lines: renderTempoDirection(t.bpm),
    });
  }
  for (const p of measure.pedals ?? []) {
    pendingDirections.push({
      tickOffset: p.tickOffset,
      lines: renderPedalDirection(p.type, p.staff ?? (staves === 2 ? 2 : 1)),
    });
  }
  for (const w of measure.wedges ?? []) {
    pendingDirections.push({
      tickOffset: w.tickOffset,
      lines: renderWedgeDirection(w.type, w.staff ?? 1),
    });
  }
  pendingDirections.sort((a, b) => a.tickOffset - b.tickOffset);
  let dirIdx = 0;

  // Group notes by voice, ordered by staff ascending then voice ascending
  const voiceMap = new Map<string, { staff: 1 | 2; notes: BuildNote[] }>();
  for (const note of measure.notes) {
    let entry = voiceMap.get(note.voice);
    if (!entry) {
      entry = { staff: note.staff, notes: [] };
      voiceMap.set(note.voice, entry);
    }
    entry.notes.push(note);
  }

  const orderedVoices = Array.from(voiceMap.entries()).sort((a, b) => {
    if (a[1].staff !== b[1].staff) return a[1].staff - b[1].staff;
    return Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]);
  });

  let cursor = 0;

  if (orderedVoices.length === 0) {
    while (dirIdx < pendingDirections.length) {
      const dir = pendingDirections[dirIdx++];
      if (dir.tickOffset > cursor) {
        const gap = dir.tickOffset - cursor;
        lines.push(`      <forward><duration>${gap}</duration></forward>`);
        cursor += gap;
      }
      lines.push(...dir.lines);
    }
    if (cursor < measure.duration) {
      lines.push(`      <forward><duration>${measure.duration - cursor}</duration></forward>`);
    }
  } else {
    for (let vIdx = 0; vIdx < orderedVoices.length; vIdx++) {
      const [, voiceData] = orderedVoices[vIdx];
      if (vIdx > 0 && cursor > 0) {
        lines.push(`      <backup><duration>${cursor}</duration></backup>`);
        cursor = 0;
      }

      for (const note of voiceData.notes) {
        const targetOffset =
          !note.isChord && note.onsetOffset !== undefined ? note.onsetOffset : cursor;

        if (vIdx === 0) {
          while (dirIdx < pendingDirections.length && pendingDirections[dirIdx].tickOffset <= targetOffset) {
            const dir = pendingDirections[dirIdx++];
            if (dir.tickOffset > cursor) {
              const gap = dir.tickOffset - cursor;
              lines.push(`      <forward><duration>${gap}</duration></forward>`);
              cursor += gap;
            }
            lines.push(...dir.lines);
          }
        }

        if (!note.isChord && targetOffset > cursor) {
          const gap = targetOffset - cursor;
          lines.push(`      <forward><duration>${gap}</duration></forward>`);
          cursor += gap;
        }

        lines.push(...renderNote(note, staves === 2));

        if (!note.isChord && !note.isGrace) {
          cursor += note.duration;
        }
      }

      if (cursor < measure.duration) {
        const remaining = measure.duration - cursor;
        lines.push(`      <forward><duration>${remaining}</duration></forward>`);
        cursor = measure.duration;
      }
    }

    // Flush any remaining mid-measure directions that fell between notes of voice 0
    while (dirIdx < pendingDirections.length) {
      const dir = pendingDirections[dirIdx++];
      if (dir.tickOffset < cursor) {
        lines.push(`      <backup><duration>${cursor - dir.tickOffset}</duration></backup>`);
        cursor = dir.tickOffset;
      } else if (dir.tickOffset > cursor) {
        lines.push(`      <forward><duration>${dir.tickOffset - cursor}</duration></forward>`);
        cursor = dir.tickOffset;
      }
      lines.push(...dir.lines);
    }
    if (cursor < measure.duration) {
      lines.push(`      <forward><duration>${measure.duration - cursor}</duration></forward>`);
    }
  }

  lines.push("    </measure>");
  return lines;
}

/**
 * Unified MusicXML 4.0 serializer.
 * Guarantees strict `<note>` child-element ordering, synchronized `<tie>`/`<tied>` tags,
 * and exact per-measure duration closure via `<backup>`/`<forward>`/`<voice>`.
 */
export function buildMusicXml(model: ScoreBuildModel): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    "  <work>",
    `    <work-title>${escapeXml(model.title)}</work-title>`,
    "  </work>",
    "  <part-list>",
    '    <score-part id="P1">',
    "      <part-name>Piano</part-name>",
    "    </score-part>",
    "  </part-list>",
    '  <part id="P1">',
  ];

  for (const measure of model.measures) {
    lines.push(...renderMeasure(measure, model.staves));
  }

  lines.push("  </part>");
  lines.push("</score-partwise>");
  return lines.join("\n");
}
