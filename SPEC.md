# 纯浏览器端 MusicXML 钢琴自动指法推导工具 — 产品与技术规格说明书 (SPEC)

> **定位**：100% 运行于浏览器本地（TypeScript + Web Worker，零后端）的钢琴指法自动推导、手位模拟、交互练琴（节拍器 / Web MIDI 电钢琴等待模式 / A-B 循环）与无损导出工作室。输入 `.musicxml` / `.xml` / `.mxl`，输出带有标准 W3C MusicXML `<notations><technical><fingering>` 标注的乐谱文件，可直接导入 `piano.cishoon.top`、MuseScore 等第三方工具。
>
> **前置基准文档**：
> - 领域词汇表：[GLOSSARY.md](./GLOSSARY.md)
> - 架构决策记录：[ADR-0001 双手88键时间轴工作室](./docs/adr/0001-dual-hand-88key-timeline-studio.md)、[ADR-0002 交互练琴（节拍器/MIDI/等待模式/A-B循环）](./docs/adr/0002-interactive-practice-midi-waiting-loop.md)
> - 回归测试样本集：[test-corpus/README.md](./test-corpus/README.md)（含真实样本 [05-realworld-wuchang.musicxml](./test-corpus/05-realworld-wuchang.musicxml)）
> - 交互原型参考：[prototype-preview-ux.html](./.scratch/musicxml-auto-fingering/prototype-preview-ux.html)

---

## 1. 产品目标与范围边界

### 1.1 核心工作流
1. **导入乐谱**：上传 `.musicxml` / `.xml` / `.mxl` 文件，主线程无损解析为 `Score Document` 并提取左右手 `Note Event`、已有 `Finger Anchor` 与 `Measure Timeline`（小节边界、拍号与速度曲线）。
2. **本地推导**：在 Web Worker 中运行基于 `Onset Slice` 的束搜索动态规划（Beam Search DP），依据用户选定的 `Hand Span Profile`（`S`/`M`/`L` 及偏好开关）求解全曲 `1–5` 指法，并反推稳定的 `Hand Position`、`Hand Posture` 与 `Transition Cue`。
3. **预览、微调与交互练琴**：采用「顶栏精简控制 + 滚动五线谱与内联指法气泡 + 走带练琴条 + 底部统一 88 键物理键盘与连续双手模拟」工作区；支持点击音符设锚点局部重算、一键撤销、连续倍速/BPM 调速、独立节拍器与 1 小节 `Count-In`、电钢琴 Web MIDI 接入、`Practice Mode`（双手 / 只练右手 / 只练左手）、`Waiting Mode` 逐拍等待练琴，以及整小节 `A-B Loop`。
4. **无损导出**：在主线程精准回写 `<notations><technical><fingering>`，完整保留原谱排版与记谱信息，默认按原输入格式（支持互切 `.musicxml` / `.mxl`）下载。

### 1.2 明确不纳入范围（Out of Scope）
- 复刻 `piano.cishoon.top` 其余周边生态（ChordPro 和弦谱编辑与伴奏、简谱切换、歌词卡拉 OK、符号解释模式、循环每遍自动加速、Web MIDI Out 自动演奏回传、云端账号与曲库同步）。
- 三行及以上复杂总谱、四手联弹、非钢琴乐器指法、巴赫 3–4 声部严格赋格独立声部指法优化，以及 `<score-timewise>` 格式自动双向转写。
- 依赖 Python 或远端服务器的后端指法推理。

---

## 2. 核心领域模型与 TypeScript 数据契约（`src/domain/`）

所有核心术语以 [GLOSSARY.md](./GLOSSARY.md) 为准。主线程与 Web Worker 之间仅传递可结构化克隆的纯 JSON 数据，**禁止在 Worker 内使用 `DOMParser` / `XMLSerializer`**。

