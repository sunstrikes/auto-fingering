# 钢琴运动技能的穿插调度、清醒微休息与间隔复习参数模型调研

> **关联议题**：母地图 `#11`（Wayfinder: 循证 AI 钢琴高效练琴体系规划） · 调研票 `#13` · 下游决策票 `#18`（决策：穿插微休息调度状态机与二维间隔复习策略）
> **研究范围**：面向连接 `MIDI Input Device` 的电钢琴进阶自学者，基于近 15–20 年运动神经科学、音乐心理学与 FSRS 一手文献，产出可计算的现代练琴调度参数区间、边界条件与代码演进建议。
> **领域词汇**：严格遵循仓库 [`GLOSSARY.md`](../../GLOSSARY.md) 规范术语；涉及 [`ADR-0002`](../adr/0002-interactive-practice-midi-waiting-loop.md) 边界处已显式标注。

---

## 执行摘要与核心参数速查表

传统钢琴软件的「单一 `A-B Loop` 反复死磕 + 连续 3 遍零失误线性推进」在运动学习科学中属于**低语境干扰的组块集中练习（Blocked Practice）**，极易诱发「胜任感错觉（Illusion of Competence）」并在 24–48 小时后出现显著遗忘与接缝断裂（Abushanab & Bishara, 2013; Carter & Grahn, 2016）。另一方面，直接照搬面向语言卡片的 Anki / FSRS 间隔重复模型同样在钢琴上失效：钢琴演奏属于**睡眠门控的程序性运动技能**，短时同日间距（0–15 分钟）不产生语言记忆那样的间距效应（Wiseheart et al., 2017），且其掌握状态不是二元的「记得/忘掉」，而是由 **`Speed Multiplier` × 准确度 × 组块内/接缝流畅度** 构成的连续多维表面（Shmuelof et al., 2012; Sakai et al., 2003）。

下表汇总四大核心模块的**可计算参数区间、实证依据与硬性边界**：

| 模块 | 核心可计算参数 | 推荐区间 / 规则 | 一手文献支撑 | 关键边界条件 |
| :--- | :--- | :--- | :--- | :--- |
| **1. 穿插调度（Interleaving）** | 单次会话活跃轮换组块数 | **3–4 块**（复杂复调/冷启动降至 2–3 块；纯复习上限 5 块） | Stambaugh (2011, 2013); Stambaugh & Demorest (2010); Abushanab & Bishara (2013); Carter & Grahn (2016) | 内在负荷过高时高 CI 反而损害准确率（Stambaugh, 2013; Brady, 2004） |
| **1. 穿插调度** | 单块单次停留时长 / 遍数上限 | **1–3 min** 或 **3–6 次尝试（1–2 遍干净通即切走）** | Carter & Grahn (2016) [3 min]; Stambaugh & Demorest (2010) [1–2 min]; Stambaugh (2011) [6 trials] | 连续 3 次错音率 >50% 触发降速/拆块熔断，杜绝错误肌肉记忆强化（Duke et al., 2009） |
| **1. 穿插调度** | 冷启动 `Blocked → Interleaved` 切换 | 慢速（`0.50x–0.65x`）达成 **1–2 遍干净通** 或冷启动达 **3–5 min** 即切入 `Serial` 轮换；达 `≥0.75x–0.85x` 后进入 `Random` 轮换 | Porter & Magill (2010); Guadagnoli & Lee (2004); Shea et al. (1990); Wulf & Shea (2002) | 切忌在冷启动阶段死磕至 `1.0x` 才轮换，也切忌对零基础生谱直接随机穿插 |
| **2. 清醒微休息与意象** | 段末静息窗（Micro-Offline） | **10–15 s** 纯静息（双手离键、低刺激暗屏、零交互打断） | Bönstrup et al. (2019, 2020); Buch et al. (2021); Gupta & Rickard (2022, 2024); Wamsley (2019, 2022) | 屏上图表/弹窗互动会引发逆向干扰并打断 20× 海马-新皮层神经重放（Wamsley, 2019） |
| **2. 清醒微休息与意象** | 段前意象预演窗（Audiation / Imagery） | 静息结束后、切入下一组块前 **10–20 s**（总切换间隙 **15–30 s**）；先听觉内省（时值/预判），再手位意象（速度/落点） | Bernardi et al. (2013a, 2013b); Coffman (1990); Highben & Palmer (2004); Driskell et al. (1994) | 生疏组块（`<2` 遍）应先播一遍音频范奏再引导无声意象；单日总意象占比 ≤15–20%、累计 ≤20 min |
| **2. 清醒微休息与意象** | 会话内前期宏观休息 | 30 min 会话第 **10–15 min** 后插入 **2–5 min** 离开琴键的静息 | Cash (2009) | 早置休息显著放大次日睡眠离线巩固收益，优于末期休息或无休 |
| **3. 跨天间隔复习（Motor-FSRS）** | 遗忘曲线与睡眠门控初始稳定度 $S_0$ | 采用 FSRS-6 幂律曲线，但覆盖语言默认 $S_0$：`Again=同日重排+1d`、`Hard=1d`、`Good=1–2d`、`Easy=3–4d`（仅 `Both Hands` 且 `≥0.90x` 可触发） | Ye et al. (2022); FSRS-6 Spec; Simmons & Duke (2006); Simmons (2012); Wiseheart et al. (2017); Cepeda et al. (2008) | 首次有效巩固必须跨越 ≥1 次完整夜间睡眠（24 h）；禁止在 Day 1 直接跳 8.3 天 |
| **3. 跨天间隔复习** | 多维掌握度与升档折减 | 状态向量 `(stableSpeed, handStage, accuracy, interiorFluency, junctionFluency, D, S)`；以每次冷启**首遍**自动评定 FSRS 等级；提速/合手升档时将 $S$ 折减至 `min(S, 1–2d)` | Shmuelof et al. (2012); Sakai et al. (2003); Chaffin & Imreh (2002); Walker et al. (2003) | 犹豫度（尤其组块接缝停顿）必须阻断 `Good`/`Easy` 评级；严禁把慢速高 $S$ 继承到原速 |
| **4. 亚最大提速与手部迁移** | 亚最大训练区与分区相对步长 | 主力巩固区 **`0.65x–0.85x`**；步长采用相对比例而非固定线性 `+0.15x`：解码区 `+10–15%`、亚最大区 `+8–10%`、原速冲刺区 **`+5%`**（约 2–4 BPM） | Furuya et al. (2013); Furuya & Soechting (2012); Dalla Bella & Palmer (2011); Goebl & Palmer (2013); Duke et al. (2009) | `<0.50x` 仅限 Stage 0 识谱编码，不可久留；精确百分比步长属应用工程参数化（正文已明示） |
| **4. 亚最大提速与手部迁移** | 单手（HS）→ 双手（HT）节奏 | 默认尽早低速 `Both Hands`；仅当单手主导失误 ≥75% 或独立复调干涉时触发 `rh-only`/`lh-only`，**1–2 遍干净通（≤2–3 min）即强制合手并自动降速 10–15%** | Furuya et al. (2013) [零跨手迁移]; Brown (1933); Rubin-Rabson (1939); Swinnen (2002) | 单手训练向对侧手迁移为零，且过度单手固化会制造合手负迁移（Brown, 1933; Swinnen, 2002） |

---

## 现有代码基线诊断：对比 `waitingMode.ts` 与 `practiceAnalytics.ts`

为确保后续调度器（`#18`）既能平滑承接现有 Stage 0 识谱落键工具，又不被旧有启发式规则掣肘，先对仓库现行实现做精确盘点：

1. **`src/practice/waitingMode.ts`（`Waiting Mode` 绝对严格落键验证）**：
   - 采用**绝对严格模式（Absolute Strictness）**：任意错音（`wrong-note`）或未满足 `DEFAULT_HOLD_DURATION_RATIO = 0.8` 缩放时值的提前松键（`early-release`，钳制在 `[0.06s, 4.0s]`）都会将当前 `Practice Step` 标记为 `tainted`，清空 `hitMidis`，直到所有按下琴键释放才允许重试。
   - **科学定位与局限**：它非常适合 **Stage 0 冷启动识谱编码**（在低速下防止错误音高和指法写入记忆，契合 Duke et al., 2009 的「高正确率试次」原则）；但按 [`ADR-0002`](../adr/0002-interactive-practice-midi-waiting-loop.md) 约束，`Waiting Mode` 在等待输入时会暂停节拍器，因此**无法在真实时间流压力下验证节奏连续性、速度-准确率权衡（SAF）与组块接缝流畅度**。科学调度器的进阶巩固与跨天复习必须依赖**不停顿的实时节拍/连续演奏验证模式**。
