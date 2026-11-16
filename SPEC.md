# 纯浏览器端 MusicXML 钢琴自动指法推导工具 — 产品与技术规格说明书 (SPEC)

> **定位**：100% 运行于浏览器本地（TypeScript + Web Worker，零后端）的钢琴指法自动推导、手位预览、局部微调与无损导出工具。输入 `.musicxml` / `.xml` / `.mxl`，输出带有标准 W3C MusicXML `<notations><technical><fingering>` 标注的乐谱文件，可直接导入 `piano.cishoon.top`、MuseScore 等第三方工具。
>
> **前置基准文档**：
> - 领域词汇表：[GLOSSARY.md](./GLOSSARY.md)
> - 回归测试样本集：[test-corpus/README.md](./test-corpus/README.md)（含真实样本 [05-realworld-wuchang.musicxml](./test-corpus/05-realworld-wuchang.musicxml)）
> - 交互原型参考：[prototype-preview-ux.html](./.scratch/musicxml-auto-fingering/prototype-preview-ux.html)

---

## 1. 产品目标与范围边界

### 1.1 核心工作流
1. **导入乐谱**：上传 `.musicxml` / `.xml` / `.mxl` 文件，主线程无损解析为 `Score Document` 并提取左右手 `Note Event` 与已有 `Finger Anchor`。
2. **本地推导**：在 Web Worker 中运行基于 `Onset Slice` 的束搜索动态规划（Beam Search DP），依据用户选定的 `Hand Span Profile`（`S`/`M`/`L` 及偏好开关）求解全曲 `1–5` 指法，并反推稳定的 `Hand Position` 与 `Transition Cue`。
3. **预览与微调**：采用「左谱右控工作室 + 上下分离双轨键盘」界面查看谱面指法、逐拍手位框与穿跨/大跨度预警；支持点击音符设置新 `Finger Anchor` 后局部重算、预览 `Before → After` 差异、切换「仅锁定单音」、一键撤销，以及基础版钢琴音色试听。
4. **无损导出**：在主线程精准回写 `<notations><technical><fingering>`，完整保留原谱排版与记谱信息，默认按原输入格式（支持互切 `.musicxml` / `.mxl`）下载。