```ts
export type Hand = "RH" | "LH";
export type Finger = 1 | 2 | 3 | 4 | 5;
export type SpanPreset = "S" | "M" | "L";

export interface HandSpanProfile {
  preset: SpanPreset;              // S=0.82x, M=1.00x (默认), L=1.18x
  avoidThumbOnBlack: boolean;      // 大幅提高 1 指落黑键与穿指落黑键代价
  preferStablePosition: boolean;   // 提高换把移位代价，略放宽同把位内 4/5 指惩罚
}

export interface NoteEvent {
  noteUid: string;                 // 主线程映射到原始 <note> DOM 节点的唯一 ID
  measureIndex: number;            // 0-based 小节序号
  onsetTick: number;               // 归一化统一时间刻度（支持跨 <divisions> 变更）
  durationTick: number;            // 持续刻度（Grace Note 为 0）
  onsetSec: number;                // 结合当前 tempo 换算的秒数，供速度/连击代价使用
  durationSec: number;
  midi: number;                    // 21 (A0) .. 108 (C8)
  hand: Hand;                      // Hand Assignment 结果
  voice: string;
  staff: number;                   // 1 | 2
  isGrace: boolean;                // Grace Note 标记
  graceOrder?: number;             // 同一主音前连续倚音顺序 (0, 1, ...)
  isTieStop: boolean;              // Tie Continuation（优先看 <tie type="stop"/>）
  isTieStart: boolean;
  tieChainRootUid?: string;        // 指向该延音链首个击键 NoteEvent 的 noteUid
  anchorFinger?: Finger;           // 来自原谱主 <fingering> 或用户手动设定
  anchorRawPreserved?: boolean;    // 是否原样保留原谱未改动 <fingering> DOM 节点
  anchorMode?: "phrase" | "pinOnly";
}

export interface OnsetSlice {
  sliceId: string;
  hand: Hand;
  measureIndex: number;
  onsetTick: number;
  onsetSec: number;
  isGrace: boolean;
  phraseId: number;                // 由休止符/反复/静音阈值切分的独立乐句编号
  notes: NoteEvent[];              // 按 midi 升序排列的新击键音符（不含 Tie Continuation）
  heldNotes: Array<{               // 此时仍在发声的先前击键或延音（Held Finger 约束来源）
    noteUid: string;
    midi: number;
    endTick: number;
  }>;
}

export type CueType =
  | "thumb-under"
  | "cross-over"
  | "position-shift"
  | "wide-stretch"
  | "unreachable-span"
  | "anchor-conflict";

export interface TransitionCue {
  sliceId: string;
  hand: Hand;
  measureIndex: number;
  type: CueType;
  severity: "info" | "warn" | "danger";
  cost: number;
  label: string;
}

export interface HandPosition {
  hand: Hand;
  startSliceId: string;
  endSliceId: string;
  thumbKey: number;                // 白键基准索引（或 MIDI 范围下限）
  pinkyKey: number;
  minMidi: number;
  maxMidi: number;
}

export interface SolveResult {
  fingerByNoteUid: Record<string, Finger>;
  handPositions: HandPosition[];
  transitionCues: TransitionCue[];
  warnings: TransitionCue[];       // severity 为 warn / danger 的聚合列表
  repairedAnchorUids: string[];    // 因物理互斥被局部软降级提示的原锚点
  solveTimeMs: number;
}

export interface TempoPoint {
  tick: number;
  bpm: number;
}

export interface TimeSignaturePoint {
  measureIndex: number;
  tick: number;
  beats: number;
  beatType: number;
}

export interface MeasureTimeline {
  measureIndex: number;            // 0-based 小节序号
  startTick: number;
  endTick: number;
  startSec: number;                // 原始速度下的小节起始秒数
  endSec: number;
  timeBeats: number;
  timeBeatType: number;
  isPickup: boolean;               // 弱起/不完整小节标记（<attributes>/<implicit> 或不足满小节）
}

export type PracticeMode = "both" | "rh-only" | "lh-only";

export interface PracticeStep {
  stepId: string;
  measureIndex: number;
  onsetTick: number;
  onsetSec: number;
  isGrace: boolean;
  graceOrder?: number;
  expectedMidis: number[];         // 当前练习手在本步必须命中的唯一 MIDI 集合（不含 Tie Continuation）
  expectedNotes: NoteEvent[];      // 对应待弹音符（用于指法高亮与谱面光标）
  accompanimentNotes: NoteEvent[]; // 单手练习模式下，另一只手随本步自动伴奏的音符
}

export interface LoopRange {
  enabled: boolean;
  startMeasureIndex: number;       // 0-based 闭区间起点 A（自动保证 <= endMeasureIndex）
  endMeasureIndex: number;         // 0-based 闭区间终点 B
  gapMeasure: boolean;             // 每遍间隔一小节空拍（Count-In）
}

export interface MetronomeConfig {
  enabled: boolean;
  countIn: boolean;                // 起播前先打 1 小节预备拍
  volume: number;                  // 0.0 .. 1.0
}

export interface MidiDeviceInfo {
  id: string;
  name: string;
  manufacturer?: string;
  state: "connected" | "disconnected";
}

export interface WaitingState {
  enabled: boolean;
  skipGraceNotes: boolean;
  currentStepIndex: number;
  hitMidis: number[];              // 当前 Practice Step 已累计命中的 MIDI 音高
  wrongMidis: number[];            // 当前按错的 MIDI 音高（88 键键盘标红提示）
}

export interface ScoreTimelineMetadata {
  ticksPerQuarter: number;
  tempoPoints: TempoPoint[];
  timeSignaturePoints: TimeSignaturePoint[];
  measureTimelines: MeasureTimeline[];
}
```

---

## 3. MusicXML / MXL 解析与无损回写规范（`src/musicxml/`）

