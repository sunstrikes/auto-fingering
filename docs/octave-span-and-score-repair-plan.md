# 钢琴指法「纯八度上限极限惩罚」与「乐谱可演奏性自动诊断修复」优化方案

- **状态**：`draft / approved-for-implementation`
- **日期**：`2026-11-19`
- **关联范围**：`src/solver/`、`src/domain/`、`src/musicxml/`、`src/components/`、`src/store/`、`tests/`

---

## 1. 问题背景与第 69 小节左手根因定位

### 1.1 现象还原

在浏览器（`0.25x` 慢放、第 69 小节）中，当右手弹奏 `Ab4 + Db5 + Ab5` 的同一拍上，左手 88 键手势模拟出现了 **三指同时物理按住琴键**：

- `5` 指（保持）：`E2`（MIDI `40`，`keyPos = 16.5`，白键单位 `11.5`）
- `2` 指（保持）：`E3`（MIDI `52`，`keyPos = 23.5`，白键单位 `18.5`）
- `1` 指（击键）：`Ab3`（MIDI `56`，`keyPos = 26.0`，白键单位 `21.0`）

其中：
- `E2 → Ab3` 为 **16 半音 / `9.5` 白键单位（大十度）**，远超人手物理极限（纯八度 `12` 半音 / `7.0` 白键单位）；
- `E2 → E3` 为 **12 半音 / `7.0` 白键单位（纯八度）**，但用 **`5–2` 指**去撑满一个纯八度同样严重违背解剖极限。

### 1.2 代码根因定位（共 4 处）

1. **最大跨度表本身允许 > 8 度**（[`src/solver/keyboard.ts`](../src/solver/keyboard.ts)）
   - 在 `keyPos` 连续坐标系下，所有音域上的**纯八度**（12 半音）差值恒为精确 **`7.0` 白键单位**，小九度（13 半音）起恒 **`≥ 7.416`**。
   - 现有 `BASE_MAX_SPAN["1,5"] = 8.3`（`M` 档允许大九度），`L` 档乘以 `SPAN_PRESET_SCALE.L = 1.18` 后更是达到 **`9.794`**（大十度 / 小十一度），且 `L` 档 `2–5` 达到 `6.0 * 1.18 = 7.08 >= 7.0`。因此 `L` 档下 `E2(5) + E3(2) + Ab3(1)` 甚至呈现“零超限”，连 [`analyzeHandHeldNotes`](../src/solver/heldNotes.ts) 都不会释放 `E2`。
2. **超跨度惩罚过轻且封顶，且横向扩指存在 `5.5` 盲区**（[`src/solver/costModel.ts`](../src/solver/costModel.ts)、[`src/solver/weights.json`](../src/solver/weights.json)）
   - `overSpanBase = 250.0`、`overSpanCap = 120.0`，封顶仅 `370.0`（再乘 `heldShapeWeight = 0.6` 后仅 `~222`），**低于 `heldStealPenalty = 400.0`**，远低于 `IMPOSSIBLE_COST = 1e6`。
   - `evaluateDirectedNoteTransition` 中快速扩指检测受限于 `absD <= 5.5 * scale`，导致快速连接一个纯八度（`absD = 7.0 > 5.5`，例如 `E2(5) → E3(2)`）被直接跳过 `fastOverSpan` 检查。
3. **保留音分析器缺少硬八度封顶与两两互检**（[`src/solver/heldNotes.ts`](../src/solver/heldNotes.ts)）
   - `analyzeHandHeldNotes` 仅以未封顶的 `getMaxSpan(1, 5, scale)` 单独校验老保留音与当前击键的跨度，未对多个同时保持音之间做两两互检，也未施加硬 `7.0` 八度封顶。
4. **手势渲染层的视觉最小时长造成“假保持”重叠与运行时缺少跨度不变量护栏**（[`src/components/handPostureModel.ts`](../src/components/handPostureModel.ts)）
   - `buildHandIndex` 强制 `endSec = Math.max(ev.onsetSec + 0.08, rawEnd)`（倚音则固定 `GRACE_VISUAL_SEC = 0.09`）。若原谱 `E2`/`E3` 为极短时值快琶音或滚奏（在 `Ab3` 前已结束，不在 `Ab3` 切片的 `heldNotes` 中），`buildHandIndex` 不会为其记录释放点，但 `0.08s`/`0.09s` 视觉下限仍会让音符窗口越过 `Ab3` 起音时刻，在 `0.25x` 慢放时清晰定格为三指硬撑。
   - `buildHandIndex` 的兜底防碰撞检查仅对比了 `activeHeldBySlice[t]` vs `slice.notes`，漏掉了 **两两 `activeHeld` 之间**（如 `E2(5)` vs `E3(2)`）。
   - `projectSingleHandPosture` 收集 `activeByFinger` 后缺少最终的物理跨度不变量护栏。

