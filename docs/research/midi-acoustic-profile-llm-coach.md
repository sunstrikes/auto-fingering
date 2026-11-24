# 基于 Web MIDI 信号的声学结果画像与外部注意 LLM 教练协议调研报告

> **关联议题**：`sunstrikes/auto-fingering#14`（父规划地图 `#11`；下游决策票 `#19`）
> **调研日期**：2026-11-24
> **代码基线**：`master` (`c82f1ad`) — `src/midi/webMidi.ts`、`src/domain/types.ts`、`src/practice/practiceAnalytics.ts`、`src/App.tsx`
> **遵循原则**：全部结论溯源至同行评审论文、W3C 规范、官方第一方 API 文档及 2026-11-24 实测 HTTP CORS 预检/请求响应头；严格沿用 [`GLOSSARY.md`](../../GLOSSARY.md) 领域术语。

---

## 执行摘要（Executive Summary）

1. **标准 Web MIDI 的能力边界清晰**：依据 Kuromiya 等人（*PNAS* 2025）基于 1 kHz 光学键程传感器的因果研究，标准电钢琴 Web MIDI **无法**测量擒纵点加速度与离键制音加速度（即无法做音乐学院级微音色建模），但对 **击键力度相对关系、连续击键微观时序（IOI）、双手纵向同步性、指间连断重叠（KOT/KOR）与延音踏板换音时序（CC64）** 这 5 个核心声学维度具备极高信噪比。借鉴 Sony CSL *Profy*（ACM DIS '26）的 HCI 范式，声学反馈应以**小节/乐句级局部高亮定位**替代笼统总分。
2. **现有代码有 4 处必须优先修补的信号折损**：`src/midi/webMidi.ts` 的 `MidiInputEvent` 目前丢弃了 W3C Web MIDI 原生的驱动级高精度时间戳 `MIDIMessageEvent.timeStamp`（`DOMHighResTimeStamp`）；`src/App.tsx` 在消费层丢弃了 `velocity`（仅用于本地合成）与 `CC64` 原始值 `0–127`（仅保留布尔 `pressed`）；且现有 `practiceAnalytics.ts` 仅采集 `Waiting Mode` 的停顿与错音——**时间域声学指标严禁混入 `Waiting Mode` 暂停走带数据，必须在连续定速演奏回合中采集**。
3. **跨电钢琴硬件抗噪的核心是「相对化 + 心理声学死区 + 自适应迟滞」**：依据 Dannenberg（ICMC 2006）对 MIDI 力度-响度曲线的实测，不同琴型动态范围跨度高达 15–105 dB 且近似服从平方律（$\text{Peak RMS} \propto v^2$），**严禁写死绝对力度阈值**，须采用段内相对 dB 代理与秩占优率；依据 Goebl（*JASA* 2001），旋律强奏天然产生 15–35 ms 的「旋律提前（Melody Lead）」力学伪影，双手对齐必须采用非对称容忍死区；踏板分析须动态识别开关踏板（`{0, 127}`）与连续半踏板（`0–127`），后者以 Schmitt Trigger 迟滞窗（`down >= 40` / `clear <= 20`）结合 0–220 ms 切分踏板容忍窗消除误报。
4. **外部注意 LLM 教练遵循「本地算数字、LLM 做声学转译、后置确定性校验」契约**：依据 Duke, Cash & Allen（*JRME* 2011）、Mornell & Wulf（*JRME* 2019）、Wulf & Lewthwaite（OPTIMAL Theory, 2016）及 Salmoni 等人（Guidance Hypothesis, 1984），本地 TypeScript 算出约 250–500 tokens 的封闭世界 `AcousticTelemetrySummary`（每条发现带唯一 `evidenceId`），通过各家原生 Structured Outputs 强制模型仅输出「1 句真实肯定 + 最多 2 条指向声音/乐句结果的外部注意指令 + 1 个下一遍听觉自检任务（总字 ≤ 140 字）」，客户端再做 `evidenceId` 白名单与内部身体微操词黑名单校验；无 Key 时由本地确定性外部注意模板 100% 兜底。
5. **纯静态 SPA 浏览器直连 CORS 实测结论（纠正常见二手文档误区）**：
   - **OpenRouter（最优 BYOK）**：`OPTIONS` 与 `POST`（含 401）均返回 `access-control-allow-origin: *`，且提供第一方 **OAuth PKCE**，纯静态 SPA 无需用户手抄主 Key 即可单端点路由主流模型。
   - **Anthropic**：官方显式支持 CORS，但 `POST` 必须携带 `anthropic-dangerous-direct-browser-access: true`（实测漏传时响应不含 ACAO 被浏览器拦截，携带后返回 `access-control-allow-origin: *`）。
   - **Google Gemini**：实测原生端点（`x-goog-api-key`）与 OpenAI 兼容端点（`Authorization: Bearer`）在 `OPTIONS` 与 `POST`（含 400）均反射 `access-control-allow-origin: <Origin>`，且支持在 GCP 控制台绑定 HTTP Referrer 域名白名单。
   - **OpenAI（存在 401 盲区坑点）**：`OPTIONS` 预检通过，但实测 `POST` 返回 `401` 时边缘层**省略了 `Access-Control-Allow-Origin`**，导致浏览器吞掉错误体并抛出不透明的 `TypeError: Failed to fetch`，前端须做针对性诊断提示并允许配置自定义 `Base URL`。
   - **本地 Ollama**：默认仅放行 `localhost`/`127.0.0.1`/`0.0.0.0`；从公网 HTTPS 静态站直连需用户配置 `OLLAMA_ORIGINS="https://<本站域名>"`，且 **Chrome 142+ 会弹出 Local Network Access（`loopback-network`）原生权限提示**，**Safari 则严格拦截 `https:// → http://localhost` Mixed Content**（好在 Safari 本身也不支持 Web MIDI）。

---

## 一、现有代码库信号管线盘点与最小采集修补

在设计声学指标前，先核对本仓库现有 Web MIDI 采集与分析链路（均基于实际源码审读）：

### 1.1 已具备的信号与乐谱元数据

| 来源文件 | 现有字段 / 能力 | 对声学画像的可复用价值 |
| :--- | :--- | :--- |
| `src/midi/webMidi.ts` | `parseMidiMessage()` 解析 `0x90`（`noteon` 含 `velocity: 1..127`，`data2 === 0` 归为 `noteoff`）、`0x80`（`noteoff`）、`0xb0 CC64`（`sustain` 含原始 `value: 0..127` 与 `pressed: data2 >= 64`）；区分 `source: "midi" \| "virtual" \| "qwerty"` | 已覆盖钢琴演奏最核心的三类 MIDI 事件；`source` 字段可直接用于屏蔽无力度/无踏板的软件输入源 |
| `src/domain/types.ts` | `ScoreDocument` 保留完整 `Measure Timeline`（`startTick`/`endTick`/`startSec`/`endSec`/`timeBeats`/`timeBeatType`）、`NoteEvent`（`measureIndex`, `onsetSec`, `durationSec`, `midi`, `hand`, `voice`, `staff`, `isGrace`, `isTieStop`, `isTieStart`, `isArpeggiated`）与 `pedalIntervals?: PedalInterval[]` | **天然提供“声部先验”与“结构锚点”**：无需盲猜旋律/伴奏声部，可直接利用 `hand` + `voice` + 同手最高音；可直接排除 `Grace Note`、`Tie Continuation` 与 `isArpeggiated` 和弦 |
| `src/domain/types.ts` | `SolveResult` 提供 `fingerByNoteUid` 与 `transitionCues`（`thumb-under`, `cross-over`, `position-shift`, `wide-stretch` 等） | 可将 IOI 异常点与 `Transition Cue` 交叉关联（例如“第 12 小节穿指处跑动略微抢拍”） |
| `src/practice/practiceAnalytics.ts` | 统计 `Waiting Mode` 下的 `pitchErrors`、`durationErrors`、`hesitationCount`（阈值 `1.6x + 0.45s`）、`cleanStreak` 与小节故障聚类 | 保留为「阶段 0 · 识谱落键」分析；声学画像作为独立模块叠加，不破坏现有单测 |

### 1.2 必须前置修补的 4 处信号折损