### 3.1 容器读写与编码约束
1. **文件识别与读取**：
   - `.musicxml` / `.xml`：UTF-8 文本解析，提取并缓存文件首行原始 XML 声明（如 `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`）。
   - `.mxl`：主线程使用 `JSZip.loadAsync(buffer)` 读取 `META-INF/container.xml`，选取 `container > rootfiles > rootfile` 的第 1 个条目获取 `full-path`（去除可能的前导 `/`），加载主 XML 文本；保留原 `JSZip` 实例以便导出时原样留存附带资源。
   - 使用 `DOMParser.parseFromString(xmlText, "application/xml")` 解析，检查 `doc.querySelector("parsererror")`。若根元素为 `<score-timewise>` 或钢琴谱表总数 `> 2`，阻断并提示仅支持标准双谱表以下 `score-partwise`。
2. **统一时间轴与 `Measure Timeline` 抽取（Score Order）**：
   - 按谱面线性小节顺序抽取每个物理 `<note>` 一次，**不物理展开反复次数**（避免同一 XML `<note>` 在第 1/2 遍产生冲突指法）。
   - 追踪每个 `<measure>` 内 `<attributes><divisions>`、`<time>` 拍号变更、`<backup>`、`<forward>` 与 `<sound tempo>`，将所有击键统一到全局最小公倍数基准刻度 `ticksPerQuarter`（即 `globalLcm`）。
   - 在 `Score Document` 中保留 `ticksPerQuarter`、`tempoPoints`（缺省 `100` BPM）、`timeSignaturePoints` 与逐小节 `measureTimelines`（含每小节精确起止 tick/sec 及 `isPickup` 弱起判定），作为节拍器、调速显示、小节标尺与 `A-B Loop` 的唯一时间基准。
   - **休止符与乐句切分**：遇到整小节及以上休止符、`<repeat direction="backward"/>`、跳房子边界（`<ending>`），或单手无 `Held Finger` 且相邻击键间隔 `≥ 1.5s` 时，递增 `phraseId` 标记乐句弱边界（允许手位自然重置）。

### 3.2 `Hand Assignment` 与边缘音符规则
1. **分轨映射优先级**：
   - **单 Part 双谱表**（`<staves>2</staves>`，如 `wuchang.musicxml`）：`staff 1 → RH`，`staff 2 → LH`。
   - **双 Part 各单谱表**（`P1` + `P2`）：默认 `P1 → RH`、`P2 → LH`；若首小节谱号为 `P1=F` 且 `P2=G`，自动对调。
   - **单 Part 单谱表**：整谱视作单手模式（G 谱号默认 `RH`，F 谱号默认 `LH`），不在中央 C 硬拆分，UI 提供顶部一键切换「右手 / 左手」开关。
2. **跨谱表（Cross-staff）判定**：
   - 统计全曲每个 `(partId, voice)` 的 `<staff>` 分布。若某 `voice` 有 **≥ 70%** 的音符落在同一 `staff`（主场谱表），则其偶发跨入另一谱表的音符**保留原声部手别**（维持左手琶音上行至高音谱表等连贯性）；若 `< 70%`（如全曲两手共用 `voice 1`），则严格按音符自身的 `<staff>` 归属。
3. **同手多 Voice、`Tie Continuation` 与 `Grace Note`**：
   - **合并 `Onset Slice`**：同一只手、同一 `onsetTick` 上所有新击键音符（跨 `voice` 合并，如 `staff 1` 的 `voice 1` + `voice 2`）合并为同一个 `Onset Slice`，按 `midi` 升序排列。
   - **`Tie Continuation`**：优先依据发声语义子元素 `<tie type="stop"/>` 判定（缺失 `<tie>` 时才以 `<notations><tied type="stop"/>` 兜底）。`Tie Continuation` **不进入新击键 `Onset Slice`**，但会将其延续终止刻度计入前驱击键的 `Held Finger` 占位区间，禁止同手其他声部在释放前复用该手指；`Tie Continuation` 节点**不写入 `<fingering>`**。
   - **`Grace Note`**：`<grace/>` 音符（`durationTick = 0`）作为紧邻主音之前的独立前置 `Onset Slice`（多倚音按 XML 顺序串联，带 `<chord/>` 则合并）参与指法求解，并**正常写回 `<fingering>`**。

### 3.3 原锚点提取、冲突策略与无损 XML 注入
1. **原谱 `<fingering>` 提取（`Finger Anchor`）**：
   - 在默认「保留原指法并补全」模式下，读取 `<notations><technical><fingering>`（忽略 `alternate="yes"` 与 `substitution="yes"` 辅音标记），解析首个 `1–5` 数字作为 `anchorFinger`（若为 `"1-2"` 等连字符文本，以首指作入音锚点并保留尾指作后继参考）。
   - **冲突处理**：若原谱锚点物理互斥（如同拍重指），**绝不静默篡改原谱 `<fingering>`**，保留原节点并在该处生成 `anchor-conflict` 红色预警；同时在全局设置提供「**忽略原谱指法，全曲重新推导**」一键开关。