2. **`src/practice/practiceAnalytics.ts`（会话级分析与线性推进器）**：
   - **固定集中式通关门槛**：`MASTERY_REQUIRED_CLEAN_PASSES = 3`，要求在同一 `A-B Loop` 连续 3 遍零失误才算 `mastered`，驱动的是典型的 **Blocked 线性状态机**（`practicing → step-up-hand → step-up-speed → ready-next-measure → piece-mastered`）。
   - **犹豫度未纳入掌握度阻断条件**：虽然定义了步间延迟检测常量（`FLUENCY_HESITATION_RATIO_THRESHOLD = 1.6`、`FLUENCY_MIN_EXTRA_LATENCY_SEC = 0.45`），但在 `recordPracticeStepCompleted` 与 `evaluatePracticeProgression` 中，犹豫**不会重置 `cleanStreak`，也不会阻止 `mastered = true`**，仅在文案中附加提示，且未区分「组块内步间犹豫」与「跨小节/组块接缝停顿」。
   - **固定线性提速步长与粗暴降速**：`evaluatePracticeProgression` 使用固定线性增量 `+0.15x`（第 848 行，从 `0.50x → 0.65x` 实际相对增速高达 `+30%`，在 `0.85x → 1.00x` 也达 `+17.6%`）；`buildPracticeRepeatRecommendations` 出错时一刀切乘 `0.75`（第 644 行，下限 `0.5x`），未区分轻微冷启手生与结构性崩盘。
   - **合手切回未做降速补偿**：单手（`rh-only`/`lh-only`）达标进入 `step-up-hand` 切回 `both` 时，仅调用 `resetMeasureCleanStreak` 清零连胜，却保持原 `Speed Multiplier` 不降速，容易直接撞上双手耦合墙（Swinnen, 2002）。
   - **零穿插队列、零微休息/意象编排、零跨天持久化**：`PracticeAnalyticsState` 完全驻留单次内存会话，缺乏跨组块调度队列、静息计时器与跨天遗忘曲线追踪。

> **ADR 兼容性说明（依据 `docs/agents/domain.md`）**：[`ADR-0002`](../adr/0002-interactive-practice-midi-waiting-loop.md) 第 6 条明确约定基础手动 `A-B Loop`「no automatic speed ramping」，第 5 条约定 `Waiting Mode` 服务基础交互排练；同时母地图 `#11` 规定保留现有手动 `A-B Loop`、`Waiting Mode` 与 `practiceAnalytics.ts` 作为「阶段 0 · 初识谱落键工具」。因此，本文给出的穿插队列、自动阶梯提速、微休息计时与 Motor-FSRS 均应作为**上层可切换的「科学练琴调度模式」**增量叠加，**不破坏 ADR-0002 对手动 `A-B Loop` 与 `Waiting Mode` 的既有契约**。

---

## 一、穿插练习（Interleaved Practice）与冷启动切换参数模型

### 1.1 一手实证证据矩阵

音乐演奏与运动学习领域的语境干扰（Contextual Interference, CI）研究表明：**集中练习（Blocked）提升当堂流畅度错觉，穿插/随机练习（Interleaved/Random）提升 24–48 小时后的真实保持率与迁移能力**，但其收益严格受任务内在负荷与学习者熟练度调制：

| 一手文献 | 实验对象与乐器/任务 | 轮换组块数与单块停留参数 | 保持期与核心实证结果 | 对调度模型的启示 |
| :--- | :--- | :--- | :--- | :--- |
| **Carter & Grahn (2016)**, *Front. Psychol.* | 10 名进阶单簧管演奏者（均龄约 8.7 年琴龄）；4 首真实曲目（2 首 >2 min 协奏曲呈示部 + 2 首 <1 min 技术选段） | 组内对照：Blocked = 每首连续 **12 min**；Interleaved = 两首以 **3 min/首** 交替 4 轮（总计仍为 12 min/首） | 24 小时后由 3 名职业演奏家盲评：凡出现评分差异处，**Interleaved 均优于 Blocked**；问卷显示受试者报告目标设定更清晰、专注度与纠错识别率更高 | 长乐段以 **3 min** 为轮换切片即可产生显著保持优势；较短钢琴组块应进一步缩至 1–2.5 min |
| **Abushanab & Bishara (2013)**, *Mem. Cognit.* 41(6):928–937 | 受过正规钢琴训练的演奏者；**钢琴旋律**（8 首关键旋律，组内设计） | **4 首**固定顺序（Blocked: A-A-A, B-B-B） vs **4 首**随机顺序（Interleaved） | 练习当堂 Fixed 更快；**2 天后保持测试 Random 在速度与准确率上均显著反超 Fixed**；但受试者的元认知预测依然错误地认为 Fixed 更好（**Illusion of Competence**） | **钢琴直接实证**：4 组块轮换有效；必须设计 UX 机制对抗用户「切来切去感觉不顺手」的元认知错觉 |
| **Stambaugh (2011)**, *JRME* 58(4):368–383 | 41 名初学单簧管学生；**3 首** 7 音旋律练习 | 连续 3 天、每天 **18 试次**：Blocked = 单首连弹 18 遍；Random = **3 首各 6 遍**随机交错 | 习得末期无差异；**24 小时延迟保持测试中 Random 组演奏显著更快且保持更佳** | 短乐句（1–2 小节）单日每块 6 试次、分散在轮换中即可显著拉高次日速度 |
| **Stambaugh & Demorest (2010)**, *Update* 28(2):20–28 | 7 年级木管初学者；**3 首** 8 小节旋律 | 总时长 **18 min**：Blocked（**6 min** × 3） vs Hybrid（每 **2 min** 切换） vs Serial/Random（每 **1 min** 切换） | 验证了 1–2 min 频次切换在真实 8 小节乐段上的可行性与不同负荷响应 | 常规 4–8 小节乐段单次停留 **1–2 min** 是合理生态窗口 |
| **Stambaugh (2013)**, *Psychol. Music* 41(6):749–763 | 46 名大学管乐生（木管 vs 铜管）；**3 首** 7 音技术片段 | Blocked vs Random，24 小时保持测试 | **关键交互效应**：木管组 Random 在速度与均匀度显著胜出；**铜管组反而 Blocked 在准确率与速度上更优**（因铜管唇振/气息的基线内在认知与生理负荷更高） | **硬性边界**：当钢琴组块内在负荷极高（初识复调、大跨度八度跳进）时，强行随机穿插会过载并损害准确率 |
| **Brady (2004, 2008)**, *Percept. Mot. Skills* | 元分析（61 项研究，139 个效应量） | 汇总实验室基础任务与真实应用运动任务 | 总效应量 $d=0.38$；基础实验室 $d=0.57$ vs **真实应用技能 $d=0.19$**；成人 $d=0.50$ vs **儿童 $d=0.10$（不显著）** | 复杂真实乐器技能不可直接照搬实验室「从第一遍起就纯随机」的极端策略 |
| **Guadagnoli & Lee (2004)**, *J. Mot. Behav.*; **Wulf & Shea (2002)**, *Psychon. Bull. Rev.* | 挑战点理论（Challenge Point Framework）与复杂技能综述 | 区分名义难度（Nominal）与功能难度（Functional） | 复杂技能本身占用高信息处理带宽，过早施加高 CI 会使功能难度越过最优挑战点，阻碍广义运动程序（GMP）形成 | 必须按个体当前熟练度动态调节 CI 强度 |
| **Shea, Kohl, & Indermill (1990)**, *Acta Psychol.* 73(2):145–157 | 50 / 200 / 400 试次交互实验 | 比较不同练习量下 Blocked 与 Random 的保持曲线 | 练习早期（50 试次）Blocked 占优；随编码充分（400 试次），Random 在保持测试中显著反超且动作程序更灵活 | 支持「冷启动短期 Blocked → 充分编码后切入 Random」的阶段演进 |
| **Porter & Magill (2010)**, *J. Sports Sci.* 28(12):1277–1285 | 2 项真实运动技能实验（高尔夫推杆 + 篮球多类型传球） | 对比纯 Blocked、纯 Random 与**系统递增 CI 调度（Blocked → Serial → Random）** | **渐进递增 CI 组在保持测试与迁移测试中同时击败纯 Blocked 组和纯 Random 组** | **核心调度范式**：对单个钢琴组块实施 `Blocked（建图）→ Serial（有序穿插）→ Random（随机穿插）` |
| **Duke, Simmons, & Cash (2009)**, *JRME* 56(4):310–321 | 17 名大学钢琴专业本科/研究生；肖斯塔科维奇《第一钢琴协奏曲》3 小节高难乐段 | 自由练习至自信达标，24 小时后原速保持测试 | **总练琴时长、总试次、完整遍数与次日成绩均无显著相关**；次日名次由**练琴正确试次占比**决定（全部试次正确率 $r=-0.51$、完整试次正确率 $r=-0.71$、错误试次数 $r=0.48$）；前 3 名全部采用：早期带音乐抑扬（Inflection）、精准定位错误源、降速拆解再递增提速、立即验证修复稳定性 | 穿插调度必须配合**错误熔断**：切忌放任用户带着高错音率盲目刷遍数 |