1. **驱动级高精度时间戳被丢弃（最关键）**：
   `src/midi/webMidi.ts` 第 31 行 `MIDIMessageEventLike` 虽然声明了 `timeStamp?: number`，但 `MidiInputEvent` 联合类型（第 3–27 行）与 `parseMidiMessage()`（第 124–184 行）并未透传该字段。`src/App.tsx` 第 1356–1362 行在 React 回调中通过 `AudioContext.currentTime` 或 `performance.now() / 1000` 事后取时。根据 [W3C Web MIDI API 规范](https://www.w3.org/TR/webmidi/) 与 DOM `Event` 接口，`MIDIMessageEvent.timeStamp` 是 OS/MIDI 驱动层打上的 `DOMHighResTimeStamp`（单位 ms，与 `performance.now()` 共享文档 time origin，非跨源隔离下浏览器通常量化至 ~0.1 ms 精度，见 [MDN `DOMHighResTimeStamp`](https://developer.mozilla.org/en-US/docs/Web/API/DOMHighResTimeStamp)）。在主线程触发 React 重渲染或 GC 时，回调内现取时间可引入 5–20 ms 抖动，已超过人耳对快跑动 IOI 的 6 ms 分辨阈（Friberg & Sundberg, 1995）。
   - **最小修补**：在 `MidiInputEvent` 各分支增加 `timeStampMs: number`（优先取 `msgEvent.timeStamp`，缺失或虚拟输入回退 `performance.now()`），并在独立于 React State 的环形缓冲区（ref/plain array）中同步记录原始 `MidiInputEvent` 流，**避免音频/声学采集受 React 渲染调度干扰**。
2. **消费层丢弃 `velocity` 与 `CC64` 原始连续值**：
   `src/App.tsx` 第 328–349 行中，`event.velocity` 仅用于本地 `audio.triggerNote()`，并未进入任何分析结构；`event.type === "sustain"` 仅执行 `setSustainPedalPressed(event.pressed)`，丢弃了 `0–127` 连续踏板深度 `event.value`。声学画像采集器应直接订阅底层 `onMidiEvent` 的完整事件对象。
3. **`Waiting Mode` 与连续演奏的数据隔离**：
   `Waiting Mode` 会在每个 `Practice Step` 暂停走带等待击键。此类数据只能衡量音高准确度与持键习惯，**绝不可用于计算 IOI 均匀度、双手对齐、KOT/KOR 或踏板换音清晰度**。声学画像仅在「不暂停的定速跟拍/自由连续录音回合」中激活。
4. **乐谱表情记号缺口与非真实琴输入隔离**：
   当前 `NoteEvent` 尚未解析 MusicXML 的力度记号（`<dynamics>` 如 `p`/`mf`/`f`）与连断奏记号（`<slur>`/`<staccato>`）。因此在阶段 1 实现中，力度与触键指标须以**乐谱固有织体结构**（旋律-伴奏分层、等时值跑动连贯性、和声/小节边界踏板清音）作为客观参照，而不臆测谱面未解析的表情要求；同时当 `source !== "midi"`（虚拟键盘/电脑键盘）时自动关闭力度与踏板维度，只保留基础时序反馈。

---

## 二、Part 1：基于标准 Web MIDI 的可解释声学结果画像（Acoustic Profile）

### 2.1 科学能力边界：无 1 kHz 光学传感器时，能测什么 vs 测不了什么？

近期索尼计算机科学实验室（Sony CSL）与东京大学/NeuroPiano 研究所（Shinichi Furuya 课题组）的两项里程碑研究，为我们划定了精准的技术边界：

- **Kuromiya, Kobayashi, Hirano & Furuya (*PNAS*, 2025, DOI: `10.1073/pnas.2425073122`)**——《*Motor origins of timbre in piano performance*》使用高分辨率非接触光学键程传感系统（*HackKey*）结合双盲听觉实验，证明钢琴家确实可通过触键运动控制听众感知的三大音色维度（**Weight 轻重、Clarity 清晰/浑浊、Brightness 明暗**），并分离出 **5 个决定性运动学特征**：
  1. 键下压速度（Key descending velocity）
  2. 擒纵点加速度（Acceleration at escapement — 因果干预实验证明单独操纵此项即可改变听感音色）
  3. 制音/离键速度与加速度（Mute velocity and acceleration）
  4. 连续击键微观时序关系（Temporal relationships / micro-timing）
  5. 双手同步性（Intermanual synchronicity）
- **Kawamura, Nakamura, Nishioka, Shioki, Furuya & Rekimoto (*ACM DIS '26*, arXiv:2606.10627)**——《*Profy: Interpretable Visualization of Expertise-Dependent Motor Skills Toward Supporting Piano Practice*》基于 1 kHz 光学键程与音频训练弱监督模型，证明了钢琴练习辅助系统的核心 HCI 洞见：**传统全局总分或笼统评语无法转化为练琴行动；只有将专业与业余的差异映射为「与时间和乐谱对齐的局部可解释高亮」，练习者才能直接定位、截取并循环攻克薄弱乐句。**

将 *PNAS* 2025 五大特征与 Lerch, Arthur, Pati & Gururani（*TISMIR*, 2020/2021）及 Pati, Gururani & Lerch（*Applied Sciences*, 2018; *ISMIR*, 2020）综述的自动钢琴演奏评估（APPA/MPA）MIDI 维度映射到标准 Web MIDI，可清晰界定本系统的边界：

| 声学/运动维度 | 物理真值来源 | 标准 Web MIDI 可观测性 | 工程取舍建议 |
| :--- | :--- | :--- | :--- |
| 声部力度平衡（Voicing） | 键下压末速度 | **高信噪比**（相对 `velocity` 分布） | **核心纳入**（必须做相对归一化，禁用绝对值） |
| 连续跑动时值均匀度（Timing Evenness） | 击键微观时序 | **极高信噪比**（`MIDIMessageEvent.timeStamp` IOI） | **核心纳入**（采用去趋势 nPVI + 局部离群定位） |
| 双手/和弦纵向对齐（Synchronization） | 双手击键同步性 | **高信噪比**（同 `Practice Step` `timeStamp` 差） | **核心纳入**（必须补偿 Goebl 2001 力度提前伪影） |
| 触键连断清晰度（Articulation: KOT/KOR） | 键释放与下音击键重叠 | **中高信噪比**（无踏板区 `NoteOff` → `NoteOn`） | **条件纳入**（仅在无踏板/非同音反复段启用） |
| 延音踏板和声清晰度（Pedal Clarity） | 制音器抬放与和声边界 | **高信噪比**（`CC64` 0–127 波形 vs 和声边界） | **核心纳入**（自动适配开关/半踏板 + 切分踏板窗） |
| 单音擒纵点音色微操（Brightness/Weight） | 1 kHz 键程加速度曲线 | **不可观测**（标准电钢双/三触点仅报末速度） | **明确排除**（不臆造“音色明暗/触键深浅”假指标） |
| 离键制音加速度（Mute kinematics） | 键回弹速度曲线 | **极低/不可靠**（消费级电钢多发 `0x90 vel=0` 或固定 `0x80` 释放力度，且本库 `webMidi.ts` 已归零） | **明确排除** |

---

### 2.2 五大高信噪比 Web MIDI 声学指标与可靠计算口径

> **前置假设**：所有时间均采用 `MIDIMessageEvent.timeStamp`（转换为毫秒或秒），且均基于**非暂停连续演奏回合**中已归因到 `ScoreDocument` `NoteEvent` 的匹配事件集合计算（轻量归因策略见第四章与下游票 `#19`）。

#### 指标 1：旋律与伴奏声部力度分离度（Voicing Separation）

- **理论依据与硬件陷阱**：
  Dannenberg（*ICMC* 2006，《*The Interpretation of MIDI Velocity*》）实测多款硬件/软件合成器与钢琴音源后指出：MIDI 标准从未规定力度 `1–127` 与声压 dB 的映射关系，实测钢琴音色动态范围跨度高达 **15 dB 至 105+ dB**；且实测响度并非与 MIDI velocity 呈对数线性，而是近似满足**平方律**（$\text{Peak RMS} \propto v^2$，即每倍增力度约 +12 dB）。此外，不同品牌电钢琴出厂键床力度映射差异显著（Yamaha 偏线性直白、Roland PHA 系列扫描均匀且内置 1–10 级曲线、Kawai 偏古典深沉曲线），用户还可能开启机内 Soft / Heavy 触键档位。因此，**任何基于“旋律必须 > 85、伴奏必须 < 55”的绝对力度判据都是工程反模式**。
- **声部自动分层（复用 `ScoreDocument`）**：
  1. 双手织体（`Practice Mode === "both"`）：默认以右手最高声部（或 `RH` 全体，单手和弦内取 `max(midi)` 为 top-voice）为候选旋律集 $M$，左手（及右手内声部）为伴奏集 $A$；若检测到左手为高密度单音旋律而右手为柱式和弦伴奏，则自动互换或退化为「最高音 vs 其余音」。
  2. 单手多声部织体（同 `Onset Slice` 含 $\ge 2$ 音，且持续出现于乐段内）：取每拍最高音 $M$ vs 内声部 $A$。
- **可靠计算口径（双指标防曲线失真）**：
  1. **平方律相对响度差（$\Delta L_{\text{voice}}$，单位 dB proxy）**：依据 Dannenberg（2006）经验律，将各音映射至相对分贝域 $L(v) = 40 \log_{10}(v / 127)$（过滤 $v \le 1$ 的极弱误触），按同拍/同小节配对或整段中位数计算：
     $$\Delta L_{\text{voice}} = \operatorname{median}_{i \in M}\!\left(L(v_i)\right) - \operatorname{median}_{j \in A}\!\left(L(v_j)\right)$$
  2. **旋律力度秩占优率（Rank Dominance，$R_{\text{dom}}$）**：对同拍/相邻 150 ms 窗口内配对的旋律音与伴奏音，计算 $v_M > v_A$ 的比例：
     $$R_{\text{dom}} = \frac{1}{|P|}\sum_{(i,j)\in P}\mathbb{I}(v_i > v_j)$$
     **关键数学性质**：$R_{\text{dom}}$ 对**任意严格单调递增的电钢琴力度曲线完全不变（Curve-Invariant）**！无论用户把琴调成 Soft 还是 Hard，只要旋律确实比伴奏响，$R_{\text{dom}}$ 保持完全一致。
  3. **稳健段内动态跨度（Dynamic Span）**：$\text{IQR}(L) = Q_{75}(L) - Q_{25}(L)$，用于检测整段力度是否像“打字机一样完全平坦”（$\text{IQR}(v) < 6$ 往往提示固定力度键盘或动态失控）。
- **建议判据与反馈边界**：
  - 仅在有效配对数 $|P| \ge 6$ 且 $\text{IQR}(v) \ge 4$ 时启用。
  - **良好（绿）**：$\Delta L_{\text{voice}} \ge +3.0\text{ dB}$ 且 $R_{\text{dom}} \ge 75\%$；
  - **略平（琥）**：$+1.5\text{ dB} \le \Delta L_{\text{voice}} < +3.0\text{ dB}$ 或 $60\% \le R_{\text{dom}} < 75\%$；
  - **伴奏喧宾夺主（红）**：$\Delta L_{\text{voice}} < +1.5\text{ dB}$ 或 $R_{\text{dom}} < 60\%$，并标出 $\Delta L$ 最小的前 1–2 个小节。

#### 指标 2：连续跑动 IOI 时值均匀度（Temporal Evenness）

- **理论依据与心理声学基准**：
  - Jabusch, Vauth & Altenmüller（*Movement Disorders*, 2004）建立的 MIDI Scale Analysis 以及 Furuya 课题组大量音阶/跑动运动控制研究（如 Furuya et al., *PLOS ONE* / *Frontiers*）均以连续击键间隔（IOI / IKI）的标准差（SD）与变异系数（$\text{CV} = \text{SD}/\text{Mean}$）衡量手指时值均匀度。
  - **听觉分辨阈（JND）**：Friberg & Sundberg（*JASA*, 1995, 98(5): 2524–2531）通过心理声学实验确立了人耳对等时值序列时间偏差的精确双段阈律：**快拍（$\text{IOI} < 240\text{ ms}$，约 16 分音符 $\ge 63\text{ BPM}$）绝对分辨阈约为 $6\text{ ms}$**；**慢拍（$\text{IOI} \ge 240\text{ ms}$）相对分辨阈恒定约为 $\text{IOI}$ 的 $2.5\%$**。这意味着低于 6 ms 或 2.5% 的微小波动属于人耳不可辨的物理噪声，不应报警。
  - **真实曲目中的 Rubato 误判陷阱**：在真实独奏曲目而非机械音阶中，句尾渐慢（ritardando）或轻微弹性速度（rubato）会让全局 $\text{CV}(\text{IOI})$ 飙升，把**音乐性呼吸误报为“节奏不稳”**。
- **可靠计算口径（去趋势局部 nPVI + 乐谱时值归一化）**：
  1. 提取同手连续单音/主旋律线事件序列，排除 `isGrace` 装饰音、休止符跨段与跨卡顿断点（单次间隔超过乐谱预期 1.6× 记为停顿断点，不混入跑动均匀度）。
  2. 对相邻已匹配音符 $k \to k+1$，先按 `ScoreDocument` 的理论时值（经 `Speed Multiplier` 缩放）做归一化，得到**局部节奏比值**：
     $$r_k = \frac{t_{\text{on}}(k+1) - t_{\text{on}}(k)}{\Delta t_{\text{score}}(k) / \text{speedMultiplier}}$$
     （对等时值跑动如连续八分/十六分音符，等价于直接对 $\text{IOI}_k$ 缩放一个常数；对混合时值乐句，则把附点、切分从“不均匀”中剥离出来。）
  3. 采用 Patel & Daniele（*Cognition*, 2003）引入音乐节律研究的 **归一化相邻变异性指数（nPVI）** 作用于 $r_k$ 序列：
     $$\text{nPVI}_{\text{norm}} = \frac{100}{m - 1} \sum_{k=1}^{m-1} \left| \frac{r_k - r_{k+1}}{r_k + r_{k+1}} \right|$$
     **核心优势**：因为仅对**相邻音符对**求差并以其之和归一化，平缓的渐慢/渐快在相邻两音间变化极小（对 nPVI 贡献微乎其微），而**4/5 指塌陷、穿指卡顿、抢拍“瘸腿”**会在相邻音对上瞬间产生巨大尖峰！
  4. **离群点精准归因**：同时计算每个音对的局部偏离 $e_k = |r_k - \operatorname{median}_{\text{win}=5}(r)|$ 与绝对毫秒偏离 $|\Delta t_k - \Delta t_{\text{local}}|$。当 $e_k > 0.12$ 且绝对偏离 $> \max(15\text{ ms}, 0.08 \cdot \text{IOI}_{\text{local}})$ 时，标记该 `Note Event` 所在小节为抢拍（$r_k < 1$）或拖拍（$r_k > 1$），并检查相邻是否存在 `Transition Cue`（如 `thumb-under` / `cross-over`）。
- **建议判据（锚定 Friberg & Sundberg 1995 的 ~2–4 倍 JND 实用练习阈）**：
  - 有效音对 $m \ge 5$ 时计算。
  - **颗粒均匀（绿）**：$\text{nPVI}_{\text{norm}} < 5.0$（等价于相邻音平均时值抖动 $< 10\%$，对快速 16 分音符约对应 10–15 ms 内）；
  - **轻微起伏（琥）**：$5.0 \le \text{nPVI}_{\text{norm}} < 9.5$；
  - **明显抢/拖拍（红）**：$\text{nPVI}_{\text{norm}} \ge 9.5$，或出现 $\ge 2$ 处超过 20% 的局部尖峰。

#### 指标 3：双声部 / 双手纵向对齐偏移（Chord & Intermanual Synchronization）

- **理论依据与必避物理陷阱（Goebl 2001 力度伪影）**：
  Kuromiya & Furuya（*PNAS* 2025）指出双手同步性直接影响清晰度听感；但 Goebl（*JASA*, 2001，《*Melody lead in piano performance: Expressive device or artifact?*》）对专业钢琴家演奏肖邦的计算机监控钢琴数据做了里程碑拆解：在击弦/MIDI `NoteOn` 层面，旋律音普遍比伴奏音早约 **~30 ms**；但回溯到手指触碰琴键表面瞬间，双手偏移几乎为 **0 ms**！原因纯属物理力学——旋律音力度更大、键锤加速更快，提前撞击传感器/琴弦（Velocity Artifact）。
  - **工程红线**：如果产品采用对称阈值 `|t_RH - t_LH| > 15 ms` 报警，**演奏越有层次感（右手旋律越突出），系统越会误报“双手不齐”**！
- **可靠计算口径（非对称 Melody-Lead 补偿死区）**：
  1. 筛选 `Practice Mode === "both"` 下同时包含 `RH` 与 `LH` 的 `Practice Step`，**强制排除**标有 `isArpeggiated === true` 的琶音步与 `Grace Note`。
  2. 对每个双手法定同步步 $s$，计算有符号手间偏移 $\delta_s = \operatorname{median}(t_{\text{RH}, s}) - \operatorname{median}(t_{\text{LH}, s})$，并记录主声部力度差 $\Delta v_s = \max(v_{\text{RH}, s}) - \max(v_{\text{LH}, s})$，以及单手和弦内部极差 $S_{\text{chord}, s} = \max(t_s) - \min(t_s)$。
  3. **力度伪影非对称死区**：
     - **顺向提前（高力度手领先低力度手）**：若 $\operatorname{sign}(\delta_s) = -\operatorname{sign}(\Delta v_s)$ 且 $|\Delta v_s| \ge 8$，将允许死区放宽至 **$35\text{ ms}$**（即扣除典型 25–35 ms 物理提前量，仅超出的部分计为有效错开 $\delta_s^{\text{eff}} = \max(0, |\delta_s| - 35\text{ ms})$）；
     - **逆向错开（轻伴奏反而抢先于强旋律）或同力度对撞**：死区收紧至 **$22\text{ ms}$**（$\delta_s^{\text{eff}} = \max(0, |\delta_s| - 22\text{ ms})$）。
  4. **汇总指标**：有效偏移中位数 $\operatorname{median}(\delta^{\text{eff}})$、系统性单手拖后趋势（如 $\operatorname{median}(\delta_s) < -30\text{ ms}$ 且超 65% 同步步均表现为左手滞后）、以及重度“劈叉”率（$|\delta_s| > 50\text{ ms}$ 的占比）。
- **建议判据**：
  - 有效双手法定同步步 $\ge 4$ 时启用。
  - **整齐融合（绿）**：重度错开率 $< 10\%$ 且 $\operatorname{median}(\delta^{\text{eff}}) \le 10\text{ ms}$；
  - **偶发错拍（琥）**：重度错开率 $10\%–25\%$ 或存在系统性 30–45 ms 单手滞后；
  - **明显劈叉（红）**：重度错开率 $> 25\%$ 或 $\operatorname{median}(|\delta_s|) > 45\text{ ms}$。

#### 指标 4：触键连奏重叠度 vs 断奏分离度（Articulation: KOT / KOR）

- **理论依据与实证区间**：
  Repp（1995）提出 **Key Overlap Time（KOT）**，Bresin & Battel（*Journal of New Music Research*, 2000, 29(3): 211–224）提出速度无关的 **Key Overlap Ratio（KOR）**，后成为 Cancino-Chacón 等人 *Partitura* / *DExter* 演奏分析管线的标准特征。Bresin & Battel 实测莫扎特奏鸣曲 K.545 表明：专业演奏者的 **断奏（staccato）** 实际按键时长约占局部 IOI 的 **40%**（即 $\text{KOR} \approx -0.60$）；**同音反复** 约占 **60%**（$\text{KOR} \approx -0.40$）；**连奏（legato）** 为正重叠且随 IOI 系统缩放（典型 $\text{KOT} \approx +20\text{–}80\text{ ms}$，$\text{KOR} \in [+0.05, +0.25]$）。
- **可靠计算口径**：
  对同一手、同一声部（排除和弦内同时音与同音反复 `midi[n] === midi[n-1]`）的相邻已匹配音符 $n-1 \to n$，仅当**区间内延音踏板未踩下**（`!sustainActive`）时计算：
  $$\text{KOT}_n = t_{\text{off}}(n-1) - t_{\text{on}}(n), \qquad \text{KOR}_n = \frac{\text{KOT}_n}{t_{\text{on}}(n) - t_{\text{on}}(n-1)}$$
  *(注：当 `KOR` 落于 $[-1, +1]$ 外时做截断保护，防止极长跨拍延迟扭曲统计。)*
- **核心应用场景与防误报边界**：
  1. **严禁在踩下踏板区间报“手指提前离键”**：踩踏板时手指离开换把是正确技法，此时声学连贯性由指标 5（踏板）接管。
  2. **最有练琴价值的两种明确异常**（即使乐谱未解析 `<slur>`/`<staccato>` 也能高信噪比检出）：
     - **手指粘连/糊音（Finger Muddiness）**：在非踏板连续跑动（$\text{IOI} < 350\text{ ms}$）中，若相邻异音（尤其二度/半音邻音）出现 $\text{KOR} > +0.35$（或 $\text{KOT} > 90\text{ ms}$），听觉上会明显浑浊粘连，极高概率源于换指未及时离键；
     - **歌唱长音干断（Premature Release / Dry Gap）**：在标示时值饱满的慢速旋律（如二分/四分音符连续进行且无踏板）中，若 $\text{KOR} < -0.35$ 且无断奏织体特征，提示乐句呼吸中断。
  3. 未来若解析 MusicXML `<articulations><staccato/>` 与 `<slur>`，可直接对照 Bresin & Battel（2000）区间（断奏 $\text{KOR} < -0.40$，连奏 $\text{KOR} > +0.02$）做精确乐谱意图核验。

#### 指标 5：延音踏板 `CC64` 切换与和声边界浑浊度（Pedal Harmonic-Overlap Clarity）

- **理论依据与电钢琴踏板硬件现实**：
  Liang, Fazekas & Sandler（2017/2018）以及 Zhang, Fang, Wang & Fujinaga（2024/2025）系统研究了钢琴延音踏板动作（含切分踏板 syncopated pedaling、半踏板 half-pedaling）与和声重叠（harmonic overlap）的量化评估。在消费级电钢琴硬件上，`CC64` 存在两类截然不同的行为：
  - **开关踏板（Switch，如 Yamaha FC5）**：仅发离散 `0` / `127`（或 `0` / `64+`）。
  - **连续半踏板（Continuous，如 Yamaha FC3A、Roland DP-10、三踏板单元）**：发送密集 `0–127` 连续流；真钢与物理建模音源（Pianoteq / SuperNATURAL）在 `CC64 ∈ [20, 90]` 区间呈现渐进制音，低于 `~15–20` 彻底清音，高于 `~90` 完全抬起。若沿用 `webMidi.ts` 当前写死的单阈值 `data2 >= 64`，在半踏板微颤（如 `62 → 65 → 63`）时会触发大量假换踏板，或在学习者只抬到 `45` 未彻底清音时误判为“已经换干净”。
- **自适应硬件检测与迟滞滤波（零用户配置）**：
  - 在回合事件流中统计 `CC64` 的唯一值：若全段仅出现 $\le 3$ 个值（如 `{0, 127}`），标记 `pedalHardware = "switch"`，使用 `pressed = (value >= 64)`；若出现中间连续值（存在 `10 < value < 115`），标记 `pedalHardware = "continuous"`，启用 **Schmitt Trigger 双阈值迟滞状态机** + **30 ms 最小状态防抖**：
    - 进入延音态（`engaged`）：`value >= 40`
    - 确认彻底清音（`cleared`）：`value <= 20`（允许检测「半抬未清音」状态：`20 < value < 40` 停留过长）
- **可靠计算口径（识别合法切分踏板 vs 和声浑浊）**：
  1. **轻量和声切换锚点 $t_H$（无需重型和声识别模型）**：直接从 `ScoreDocument` 构造候选和声边界集合——（a）乐谱自带的 `PedalInterval.freshPress` 起点；（b）每小节首拍（若本小节低音根音 `min(LH.midi) % 12` 相比上一小节变化）；（c）小节内低音声部（LH 最低音）发生音级变化且持续 $\ge 1$ 拍的时刻。
  2. **切分踏板（Syncopated Pedaling）时间窗评估**：标准古典钢琴换踏板是「手指先落新和声 $t_H$，脚在 $t_H$ 后 **50–220 ms** 内快速抬起清音再踩下」。对每个处于踏板激活态的候选和声切换点 $t_H$：
     - **干净换踏板（Clean Syncopated / Direct Change）**：在 $[t_H - 60\text{ ms},\; t_H + 220\text{ ms}]$ 窗口内观测到 `CC64` 跌入 `cleared`（`<= 20`），且未造成提前断音；
     - **和声重叠浑浊（Harmonic Blur / Pedal Bleed）**：在 $t_H$ 之后持续超过 **250 ms**（且新和声与前和声存在低音根音变化或小二度/大七度/三全音跨界碰撞音高集合）仍未进入 `cleared`（包括「一直踩死不换」与「半踏板只抬到 35 未清干净」）；
     - **提前松踏板干断（Premature Lift Gap）**：在 $t_H$ 之前早于 `120 ms` 就进入 `cleared` 且期间手指已全部离开，造成听觉空洞。
  3. **汇总指标**：
     $$\text{Pedal Clarity Ratio} = \frac{\text{干净换踏板边界数}}{\text{踏板激活态下的候选和声边界总数}}$$
     并输出浑浊持续时长最长的 Top-2 小节编号及原因类型（`late-clear` 换脚偏慢 / `no-clear` 跨和声未换 / `incomplete-lift` 抬脚未清底 / `early-lift` 提前断音）。

---

### 2.3 电钢琴硬件偏差与 Web MIDI 工程抗噪总表

| 硬件 / 环境偏差源 | 典型表现与物理机制 | 抗噪工程策略（全自动、免手动标定） |
| :--- | :--- | :--- |
| **不同品牌力度曲线与档位**（Dannenberg 2006） | 同样触键在 Yamaha/Roland/Kawai 或 Soft/Hard 档位下 `velocity` 差 15–30 阶；响度跨度 15–105 dB | 绝不用绝对 `velocity` 判好坏；统一改用段内相对平方律 dB 代理 $\Delta L$ + 单调曲线不变的秩占优率 $R_{\text{dom}}$ |
| **固定力度琴 / 虚拟键盘 / QWERTY** | `velocity` 恒定（如 64 或 100）或 `source !== "midi"` | 检测到 `source !== "midi"` 或整段 `IQR(velocity) < 3` 时自动静默隐藏力度维度，不给假评价 |
| **BLE 蓝牙 MIDI 抖动与连接间隔** | BLE MIDI 典型 7.5–15 ms 包聚集抖动（bursting），双音同时按可能被打包成同时间戳或错开 15 ms | 强制透传 `MIDIMessageEvent.timeStamp`；检测大量事件呈现 7.5/15 ms 周期网格量化或设备名含 `Bluetooth`/`BLE` 时，将对齐/IOI 告警死区放宽 1.4× 并在设置页温和提示“USB 有线连接精度最佳” |
| **Goebl (2001) 力度-击弦时间耦合** | 强奏旋律比轻伴奏自然提前 15–35 ms | 双手对齐采用非对称死区：高力度领先放宽至 35 ms，逆向（轻伴奏抢先）收紧至 22 ms |
| **开关踏板 vs 半踏板微颤** | 开关仅 `0/127`；连续踏板在 40–70 间微颤导致高频假触发 | 会话内自动观测去重 `CC64` 值切分 `switch`/`continuous`；连续模式启用 `>=40` / `<=20` Schmitt 迟滞 + 30 ms 去抖 |
| **单次误触 / 抖键 / 换气大停顿** | 极弱误碰（`vel <= 1`）或走神停顿 2 秒拉爆方差 | 剔除 `vel <= 1` 幽灵音；所有汇总指标采用 **中位数 / IQR / MAD / 局部 nPVI** 替代脆弱的均值与标准差；超过 1.6× 预期时值的间隔切分为断点单独统计 |
| **主线程 React 渲染阻塞** | `App.tsx` 渲染重绘导致回调取时偏差 5–20 ms | `onMidiEvent` 采集层直接读 `msgEvent.timeStamp` 写入无状态 `ref` 缓冲，回合结束后一次性离线计算声学画像 |

---

## 三、Part 2：外部注意 LLM 教练协议与静态 SPA 浏览器直连约束

### 3.1 运动学习与音乐心理学理论基石

教练协议的提示词、展示形态与触发频率，严格锚定以下四项同行评审实证研究：

1. **远端外部注意优于内部注意（Duke, Cash & Allen, *Journal of Research in Music Education*, 2011, 59(1): 44–55, DOI: `10.1177/0022429410396093`)**：
   16 名音乐专业学生在键盘交替任务中分别聚焦「手指（内部）→ 琴键（近端外部）→ 琴槌（中端外部）→ 声音（最远端外部）」。结果显示：**注意焦点越远端（指向声音结果），动作时序精准度与迁移效果越高**；聚焦手指反而触发「受限动作假说（Constrained Action Hypothesis）」，干扰自动化神经运动协调。
2. **外部注意同时提升表现力与技术精准度（Mornell & Wulf, *JRME*, 2019, 66(4): 375–391；2018 在线首发）**：
   跨两项实验证实，对有经验的演奏者，要求其关注「声音表达与听众听到的乐句效果」（外部注意）比关注「手指/身体动作与精准不错音」（内部注意）及常规控制组，**同时显著提升音乐表现力与技术精准度**。
3. **OPTIMAL 运动学习理论三要素（Wulf & Lewthwaite, *Psychonomic Bulletin & Review*, 2016, 23(5): 1382–1414, DOI: `10.3758/s13423-015-0999-9`)**：
   高效率技能习得同时依赖：**（a）外部注意焦点（External Focus）**、**（b）增强成功预期（Enhanced Expectancies — 先肯定真实做对的部分以激活多巴胺奖赏巩固，而非通篇挑错）**、**（c）学习者自主权（Autonomy — 由用户掌控何时获取深入点评与选择关注焦点）**。