2. **定点无损回写算法**：
   - 未经用户修改的原谱 `Finger Anchor`：**原封不动保留其现有 `<fingering>` DOM 节点及所有属性**（`default-x`、`default-y`、`substitution`、`placement` 等）。
   - 新增指法或用户修改后的指法：
     - 创建节点务必使用 `doc.createElementNS(doc.documentElement.namespaceURI, tagName)`，杜绝多余 `xmlns=""`。
     - 若 `<note>` 已有 `<notations>`，**仅在其中查找或追加 `<technical>`**，严禁覆盖或重建同级 `<tied>`、`<slur>`、`<articulations>`、`<ornaments>` 等节点。
     - 若需新建 `<notations>`，严格按 MusicXML 4.0 XSD 顺序插入在首个 `<lyric>` / `<play>` / `<listen>` 之前（即位于 `<staff>` / `<beam>` 之后）；若均无则 `appendChild` 到 `<note>` 末尾。
     - 新增 `<fingering>` 显式设置 `placement="above"`（右手）或 `placement="below"`（左手），文本为 `"1"`–`"5"`。
3. **导出打包**：
   - `XMLSerializer.serializeToString(doc)` 后，首行重新拼回原文件保存的 `<?xml ...?>` 声明（无声明时默认补 `<?xml version="1.0" encoding="UTF-8"?>\n`），`doc.doctype` 由浏览器原生保留。
   - 默认沿用导入格式导出，支持一键切换导出 `.musicxml` 或 `.mxl`。导出 `.mxl` 时直接更新原 `JSZip` 实例内主谱条目（若原为明文 `.musicxml`，自动生成首文件为 `compression: "STORE"`、内容为 ASCII `application/vnd.recordare.musicxml` 的 `mimetype`，以及 `DEFLATE` 压缩的 `META-INF/container.xml`）。

---

## 4. 指法求解器与可视化推导算法规范（`src/solver/`）

### 4.1 统一坐标系与束搜索动态规划（Beam Search DP）
1. **右手统一坐标映射**：
   - 建立基于白键几何位置的连续坐标 `keyPos(midi)`（白键位于 `0.5, 1.5, ...`，黑键按物理键盘偏移如 `C#=0.928, D#=2.072, F#=3.916, G#=5.0, A#=6.084`）。
   - 左手音符按 D4 对称轴镜像映射（`x_lh = -x_rh`，或在和弦中反转音高顺序使 `1` 指对应最高音、`5` 指对应最低音），使左右手共享一套生物力学模型。
2. **分段求解与前瞻校验**：
   - 按 `phraseId` 独立分段求解，Web Worker 内以整数/位掩码编码状态，Beam 宽度设为 **`BEAM = 24–32`**。
   - 对每一分段内的 `Finger Anchor` 执行前瞻可行性校验，若后续存在锁定锚点，提前剪除不可达分支或保留锚点可达路径，避免远方锚点被中途剪枝误删。
3. **基线代价权重与极端容错**：
   - **默认基线**：采用实谱调优权重 `LEARNED_W`（覆盖纵向拉伸/挤压、弱指、黑键、Held Finger 抢指 `steal`、穿指/跨指、同指异音、移位速度 `velocity`）叠加轻量 `W_FIGURE` 音阶/琶音软偏置。
   - **6 音和弦与超极限跨度降级**：
     - 同手 6 音和弦若底部或顶部存在相邻二度，允许 `1` 或 `5` 指兼按相邻双音；仍超出 5 音时优先分配外端主音并将内侧音标为需琶音/分拆。
     - 当音程超出当前 `Hand Span Profile` 的 `MAX_SPAN`（如 `wuchang.musicxml` 中的 15–16 半音十度），对惩罚封顶并分配外端 `1`/`5` 最优可行解，同时强制产生 `unreachable-span` 预警。

### 4.2 `Hand Span Profile` 参数化
基准 `M` 档白键极限跨度 `MAX_SPAN`：`(1,2): 5.5`, `(1,3): 6.5`, `(1,4): 7.2`, `(1,5): 8.3`（约九度），`(2,3): 2.7`, `(2,4): 4.6`, `(2,5): 6.0`, `(3,4): 2.4`, `(3,5): 4.3`, `(4,5): 2.6`。
- **`S`（小手）**：`MAX_SPAN` 与舒适距离整体缩放 `0.82`（`1–5` 极限约纯八度），强惩罚 `1–4` 白键八度。
- **`M`（标准手，默认）**：缩放 `1.00`。
- **`L`（大手）**：缩放 `1.18`（`1–5` 极限约十度，放宽 `1–4` 八度与连续扩指）。
- **偏好开关**：
  - `avoidThumbOnBlack`：大幅乘数上调 `thumb_black` 与 `cross_thumb_black` 权重；
  - `preferStablePosition`：提高 `shift_cost` 移位惩罚并略放宽同把位内 `finger_4` / `finger_5` 代价。