### 1.2 可计算穿插调度参数与三阶段冷启动切换规则

综合上述实证，推荐为下游调度状态机（`#18`）建立以下可计算参数：

1. **活跃轮换池大小（Active Rotation Pool, $K$）**：
   - **默认标准值：$K = 3\text{–}4$ 个组块**（对应 Stambaugh 2011/2013 的 3 乐句与 Abushanab & Bishara 2013 的 4 首钢琴旋律，同时落在工作记忆焦点容量内）。
   - **负荷自适应缩放**：
     - 高内在负荷会话（含 ≥2 个新学冷启动复调/高 `Transition Cue` 密度组块）：收缩至 **$K = 2\text{–}3$**（避免 Stambaugh 2013 铜管式的认知过载）。
     - 纯跨天巩固/复习会话（组块均已建立动作图谱）：可扩展至 **$K = 4\text{–}5$**，增加检索重建频率。
   - **去相似干扰约束（Anti-Interference Pairing）**：同一轮相邻两个组块尽量避免指法模式高度相似但尾音不同的「近义变体」（如同一曲目中仅末尾转调的 A 段与 A' 段），防止逆向干扰（Allen, 2013; Walker et al., 2003）。

2. **单块单次停留预算（Per-Visit Dwell Budget）**：
   - **短组块（1–4 小节 / 典型乐句或接缝桥接）**：每次停留 **`1.0–2.5 min`** 或 **`3–6 次尝试`**（以先到者为准）；若在 `Serial`/`Random` 阶段完成 **`1–2 遍` 无错流畅通**，立即结束本次访问并切换（避免滑回低效集中重复）。
   - **较长组块（5–12 小节完整段落）**：上限 **`3.0 min`**（对应 Carter & Grahn 2016 的 3 min 切片）或 **`2–3 遍`**。
   - **错误熔断规则（基于 Duke et al., 2009）**：若单次访问内连续 **2–3 遍**出现相同 `Practice Step` 错音（或正确步占比 `< 80%`），禁止继续在当前速度磨耗，立即触发以下降载动作之一：下调 `Speed Multiplier` 10–15%、切入单手诊断（若单手失误 ≥75%）或缩小为 1–2 小节微组块。

3. **冷启动期三阶段 CI 切换门控（Blocked → Serial → Random）**：

| 组块所处阶段 | 语境干扰级别 | 进入条件 | 练习模式与停留策略 | 毕业/晋升下一阶段的切换条件 |
| :--- | :--- | :--- | :--- | :--- |
| **Phase 0：冷启动建图（Short Blocked）** | 低 CI | 全新组块，或历史稳定度 $S = 0$ 且尚无慢速干净通 | 允许使用 Stage 0 `Waiting Mode`（低速 `0.50x–0.65x`），聚焦 `Finger Assignment`、音高与 `Hand Position` 映射；**硬上限 3–5 min** | 在解码速度（`0.50x–0.65x`）下达成 **1–2 遍零失误通**（不要求 3 遍、不要求 1.0x），或达到 5 min 上限自动转入 Phase 1 防止过劳 |
| **Phase 1：有序穿插（Serial Interleaving）** | 中 CI | 已建立基本动作图谱，但 `stableSpeed < 0.80x` 或尚未跨越首次睡眠巩固（$S < 1\text{ d}$） | 固定循环序（`A → B → C → A → B → C`）；切离 `Waiting Mode` 进入实时节拍演奏；每次停留 `1.5–2.5 min`（约 2–4 遍，达 2 遍干净即切走） | `Both Hands` 下达成 `stableSpeed ≥ 0.75x–0.85x` 且**连续跨 2 轮轮换**（非连续集中）首遍干净，或跨过 ≥1 次 24h 睡眠检验通过 |
| **Phase 2：随机穿插（Pseudorandom Interleaving）** | 高 CI | 巩固期/提速期/跨天到期复习组块（$S \ge 1\text{ d}$） | 伪随机队列（约束：不连续重复同一组块、相邻不排高相似变体）；每次停留 **`1–2 遍`**（重点考察**冷启第一遍**的真实检索重建能力） | 维持跨天 Motor-FSRS 复习与接缝联排，直至全曲整合 |

### 1.3 边界条件与 UX 反直觉对冲

- **对抗「胜任感错觉」（Abushanab & Bishara, 2013）**：用户从 A 组块切到 B 再切回 A 时，第一遍往往比刚才连弹 5 遍时略显生涩。调度器 UI 不应将这种生涩渲染为负面惩罚，而应通过极简反馈明确提示：「切回首遍的轻微重新提取，正是大脑重建长期动作通路的必要信号（Desirable Difficulty）」。
- **零基础/视奏阶段保护（Wulf & Shea, 2002; Brady, 2004）**：若用户在 Phase 0 连单小节音高映射都未完成（`pitchAccuracy < 85%`），提前切走不会产生「提取练习」，只会中断未成型的动作编码；此时必须保留短期 Blocked 建图通道。

---

## 二、清醒微休息（Micro-Offline Waking Rest）与心理意象（Motor Imagery / Audiation）闭环

### 2.1 一手实证证据矩阵

近五年的运动神经科学研究揭示了清醒微休息的惊人权重，同时也存在严谨的机制争论；将其与钢琴心理意象实证结合，可以精准避免产品设计踩坑：