4. **指导假说与汇总反馈（Salmoni, Schmidt & Walter, *Psychological Bulletin*, 1984）**：
   逐音或每遍即时强塞反馈会形成「拐杖依赖」，削弱学习者自身的听觉错误检测能力；**延迟汇总反馈（Summary Feedback）与渐进撤拐（Fading Feedback）**虽然练习期看似更慢，但显著提升长期保持（Retention）与迁移（Transfer）。

---

### 3.2 零幻觉结构化 MIDI 遥测摘要与系统提示词契约

#### 架构铁律：Zero-Math LLM Boundary（本地算数字，LLM 只做声学意图转译）

绝不向 LLM 发送原始 MIDI 事件数组。本地 TypeScript 在连续演奏回合结束后，于 5 ms 内计算完所有声学统计，压缩为一份 **250–500 tokens 的封闭世界 JSON 遥测摘要（`CoachTelemetryPayload`）**。每一个允许 LLM 引用的数据点，都预先分配唯一的确定性 `evidenceId`（如 `ev-m12-voicing`）。

#### 输入遥测摘要 Schema（精简示例，约 320 tokens）

```json
{
  "schemaVersion": "1.0",
  "piece": {
    "title": "Chopin Nocturne Op.9 No.2",
    "practiceMode": "both",
    "speedMultiplier": 0.85,
    "measureRange": [9, 12],
    "timeSignature": "12/8",
    "passIndexInSegment": 3,
    "midiSource": "midi",
    "pedalHardware": "continuous"
  },
  "metrics": {
    "evenness": { "status": "ok", "nPVI": 3.8, "samplePairs": 28 },
    "voicing": { "status": "issue", "deltaDb": 0.9, "melodyDominancePct": 54, "samplePairs": 18 },
    "handSync": { "status": "ok", "medianEffOffsetMs": 6, "heavySplitPct": 5 },
    "articulation": { "status": "skipped", "reason": "sustain-active" },
    "pedalClarity": { "status": "watch", "cleanChangePct": 67, "boundaries": 6 }
  },
  "evidences": [
    {
      "id": "ev-m10-voicing",
      "dimension": "voicing",
      "severity": "issue",
      "measures": [10, 11],
      "fact": "第 10–11 小节右手旋律与左手伴奏相对响度差仅 +0.9 dB（旋律占优率 54%），层次偏平",
      "cues": []
    },
    {
      "id": "ev-m11-pedal",
      "dimension": "pedalClarity",
      "severity": "watch",
      "measures": [11, 12],
      "fact": "第 11 进 12 小节和声换根音后，踏板延迟 340 ms 才清到底（CC64 未低于 20），前和声略微残留",
      "cues": ["position-shift"]
    }
  ],
  "strengthAnchor": {
    "id": "ev-seg-evenness",
    "fact": "第 9–12 小节连续跑动时值均匀（nPVI 3.8），双手纵向对齐稳定"
  }
}
```