### 1.2 明确不纳入范围（Out of Scope）
- 复刻 `piano.cishoon.top` 练琴生态（ChordPro 和弦谱编辑与伴奏、简谱切换、歌词卡拉 OK、Waiting Mode、A-B 循环、Web MIDI 外设接入、云端账号与曲库同步）。
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
```

---

## 3. MusicXML / MXL 解析与无损回写规范（`src/musicxml/`）

### 3.1 容器读写与编码约束
1. **文件识别与读取**：
   - `.musicxml` / `.xml`：UTF-8 文本解析，提取并缓存文件首行原始 XML 声明（如 `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`）。
   - `.mxl`：主线程使用 `JSZip.loadAsync(buffer)` 读取 `META-INF/container.xml`，选取 `container > rootfiles > rootfile` 的第 1 个条目获取 `full-path`（去除可能的前导 `/`），加载主 XML 文本；保留原 `JSZip` 实例以便导出时原样留存附带资源。
   - 使用 `DOMParser.parseFromString(xmlText, "application/xml")` 解析，检查 `doc.querySelector("parsererror")`。若根元素为 `<score-timewise>` 或钢琴谱表总数 `> 2`，阻断并提示仅支持标准双谱表以下 `score-partwise`。
2. **统一时间轴抽取（Score Order）**：
   - 按谱面线性小节顺序抽取每个物理 `<note>` 一次，**不物理展开反复次数**（避免同一 XML `<note>` 在第 1/2 遍产生冲突指法）。
   - 追踪每个 `<measure>` 内 `<attributes><divisions>` 变更、`<backup>`、`<forward>` 与 `<sound tempo>`，将所有击键统一到全局最小公倍数基准刻度（或精确有理拍数）。
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
- **技术栈**：`Vite` + `React 18+` + `TypeScript (strict)` + `Tailwind CSS` + `opensheetmusicdisplay (OSMD)` + `Zustand` + `JSZip` + 原生 Web Worker（轻量强类型 RPC，新请求自动取消未完成旧计算）。
- **目录规范**：
  ```text
  src/
  ├── domain/        # 纯 TypeScript 领域模型与数据契约
  ├── musicxml/      # ScoreDocument 抽取、XSD 无损回写、JSZip .mxl 打包（可注入 DOM）
  ├── solver/        # 纯 TS 束搜索 DP、代价矩阵、手位/过渡推导、局部锚点重算（零 DOM 依赖）
  ├── workers/       # Web Worker 入口与 RPC 封装
  ├── audio/         # Web Audio 轻量钢琴试听引擎与时钟同步
  ├── store/         # Zustand 全局状态、Undo/Redo 历史栈与 Before/After Diff 计算
  └── components/    # 左谱右控 Studio UI（ScoreViewer, RiskGutter, InspectorPanel 等）
  tests/             # Vitest 单元测试与 test-corpus 回归门禁
  ```

### 5.2 确认的 UI 布局与交互细节（源自原型 `B + C` 组合）
1. **顶栏控制区**：文件导入/导出按钮（`.musicxml` / `.mxl` 切换）、单谱表左右手切换开关、`Hand Span Profile`（`S`/`M`/`L`）与 `avoidThumbOnBlack` / `preferStablePosition` 开关、「忽略原谱指法重算」开关、试听播放/倍速控制、撤销（Undo）。
2. **左谱右控双栏主工作区（方案 B）**：
   - **左侧（~65%）五线谱主视图**：OSMD 渲染 `<fingering>` 并支持点击拾音（`domToSvg` + `GetNearestNote`）；每小节左侧配**边缘风险指示条（Margin Risk Gutter）**，按该小节最高 `severity` 着红/黄色；发生局部重算后，谱面上受波及音符显示紫色 `Diff` 徽标，原始或手动锚点显示红色锚点标记。
   - **右侧（~35% 吸顶检查面板 Sticky Inspector）**：
     1. **拗手预警导航列表**：列出所有 `warn`/`danger` 预警（含小节号、手别、原因标签与代价值），点击直达并滚动高亮对应小节与拍点；
     2. **选中音符编辑器 & `Before → After` 差异卡**：显示音高、手别与当前指法，提供 `1–5` 按钮（默认走 `phrase` 局部重算）、`仅锁单音 (pinOnly)` 快捷按钮与「移除锚点」；修改后展示逐音 `改前 → 改后` 变更清单并支持一键撤销。
3. **底部双轨分离键盘预览区（方案 C）**：
   - 拆分为**上方右手独立轨道（`Right Hand`）与下方左手独立轨道（`Left Hand`）**，彻底消除双手 `Hand Position` 区间框与 `Transition Cue` 弧线重叠遮挡；
   - 每条轨道按三层渲染：**顶层** `Transition Cue` 方向弧线与技巧标签 → **中层** `Hand Position` 五指虚位区间框 → **底层**键帽实按 `1–5` 徽标及灰显 `Held Finger` / 延音占位标记。

---

## 6. 基础版钢琴音色试听与音画同步（`src/audio/`）

- **音源加载**：首次点击「试听」时按需懒加载轻量钢琴采样（如 `smplr` 精简八度采样）；内置纯 Web Audio 泛音包络合成作为离线/网络异常零延迟兜底。
- **调度与同步**：由 `AudioContext.currentTime` 精确调度播放队列，读取谱面 `<sound tempo>`（缺省 100 BPM），支持 `0.5x / 0.75x / 1.0x / 1.25x` 倍速与「从当前选中拍起播」；播放过程中通过 `requestAnimationFrame` 依据当前播放 `tick` 实时推进 OSMD `Cursor` 与双轨分离键盘高亮。

---

## 7. 测试策略与最终验收门禁（`tests/`）

采用 `Vitest`（配合 `jsdom` / `@xmldom/xmldom`）覆盖 `src/solver` 与 `src/musicxml` 核心模块（**语句覆盖率 `≥ 85%`**），并将以下两条门禁固化为 CI/开发必过测试：

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