| 一手文献 | 实验范式与关键参数 | 核心定量发现 | 工程设计启示与边界 |
| :--- | :--- | :--- | :--- |
| **Bönstrup et al. (2019)**, *Current Biology* | 人类序列按键技能；**10 s 练习 / 10 s 休息** × 36 试次 | 首日总学习增益的 **~95%** 快速发生在前 **11 个试次**内，且增益几乎全部发生在 **10 s 清醒微休息间隙（Micro-Offline）** 而非按键练习期间 | 早期习得期（前 10–15 分钟）最需要高密度短休，而非闷头连弹 |
| **Bönstrup et al. (2020)**, *npj Sci. Learn.* 5:7 | 大规模众包实验（$N=951$）；实验 3 将练习缩短至 **5 s** × 48 试次（$N=181$）并引入逆向干扰 | 缩短练习至 5 s 仍出现同等微离线增益，排除纯肌肉疲劳解释；逆向干扰实验证实动作记忆在**数秒级静息窗内**即开始稳定 | 证明短练+短休不是「仅仅歇手」，而是数秒级的记忆稳定过程 |
| **Buch, Claudino, Quentin, Bönstrup, & Cohen (2021)**, *Cell Reports* | MEG 脑磁图解码；**10 s 练习 / 10 s 休息** | 在 10 s 清醒静息窗内，大脑自发产生跨越海马与新皮层的**清醒神经重放（Waking Replay）**，时间压缩比高达 **~20 倍（20×）**，且重放频次与微离线技能增益强正相关 | 10 s 级静息足以让大脑完成数十次压缩回放，前提是不被打断 |
| **Gupta & Rickard (2022)**, *npj Sci. Learn.*; **(2024)**, *Sci. Rep.* | 系统操控练习时长（10 s vs 30 s）与休息时长（10 s vs 30 s），建立定量模型 | **重要学术争论**：主张休后增益很大程度上可由积极练习期累积、并在 10–30 s 休息期消散的**反应抑制（Reactive Inhibition, RI）**解释，质疑纯离线巩固假说 | **两派在调度参数上完全收敛**：无论机制是 20× 神经重放、RI 消散还是二者混合，**10–30 s 间歇短休**均严格优于连续死磕；同时提醒我们**绝不宣称 10 s 微休息可替代睡眠巩固** |
| **Wamsley (2019)**, *Trends Cogn. Sci.*; **(2022)**, *Nat. Rev. Psychol.* | 清醒静息记忆巩固综述 | 编码后数秒至数分钟的记忆痕迹极脆弱；**任何高负荷外部感知/认知任务都会引入逆向干扰**，阻断自发神经重放；闭眼/低刺激空载清醒态提供保护窗 | **关键 UX 约束**：微休息期间禁止弹出复杂报表、评分问卷或视频提示，屏幕必须进入极简低刺激静息态 |
| **Cash (2009)**, *JRME* 57(3):252–266 | 键盘序列学习（30 s 练习 / 30 s 休息块），比较**前期 5 min 休息** vs 后期 5 min 休息 vs 连续无休 | **前期插入 5 min 休息**不仅维持了当堂更高学习斜率，更在 12 小时夜间睡眠后的重测中取得**最大的跨夜离线增益** | 在 25–30 min 练琴会话中，应在前 **10–15 min 后**主动安排一次 **2–5 min** 的早期离键休息 |
| **Bernardi, De Buglio, Trimarchi, Chielli, & Bricolo (2013a)**, *Front. Hum. Neurosci.* | 专业钢琴家演奏斯卡拉蒂奏鸣曲高难选段；动作捕捉；**7 min** 纯心理练习（MP） vs 物理练习（PP） | 心理练习与物理练习同样诱发**运动预判（Motor Anticipation）**并优化动作时序；模态分工清晰：**听觉意象（Auditory Imagery）**主要驱动动作预判与节奏时序优化，**运动意象（Motor Imagery）**主要驱动击键速度变化 | 意象引导应**先听觉内省（Audiation）再手位/指法运动意象**，且针对性不同 |
| **Bernardi, Schories, Jabusch, Colombo, & Altenmüller (2013b)**, *Music Perception* | 16 名钢琴家生态化背谱实验 | 纯 MP 有效，但纯 PP 总体表现优于纯 MP；MP 成效高度依赖**音高内听（Pitch Imagery）与曲式结构分析** | 心理练习不能替代物理落键，但配合结构/和声锚点能显著降低过度练琴劳损 |
| **Coffman (1990)**, *JRME* 38(3):187–196 | 40 名音乐专业大学生钢琴演奏 | **物理与心理交替练习（Alternating PP+MP）**在缩短演奏耗时上与 **100% 纯物理练习无显著差异**，且二者均显著优于纯心理练习 | 用「交替无声意象」替代部分物理重复，可在不损失效率的前提下减少手指肌腱过劳 |
| **Highben & Palmer (2004)**, *Bull. Counc. Res. Music Educ.* (159):58–65 | 钢琴背谱中隔离听觉/运动反馈 | 个体基线内听能力显著调节心理练习效果：强内听者缺失外部声音时影响极小，**弱内听者难以凭空构建有效听觉意象** | 对不熟悉乐段或初级自学者，必须先提供 1 遍浏览器音频范奏作为听觉锚，不可硬逼无声空想 |
| **Driskell, Copper, & Moran (1994)**, *J. Appl. Psychol.* 79(4):481–492 | 心理练习元分析 | 总体效应量 $d=0.53$；认知/符号成分高任务 $d=0.69$ > 纯动作任务 $d=0.34$；**单次最优时长上限约 20 min**（过长出现边际递减与注意力疲劳）；新手需先具备基础任务认知图式才受益 | 控制意象引导简短高频（每次 10–20 s），单次会话累计意象时间远低于 20 min 天花板 |

### 2.2 关键神经机制辨析与「两段式切换间隙」设计

很多练琴产品容易犯一个科学错误：**把高负荷的「主动心理意象任务」直接塞进组块刚结束的 10 秒清醒微休息里**。然而根据 Buch et al. (2021) 与 Wamsley (2019, 2022)，刚弹完一个高难度组块后的前 10–15 秒需要**低外部认知占用**来保护自发神经重放与反应抑制消散；而 Bernardi et al. (2013a) 的听觉/运动意象则是**主动自上而下的前馈预判（Anticipatory Priming）**，最适合放在**即将开始下一个新组块之前**。

因此，推荐下游 `#18` 采用 **「两段式切换间隙（Two-Phase Transition Gap，总长 15–30 s）」**：

1. **阶段 A · 段末静息窗（Micro-Offline Quiet Rest：`10–15 s`）**：
   - **触发时机**：每个穿插组块访问结束瞬间（尤其在会话前 10–15 min 早期习得期，或在刚攻克一个高错音组块后）。
   - **行为与界面约束**：提示「双手离开琴键，放松肩腕，静待 10 秒让大脑自动回放」。界面**柔和降暗、不展示密密麻麻的错音分析表、不弹出交互问卷**（延迟汇总反馈移至完整轮次或会话结束，严格契合 `#11` 的低干扰原则与 Wamsley 2019 的防逆向干扰要求）。
   - **占比换算**：搭配 `60–180 s` 的单块练习槽，每块配 `10–15 s` 静息，静息占比约 **10–20%**（在极高难度的微组块冲刺期可短暂接近 Bönstrup/Cash 的 `30 s 练 / 15–30 s 休` 比例）。
2. **阶段 B · 段前意象预演窗（Optional Guided Audiation + Motor Imagery：`10–15 s`，按需开启）**：
   - **触发时机**：静息窗结束后、即将切入**下一个穿插组块**的 `Count-In` 之前（或作为整遍交替无声排练，Coffman 1990）。
   - **两步微提示（契合 Bernardi et al., 2013a）**：
     - Step 1（听觉内省 Audiation，5–8 s）：「看着下一组块首小节，心里以目标速度默听前两拍的旋律与重音」（若该组块为新学 `<2` 遍，可自动或单键触发 1 遍轻声浏览器预览，满足 Highben & Palmer 2004）。
     - Step 2（手位运动意象，5–7 s）：「双手轻放目标 `Hand Position` 键面不发声，在脑中过一遍首个 `Transition Cue`（如穿指/大跨度）的动作轨迹」。
   - **防急躁跳过 UX 建议（供 `#18` 参考）**：不强制锁死 MIDI 输入（防止引发愤怒），而是采用「**静息完成柔和呼吸进度环 + 若提前在 10 s 内猛按琴键仅温和提示『再静放 X 秒巩固效果更佳』**」，同时默认将延迟反馈摘要放在静息结束瞬间或会话末。
3. **前期宏观静息（Early Macro-Rest：`2–5 min`）**：
   - 依据 Cash (2009)，当单次练琴会话 ≥ 25 min 时，在完成首轮穿插（约第 **10–15 min**）后，建议插入 **2–5 min** 离琴走动/闭目休息，再进入下半场复习与提速，以最大化夜间睡眠巩固收益。

---

## 三、跨天间隔复习与多维掌握度模型（Motor-FSRS 钢琴适配）

### 3.1 为什么不能直接照搬语言类 Anki / FSRS？

直接把钢琴乐段当成 Anki 单词卡套用标准 FSRS 会遭遇四个根本性的领域失配：

1. **睡眠门控巩固 vs 连续时间间隔**：
   - 声明性词汇在同日间隔几分钟/几小时内就有明显间距效应，但 **Wiseheart, D'Souza, & Chae (2017)**（*PLoS ONE*, 12(8):e0182986）在钢琴 17 音旋律学习中测试了 **0、1、5、10、15 分钟**五种短间距，结果显示在音高准确率、击键力度一致性与时间一致性上**均无任何间距效应**。
   - 相反，**Walker et al. (2002 *Neuron*; 2003 *Learn. Mem.*; 2003 *Nature*)**、**Simmons & Duke (2006 *JRME*)** 以及 **Simmons (2012 *JRME*, 59(4):357–368)**（29 名音乐人，9 音钢琴序列，对比 **5 分钟 / 6 小时 / 24 小时**三组间隔）证明：**仅 24 小时（含完整夜间睡眠）间隔组产生了显著的跨会话准确率离线增益**，5 分钟与 6 小时清醒间隔均未产生此增益！因此，新习得或刚提速的钢琴组块在跨越**至少 1 次夜间睡眠（≥24h）验证前，绝不能拉长到 4–8 天**。
2. **再巩固脆弱窗（Reconsolidation Lability）**：
   - **Walker et al. (2003, *Nature*)** 证明，重新激活已巩固的运动记忆会使其重新进入短暂脆弱态，需再次巩固；**Allen (2013, *Psychol. Music*, 41(6):794–803)** 在钢琴旋律实验中发现，紧邻练习相似动作序列会引发逆向干扰、削弱跨夜增强。因此复习失误（Lapse）后，不应紧接着排练结构高度雷同的另一段。
3. **技能掌握是多维连续表面，而非二元「记得/忘了」**：
   - **Shmuelof, Krakauer, & Mazzoni (2012)**（*J. Neurophysiol.*, 108(2):578–594）指出，真正的运动技能习得体现为**速度-准确率权衡函数（Speed-Accuracy Tradeoff Function, SAF）的整体迁移**（相同速度下变异度更低、更平滑，或相同准确率下速度更高）。在 `0.60x` 下 100% 准确并连续保持 14 天，完全不代表 `1.00x` 下已掌握。