#### 结构化输出 JSON Schema（兼容 OpenAI / Anthropic / Gemini / Ollama 原生约束解码）

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["praise", "focusCues", "nextPassListeningGoal"],
  "properties": {
    "praise": {
      "type": "string",
      "description": "1 句基于 strengthAnchor 的真实肯定（<= 30 中文字），锚定声音效果"
    },
    "focusCues": {
      "type": "array",
      "minItems": 0,
      "maxItems": 2,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["evidenceId", "measures", "soundCue"],
        "properties": {
          "evidenceId": { "type": "string" },
          "measures": { "type": "array", "items": { "type": "integer" }, "minItems": 1, "maxItems": 2 },
          "soundCue": {
            "type": "string",
            "description": "指向声音、乐句、和声清澈度或琴键回弹结果的外部注意指令（<= 45 中文字），严禁身体部位微操"
          }
        }
      }
    },
    "nextPassListeningGoal": {
      "type": "string",
      "description": "下一遍练习时唯一的听觉自检任务（<= 35 中文字）"
    }
  }
}
```

> **各家原生 Structured Outputs 对接方式（官方第一方文档核实）**：
> - **OpenAI / OpenRouter / Ollama (`/v1/chat/completions`)**：`response_format: { type: "json_schema", json_schema: { name: "external_focus_coach", strict: true, schema } }`（所有对象均设 `additionalProperties: false` 且全字段列入 `required`）。
> - **Anthropic (`/v1/messages`)**：支持原生 `output_config.format`（JSON Schema 约束输出）或 `tool_choice` strict schema（注意不在 schema 内使用不被支持的范围约束如 `minLength`/`maxLength`，长度控制放在 Prompt + 客户端校验）。
> - **Google Gemini (`:generateContent`)**：`generationConfig: { responseMimeType: "application/json", responseSchema }`（或经 `/v1beta/openai/chat/completions` 统一走 `response_format`）。
> - **Ollama 原生 (`/api/chat`)**：`format: <JSON Schema 对象>`。

#### 系统提示词契约（System Prompt Contract）

```text
你是专注于「外部注意焦点（External Focus of Attention）」的钢琴声学教练。
你会收到一份经过本地程序精确测算的 JSON 演奏遥测摘要（CoachTelemetryPayload）。