### 4.3 局部锚点重算（Anchor Re-solve）
- 点击某音符设为 `Finger Anchor` 时提供两种模式：
  1. **`phrase`（默认局部重算）**：严格隔离在**目标音符所属单手及当前 `phraseId` 分段**内（无休止符超长段以锚点前后 **`±16` 小节**为安全硬边界）运行局部 Beam DP；当向前/向后推进到某个 `Onset Slice` 与原路径完全汇合时自然截断，外侧保持原指法不变，生成 `Before → After` 受波及音符差异列表。
  2. **`pinOnly`（仅锁定单音）**：仅直接覆写该音符的 `Finger Assignment` 并重算其所属局部预警/手位框，不扰动前后任何其他音符。

### 4.4 `Hand Position` 与 `Transition Cue` 推导
1. **`Hand Position` 平滑合并**：逐切片按指法推算原始五指区间（右手 `thumbKey = w - (f - 1)`，多音取质心并扩展包络实际按下键）；相邻切片在未发生穿指、跨指、整体移位且 `thumbKey` 波动 `≤ 1` 白键时，合并为连续稳定的 `Hand Position` 段落。
2. **`Transition Cue` 触发与预警分级**：
   - **常规技巧提示（`info`）**：`thumb-under`（RH 上行/LH 下行 `2/3/4 → 1`）、`cross-over`（RH 下行/LH 上行 `1 → 2/3/4`）、常规 `position-shift`（非穿跨且相邻 `Hand Position` 区间无重叠或根音移位 `≥ 2` 白键）。
   - **高风险预警（列入右侧预警导航）**：
     - `wide-stretch`（`warn` 黄色）：同和弦或相邻指距达到当前 `Hand Span Profile` `MAX_SPAN` 的 `85%` 以上；
     - `unreachable-span`（`danger` 红色）：超出当前 `MAX_SPAN` 物理极限；
     - 高代价 `position-shift`（`warn`/`danger`）：极短 `Δt` 内大跨度跳跃或快速同指异音跳跃（`awkward-jump`）；
     - `anchor-conflict`（`danger` 红色）：原谱或手动锚点存在物理冲突。

---

## 5. 前端架构、状态管理与 UI/UX 交互规范

### 5.1 技术栈与目录结构
- **技术栈**：`Vite` + `React 18+` + `TypeScript (strict)` + `Tailwind CSS` + `opensheetmusicdisplay (OSMD)` + `Zustand` + `JSZip` + Web Audio API + Web MIDI API + 原生 Web Worker（轻量强类型 RPC，新请求自动取消未完成旧计算）。
- **目录规范**：
  ```text
  src/
  ├── domain/        # 纯 TypeScript 领域模型与数据契约（含 PracticeStep / LoopRange 等纯投影构建）
  ├── musicxml/      # ScoreDocument 抽取（含 MeasureTimeline）、XSD 无损回写、JSZip .mxl 打包（可注入 DOM）
  ├── solver/        # 纯 TS 束搜索 DP、代价矩阵、手位/过渡推导、局部锚点重算（零 DOM 依赖）
  ├── workers/       # Web Worker 入口与 RPC 封装
  ├── audio/         # Web Audio 钢琴试听引擎、独立节拍器 Click 合成、播放/等待/A-B循环调度器
  ├── midi/          # Web MIDI 热插拔监听、端口选择、软件键盘/QWERTY 模拟输入适配器
  ├── store/         # Zustand 全局状态、Undo/Redo 历史栈、Diff 计算与练琴/MIDI/循环状态
  └── components/    # 工作室 UI（ScoreViewer, NoteAnchorPopover, TransportPracticeBar, PracticeSettingsModal, UnifiedPiano88）
  tests/             # Vitest 单元测试与 test-corpus 回归门禁
  ```

### 5.2 确认的 UI 布局与交互细节（[ADR-0001](./docs/adr/0001-dual-hand-88key-timeline-studio.md) + [ADR-0002](./docs/adr/0002-interactive-practice-midi-waiting-loop.md)）
1. **精简顶栏控制区**：
   - 文件导入/导出（`.musicxml` / `.mxl` 切换）、单谱表左右手切换开关、`Hand Span Profile`（`S`/`M`/`L`）与 `avoidThumbOnBlack` / `preferStablePosition` 开关、「忽略原谱指法重算」开关、`Undo/Redo`；
   - **练习模式切换**：单一三态开关 **`双手` / `只练右手（左手自动伴奏）` / `只练左手（右手自动伴奏）`**（单谱表乐谱自动锁定为对应手别）；
   - **练琴设置 & MIDI 状态入口**：显示当前电钢琴连接状态徽标（已连接设备数/名称或未连接/浏览器不支持提示），点击打开设置弹窗（`预备拍 Count-In`、`A-B 每遍间隔空拍`、`等待模式跳过倚音`、`MIDI 输入端口选择`、`MIDI 本地发声开关`、节拍器音量与电钢琴 USB 接线说明）。