---

## 2. 已确认的核心决策

1. **八度硬上限策略（覆盖 S / M / L 全档位）**：
   - `S / M / L` 全部档位均硬封顶在纯八度（`≤ 7.0` 白键 / `12` 半音）；`L` 档仅放宽**八度以内**的内指舒适跨度，任何超出纯八度的指对或手位组合在求解器与手势层均施加极限惩罚 / 禁止保持。
2. **分阶段一次性落地规划**：
   - **阶段一**：全链路 `> 8 度` 极限负惩罚 + 第 69 小节根因彻底修复；
   - **阶段二**：推导期自动检测明显不可弹和弦 / 异常乐谱（如超过 8 度、> 5 音、AI 扒谱长延音粘连），生成候选修复方案并在界面给出位置提示，用户同意后通过无损 MusicXML DOM 编辑一键替换并自动重算指法。
3. **乐谱修复支持的全部 4 类策略**：
   1. **跨手分担（`hand-redistribution`）**：双谱表下另一只手同拍可达时转移部分声部音符，零音符损失；
   2. **八度折叠 / 去冗余重复八度（`octave-fold-thin`）**：如将 `E2+E3+Ab3` 折叠保留核心和声至八度以内（如 `E2+Ab2+E3`）或删去冗余重复八度；
   3. **标记琶音滚奏（`arpeggiate`）**：在 MusicXML 中写入 `<notations><arpeggiate/>`，完整保留全部原音高；
   4. **裁剪异常过长延音（`clip-duration`）**：针对 AI 扒谱因踏板粘连导致音符时值过长的问题，将其安全裁剪至物理抬指拍点。

---

## 3. 学术文献参考