必须严格遵守以下硬性规则：
1. 【零幻觉封闭世界】只能引用输入 `evidences` 和 `strengthAnchor` 中出现的 `evidenceId`、小节号与客观声学事实。严禁猜测或编造未提供的音名、指法编号、作曲家背景或统计数字。若 `evidences` 为空，则 `focusCues` 返回空数组，只给予肯定并建议进入下一步。
2. 【严格外部注意语言】所有 `soundCue` 与 `nextPassListeningGoal` 必须指向「声音效果、乐句线条、声部距离感、和声清澈度或琴键/踏板发声结果」（例如“让右手旋律浮在左手柔和的暗色和声之上”“在进入第 12 小节那一下听见旧和声干脆清空”）。
3. 【内部身体微操黑名单】严禁提及手指编号、手腕、掌关节、虎口、小臂、肩膀、肌肉放松/发力、抬指/贴键等身体部位动作指令。
4. 【OPTIMAL 正向与琴谱架极简约束】先用 1 句真实肯定开启（`praise`），最多聚焦 2 条最重要的问题（`focusCues`），最后给 1 个下一遍用耳朵就能验证的目标（`nextPassListeningGoal`）。总文本不超过 140 个中文字，便于在琴谱架远距 3 秒扫读。
```

#### 客户端确定性后校验（Post-Generation Verifier）与无 Key 本地兜底

模型输出 JSON 后，在展示给用户之前，客户端执行 O(1) 毫秒级校验：
1. **事实锚点校验**：检查每条 `focusCue.evidenceId` 必须严格命中输入 `evidences` 的 `id` 集合，且 `measures` 全部落在 `piece.measureRange` 内；越界项直接剔除。
2. **内部注意词黑名单扫描**：用正则检测高危身体微操词（`/(手腕|手指|指尖|指关节|虎口|小臂|手臂|肩膀|肌肉|四指|五指|大拇指|抬指|塌指|发力|僵硬)/`）。若命中且开启重试预算，附加一条极短纠偏消息重试一次；若再次命中、超时（建议 8 s `AbortController`）或网络报错，**静默无缝降级到本地确定性外部注意模板**。
3. **无 Key 本地确定性兜底模板（100% 离线可用）**：
   直接按 `evidences` 严重度排序取 Top-2，映射到预审过的外部注意中文句式，例如：
   - `voicing` → *「第 {m} 小节试着把伴奏压成轻柔的背景雾气，让高音旋律像独唱一样清亮地浮出来。」*
   - `evenness` → *「第 {m} 小节的快速跑动想象成一串大小完全一致的珍珠滚过琴键，别在转弯处突然抢步或停顿。」*
   - `handSync` → *「第 {m} 小节聆听双手和弦是否融合成一个干净饱满的整体声音，避免出现前后错开的双响。」*
   - `pedalClarity` → *「第 {m} 小节新和声响起后的刹那，用耳朵确认旧和声被踏板干脆切净，留出清澈的共鸣空间。」*
   - `articulation`（粘连）→ *「第 {m} 小节让每个快速音符之间留出干爽清晰的颗粒边界，不要让前一个音的余音拖泥带水黏进下一个音。」*

---

### 3.3 静态 SPA 浏览器直连 LLM API 与本地 Ollama：CORS、认证头与安全实践矩阵

> **验证方法说明**：大量二手技术博客仍错误声称“OpenAI/Gemini 完全不支持 CORS”。本调研结合官方第一方文档，并于 **2026-11-24** 对各云端官方生产端点实际发起标准跨域 `OPTIONS` 预检与带 `Origin: https://app.example.com` 的 `POST` 探针，核实了真实线上响应头行为。