4. **组块接缝（Chunk Junction）是最脆弱的遗忘热点**：
   - **Sakai, Kitaguchi, & Hikosaka (2003)**（*Exp. Brain Res.*）表明，序列学习会自发形成组块，表现特征是**组块内击键间隔（IKI）短，而组块边界（接缝）出现显著时间停顿**；**Chaffin & Imreh (2002)**（*Psychol. Sci.*）同样发现，演奏停顿与重起高度聚集在曲式结构边界。如果只测准确率、忽略接缝犹豫度（正如当前 `practiceAnalytics.ts` 的缺陷），调度器会把「会弹但接不上」的乐段误判为已掌握。

### 3.2 FSRS-5 / FSRS-6 一手数学核心（核验基线）

依据 **Ye, Su, & Cao (2022, *ACM KDD*)** 的 DSR（Difficulty, Stability, Retrievability）三组件模型及 `open-spaced-repetition` 官方 **FSRS-5（19 权重） / FSRS-6（21 权重）** 规范：

1. **幂律遗忘曲线（Power-Law Forgetting Curve）**：
   $$R(t, S) = \left(1 + \text{factor} \cdot \frac{t}{S}\right)^{-w_{20}}, \quad \text{其中 } \text{factor} = 0.9^{-\frac{1}{w_{20}}} - 1$$
   - 稳定度 $S$ 定义为提取概率 $R$ 从 $100\%$ 衰减至 $90\%$ 所需的天数（$R(S, S) = 0.9$）。
   - 在 FSRS-4.5/5 中，$w_{20}$ 固定为 $0.5$，此时 $\text{factor} = 19/81 \approx 0.2346$；在 FSRS-6 中，$w_{20}$ 变为可训练衰减参数（全局默认 $w_{20} = 0.1542$）。
   - 给定目标保持率 $r_d$（如 $0.90$），反解下次复习间隔天数：
     $$I(r_d, S) = \frac{S}{\text{factor}} \left(r_d^{-\frac{1}{w_{20}}} - 1\right)$$

2. **初始稳定度（$S_0$）与跨天更新方程**：
   - 评级 $G \in \{1=\text{Again}, 2=\text{Hard}, 3=\text{Good}, 4=\text{Easy}\}$；标准 FSRS-6 全局默认 21 权重为：
     `w = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542]`
     （对应语言卡片默认初始稳定度：$S_0(\text{Again})=0.212\text{ d}$、$S_0(\text{Hard})=1.2931\text{ d}$、$S_0(\text{Good})=2.3065\text{ d}$、$S_0(\text{Easy})=8.2956\text{ d}$）。
   - **回忆成功后的稳定度更新（$G \in \{2, 3, 4\}$）**：
     $$S'_r(D, S, R, G) = S \cdot \left(1 + e^{w_8} \cdot (11 - D) \cdot S^{-w_9} \cdot \left(e^{w_{10}(1 - R)} - 1\right) \cdot h_b\right)$$
     其中 $h_b = w_{15}$（当 $G=\text{Hard}$ 惩罚）、$1$（当 $G=\text{Good}$）、$w_{16}$（当 $G=\text{Easy}$ 奖励）。
   - **遗忘失误后的稳定度更新（$G = 1$）**：
     $$S'_f(D, S, R) = \min\left(w_{11} \cdot D^{-w_{12}} \cdot \left((S + 1)^{w_{13}} - 1\right) \cdot e^{w_{14}(1 - R)},\; S \cdot e^{w_{17} \cdot w_{18}}\right)$$
   - **同日复习短程稳定度更新（FSRS-5 引入，FSRS-6 增加 $w_{19}$ 阻尼）**：
     $$S'(S, G) = S \cdot e^{w_{17} \cdot (G - 3 + w_{18})} \cdot S^{-w_{19}}$$

### 3.3 钢琴适配：多维掌握度向量与全自动 MIDI 评级映射（Motor-FSRS）

为满足 `#11` 中「双手尽量留在琴键上、少触控打断」的一等 UX 约束，**不应让用户每次弹完手动点选 Again/Hard/Good/Easy**，而应由 Web MIDI 遥测在每次到期组块的**冷启首遍（Cold First-Pass Probe）**自动判定 FSRS 评级：

#### 1. 组块与接缝的多维状态向量
每个调度单元（**核心组块 Chunk** 或 **跨组块接缝桥接 Junction Bridge**，可复用相邻 2 小节跨边界范围）持久化以下状态：

```ts
interface MotorChunkMemoryState {
  // 技能坐标（SAF 表面位置）
  handStage: "rh-only" | "lh-only" | "both";
  stableSpeed: number;          // 当前已验证稳定的相对 Speed Multiplier（如 0.75）
  targetSpeed: number;          // 曲目目标相对速度（默认 1.0）
  // 最近一次冷启首遍遥测
  lastAccuracy: number;         // 1 - faultSteps / totalSteps（含 wrong-note 与 early-release）
  lastInteriorHesitations: number;  // 组块内步间犹豫次数（沿用/校准 1.6x 阈值）
  lastJunctionHesitationRatio: number; // 跨组块边界 IKI / 预期 IKI（专门追踪接缝稳度）
  lastTimingCv: number | null;  // 实时节拍模式下的相对 IOI 变异系数（连续流畅度）
  // FSRS-6 适配状态（绑定于当前 stableSpeed 档位）
  difficulty: number;           // D ∈ [1, 10]
  stabilityDays: number;        // S（天），定义在当前 stableSpeed 下的 90% 保持期
  lastReviewedAtMs: number;
  sleepConsolidatedNights: number; // 在当前速度档位下通过跨夜冷检的次数
}
```

#### 2. 冷启首遍 MIDI 遥测 → 自动 FSRS 评级映射规则
> **为什么必须按「冷启首遍」而非「热身后的第 3 遍」评级？** 因为热身 2 遍后再测反映的是短期工作记忆提取（Retrieval Practice 后效），会严重高估真实跨天保持率 $R$，导致间隔膨胀过快。

| 自动评级 $G$ | 冷启首遍（实时节拍/连续演奏）客观判定条件 | 速度与调度动作 |
| :--- | :--- | :--- |
| **`1 (Again)` · 退化/失误** | 出现 **≥2 处**错音/时值失误；或发生中断停顿（单步卡滞 `> 2.5×` 预期时值或主动中止）；或被迫降速超过当前 `stableSpeed` 的 `10%` 才弹完 | 触发 $S'_f$ 遗忘折减；将本次练习工作速度回调 `-10% 至 -15%`（下限 `0.50x`）；当日穿插池重新入队；`sleepConsolidatedNights` 归零 |
| **`2 (Hard)` · 勉强/带犹豫** | 仅 **1 处**轻微错音/早松；**或 0 错音但存在明显犹豫**（组块内犹豫 `≥1` 次，或接缝 IKI 比值 `> 1.6×`）；或仅在比 `stableSpeed` 低 `5–10%` 时才零失误 | 走 $S'_r$ 但施加 Hard 惩罚（$w_{15}$）；**锁定当前 `stableSpeed` 不允许提速**；若是接缝 IKI 尖峰，自动向穿插池注入该边界的 2 小节 `Junction Bridge` |
| **`3 (Good)` · 稳定保持** | 在当前 `stableSpeed`（且 `Both Hands`）下 **0 错音、0 早松、0 犹豫**，接缝比值 `≤ 1.4–1.6×` | 正常 $S'_r$ 增长；`sleepConsolidatedNights += 1`；若 `stableSpeed < targetSpeed`，**解锁下一亚最大提速阶梯**（见第四节） |
| **`4 (Easy)` · 余裕流畅** | 满足 `Good` 全部条件，且实时节拍 IOI 变异度低（无拖拍抢拍），并在首遍或紧接试探遍中流畅通过 `+5–10%` 提速测试 | 施加 Easy 奖励（$w_{16}$）；允许提速并温和拉长间隔 |