1. **E. Nakamura & K. Yoshii (2018)**, *"Statistical Piano Reduction Controlling Performance Difficulty"*, *APSIPA Transactions on Signal and Information Processing*, Vol. 7, E13 ([arXiv:1808.05006](https://arxiv.org/abs/1808.05006)).
   - 在音乐保真度与可演奏难度约束（含手跨度、指法运动代价）之间做统计优化：当原和弦超出目标跨度时执行删冗余音、八度折叠或重新分声部。
2. **E. Nakamura, N. Ono, S. Sagayama (2014)**, *"Merged-Output HMM for Piano Fingering of Both Hands"* (*ISMIR 2014*) & **E. Nakamura, Y. Saito, K. Yoshii (2020)**, *"Statistical Learning and Estimation of Piano Fingering"* (*Information Sciences*).
   - 双手联合指法与分部（hand assignment）联合建模框架。
3. **F. Foscarin, E. Karystinaios, E. Nakamura, G. Widmer (2024)**, *"Cluster and Separate: A GNN Approach to Voice and Staff Prediction for Score Engraving"* (*ISMIR 2024 Best Paper Nominee*).
   - 说明大量单手超八度“错和弦”源于声部 / 左右手谱表划分错误，可通过联合代价模型识别最优跨手重分配。
4. **S.-C. Chiu, M.-K. Shan, J.-L. Huang (2009)**, *"Automatic System for the Arrangement of Piano Reductions"* (*IEEE ISM 2009*, pp. 459–464).
   - 将单手最大跨度与 `≤ 5` 音作为硬约束，通过声位压缩与去冗余保证物理可演奏性。
5. **M. Suzuki (2023)**, *"Piano score rearrangement into multiple difficulty levels via notation-to-notation approach"* (*EURASIP J. Audio, Speech, and Music Processing*) & **P. Ramoneda, E. Parada-Cabaleiro, D. Jeong, X. Serra (2025)**, *"Difficulty-Controlled Simplification of Piano Scores with Synthetic Data for Inclusive Music Education"* ([arXiv:2511.16228](https://arxiv.org/abs/2511.16228)).
   - 直接面向 MusicXML 符号记谱域实施和弦化简、八度压缩与琶音处理，保证修改后的乐谱无损可读。
6. **Q. Kong et al.**, *"High-resolution Piano Transcription with Pedals by Regressing Onset and Offset Times"*.
   - 分析自动钢琴扒谱中延音踏板导致的音符 offset 过长粘连误差及其边界裁剪修复思路。
7. **Ramani (2026)**, *"A Comprehensive Corpus of Biomechanically Constrained Piano Chords: Generation, Analysis, and Implications for Voicing and Psychoacoustics"* ([arXiv:2603.29710](https://arxiv.org/abs/2603.29710)).
   - 基于生物力学手跨度约束建模可行和弦空间与声位评估。

---

## 4. 阶段一详细设计（全链路 `> 8 度` 极限惩罚 + 第 69 小节修复）

### 4.1 [`src/solver/keyboard.ts`](../src/solver/keyboard.ts)：硬八度上限与内指跨度表

1. 新增导出常量：
   - `MAX_OCTAVE_SPAN = 7.0`（纯八度 `12` 半音精确值）
   - `MAX_OCTAVE_SEMITONES = 12`
2. 定义各指对解剖硬上限 `MAX_SPAN_CEILING: Record<string, number>`：
   - `"1,5": 7.0`、`"1,4": 7.0`、`"1,3": 6.8`、`"1,2": 6.5`
   - `"2,5": 6.5`（严格 `< 7.0`，即使 `L` 档也禁止 `5–2` 撑满 `E2–E3` 纯八度）
   - `"2,4": 5.5`、`"3,5": 5.2`、`"2,3": 3.5`、`"3,4": 3.0`、`"4,5": 3.2`
3. 职责拆分：
   - `getMaxSpan(fLow, fHigh, scale)` 返回 `Math.min((BASE_MAX_SPAN[key] ?? 8.3) * scale, MAX_SPAN_CEILING[key] ?? MAX_OCTAVE_SPAN)`：
     - `S (0.82×)`：`1–5 = 6.806`、`2–5 = 4.92`（纯八度预警，七度可弹）
     - `M (1.00×)`：`1–5 = 7.0`、`2–5 = 6.0`（纯八度可弹，严禁 `> 7.0`）
     - `L (1.18×)`：`1–5 = 7.0`、`1–4 = 7.0`、`2–5 = 6.5`（外跨度同样硬封顶在纯八度，仅放宽八度以内各指对跨度）
   - 新增 `getComfortSpan(fLow, fHigh, scale)`（保留 `(BASE_MAX_SPAN[key] ?? 8.3) * scale` 原始缩放）专供 `wide-stretch` 黄色预警阈值判断，避免 `M` / `L` 档下正常 `1–5` 纯八度（`7.0 >= 0.85 * 7.0`）误触发刷屏黄色警告，同时保持 `S > M > L` 的内指宽跨度预警递减梯次。

### 4.2 [`src/solver/costModel.ts`](../src/solver/costModel.ts)：`> 8 度` 极限惩罚与横向扩指盲区修复

1. **强化 `computePairwiseSpanCost`**：
   - 对 **任何 `dist > MAX_OCTAVE_SPAN + 1e-6`（即 `> 8 度`）**：
     - 立即施加 `IMPOSSIBLE_COST + over * 1000 + (5 - Math.abs(fB - fA)) * 100` 极限负惩罚，并标记 `hasUnreachableSpan = true`。
     - 该惩罚量级（`≥ 1,000,000`）远超 `heldStealPenalty (400)` 及一切常规横向代价，从数学上保证 DP / A* 绝不主动选择超过八度的保持/转移组合；同时当原谱被迫出现硬核大十度同拍和弦（如 `C3+E5`）且全候选都超八度时，`(5 - |fB - fA|) * 100` 依然能确保外声部稳定选择 `1` 指和 `5` 指作为唯一最优降级解。
   - 对 **八度以内但超过指对极限**（如 `5–2` 撑纯八度 `7.0 > getMaxSpan(2, 5, scale)`）：
     - 将基础惩罚提高至大于 `heldStealPenalty * 2`（例如 `800 + over * 120 + over * vw.overSpanTiebreaker`），确保求解器不会为了避免 `heldStealPenalty` 而硬凑 `5–2` 八度或畸形内指拉伸。
   - [`src/solver/weights.json`](../src/solver/weights.json) 保留现有 `heldStealPenalty: 400` 等基准权重，避免破坏已有单测预期。
2. **修复 `evaluateDirectedNoteTransition` 横向扩指盲区**：
   - 将快速同向超跨度检查（`fastOverSpan` / `fastWideStretch`）从原 `absD <= 5.5 * scale` 块中独立出来，**仅要求 `absD > 0.2` 且同向增减（`d > 0 && currFinger > prevFinger` 或 `d < 0 && currFinger < prevFinger`）** 且 `absD <= MAX_OCTAVE_SPAN * scale` 或触发八度校验：
     - 快速纯八度（`dt < 0.2s`）用不合理的内指组合（如 `5 → 2`）将正确命中 `fastOverSpan` + `hasUnreachableSpan = true`；
     - 软性距离偏差 `stretchDeviation` / `crampLinear` 仍保留在 `absD <= 4.0 * scale` 内，以免干扰常规换把。

### 4.3 [`src/solver/heldNotes.ts`](../src/solver/heldNotes.ts)：保留音分析器加强

1. 在 `analyzeHandHeldNotes` 中强制 `maxOuterSpan = Math.min(getMaxSpan(1, 5, scale), MAX_OCTAVE_SPAN)`（确保 `S / M / L` 均 `≤ 7.0`）。
2. 在 Pass 1 / Pass 2 中新增**联合保持音集合互检**：
   - 除检查单个保持音 `h` 与当前击键包络 `[bounds.minPos, bounds.maxPos]` 是否超过 `maxOuterSpan` 外，还按从新到旧（`onsetTick` 降序）依次检查多个同时活跃保持音两两之间的跨度；
   - 一旦更早按下的老保持音（如第 69 小节 `E2`）与当前击键（`Ab3`）或与后按下的新保持音构成 `> maxOuterSpan`，立即将老保持音单调释放（`unreachable` / 提前进入高伸展时 `pre-release`），杜绝多保持音残留冲突。

### 4.4 [`src/components/handPostureModel.ts`](../src/components/handPostureModel.ts)：视觉防假重叠与运行时跨度护栏

1. **加强 `buildHandIndex`**：
   - 在已有 `held` vs `struck` 碰撞/超跨度校验基础上，补充 **两两 `activeHeld` 之间**的 `getMaxSpan` 与重指互检，并统一叠加 `MAX_OCTAVE_SPAN` 封顶，保证 `E2(5)` + `E3(2)` 这类不合法双保持音一定释放更早的 `E2`。
   - 新增**短时值 / 倚音视觉窗口越界裁切**：当某个音符因为 `Math.max(ev.onsetSec + 0.08, rawEnd)` 或 `GRACE_VISUAL_SEC (0.09)` 被拉长，导致视觉 `endSec` 跨过了同手后续切片 `nextSlice.onsetSec`（而逻辑时值本身已结束、并未出现在 `nextSlice.heldNotes` 中），若该音符与后续切片的指法存在同指复用或超过 `Math.min(getMaxSpan(...), MAX_OCTAVE_SPAN)` 冲突，则自动将 `fingerEndSec` 裁切至 `nextSlice.onsetSec - 0.005`（彻底消除 `0.25x` 慢放下因 `0.08s` 视觉下限带来的三指假同按）。
2. **增加 `projectSingleHandPosture` 运行时物理跨度不变量护栏**：
   - 从时间窗口收集完 `activeByFinger` 后，以当前切片新击键音符为基准（不可退让），其余历史保持音按 `onsetSec` 从新到旧逐个校验；
   - 任何与已保留活跃音符违反 `Math.min(getMaxSpan(fA, fB, handScale), MAX_OCTAVE_SPAN)` 或产生不可达指序倒置的历史保持音，强制从 `activeByFinger` 中移除抬指并转入 `pedalSustainedMap`（保留 88 键键盘的虚线踏板延音高亮）。

### 4.5 [`src/solver/solveFingering.ts`](../src/solver/solveFingering.ts) & [`src/components/PracticeSettingsModal.tsx`](../src/components/PracticeSettingsModal.tsx)

- [`src/solver/solveFingering.ts`](../src/solver/solveFingering.ts) 中 `derivePositionsAndCues`：
  - 使用硬封顶后的 `getMaxSpan` 检测 `unreachable-span`，使用 `getComfortSpan` 计算 `wide-stretch`（0.85 阈值），并考虑 [`NoteEvent.isArpeggiated`](#51-domain-数据模型与-musicxml-解析扩展)（显式标记 `<arpeggiate/>` 的和弦不重复报危险红色超跨度，改为 `info` 或提示级）。
- [`src/components/PracticeSettingsModal.tsx`](../src/components/PracticeSettingsModal.tsx)：
  - 将 `SPAN_PRESETS` 中 `L` 档提示从 `"大手型（允许更大八度/九度扩张，1.18×）"` 更新为 `"大手型（上限纯八度，放宽八度内内指跨度，1.18×）"`。

---

## 5. 阶段二详细设计（不可弹和弦 / 乐谱问题诊断与用户确认替换）

### 5.1 Domain 数据模型与 MusicXML 解析扩展

1. **[`src/domain/types.ts`](../src/domain/types.ts)**：
   - `NoteEvent` 新增可选字段 `isArpeggiated?: boolean`。
   - 新增纯 JSON（Web Worker 可克隆）类型定义：
     ```ts
     export type ScoreRepairStrategy =
       | "hand-redistribution"
       | "octave-fold-thin"
       | "arpeggiate"
       | "clip-duration";

     export type ScoreRepairIssueKind =
       | "chord-over-octave"
       | "chord-exceeds-5"
       | "held-over-octave";

     export type ScoreRepairNoteEdit =
       | {
           kind: "reassign-hand";
           noteUid: string;
           targetHand: Hand;
         }
       | {
           kind: "change-pitch";
           noteUid: string;
           oldMidi: number;
           newMidi: number;
         }
       | {
           kind: "remove-note";
           noteUid: string;
         }
       | {
           kind: "add-arpeggiate";
           noteUid: string;
         }
       | {
           kind: "clip-duration";
           noteUid: string;
           newDurationTick: number;
         };

     export interface ScoreRepairOption {
       optionId: string;
       strategy: ScoreRepairStrategy;
       label: string;
       description: string;
       fidelityScore: number; // 保真度评分，越高越优先推荐
       previewSummary: string; // e.g. "LH E2+E3 | RH Ab3+..." 或 "E2+Ab2+E3"
       edits: ScoreRepairNoteEdit[];
     }

     export interface ScoreRepairSuggestion {
       repairId: string;
       measureIndex: number; // 0-based
       sliceId: string;
       hand: Hand;
       onsetTick: number;
       issueKind: ScoreRepairIssueKind;
       summary: string; // e.g. "第69小节 · 左手 · E2+E3+Ab3 (16半音)"
       maxSemitones: number;
       options: ScoreRepairOption[]; // 按 fidelityScore 降序，options[0] 为首选推荐
     }
     ```
   - `SolveResult` 新增可选字段 `repairSuggestions?: ScoreRepairSuggestion[]`。
2. **[`src/musicxml/parser.ts`](../src/musicxml/parser.ts)**：
   - 解析 `<notations><arpeggiate/>`（或 `<notations><non-arpeggiate>` 之外的标准琶音记号）设置 `event.isArpeggiated = true`。

### 5.2 纯 TS 乐谱修复分析器（新增 `src/solver/scoreRepair.ts`，零 DOM 依赖）

在 `solveFingering` 与 `localResolveFingering` 末尾调用 `analyzeScoreRepairSuggestions(onsetSlices, profile)`：

1. **三类问题扫描**：
   - `chord-over-octave`：同拍切片内（非全部已标记 `isArpeggiated`）任意两音 `Math.abs(posB - posA) > MAX_OCTAVE_SPAN + 1e-6`（即 `> 12` 半音）；
   - `chord-exceeds-5`：同拍切片 `notes.length > 5` 且无法满足 6 音相邻二度兼按；
   - `held-over-octave`：非 `pedalSustained` 的长保留音在后续拍导致 `Math.abs(posHeld - posNote) > MAX_OCTAVE_SPAN + 1e-6`。
2. **四类策略生成与保真度排序**：
   - **策略 1：`hand-redistribution`（跨手分担，优先级最高）**
     - 仅在双谱表乐谱（同时出现过 RH 与 LH 切片，非单谱表模式）启用；
     - 检索同拍对侧手切片与活跃保持音状态，尝试将左手超八度高音移至右手（或将右手超八度低音移至左手）；
     - 约束校验：移交后原手包络 `≤ MAX_OCTAVE_SPAN` 且 `≤ 5` 音，目标手含新音与活跃保持音后的总跨度 `≤ MAX_OCTAVE_SPAN` 且 `≤ 5` 音，且不破坏同拍手部基本音高秩序；
     - 零音高/和声损失。
   - **策略 2：`octave-fold-thin`（八度折叠 / 去冗余重复八度）**
     - **情况 A（和弦内存在同音级八度重复，如 `E2 + E3 + Ab3`）**：
       - **首选折叠保留低音与全和声**：保留最低根音 `E2` 确定低音功能，将超八度内声/高音向下折叠 1 个八度并去重（如 `Ab3 (56) → Ab2 (44)`，得到 `E2+Ab2+E3`，精确纯八度且不丢音级）；
       - **备选去冗余八度**：若保留声部跨度已 `≤ MAX_OCTAVE_SPAN` 且不改变外声部骨架，生成移除冗余重复八度低音/内音选项（如去掉最低冗余 `E2` 得 `E3+Ab3`）。
     - **情况 B（无同音级重复的超八度和弦，如 `C3 + G3 + E4`、`Eb4 + Bb4 + F5`）**：
       - 左手：保留最低根音，将其余超八度音高向下折叠若干八度直至落入 `[root, root + 12]` 区间并去重；
       - 右手：保留最高旋律音，将其余超八度音高向上折叠至 `[top - 12, top]` 区间并去重；
       - 仅输出折叠后外跨度 `≤ MAX_OCTAVE_SPAN`、无撞音且至少保留 2 个不同音级的方案。
   - **策略 3：`arpeggiate`（标记琶音滚奏）**
     - 针对 `chord-over-octave` 与 `chord-exceeds-5`，对切片内全部未标琶音的同拍音符生成 `add-arpeggiate` 编辑，保留 100% 原音高。
   - **策略 4：`clip-duration`（裁剪异常过长延音）**
     - 针对 `held-over-octave`（AI 扒谱常见踏板粘连导致的长音），计算从该音 `onsetTick` 到首个超八度冲突拍 `conflictSlice.onsetTick` 的安全持续刻度 `newDurationTick = conflictSlice.onsetTick - onsetTick`（要求 `newDurationTick > 0`），生成裁剪建议；对于跨小节 tie 链，裁剪时在修复写入器侧协同处理截断点后的多余延续。

### 5.3 无损 MusicXML 4.0 DOM 修复写入器（新增 `src/musicxml/repairWriter.ts`）

导出 `applyScoreRepairToXml(rawXmlText, scoreDoc, option, deps)`：基于最新 `rawXmlText` 解析独立 `XMLDocument` 副本后，通过 `scoreDoc.noteEvents` / `scoreDoc.noteElementsByUid` 的结构位置定位目标 `<note>` 元素执行 XSD 合规修改并序列化，绝不破坏其他音符的 `<fingering>`、`<slur>`、`<lyric>`、`<direction>`：

1. **`add-arpeggiate`**：复用 `notations` XSD 顺序插入规则（插入于 `<lyric>/<play>/<listen>` 之前），在 `<notations>` 内安全追加 `<arpeggiate/>`（不破坏同级 `<tied>` / `<slur>` / `<technical>`）。
2. **`change-pitch`**：更新目标 `<note><pitch>` 下的 `<step>` / `<alter>` / `<octave>`（参照当前小节/调号 `<fifths>` 选择合理等音拼写），并移除旧 `<accidental>` 或按需要调整，避免乐谱显示冲突升降号。
3. **`remove-note`**：
   - 若被删音符是和弦首音（无 `<chord/>`），检查同一小节紧邻其后的同一声部兄弟 `<note>`：若下一音符带有 `<chord/>`，剥离该兄弟节点的 `<chord/>` 子元素并使其继承游标推进，确保小节后续音符时间游标严格不变；
   - 若被删音符本身带有 `<chord/>`，直接安全移除；
   - 若为延音链起点（`isTieStart`），同步移除后续关联 `TieContinuation` 或将独奏声部替换为等长休止符。
4. **`reassign-hand`（跨手分担）**：
   - **路径 A（目标手同拍已有等时值音符/和弦）**：从源和弦按 `remove-note` 规则安全摘除该音；在目标手同拍和弦末尾克隆插入一个带 `<chord/>`、继承目标手 `<staff>` 与 `<voice>` 的新 `<note>`，总游标变化严格为 `0`。
   - **路径 B（目标手同拍无等时值音符，单 part 双谱表）**：在源音（及同拍其余和弦音）之后记录持续时间 `D`，在同拍后插入 `<backup><duration>D</duration></backup>` + 移轨 `<note>`（设置目标 `<staff>` 及不与源手碰撞的独立新 `<voice>`），再若原小节游标停留在同拍末尾则无需额外 `<forward>`，保证整个 `<measure>` 游标数学严格守恒；并避免使用已有相反 `<staff>` 主导的 voice 号，防止被 [`src/musicxml/parser.ts`](../src/musicxml/parser.ts) 的跨谱表 `>= 70%` 规则覆盖还原。
5. **`clip-duration`（裁剪异常延音）**：
   - 先验证在小节当前 `<divisions>` 下目标 `newDurationTick` 与剩余差值 `restTick = oldDurationTick - newDurationTick` 均可表示为有效整分数时长；若跨小节 tie 链在截断点前已结束部分 `<measure>`，则：
     - 将截断点所在小节内的目标音 `<duration>` 更新为局部保留刻度（并同步合法 `<type>` / `<dot/>`、去掉不再延续的 `<tie type="start"/>` / `<tied type="start"/>`），在其同声部后紧接插入 `<note><rest/><duration>...</duration><voice>...</voice><staff>...</staff></note>`（如为和弦音内局部短化则在声部结尾补位或使用独立备份声部），并将截断点之后的孤立 `TieContinuation` `<note>` 替换为等长 `<rest/>`，确保每一小节时值守恒、可被 MuseScore / OSMD / 本工具正常重解析。

### 5.4 状态管理、Undo/Redo 与交互 UI

1. **[`src/store/useStudioStore.ts`](../src/store/useStudioStore.ts)**：
   - 扩展 `StudioSnapshot`（新增可选 `rawXmlText?: string`、`scoreDoc?: ScoreDocument`），新增 `applyScoreRepair` action；
   - `applyScoreRepair`：把修改前完整状态（`rawXmlText`、`scoreDoc`、`anchors`、`removedRawAnchorUids`、`solveResult`、`fingerByNoteUid`）压入 `history.past` 并清空 `future`，写入修复后 `rawXmlText`、`scoreDoc` 与重算后的 `solveResult` 并更新 `renderedXml`；
   - 更新 `undo` / `redo`：若快照含 `scoreDoc` / `rawXmlText` 则一并恢复并重绘，使得每次「同意替换」均可一键撤回/重做，且下载 `.musicxml` / `.mxl` 导出修改后乐谱。
2. **新增 [`src/components/ScoreRepairPanel.tsx`](../src/components/ScoreRepairPanel.tsx) & 接入 [`src/App.tsx`](../src/App.tsx)**：
   - 在顶部状态栏（紧邻预警数量与 `lastDiff` 下拉按钮）新增「**乐谱修复建议 N**」提示按钮（高风险超八度场景使用醒目琥珀/红徽标）；
   - 点击展开浮动列表，按小节顺序列出 `solveResult.repairSuggestions`（支持过滤会话内已忽略项）：
     - 每条清晰展示位置与问题（例如 `第69小节 · 左手 · E2+E3+Ab3（超八度 16 半音）`）；
     - 点击条目位置可自动调用 `handleSelectSlice` 跳到该小节并在 88 键键盘 / 五线谱上高亮定位；
     - 展示该位置生成的所有可行策略标签（如 `八度折叠 (推荐)`、`去冗余低音`、`跨手分担`、`标记琶音`、`裁剪延音`）与 `修改前 → 修改后` 预览；
     - 用户点击「**同意替换**」后：调用 `applyScoreRepairToXml` 生成新 XML → 调用 `parseMusicXml` + `solverClientRef.current.solve`（走 Web Worker）重新求解全曲（保留并清理失效锚点）→ `useStudioStore.getState().applyScoreRepair(...)` 提交并刷新 OSMD 谱面与 88 键手势；
     - 用户点击「**忽略**」则在本次会话内标记隐藏该 `repairId`（重新上传文件或手动撤回后可重置）。

---

## 6. 阶段三测试与验收计划

### 6.1 需同步调整的既有旧规格测试（4 处）

1. [`tests/solver.test.ts`](../tests/solver.test.ts#L181-L223)（`S/M/L` 跨度缩放测试）：
   - 纯八度 `C4–C5`（`7.0` 白键）：`S` 下标红 `unreachable-span`，`M` 与 `L` 下均为 `0 unreachable-span`；
   - 十度 `C4–E5`（`9.0` 白键）与小九度 `C4–Db5`（`7.416` 白键）：`S / M / L` 全部触发 `unreachable-span`（`> 8 度` 硬约束生效）；
   - 八度以内内指宽跨度（如 `C4–G4` 用 `1–2` 或 `E4–B4`）：验证预警数严格遵循 `S >= M >= L` 递减。
2. [`tests/solver.test.ts`](../tests/solver.test.ts#L474-L508)（`wide-stretch` 提示测试）：
   - 将原九度和弦 `E4 + F5` 替换为八度以内触发 `wide-stretch` 的宽跨度和弦（如 `C4 + Bb4` 在对应档位下 `>= 0.85 * comfortSpan` 且 `<= 7.0`），避免混淆成 `unreachable-span`。
3. [`tests/solver.test.ts`](../tests/solver.test.ts#L515-L565)（`05-realworld-wuchang.musicxml` 门禁）：
   - 保持 `solveTimeMs <= perfBudget(200)` 性能预算；
   - 10 度大跳小节在 `S / M / L` 下均被正确标记为 `unreachable-span`（符合新八度硬封顶契约）；
   - 调整 `S > M > L` 整体预警数与高危预警数分级断言（`L` 放宽八度以内内指及快速移动后仍显著低于 `M` 与 `S`）。
4. [`tests/solver.test.ts`](../tests/solver.test.ts#L804-L832)（`A*` 保持音前瞻测试）：
   - 将原九度 `C4..D5` 改为纯八度 `C4..C5`，依然验证首音 `C4` 必须选 `1` 指（若错选 `2` 指则在尾音 `C5` 触发 `2–5` 跨度超限）。

### 6.2 需新增的回归测试

1. [`tests/solver.test.ts`](../tests/solver.test.ts)：
   - **第 69 小节左手模型（`E2` 保持 + `E3` 保持 + `Ab3` 击键，覆盖 `S/M/L` 三档）**：验证任何超八度（`> 7.0`）指对组合均返回 `>= IMPOSSIBLE_COST`，保持音分析器在 `L` 档同样释放 `E2`，且不出现 `5–2` 硬撑 `E2–E3` 纯八度或超八度未报警情况；验证快速 `E2(5) → E3(2)` 不再绕过 `evaluateDirectedNoteTransition`。
2. [`tests/handPosture.test.ts`](../tests/handPosture.test.ts)：
   - **第 69 小节 `L` 档 + 短时值 `< 0.08s` 滚奏 + `0.25x` 慢放视觉测试**：验证在 `L` 档及极短音符跨拍边界时，左手在 `Ab3` 切片处 5 指自然抬起、`activeByFinger` 最大白键物理跨度严格 `<= 7.0`，且被释放的 `E2` 保持柔和踏板高亮而不扭曲手指骨骼。
3. **新增 `tests/scoreRepair.test.ts`**：
   - 验证 [`analyzeScoreRepairSuggestions`](../src/solver/scoreRepair.ts) 对 `chord-over-octave`（含第 69 小节 `E2+E3+Ab3`）、`chord-exceeds-5`、`held-over-octave` 均生成按保真度排序的候选方案（涵盖全部 4 类策略）；
   - 验证 [`applyScoreRepairToXml`](../src/musicxml/repairWriter.ts) 的全部 5 类 DOM 原子操作（含首音移除 `<chord/>` 继承、跨手转移 `<backup>` 游标与跨谱表 `>=70%` 规避、延音裁剪补 `<rest/>` 与孤立连音尾处理）后：小节总时值严格守恒、无多余 `xmlns=""`、重解析再求解彻底消除原超八度预警；
   - 验证 `useStudioStore` 的 `applyScoreRepair` + `undo` / `redo` 完整闭环。
4. [`tests/musicxml.test.ts`](../tests/musicxml.test.ts)：
   - 验证 `<notations><arpeggiate/>` 解析设置 `NoteEvent.isArpeggiated = true` 及导出保真。

### 6.3 最终验证命令

```bash
npm --prefix /Users/sunminqi/code/music/auto-fingering run typecheck
npm --prefix /Users/sunminqi/code/music/auto-fingering test
npm --prefix /Users/sunminqi/code/music/auto-fingering run build
```

---

## 7. 阶段四扩展：柱式/分解和弦转位几何先验与 12 调式音阶/琶音周期穿指优化（方案 1 + 方案 2）

针对 12 个大/小调全量基准测试中发现的**黑键调柱式和弦外框被 `thumbBlackAvoid` 误伤**、**三/四音和弦转位缺少音程开口结构先验**、**柱式和弦单候选剪枝无法避让保持音**，以及 **12 调式音阶中 `2↔1` 碎穿指压倒 `3+4` 标准周期穿指**问题，详细设计已独立归档至专项计划文件：

- 详见：[钢琴指法「柱式/分解和弦转位几何先验」与「12 调式音阶/琶音周期穿指」优化方案](./chord-and-scale-fingering-plan.md)

核心要点概览：
1. **方案 1（和弦指法优化）**：
   - **柱式和弦 `1–5` 外框黑键惩罚豁免**：3+ 音和弦中由 `1` 指和 `5` 指承担外框时豁免 `thumbBlackAvoid (4.5)` 与 `pinkyBlack (1.152)` 重罚，使 12 调原位三和弦统一收敛至 RH `1-3-5` / LH `5-3-1`；
   - **和弦转位音程开口软先验（`computeChordVoicingPrior`）**：按原位（三度+三度）、第一转位（三度+四度，RH `1-2-5` / LH `5-3-1` 或 `5-2-1`）、第二转位（四度+三度，RH `1-3-5` / LH `5-2-1`）及四音和弦四度开口位置施加软偏置；
   - **保持音感知的 Top-3 和弦候选保留**：当 `slice.heldNotes.length > 0` 时保留前 3 个和弦指型候选进入 A* / Beam Search，避免与跨声部保持音抢指。
2. **方案 2（12 调式音阶/琶音指法优化）**：
   - **黑白键地形感知的穿跨指（Terrain-Aware Thumb Crossing）**：对 `黑键(2/3/4) → 白键(1)` 穿指与 `白键(1) → 黑键(2/3/4)` 跨指大幅减免 `cross4Extra`，同时对纯白键二度级进的 `2↔1` 碎穿指施加额外惩罚，修复 `F` 大调右手（`1-2-3-4-1-2-3-4`）、`Db` 大调右手（`2-3-1-2-3-4-1-2`）及 `Eb/Ab/Bb` 大调左手（`3+4` 七音周期）与跨八度长琶音指法。