#### 五大 Provider 浏览器直连对照矩阵

| Provider | 目标端点（浏览器直连 `fetch`） | 必需认证/特性请求头 | `OPTIONS` 预检实测（2026-11-24） | `POST` 错误/正常响应 CORS 实测与文档约束 | 纯静态 SPA 推荐评级 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **OpenRouter** | `https://openrouter.ai/api/v1/chat/completions` | `Authorization: Bearer <key>`、`Content-Type: application/json`；可选 `HTTP-Referer`、`X-Title` | `HTTP/2 204`，`access-control-allow-origin: *`，显式放行 `Authorization, HTTP-Referer, X-Title` 等全量头 | `POST`（含 401）均稳定返回 `access-control-allow-origin: *`；**官方提供 OAuth PKCE**（`https://openrouter.ai/auth` + `POST /api/v1/auth/keys`）专为纯前端 SPA 设计 | **★★★★★ 首推（一等 BYOK）** |
| **Anthropic** | `https://api.anthropic.com/v1/messages` | `x-api-key`、`anthropic-version: 2023-06-01`、**强制 `anthropic-dangerous-direct-browser-access: true`** | `HTTP/2 200`，`access-control-allow-origin: *`，放行上述全部头 | **关键机制**：实测漏传 `anthropic-dangerous-direct-browser-access: true` 时，`POST` 响应**不返回 ACAO** 被浏览器拦截；携带后返回 `access-control-allow-origin: *` + `vary: ..., anthropic-dangerous-direct-browser-access`（2024 年 8 月官方正式支持） | **★★★★☆ 官方明确支持** |
| **Google Gemini** | 原生：`https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent`<br>OpenAI 兼容：`.../v1beta/openai/chat/completions` | 原生：`x-goog-api-key`（**禁止放 URL `?key=`**）<br>兼容：`Authorization: Bearer` | 两者均 `HTTP/2 200`，**反射 `access-control-allow-origin: <Origin>`**，放行 `x-goog-api-key`/`authorization` | 两者在 `POST`（含 400 错误）均稳定反射 `access-control-allow-origin: <Origin>`；GCP/AI Studio 支持给个人 Key 绑定 **HTTP Referrer 域名白名单**，BYOK 安全性佳 | **★★★★☆ 稳定直连 + 可锁域名** |
| **OpenAI** | `https://api.openai.com/v1/chat/completions`<br>`https://api.openai.com/v1/responses` | `Authorization: Bearer <key>`、`Content-Type: application/json`（若用官方 SDK 需 `dangerouslyAllowBrowser: true`） | `HTTP/2 200`，Chat 反射 `<Origin>`，Responses 返回 `*` | **重大工程坑点**：实测 `POST` 返回 `401`（如用户填错 Key）时，边缘层**缺失 `access-control-allow-origin` 头**！浏览器会隐藏 401 响应体，直接抛 `TypeError: Failed to fetch`（CORS 报错），前端无法区分 Key 错误与断网；且官方不承诺长期支持浏览器直连 | **★★★☆☆ 可用但需容错兜底** |
| **本地 Ollama** | `http://localhost:11434/api/chat` 或 `http://localhost:11434/v1/chat/completions` | 无需 Key（本地隐私 0 费用） | 仅对允许源返回 CORS；默认放行 `localhost`/`127.0.0.1`/`0.0.0.0`（任意端口）及 `app://`/`file://`/`tauri://` | **两大现实约束**：(1) 本站部署于公网 HTTPS（如 EdgeOne Pages）时默认返回 **403/CORS 拦截**，用户必须设环境变量 `OLLAMA_ORIGINS="https://<本站域名>"` 并重启 Ollama；(2) 跨安全上下文访问 loopback 触发浏览器 Mixed Content / LNA 规则（见下文） | **★★★★☆ 隐私零费（需 1 步向导）** |