2. **上方全宽滚动五线谱区（`ScoreViewer` + 内联 `NoteAnchorPopover`）**：
   - 默认单行横向滚动五线谱（可切换多行分页布局），顶部紧凑条展示求解状态、危险/警告计数与 `<` `>` 预警跳转、`Before → After` Diff 下拉；小节边栏或顶条显示 `Margin Risk Gutter` 红/黄风险标。
   - **编辑 vs 练琴点击防冲突规则**：
     - 处于**停止（`stopped`）且未处于等待选点/等待中**时，点击谱面音符弹出内联 `NoteAnchorPopover`（提供 `1–5` 指法按钮、`phrase`/`pinOnly` 切换、「移除锚点」与「从此拍试听」）；
     - 处于**播放中或 `Waiting Mode` 激活状态**时，点击谱面小节或音符优先跳转练琴光标至对应位置（不弹出指法编辑气泡），防止练琴误触打断。
3. **中部走带与练琴条（`TransportPracticeBar`）**：
   - 位于五线谱与 88 键键盘之间，集中提供：
     - **小节进度标尺（兼 A-B 选区条）**：显示各小节编号与当前光标小节，支持点击跳转；开启 A-B 循环选区时支持直接点选起点小节 A 与终点小节 B（或使用起止微调），并在标尺上高亮 `[A..B]` 区间。
     - **播放走带**：`回到开头`、`播放 / 暂停`、`从选中拍起播`、`停止`；
     - **速度控制**：快捷倍率档位（`0.25x / 0.5x / 0.6x / 0.75x / 0.9x / 1.0x / 1.25x / 1.5x`）、`-/+` 步进微调，以及可点击直接输入目标 BPM 的 `倍速 × ♩=BPM` 读数按钮；
     - **练琴核心开关**：`节拍器`（附带当前拍点视觉闪烁指示）、`等待模式`、`A-B 循环`。
4. **底部全宽 88 键物理键盘与连续双手模拟（`UnifiedPiano88`）**：
   - 88 键共用物理键盘，左右手以靛蓝/青绿区分键帽高亮、上方双层 `Hand Position` / `Transition Cue` 通道，以及基于连续 `scoreSec` 驱动的半透明双手 `Hand Posture` SVG 骨骼模拟（含 `Held Finger` 锚定、穿跨指层级与提前量移位缓动）。
   - 接入练琴扩展：在 `Practice Mode` 下对伴奏手视觉降噪突出当前练习手；`Waiting Mode` 下高亮当前待弹目标键并支持**错音红色警示键**与 **MIDI 实时按键按下反馈**；支持点击琴键或电脑键盘快捷键触发虚拟 MIDI `NoteOn`/`NoteOff` 以便无琴测试。

---

## 6. 音频引擎、节拍器、Web MIDI 与交互练琴规范（`src/audio/` & `src/midi/`）

### 6.1 钢琴音色与连续速度控制（`Speed Multiplier`）
- **音源加载**：首次播放或试听时按需懒加载轻量钢琴采样（`smplr` 精简八度采样），内置纯 Web Audio 泛音包络合成作为离线/超时零延迟兜底。
- **连续调速与等比缩放**：
  - 支持 `0.25x–1.5x` 连续倍率、`0.25 / 0.5 / 0.6 / 0.75 / 0.9 / 1.0 / 1.25 / 1.5` 快捷档、`±0.05x`（或 `±5 BPM`）微调，以及点击 `♩=BPM` 直接输入目标基准拍速。
  - 若乐谱含中途 `<sound tempo>` 变速，修改目标 BPM 时按 `speedMultiplier = targetBpm / initialBaseBpm` **等比缩放全曲所有速度段**，保留原谱相对快慢变化。
  - **求解器隔离**：指法求解器（`src/solver/`）始终使用解析阶段按原谱 `<sound tempo>` 计算的 `NoteEvent.onsetSec`，不因练琴调速触发重算，保证指法方案稳定不跳变。

### 6.2 独立节拍器与预备拍（`Metronome` & `Count-In`）
- **拍点网格生成**：依据 `Score Document.measureTimelines` 与 `tempoPoints` 按小节生成强弱拍事件（每小节第 1 拍重音高音 Click，其余拍弱音低音 Click，支持中途变拍号如 `4/4 → 3/4 → 6/8`）；弱起小节（`isPickup`）仅调度落在该小节实际 tick 跨度内的拍点。
- **独立音频路由**：使用独立 Web Audio 短脉冲合成节点（高/低木鱼音色）与增益控制，**不受 `PianoAudioEngine.stopAll()` 截断**。
- **预备拍（`Count-In`）与等待联动**：
  - 开启「预备拍」后，从任意小节起播前先按起始小节所在拍号与当前速度播放 **1 整小节**预备拍（屏幕显示倒数拍号），随后无缝进入正片播放。
  - 节拍器支持独立开启，但在 **`Waiting Mode` 卡住等待用户输入期间自动暂停打拍**，避免节奏提示与等待卡顿产生节拍撕裂。