#### 3. 初始复习间隔、提速升档折减与保持期边界
- **覆盖语言默认 $S_0$（睡眠门控 + 演奏会窗口约束）**：
  - 结合 **Simmons (2012)** 的 24 小时睡眠门槛与 **Cepeda et al. (2008)**（*Psychol. Sci.*：目标保持期 1 周时最优间距约占 20–40%，目标保持期 1 年时占 5–10%；对常见 2–8 周攻克一首独奏曲的目标，初期复习应紧密），推荐保守初始稳定度 $S_0$ 与目标保持率 $r_d \in [0.85, 0.90]$：
    - `Again` ($G=1$)：当日稍后穿插复检 + 次日 **`0.5–1.0 天`**；
    - `Hard` ($G=2$)：**`1.0 天`**（强制跨 1 夜验证）；
    - `Good` ($G=3$)：**`1.0–2.0 天`**（覆盖 FSRS-6 语言默认 `2.31 d`，前两夜不跨越过宽）；
    - `Easy` ($G=4$)：**仅当 `handStage === "both"` 且 `stableSpeed >= 0.90x` 时开放**，初始稳定度上限 **`3.0–4.0 天`**（禁用语言默认 `8.30 d`，防止运动程序尚未完成结构巩固就被雪藏一周）。
  - 典型单曲习得间隔演进轨（无失误路径）：**`Day 0（当堂穿插）→ Day 1（24h 首夜检验）→ Day 2–3 → Day 5–7 → Day 10–14 → Day 21–30`**（进入曲目维护期，单块最大间隔可按用户演出日期设上限如 `21–30 d`）。
- **提速/合手升档的「防稳定度错觉」折减规则**：
  - 当组块从 `0.70x` 升档至 `0.80x` 或从单手切至 `Both Hands` 时，其动作控制已进入 SAF 曲线上的新坐标点，旧速度下的高稳定度（如 $S = 10\text{ d}$）**不可直接继承**。
  - 工程规则：保留难度先验 $D$（反映该乐段固有的指法/读谱复杂度），但将新档位稳定度钳制折减为：
    $$S_{\text{after\_upgrade}} = \min\left(S_{\text{old}} \cdot \gamma,\; S_{\text{upgrade\_cap}}\right), \quad \gamma \in [0.4, 0.6],\; S_{\text{upgrade\_cap}} \in [1.0, 2.0]\text{ 天}$$
    同时设置 `sleepConsolidatedNights = 0`，强制新速度档位重新经过 1–2 次夜间睡眠巩固检验。
- **速度退化判定规则（Speed Downgrade Rule）**：
  - 若某组块在当前 `stableSpeed` 连续 **2 个复习日**均落入 `Again`，或在超期遗忘（$R < 0.60$）后冷启失误率 `> 25%`，自动将 `stableSpeed` 下调 1 档（`-10%`），避免在高于当前能力的速度下重复刻录错误。

#### 4. 平滑承接/演进现有 `practiceAnalytics.ts` 的「连续 3 遍零失误」
现有 `MASTERY_REQUIRED_CLEAN_PASSES = 3` 并非全错，问题在于它要求**同一时段连续（Blocked）3 遍**且不验犹豫度与跨天保持。平滑演进路径：
- **Stage 0 手动模式（`Waiting Mode` + 手动 `A-B Loop`）**：原样保留 `practiceAnalytics.ts` 3 遍提示，作为初学者局部落键校验器。
- **科学调度模式**：将「3 遍」拆解为三层循证里程碑：
  1. **出冷启动（Blocked → Interleaved）**：慢速 `1–2` 遍干净通即可切走（替代原地连刷 3 遍）；
  2. **当堂巩固（Session Mastery）**：跨 **`2–3` 个独立穿插轮次**累计拿到 3 遍零失误且零犹豫（`1 遍 × 3 轮穿插` 远胜 `连续 3 遍`）；
  3. **真实掌握（Long-Term Mastery）**：在目标 `Speed Multiplier`（`Both Hands`）下，跨越至少 **2 次跨天冷检（如 Day 1 与 Day 3–4）** 首遍零错音、零接缝犹豫。

---

## 四、亚最大速度阶梯与单手/双手迁移边界

### 4.1 一手实证证据矩阵

| 一手文献 | 实验设计 | 核心发现 | 对调度器的直接含义 |
| :--- | :--- | :--- | :--- |
| **Furuya, Nakamura, & Nagata (2013)**, *BMC Neuroscience* 14:133 | 12 名右利手无音乐基础青年（6 训练 + 6 对照）；连续 **4 天**在**亚最大速度（目标 IKI = `500 ms`，即 2 Hz / 120 BPM 四分音符）**练习钢琴手指序列；测前/测后及 **2 个月后保持**，测同手未练序列与对侧未练手 | ① 亚最大速度多日练习**渐进且显著提升了最大执行速度**（最短 IKI 缩短）；② 增速效果在**2 个月后仍稳健保持**；③ 存在**同手迁移（Intra-Manual Transfer）**至同手未练组合；④ **零跨手迁移（No Inter-Manual Transfer）**，右手练快不会自动带快左手 | ① 无需死磕原速即可推高速度天花板，大量巩固应落在亚最大速度区；② 弱手（常为左手）必须独立显式训练其专属序列，不能指望右手迁移 |
| **Furuya & Soechting (2012)**, *J. Neurophysiol.* 108(7):2060–2068; **Goebl & Palmer (2013)**, *PLoS ONE* | 专业钢琴家在不同速度（7–16 音/秒）下弹奏旋律的运动学捕捉 | 跨中高速区间，熟练钢琴家保持**速度不变的关节协同模式**（以掌指关节 MCP 为主导、指间关节相对稳定），高效率运动学直接决定高速时序精度与极限速度 | 提速过程应保持动作结构平滑不变形，避免大幅跳速导致关节代偿 |
| **Dalla Bella & Palmer (2011)**, *PLoS ONE* 6(6):e20518 | 专业钢琴家多速度背谱演奏与手指运动捕捉 | 速度提升时，手指在击键前约 1 个音的**抬指峰值高度增加**以强化触觉反馈、补偿速度-准确率权衡；极慢速与高速的触键预备运动学特征存在差异 | **速度下限警示**：长期停留在 `<0.50x` 极慢速会让大脑停留在逐音闭环点击模式，无法建立提前 1 音的预备抬指与组块前馈控制 |
| **Furuya, Aoki, Nakahara, & Kinoshita (2012)**, *Hum. Mov. Sci.* 31(1):26–39 | 速度 × 力度交互下的上肢肩/肘/腕/指关节运动学与肌电共激活 | 速度与力度对上肢多关节与肌肉共激活存在显著非线性交互；过快突破控制阈值易诱发前臂拮抗肌过度共激活（僵硬与劳损风险） | 越接近 `0.85x–1.0x` 高速上限，单次提速步长必须越精细，防止诱发肌群共激活僵硬 |
| **Brown (1933)**, *J. Exp. Psychol.*; **Rubin-Rabson (1939)**, *J. Educ. Psychol.* | 钢琴曲目「先分后合（Hands Separate）」与「直接合手（Hands Together）」对照实验 | **直接/尽早合手**在总学习时长与试次效率上显著优于长时间单手孤立练习；过度单手练习会使左右手分别固化为孤立的记忆程序，**反而对后续合手造成干扰（负迁移）** | 驳斥「必须先单手练到 1.0x 滚瓜烂熟再合手」的传统教条；单手练习只能作为短时精准排障工具 |
| **Swinnen (2002)**, *Nat. Rev. Neurosci.* 3(5):348–359 | 双手协调神经机制经典综述 | 双手运动受跨半球神经耦合（SMA、前运动皮层、胼胝体）强约束，天生存在同相（$\Phi=0^\circ$）与反相（$\Phi=180^\circ$）对称吸引子；非对称独立声部会产生强烈**时空干涉** | 双手合奏本质上是**独立的神经网络协调程序**，并非「右手程序 + 左手程序」的简单叠加；合手切换时必须降载（降速）以容纳跨半球去耦合认知负荷 |

### 4.2 亚最大提速阶梯设计（显式区分「实证证据」与「工程参数化」）

> **科学严谨性声明**：现有同行评审运动神经科学论文证实了**亚最大速度训练可有效提升最大速度且保持数月**（Furuya et al., 2013）、**高水平演奏者通过降速排错后阶梯回升提速**（Duke et al., 2009）、以及**高速区关节运动学与共激活非线性敏感**（Furuya et al., 2012; Dalla Bella & Palmer, 2011），但**学术界并不存在唯一被实验锁死的全局固定提速百分比常数**。以下「分区相对比例步长」是基于上述生物力学与感知规律，结合钢琴应用教学共识（5–10% 相对步长）所做的**工程参数化推荐**，旨在替代 `practiceAnalytics.ts:848` 失真的固定线性 `+0.15x`。

