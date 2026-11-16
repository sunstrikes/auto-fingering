# Test Corpus 样本清单

用于「纯浏览器端 MusicXML 自动指法推导工具」的算法校验、XML 无损读写回归测试及 `piano.cishoon.top` 导入/导出兼容验收。

| 编号 | 文件名 | 格式 | 核心来源 | 覆盖的边界特征 |
| :--- | :--- | :--- | :--- | :--- |
| 01 | `01-single-staff-melody.musicxml` | `.musicxml` | 合成最小样本 | 单 Part 单高音谱表、无 `<fingering>`、级进穿指、升降记号黑键（`Bb4` / `F#4`）、八度大跳、休止符乐句分段 |
| 02 | `02-grand-staff-arpeggio-chord.musicxml` | `.musicxml` | 合成最小样本 | 标准双谱表（`<staves>2</staves>`）、无 `<fingering>`、柱式和弦（`<chord/>`）、阿尔贝蒂低音分解和弦、同手双声部（`voice 1` + `voice 3`）、宽跨度低音 |
| 03 | `03-partial-fingering-hanon.musicxml` | `.musicxml` | 合成最小样本 | 标准双谱表、局部预置 `<notations><technical><fingering placement="above\|below">`（`Finger Anchor` 保留与补全）、和弦顶音锚点与 `<notations>` 后接 `<lyric>` 的 XSD 顺序校验 |
| 04 | `04-tie-cross-staff-compressed.mxl` | `.mxl` | 合成最小样本 | 标准 `.mxl` 容器（首文件 `STORE` 存储 `mimetype` + `META-INF/container.xml`）、倚音（`<grace slash="yes"/>`）、跨小节连音链（`<tie type="stop"/>` + `<tie type="start"/>`）、无视觉 `<tied>` 的纯语义 `<tie type="stop"/>`、跨谱表音符（`voice 2` 写于 `<staff>1</staff>`） |
| 05 | `05-realworld-wuchang.musicxml` | `.musicxml` | 真实用户曲谱 (`wuchang.musicxml`) | MusicXML 4.0（`score model + Transkun` 制谱）、73 小节 / 1321 `<note>`（31 休止符、425 `<chord/>`）、无 `<fingering>`、6 个降号调性（`<fifths>-6</fifths>`）、双手八度与 1–4 音和弦（最大横向/纵向跨度达 15–16 半音）、同手多声部（`voice 1/2` 在 `staff 1`、`voice 5/6` 在 `staff 2`）、66 组 `tie`、2 个倚音、110 个 `<direction>`、83 个 `<backup>` |