### 6.3 电钢琴接入（`src/midi/`，Web MIDI API）
- **连接与热插拔**：通过 `navigator.requestMIDIAccess()` 自动监听所有 MIDI 输入端口及 `onstatechange` 热插拔事件，默认合并所有已连接设备输入（亦可在设置弹窗中指定单一端口），并支持通过注入 Mock `MIDIAccess` 进行无硬件测试。若浏览器不支持 Web MIDI（如 Safari 或非安全上下文），在设置/状态徽标清晰提示降级原因并引导使用虚拟键盘模拟。
- **事件解析**：规范处理标准 MIDI `NoteOn`（`0x90`, `velocity > 0`）、`NoteOff`（`0x80` 或 `velocity === 0` 的 `NoteOn`）及踏板 `CC 64`。
- **MIDI 本地发声开关（`midiLocalSound`）**：
  - 处于 `Waiting Mode` 时**默认关闭**本地发声，由电钢琴自带音源发声（避免浏览器合成音与电钢琴扬声器重叠回响）；
  - 为无音源纯 MIDI 键盘或静音练琴用户提供设置内手动开启「MIDI 本地发声」，开启后实时将输入 `NoteOn`/`NoteOff` 路由至 `PianoAudioEngine`。
- **软件模拟输入**：点击 88 键虚拟琴键或按下映射的电脑键盘按键可发出等价 `NoteOn`/`NoteOff` 事件驱动 `Waiting Mode` 判定。

### 6.4 练习模式、等待模式（`Waiting Mode`）与 `A-B Loop`
1. **跨手步进序列（`Practice Step`）构建**：
   - 根据当前 `Practice Mode`（`both` / `rh-only` / `lh-only`），按 `(onsetTick, isGrace, graceOrder)` 合并同一拍上所有新击键音符：属于当前练习手的非 `Tie Continuation` 音符构成 `expectedMidis`；单手练习模式下，另一只手的同拍音符归入 `accompanimentNotes`。
   - **倚音策略**：`Grace Note` 默认作为前置 `Practice Step` 依次等待弹奏；设置中开启「等待模式跳过倚音」时，自动跳过 `isGrace === true` 步进。
2. **等待判定状态机（累计命中模型）**：
   - 光标推进到下一个 `Practice Step` 时，若 `expectedMidis` 非空则暂停时间推进并高亮提示该步琴键与指法；伴奏手音符仅在当前步命中推进后触发演奏，**待弹手不由浏览器提前发声**。
   - **累计命中（Rolled Chord 容错）**：在当前步等待期间，每收到属于 `expectedMidis` 的新 `NoteOn` 即将其加入 `hitMidis` 并持续保留（允许和弦各音先后落下、先落音短暂松开），当 `expectedMidis` 全部命中时立即推进至下一步并清空 `hitMidis` / `wrongMidis`。
   - **防重复音穿透**：连续两步出现相同 MIDI 音高时，进入新一步会重置 `hitMidis`，必须收到**新的 `NoteOn`** 才算命中（不可靠上一步持续按住不放直接跳过）。
   - **错音反馈**：收到不在 `expectedMidis` 中的 `NoteOn` 时，将该音记入 `wrongMidis` 并在 88 键键盘上**红色警示**（对应 `NoteOff` 或步进完成后清除），**不清空已正确命中的 `hitMidis`**。
   - **暂停即弹起播**：在播放暂停且开启等待模式时，用户在电钢琴/模拟键盘上弹对当前光标所在 `Practice Step` 的音符后，自动从该步唤醒并继续等待模式练琴。
3. **整小节 `A-B Loop`**：
   - 仅按整小节闭区间 `[startMeasureIndex, endMeasureIndex]`（`0-based`，点选自动规范 `A ≤ B`）工作；
   - 播放或等待模式完成 B 小节最后一个音符/小节末尾后：若关闭「每遍间隔空拍」，立即跳转回 A 小节首拍；若开启「每遍间隔一小节空拍（`gapMeasure`）」，先按 A 小节拍号打完 1 小节节拍器空拍再跳回 A 小节继续。

---

## 7. 测试策略与最终验收门禁（`tests/`）

采用 `Vitest`（配合 `jsdom` / `@xmldom/xmldom`）覆盖 `src/solver`、`src/musicxml`、`src/audio`、`src/midi`、`src/domain` 与核心交互状态（核心算法模块**语句覆盖率 `≥ 85%`**），并将以下门禁固化为 CI/开发必过测试：