| 速度区间（相对 `Speed Multiplier`） | 神经生物力学定位 | 推荐相对提速步长 | 典型阶梯示例（目标 `1.00x`） | 验证与退出原则 |
| :--- | :--- | :--- | :--- | :--- |
| **解码区：`0.45x – 0.60x`** | Stage 0 音高/指法/手位图谱编码（可用 `Waiting Mode`） | **`+12% – 15%`（相对）**（约 `+0.07x–0.09x`） | `0.50x → 0.58x → 0.65x` | **禁止久留**：仅需 1–2 遍零失误解码即迅速脱离，防止固化逐音闭环点击习惯（Dalla Bella & Palmer, 2011） |
| **亚最大巩固主力区：`0.65x – 0.85x`** | 实时节拍前馈组块建立、同手神经肌肉优化主力区（Furuya et al., 2013） | **`+8% – 10%`（相对）**（约 `+0.05x–0.08x`） | `0.65x → 0.72x → 0.78x → 0.85x` | **多日核心训练区**：跨穿插轮次零错音且零接缝犹豫即升档；鼓励结合 24h 睡眠离线巩固自然抬升次日舒适速度 |
| **性能/原速冲刺区：`0.85x – 1.00x`** | 高速触键预备与抗共激活僵硬精细调校区（Furuya et al., 2012; Goebl & Palmer, 2013） | **`+5%`（相对）**（约 `+0.04x–0.05x`，或 2–4 BPM） | `0.85x → 0.90x → 0.95x → 1.00x` | 严格零错音 + 零接缝犹豫 + 稳定 IOI 均匀度方可升档；每次升档触发 Motor-FSRS 稳定度折减 |
| **可选超速裕度探针：`1.05x`** | 仅面向已稳定达标（`≥2` 次跨夜 `1.00x` `Good`）的短技术组块 | 单次上限 **`+5%`**（不高于 `1.05x`） | `1.00x → 1.05x → 1.00x` | 仅作 1–2 遍短试探以扩大 SAF 安全裕度，严禁在出现紧张或错音时强练 |

**对比现有 `practiceAnalytics.ts` 的错误回退优化**：
- 轻微冷启手生或单次犹豫（`Hard`）：保持当前速度或小幅回撤 **`-5% 至 -10%`**；
- 连续 2 遍以上同位复发错音或结构崩盘（`Again`）：按当前策略下调 **`-15% 至 -25%`**（下限 `0.50x`），回到干净可控制区重建（Duke et al., 2009）。

### 4.3 单手（`rh-only` / `lh-only`）与双手（`both`）科学验证节奏

结合 **Furuya et al. (2013)**（零跨手迁移）、**Brown (1933) / Rubin-Rabson (1939)**（过度单手固化阻碍合手）与 **Swinnen (2002)**（双手耦合干涉），推荐取代 `practiceAnalytics.ts:651` 的简单触发规则：

1. **默认早合手原则**：对于织体常规（如柱式和弦伴奏 + 旋律）的新组块，默认从 `0.50x–0.60x` 直接以 **`Both Hands`** 启动，避免无谓的单手重复成本。
2. **单手精准介入触发条件**（满足任一即可自动建议 `rh-only` / `lh-only`）：
   - 现有遥测判据增强：单手失误占比 `≥ 75%` 且在当前组块复发 `≥ 2` 遍（尤其针对常见弱手 LH，因 RH 练习对其零迁移，Furuya et al., 2013）；
   - 乐谱结构先验：高复杂度复调/多声部独立声线、异节奏（如 3 对 2）引发 Swinnen 式双手相位吸引干涉；
   - 求解器先验：单手密集出现高风险 `Transition Cue`（大跨度伸展、快速穿指/跨指）。
3. **单手防固化上限（Anti-Entrenchment Cap）**：
   - 单手模式仅用于解决音高映射与独立指法运动学，**速度上限建议封顶在 `0.70x–0.80x`，毕业门槛为 `1–2 遍` 干净通（或单块累计 `≤ 2–3 min`）**——严禁将单手一路练到 `1.00x` 连续 3 遍才开始合手。
4. **合手切换时的自动降载补偿（弥补 `practiceAnalytics.ts` 缺口）**：
   - 当组块由 `rh-only`/`lh-only` 晋升回 `Both Hands` 时，调度器应**自动将工作 `Speed Multiplier` 下调 `10%–15%`**（例如单手 `0.75x` 达标 → 合手从 `0.65x` 起步），为跨半球双手去耦合留出工作记忆与运动控制余量（Swinnen, 2002; Guadagnoli & Lee, 2004）。

---

## 五、给下游决策票 `#18` 的架构建议与待拍板清单

直接对照 `#18` 的三大决策议题，基于本次一手调研收敛出推荐默认策略与需在 `#18` 拍板的权衡项：

### 议题 1：会话排课（15/30 min）与穿插轮换队列
- **推荐默认分配配额**（基于 15–30 min 典型自学者会话）：
  - **到期复习组块（Due Motor-FSRS）**：占 **40–50%** 预算（冷启首遍评估真实保持率，优先安排在会话前半段清醒期）；
  - **脆弱接缝桥接（Junction Bridges）**：占 **15–20%** 预算（针对接缝 IKI 比值 `>1.6×` 的 2 小节跨界片段穿插加固）；
  - **新学冷启动 / 提速攻坚组块**：占 **30–40%** 预算（受限于活跃池总计 **3–4 块**；单次 15 min 会话最多引入 **1–2 个**新冷启动组块，避免认知过载与睡眠逆向干扰）。
- **需 `#18` 拍板**：
  - 当用户某天积压了 10+ 个到期组块时，采用「按 $R$ 最低且接缝最弱优先截断至 4–5 块」还是「先做极速 1 遍冷检巡航再挑最差 3 块精练」？
  - Phase 0 冷启动 `Blocked → Serial` 毕业门槛定为「`0.55x` 连续 1 遍」还是「连续 2 遍」（兼顾效率与新手挫败感）？

### 议题 2：清醒微休息与意象预演闭环 UX
- **推荐默认方案**：采用本文 2.2 节的「**两段式切换间隙**」——段末 **`10 s` 强制低刺激静息**（默认自动倒数，不强锁琴键但温和防跳过）+ 段前可选 **`10–15 s` 听觉内省/手位预演提示**（新块自动附 1 遍音频范奏）；30 min 会话第 12–15 min 提示 2–3 min 早置离琴休息。
- **需 `#18` 拍板**：
  - 温和防跳过机制的具体交互（例如：静息未满 10 s 提前击键时，是否静音/忽略评分并显示柔和呼吸提示，还是允许用户按某固定低音区琴键/踏板主动跳过，贯彻「手不离键」原则）？
  - 延迟汇总反馈的展示时机：每轮完整循环结束（约 6–8 min）给一张极简卡片，还是严格等到整场会话结束？

### 议题 3：多维掌握度与 Motor-FSRS 持久化契约
- **推荐默认方案**：采用 **FSRS-6 数学核** + **睡眠门控保守初始稳定度**（`1d / 1–2d / 3–4d`）+ **冷启首遍 Web MIDI 自动评级** + **提速/合手升档 $S$ 折减（$\min(0.5S, 2\text{d})$）**；同时保留 Stage 0 `practiceAnalytics.ts` 连续 3 遍逻辑仅服务手动 `Waiting Mode` 自由排练。
- **需 `#18` 拍板**：
  - 实时连续演奏评估中（脱离暂停式 `Waiting Mode` 后），因 `#11` 明确排除了 HMM/OLTW 自由变速 Rubato 追谱，如何基于固定节拍器时间网格（`Measure Timeline` + 节拍窗容差）计算 `accuracy`、`interiorHesitation` 与 `junctionHesitationRatio`？（可与声学画像调研票对齐容差窗口。）
  - 是否将 `Motor-FSRS` 的稳定度 $S$ **按单个当前 `stableSpeed` 维护（升档折减）**，还是按离散速度档（如 `0.6x / 0.8x / 1.0x`）分开记录？（前者状态空间极简、适合本地 IndexedDB，推荐作为 MVP。）

### 建议同步至 `/domain-modeling`（`GLOSSARY.md` 缺口提示）
本次调研引入了若干现有 `GLOSSARY.md` 尚未收录的核心领域概念，建议在 `#18` 及组块决策定案后统一纳入：
- **Practice Chunk（练习组块）** 与 **Chunk Junction / Bridge（组块接缝桥接）**
- **Interleaved Session Queue（穿插练琴队列）**
- **Micro-Offline Rest（清醒微休息）** 与 **Audiation Cue（听觉意象预演提示）**
- **Cold Retrieval Probe（冷启首遍检验）** 与 **Speed-Conditioned Stability（速度条件稳定度）**

---

## 参考文献（一手文献）