#### 公网 HTTPS 静态 SPA 直连本地 Ollama 的浏览器兼容真相

本应用部署形态为纯静态 SPA（参见 [`docs/deployment-edgeone.md`](../deployment-edgeone.md)，托管于公网 `https://` 域名，同时支持本地 `http://localhost` 开发/自托管）：

1. **Chrome / Edge（本应用 Web MIDI 首选浏览器）**：
   - W3C 规范将 `localhost` / `127.0.0.1` 视为 *Potentially Trustworthy Origin*，Chrome 免除其 Mixed Content 拦截；
   - **但自 Chrome 142（2025 年底起）全面上线 Local Network Access（LNA）安全门控**：公网 `https://` 页面首次 `fetch('http://localhost:11434/...')` 时，浏览器会弹出原生权限提示（`loopback-network`，“允许此网站连接本机上的应用”）。用户点击允许后方可通信，且同时豁免 Mixed Content。**产品设置向导必须提前图文说明这一步，并给出 Ollama `OLLAMA_ORIGINS` 复制命令！**
2. **Firefox**：支持 `https://` → `http://localhost` / `http://127.0.0.1` 的 Mixed Content 豁免（Firefox 55/84 起），配置好 `OLLAMA_ORIGINS` 即可直连。
3. **Safari**：**严格阻止** `https://` 页面请求 `http://localhost`（触发不可绕过的 Mixed Content 拦截），除非用户在本地给 Ollama 套 HTTPS 反代（如 Caddy）。鉴于 Safari 本身也不原生支持 Web MIDI API，前端可直接提示“Web MIDI 与本地 Ollama 推荐使用 Chrome / Edge”。
4. **`OLLAMA_ORIGINS` 安全最小权限指引**：引导用户设为精确来源（如 `OLLAMA_ORIGINS="https://your-studio-domain.example"`），**切忌在教程中随意推荐 `OLLAMA_ORIGINS="*"`**（否则任意打开的公网网页都能静默探测并盗用用户本机 GPU 算力）。macOS 配置示例：`launchctl setenv OLLAMA_ORIGINS "https://<本站域名>"` 后重启 Ollama 应用。

#### 纯静态 SPA 的 BYOK 密钥与通信安全实践

1. **零重型 SDK，双轻量 Fetch 适配器统一接入**：
   - 不引入 `@anthropic-ai/sdk`、`openai`、`@google/genai` 等重型 Node-first SDK（避免打包体积膨胀及各家 `dangerouslyAllowBrowser` 差异）。
   - 用 < 250 行原生 TypeScript `fetch` + `AbortController`（8 s 超时）实现仅 **2 个薄适配器**：
     - **`OpenAICompatibleAdapter`**：一次覆盖 **OpenRouter（含 OAuth PKCE）**、**Google Gemini (`/v1beta/openai/`)**、**OpenAI**、**本地 Ollama (`/v1/chat/completions`)** 及用户自定义的任意兼容网关（如 DeepSeek / 自建反代）；
     - **`AnthropicMessagesAdapter`**：专用于 `https://api.anthropic.com/v1/messages`，固定注入 `anthropic-dangerous-direct-browser-access: true` 与 `anthropic-version: 2023-06-01`。
2. **密钥存储分级与防误导泄露**：
   - **默认「仅当前会话（`sessionStorage` / 内存）」**，关闭标签页自动销毁；
   - 提供显式开关「在本设备记住密钥（写入 `localStorage`）」，旁附单行风险提示（“密钥仅保存在您的浏览器本地，绝不上传至本站服务器；请勿在公共电脑勾选”）；
   - **数据边界铁律**：IndexedDB 练习历史与用户手动导出的 JSON 备份文件**严禁包含任何 API Key 或 Base URL 凭据**；
   - **绝不走 URL Query 传 Key**：例如调用 Gemini 时强制走 `x-goog-api-key` 或 `Authorization: Bearer` 头，绝不拼接 `?key=...`（防止泄露到浏览器历史、代理日志或 Referer）。
3. **OpenAI 401 CORS 盲区专项处理**：
   对 OpenAI 直连请求若捕获 `TypeError`（浏览器吞掉无 ACAO 的 401 错误），前端明确提示：「请求被拦截：可能是 API Key 无效/额度耗尽（OpenAI 401 响应未返回 CORS 头），或网络无法直连 `api.openai.com`。建议检查 Key 或改用 OpenRouter / Gemini。」
4. **最小化 XSS 攻击面**：
   因 BYOK 密钥驻留浏览器前端，静态站部署配置中应坚持无第三方统计/广告脚本、使用 React 默认转义（禁止 `dangerouslySetInnerHTML` 渲染 LLM 文本），并在托管层配置严格 `Content-Security-Policy`（`script-src 'self'`、`object-src 'none'`）。

---

## 四、面向下游决策票 `#19` 的工程落地建议

结合 `#19` 需要拍板的三大问题，本调研直接收敛如下可拍板方案供 `#19` 评审：

### 4.1 连续演奏的轻量匹配边界（不做 HMM / OLTW 自由 Rubato 追谱）

在放弃浏览器端复杂 Rubato 实时追谱的前提下，推荐采用**「定速跟拍单乐段录制 + 回合后有界动态窗口归因（Bounded Window Attribution）」**：
1. **定速锚点**：连续演奏回合启动前提供 1 小节 `Count-In`，播放节拍器（和/或单手伴奏音轨），确定性锚定回合起点 $t_0$，每个乐谱 `Note Event` 均有明确的理论时刻 $t_i^{\text{exp}} = t_0 + (\text{onsetSec}_i - \text{segStartSec}) / \text{speedMultiplier}$。
2. **回合后单遍离线轻量归因（计算耗时 < 2 ms）**：
   - 对每个实测 `noteon` 事件，按 `midi` 音高在非对称捕获窗 $[t^{\text{exp}} - W_{\text{early}},\; t^{\text{exp}} + W_{\text{late}}]$ 内做最近邻贪心/一维二分匹配，其中 $W_{\text{early}} = \min(220\text{ ms},\; 0.40 \cdot \text{IOI}_{\text{local}})$、$W_{\text{late}} = \min(280\text{ ms},\; 0.48 \cdot \text{IOI}_{\text{local}})$。
   - **漏弹不崩盘**：窗内无匹配 `Note Event` 标记为 `missed`，走带与后续匹配完全不受影响；
   - **多弹不污染**：未命中任何预期音高的 `noteon` 标记为 `extra`，单独计入错音率，不进入 IOI / KOR / Voicing 计算；
   - **卡顿半拍优雅处理**：若演奏者中途整体滞后超过半拍（$> 0.6\text{ beat}$），不强行做全局 DTW，而是在该断点之后允许**最多 1 次小节/强拍局部时钟重锚（Local Beat Re-anchor）**，并将断点前后的跨段间隔标记为 `hesitationBreak`——既避免把卡顿后的整段都判为全错，又防止把卡顿时长污染进跑动 nPVI。

### 4.2 琴谱架视野内延迟汇总卡片：只展示 2–3 个核心指标