### 7.1 算法与性能门禁（基于 `test-corpus/` 01–05）
1. **硬约束零违规**：样本 `03` 及交互新增的 `Finger Anchor`（无自身物理冲突时）遵循率 `100%`；`Tie Continuation` 写回指法数为 `0`；同手同拍 `Onset Slice` 无非允许重指冲突。
2. **基础乐理自然度**：样本 `01` C 大调上行音阶输出标准穿指（如 `1-2-3-1-2-3-4-5`）；样本 `02` 阿尔贝蒂低音与柱式和弦无逆序反关节。
3. **浏览器性能预算**：真实样本 [05-realworld-wuchang.musicxml](./test-corpus/05-realworld-wuchang.musicxml)（73 小节、1321 `<note>`）在 Web Worker 内全曲求解总耗时 **`≤ 200 ms`**，单次局部锚点重算 **`≤ 20 ms`**。
4. **跨度缩放响应**：样本 `05` 中的 15–16 半音十度跨度在 `S`/`M` 下稳定触发 `wide-stretch` / `unreachable-span` 预警，切至 `L` 后高危预警数量显著下降。
5. **跨谱表连贯性**：样本 `04` `voice 2` 跨入 `staff 1` 的音型由 `Left Hand` 连续分配指法。

### 7.2 导出与 `piano.cishoon.top` 兼容验收门禁
1. 导出的 `wuchang-fingered.musicxml` 与样本 `04` `.mxl` 在 `piano.cishoon.top` 与 OSMD 中均无报错正常加载。
2. 所有击键音符与和弦分音在谱面一一对应正确显示 `1–5` 指法，无串位或遗漏。
3. 样本 `03` 原有 `<fingering>` 与 `<lyric>`、样本 `05` 原始 `<direction>`（速度/力度记号）与 `<tied>`/`<slur>` 100% 无损保留。
4. `Tie Continuation` 音符处不出现重复冗余指法。
5. 导出 XML 通过元素子序与命名空间校验（无 `<notations>` 错排于 `<lyric>` 之后或多余 `xmlns=""`，`.mxl` 首文件为未压缩 `STORE` `mimetype`）。

### 7.3 交互练琴（节拍器 / 调速 / Web MIDI / 等待模式 / A-B 循环）验收门禁
1. **`MeasureTimeline` 与强弱拍**：含变拍号、中途 `<sound tempo>` 与弱起小节的乐谱可正确生成节拍网格，等比 BPM 缩放同步作用于播放器与节拍器，且不改变指法求解结果。
2. **节拍器与预备拍**：独立音频调度在 `PianoAudioEngine.stopAll()` 时不被截断；开启 `Count-In` 时播放前准确触发 1 小节重弱拍；`Waiting Mode` 暂停等待期间节拍器停止发声。
3. **Web MIDI 注入测试**：通过 Mock `MIDIAccess` 验证热插拔连接/断开状态同步、`NoteOn`/`NoteOff`（含 `velocity=0` 等价 `NoteOff`）解析，以及 `midiLocalSound` 开关在等待/非等待下的本地发声隔离。
4. **`Waiting Mode` 状态机**：验证双手同拍跨手合并步进、和弦先后落键累计命中、重复同音防穿透、`Tie Continuation` 自动免弹、错音标红不清空已命中、倚音等待/跳过开关、单手 `Practice Mode` 伴奏手自动发声，以及暂停状态弹对当前音直接唤醒开播。
5. **`A-B Loop` 门禁**：验证整小节 `[A..B]` 区间（含 `B < A` 自动规范）、直接跳回 A 小节与开启 `gapMeasure` 时插入 1 小节空拍再循环的行为，以及与 `Waiting Mode` 组合循环的连续性。

### 7.4 可选预训练指法先验（`src/prior/`，P2 软先验与物理否决）验收门禁
1. **默认关闭与零开销**：默认指法风格为 `classic`（启发式），关闭时不下载任何模型权重文件，求解结果与纯启发式基准 100% 一致。
2. **纯 TS 前向对齐**：`src/prior/lumikeyTransformer.ts` 对 `@lumikey/piano-fingering-model` 导出的左右手权重（`public/models/lumikey-prior-{left,right}.bin`）在 26×5 特征下的输出 logits 与 ONNX 参考图最大误差 `< 1e-3`。
3. **物理与锚点一票否决不变量**：先验仅作为封顶附加代价项 `priorCost(slice, cand) = λ · Σ min(cap, -logP[note][finger])`（默认 `cap = 6.0`）进入候选重排，永不参与 `generateSliceCandidates` 过滤；无论 `λ` 如何调节，`Finger Anchor` 保持率 100%、不出现同手和弦重指冲突、不越过 `S`/`M`/`L` 最大跨度、不新增 `unreachable-span` 或 `anchor-conflict` 警告；模型加载失败或抛错时静默回退至经典启发式求解。
4. **合规与降级开关**：支持构建期通过 `VITE_BUNDLE_PRIOR=0` 禁用内置权重并在设置面板填入自定义模型 URL（详见 [ADR-0003](./docs/adr/0003-pretrained-fingering-prior.md) 与 [NOTICE](./NOTICE)）。