1. Abushanab, B., & Bishara, A. J. (2013). Memory and metacognition for piano melodies: Illusory advantages of fixed- over random-order practice. *Memory & Cognition*, 41(6), 928–937.
2. Allen, S. E. (2013). Memory stabilization and enhancement following music practice. *Psychology of Music*, 41(6), 794–803.
3. Bernardi, N. F., De Buglio, M., Trimarchi, P. D., Chielli, A., & Bricolo, E. (2013). Mental practice promotes motor anticipation: Evidence from skilled music performance. *Frontiers in Human Neuroscience*, 7, 451. https://doi.org/10.3389/fnhum.2013.00451
4. Bernardi, N. F., Schories, A., Jabusch, H.-C., Colombo, B., & Altenmüller, E. (2013). Mental practice in music memorization: An ecological-empirical study. *Music Perception*, 30(3), 275–290.
5. Bönstrup, M., Iturrate, I., Thompson, R., Cruciani, G., Censor, N., & Cohen, L. G. (2019). A rapid form of offline consolidation in skill learning. *Current Biology*, 29(8), 1346–1351.e4. https://doi.org/10.1016/j.cub.2019.02.049
6. Bönstrup, M., Iturrate, I., Hebart, M. N., Censor, N., & Cohen, L. G. (2020). Mechanisms of offline motor learning at a microscale of seconds in large-scale crowdsourced data. *npj Science of Learning*, 5, 7. https://doi.org/10.1038/s41539-020-0066-9
7. Brady, F. (2004). Contextual interference: A meta-analytic study. *Perceptual and Motor Skills*, 99(1), 116–126. (And applied review: Brady, F. (2008). The contextual interference effect and sport skills. *Perceptual and Motor Skills*, 106(2), 461–472.)
8. Brown, R. W. (1933). The relation between two methods of learning piano music. *Journal of Experimental Psychology*, 16(3), 435–441.
9. Buch, E. R., Claudino, L., Quentin, R., Bönstrup, M., & Cohen, L. G. (2021). Consolidation of human skill linked to waking hippocampo-neocortical replay. *Cell Reports*, 35(10), 109193. https://doi.org/10.1016/j.celrep.2021.109193
10. Carter, C. E., & Grahn, J. A. (2016). Optimizing music learning: Exploring how blocked and interleaved practice schedules affect advanced performance. *Frontiers in Psychology*, 7, 1251. https://doi.org/10.3389/fpsyg.2016.01251
11. Cash, C. D. (2009). Effects of early and late rest intervals on performance and overnight consolidation of a keyboard sequence. *Journal of Research in Music Education*, 57(3), 252–266.
12. Cepeda, N. J., Vul, E., Rohrer, D., Wixted, J. T., & Pashler, H. (2008). Spacing effects in learning: A temporal ridgeline of optimal retention. *Psychological Science*, 19(11), 1095–1102.
13. Chaffin, R., & Imreh, G. (2002). Practicing perfection: Piano performance as expert memory. *Psychological Science*, 13(4), 342–349.
14. Coffman, D. D. (1990). Effects of mental practice, physical practice, and knowledge of results on piano performance. *Journal of Research in Music Education*, 38(3), 187–196.
15. Dalla Bella, S., & Palmer, C. (2011). Rate effects on timing, key velocity, and finger kinematics in piano performance. *PLoS ONE*, 6(6), e20518. https://doi.org/10.1371/journal.pone.0020518
16. Driskell, J. E., Copper, C., & Moran, A. (1994). Does mental practice enhance performance? *Journal of Applied Psychology*, 79(4), 481–492.
17. Duke, R. A., Simmons, A. L., & Cash, C. D. (2009). It's not how much; it's how: Characteristics of practice behavior and retention of performance skills. *Journal of Research in Music Education*, 56(4), 310–321.
18. Furuya, S., Aoki, T., Nakahara, H., & Kinoshita, H. (2012). Individual differences in the biomechanical effect of loudness and tempo on upper-limb movements during repetitive piano keystrokes. *Human Movement Science*, 31(1), 26–39.
19. Furuya, S., Nakamura, A., & Nagata, N. (2013). Transfer of piano practice in fast performance of skilled finger movements. *BMC Neuroscience*, 14, 133.
20. Furuya, S., & Soechting, J. F. (2012). Speed invariance of independent control of finger movements in pianists. *Journal of Neurophysiology*, 108(7), 2060–2068.
21. Goebl, W., & Palmer, C. (2013). Temporal control and hand movement efficiency in skilled music performance. *PLoS ONE*, 8(1), e50901. https://doi.org/10.1371/journal.pone.0050901
22. Guadagnoli, M. A., & Lee, T. D. (2004). Challenge point: A framework for conceptualizing the effects of various practice conditions in motor learning. *Journal of Motor Behavior*, 36(2), 212–224.
23. Gupta, M. W., & Rickard, T. C. (2022). Dissipation of reactive inhibition is sufficient to explain post-rest improvements in motor sequence learning. *npj Science of Learning*, 7, 25. https://doi.org/10.1038/s41539-022-00140-z (And Gupta, M. W., & Rickard, T. C. (2024). Comparison of online, offline, and hybrid hypotheses of motor sequence learning using a quantitative model that incorporate reactive inhibition. *Scientific Reports*, 14.)
24. Highben, Z., & Palmer, C. (2004). Effects of auditory and motor mental practice in memorized piano performance. *Bulletin of the Council for Research in Music Education*, (159), 58–65.
25. Open Spaced Repetition. (2024–2025). *FSRS-5 & FSRS-6 Algorithm Specification (The Algorithm / DSR Model)*. GitHub `open-spaced-repetition/fsrs4anki`.
26. Porter, J. M., & Magill, R. A. (2010). Systematically increasing contextual interference is beneficial for learning sport skills. *Journal of Sports Sciences*, 28(12), 1277–1285. https://doi.org/10.1080/02640414.2010.502946
27. Rubin-Rabson, G. (1939). Studies in the psychology of memorizing piano music: I. A comparison of the unilateral and coordinated approaches. *Journal of Educational Psychology*, 30(5), 321–345.
28. Sakai, K., Kitaguchi, K., & Hikosaka, O. (2003). Chunking during human visuomotor sequence learning. *Experimental Brain Research*, 152(2), 229–242.
29. Shea, C. H., Kohl, R., & Indermill, C. (1990). Contextual interference: Contributions of practice. *Acta Psychologica*, 73(2), 145–157.
30. Shmuelof, L., Krakauer, J. W., & Mazzoni, P. (2012). How is a motor skill learned? Change and invariance at the levels of task success and trajectory control. *Journal of Neurophysiology*, 108(2), 578–594.
31. Simmons, A. L. (2012). Distributed practice and procedural memory consolidation in musicians' skill learning. *Journal of Research in Music Education*, 59(4), 357–368.
32. Simmons, A. L., & Duke, R. A. (2006). Effects of sleep on performance of a keyboard melody. *Journal of Research in Music Education*, 54(3), 257–269.
33. Stambaugh, L. A. (2011). When repetition isn't the best practice strategy: Effects of blocked and random practice schedules. *Journal of Research in Music Education*, 58(4), 368–383. https://doi.org/10.1177/0022429410385945
34. Stambaugh, L. A. (2013). Differential effects of cognitive load on university wind students' practice. *Psychology of Music*, 41(6), 749–763.
35. Stambaugh, L. A., & Demorest, S. M. (2010). Effects of practice schedule on wind instrument performance: A preliminary application of a motor learning principle. *Update: Applications of Research in Music Education*, 28(2), 20–28.
36. Swinnen, S. P. (2002). Intermanual coordination: From behavioural principles to neural-network interactions. *Nature Reviews Neuroscience*, 3(5), 348–359.
37. Walker, M. P., Brakefield, T., Morgan, A., Hobson, J. A., & Stickgold, R. (2002). Practice with sleep makes perfect: Sleep-dependent motor skill learning. *Neuron*, 35(1), 205–211.
38. Walker, M. P., Brakefield, T., Hobson, J. A., & Stickgold, R. (2003). Dissociable stages of human memory consolidation and reconsolidation. *Nature*, 425(6958), 616–620.
39. Wamsley, E. J. (2019). Memory consolidation during waking rest. *Trends in Cognitive Sciences*, 23(3), 171–173. (And Wamsley, E. J. (2022). Offline memory consolidation during waking rest. *Nature Reviews Psychology*, 1, 441–453.)
40. Wiseheart, M., D'Souza, A. A., & Chae, J. (2017). Lack of spacing effects during piano learning. *PLoS ONE*, 12(8), e0182986.
41. Wulf, G., & Shea, C. H. (2002). Principles derived from the study of simple skills do not generalize to complex skill learning. *Psychonomic Bulletin & Review*, 9(2), 185–211.
42. Ye, J., Su, J., & Cao, Y. (2022). A stochastic shortest path algorithm for optimizing spaced repetition scheduling. *Proceedings of the 28th ACM SIGKDD Conference on Knowledge Discovery and Data Mining (KDD '22)*, 4381–4390. https://doi.org/10.1145/3534678.3539081