遵循 *Profy*（DIS '26）「局部定位 > 全局打分」与琴谱架远距 3 秒扫读约束，**禁止展示 5 张折线图或 0–100 综合打分**，每回合结束后的汇总卡片严格限定为 **「顶部 2–3 枚状态胶囊 + 底部小节热区条（点击即设为 `A-B Loop`）」**：

- **槽位 1（常驻）**：**节奏均匀度（Evenness）** — 由去趋势 $\text{nPVI}_{\text{norm}}$ 驱动（绿/琥/红 + 最不稳小节号）。
- **槽位 2（自适应）**：
  - 双手/多声部乐段 → **声部层次（Voicing）**（$\Delta L_{\text{voice}}$ & 旋律占优率）；
  - 纯单旋律单手乐段 → 自动切换为 **触键清晰度（Articulation KOR）**（检测跑动粘连或干断）。
- **槽位 3（按信号自适应，无则隐藏保持 2 枚）**：
  - 检测到 `CC64` 活动 → **踏板清晰度（Pedal Clarity）**（干净换踏板率 + 浑浊小节）；
  - 无踏板且为双手同步和弦织体 → **双手对齐（Hand Sync）**（经 Goebl 伪影补偿的错开状态）。

### 4.3 外部注意教练的触发时机与降级策略

遵循 Guidance Hypothesis（Salmoni et al., 1984）与 OPTIMAL Autonomy（Wulf & Lewthwaite, 2016）：
1. **0 ms 本地先行**：回合结束瞬间立刻展示「2–3 枚声学状态胶囊 + 小节热区 + 1 句本地确定性外部注意提示」（零延迟、零费用、离线可用）。
2. **默认按需触发 + 可选每 3 遍汇总触发（绝不每遍自动弹窗）**：
   - 默认提供大号按钮「获取 AI 外部注意点评」（支持免手控快捷键，例如待机态双击最左端 A0 键或长踩踏板触发，交由 `#15`/`#19` 统一收口）；
   - 用户可在设置中开启「每满 3 遍自动汇总点评」（契合 Summary Feedback 科学机制，同时将 BYOK 成本降低 3 倍）；
   - 任何 API 失败、401 盲区或 8 s 超时均静默回退到本地兜底提示，并在角标显示无打扰的状态灯。

---

## 五、参考文献与第一方资料索引

### 学术与心理声学第一方文献

1. **Kuromiya, K., Kobayashi, Y., Hirano, M., & Furuya, S. (2025).** *Motor origins of timbre in piano performance*. Proceedings of the National Academy of Sciences (PNAS). DOI: [`10.1073/pnas.2425073122`](https://doi.org/10.1073/pnas.2425073122)
2. **Kawamura, K., Nakamura, F., Nishioka, H., Shioki, M., Furuya, S., & Rekimoto, J. (2026).** *Profy: Interpretable Visualization of Expertise-Dependent Motor Skills Toward Supporting Piano Practice*. Proceedings of the 2026 ACM Designing Interactive Systems Conference (DIS '26) / [`arXiv:2606.10627`](https://arxiv.org/abs/2606.10627).
3. **Lerch, A., Arthur, C., Pati, A., & Gururani, S. (2020/2021).** *An Interdisciplinary Review of Music Performance Analysis*. Transactions of the International Society for Music Information Retrieval (TISMIR).
4. **Pati, K. A., Gururani, S., & Lerch, A. (2018).** *Assessment of Student Music Performances Using Deep Neural Networks*. Applied Sciences, 8(4), 507; 及 *Score-Informed Networks for Music Performance Assessment* (ISMIR, 2020).
5. **Dannenberg, R. B. (2006).** *The Interpretation of MIDI Velocity*. Proceedings of the International Computer Music Conference (ICMC 2006), Carnegie Mellon University.
6. **Goebl, W. (2001).** *Melody lead in piano performance: Expressive device or artifact?* The Journal of the Acoustical Society of America (JASA), 110(1), 563–572.
7. **Friberg, A., & Sundberg, J. (1995).** *Time discrimination in a monotonic, isochronous sequence*. The Journal of the Acoustical Society of America (JASA), 98(5), 2524–2531.
8. **Jabusch, H.-C., Vauth, H., & Altenmüller, E. (2004).** *Quantification of focal dystonia in pianists using scale analysis*. Movement Disorders, 19(2), 171–180.
9. **Patel, A. D., & Daniele, J. R. (2003).** *An empirical comparison of rhythm in language and music*. Cognition, 87(1), B35–B45.（nPVI 音乐节奏公式出处）
10. **Bresin, R., & Battel, G. U. (2000).** *Articulation Strategies in Expressive Piano Performance: Analysis of Legato, Staccato, and Repeated Notes in Performances of the Andante Movement of Mozart's Sonata in G major (K 545)*. Journal of New Music Research, 29(3), 211–224.（KOR / KOT 实证区间）
11. **Liang, B., Fazekas, G., & Sandler, M. (2017/2018).** *Measurement, Recognition, and Visualization of Piano Pedaling Gestures and Techniques*; 及 **Zhang, H., Fang, K., Wang, Z., & Fujinaga, I. (2024/2025).** *Evaluating High-Resolution Piano Sustain Pedal Depth Estimation with Musically Informed Metrics*.
12. **Duke, R. A., Cash, C. D., & Allen, S. E. (2011).** *Focus of Attention Affects Performance of Motor Skills in Music*. Journal of Research in Music Education, 59(1), 44–55. DOI: [`10.1177/0022429410396093`](https://doi.org/10.1177/0022429410396093)
13. **Mornell, A., & Wulf, G. (2019; online 2018).** *Adopting an External Focus of Attention Enhances Musical Performance*. Journal of Research in Music Education, 66(4), 375–391.
14. **Wulf, G., & Lewthwaite, R. (2016).** *Optimizing performance through intrinsic motivation and attention for learning: The OPTIMAL theory of motor learning*. Psychonomic Bulletin & Review, 23(5), 1382–1414. DOI: [`10.3758/s13423-015-0999-9`](https://doi.org/10.3758/s13423-015-0999-9)
15. **Salmoni, A. W., Schmidt, R. A., & Walter, C. B. (1984).** *Knowledge of Results and Motor Learning: A Review and Critical Reappraisal*. Psychological Bulletin, 95(3), 355–386.（Guidance Hypothesis）

### W3C 规范与官方第一方 API 文档

16. **W3C Web MIDI API Specification (`MIDIMessageEvent` / `DOMHighResTimeStamp`)**: <https://www.w3.org/TR/webmidi/>；MDN `DOMHighResTimeStamp`: <https://developer.mozilla.org/en-US/docs/Web/API/DOMHighResTimeStamp>
17. **Anthropic API Docs — CORS (`anthropic-dangerous-direct-browser-access`) & Structured Outputs**: <https://docs.anthropic.com/> / `@anthropic-ai/sdk` (`dangerouslyAllowBrowser: true`)；实测端点 `https://api.anthropic.com/v1/messages`（2026-11-24）。
18. **OpenAI API Docs — Structured Outputs & `openai-node` (`dangerouslyAllowBrowser`)**: <https://platform.openai.com/docs/guides/structured-outputs> & <https://github.com/openai/openai-node>；实测端点 `https://api.openai.com/v1/chat/completions` & `/v1/responses`（2026-11-24）。
19. **Google Gemini API Docs — API Key Security, Structured Outputs & OpenAI Compatibility**: <https://ai.google.dev/gemini-api/docs/api-key>、<https://ai.google.dev/gemini-api/docs/structured-output>、<https://ai.google.dev/gemini-api/docs/openai>；实测端点 `https://generativelanguage.googleapis.com/v1beta/...`（2026-11-24）。
20. **OpenRouter Docs — CORS, App Attribution & OAuth PKCE**: <https://openrouter.ai/docs/use-cases/oauth-pkce> & `POST https://openrouter.ai/api/v1/auth/keys`；实测端点 `https://openrouter.ai/api/v1/chat/completions`（2026-11-24）。
21. **Ollama Official Docs — `OLLAMA_ORIGINS` FAQ & Structured Outputs**: <https://docs.ollama.com/faq> & <https://docs.ollama.com/capabilities/structured-outputs>
22. **Chrome for Developers — Local Network Access (Chrome 142+ `loopback-network` permission & Mixed Content)**: <https://developer.chrome.com/blog/local-network-access> & W3C Mixed Content / Secure Contexts 规范。
