# EdgeOne Pages 部署记录

## 当前部署

- 访问地址（临时，未认领前需带 `eo_token` 查询参数，完整链接见本次部署会话输出）：
  `https://musicxml-fingering-64kxzh6x-uccnnmuq.edgeone.cool/?eo_token=***&eo_time=***`
- Project ID：`makers-rototwd7gtlk`
- Deployment ID：`dpgk41enldi2`
- 部署方式：EdgeOne CLI `1.7.2` 匿名部署（`--anonymous`）
- 部署产物：`npm run build` 生成的 `dist/`（静态资源，无服务端函数）
- 有效期：未认领的匿名项目会在 **2026-11-16 21:40（Asia/Shanghai）** 自动删除

> 该地址带有临时访问令牌；未认领前直接访问根路径会返回 401。

## 为什么用匿名部署

EdgeOne CLI 浏览器登录已成功，但当前腾讯云账号 **未开通 EdgeOne Makers**，CLI 返回：

```text
Makers is not enabled for this account.
```

因此先用官方支持的匿名部署拿到可访问地址。认领后项目会转入自己的账号，成为正式项目。

## 认领步骤（1 小时内完成）

1. 打开 [EdgeOne Makers 控制台](https://console.cloud.tencent.com/edgeone/makers)，按提示开通 Makers 服务。
2. 登录 CLI：`npx edgeone@latest login`。
3. 认领本次部署（Sid 见部署输出或本次会话记录）：

   ```bash
   npx edgeone@latest makers claim --sid <Sid>
   ```

   或直接打开控制台认领页（认领 token 见部署输出，不要提交到仓库）：

   `https://console.cloud.tencent.com/edgeone/makers/claim?token=<Sid>`

认领后即可绑定自定义域名、查看构建日志，并持续用同一项目发布。

## 重新部署（匿名预览）

注意：项目名由 CLI 根据**当前目录名**生成。本仓库目录含中文（`musicxml-指法`），CLI 会生成
`musicxml----xxxx` 这种含连续连字符的非法项目名，服务端会拒绝：

```text
Project name cannot contain consecutive hyphens (--)
```

绕过方式是先复制到一个纯 ASCII 目录再部署：

```bash
npm run build
rm -rf /tmp/musicxml-fingering
mkdir -p /tmp/musicxml-fingering
cp -R dist /tmp/musicxml-fingering/site
cd /tmp/musicxml-fingering
npx edgeone@latest makers deploy ./site --anonymous --site china
```

部署成功后 CLI 会输出：

- `Access URL`：带 `eo_token` 的访问地址
- `Project ID` / `Deploy ID`
- `Claim (CLI)` / `Claim (Web)`：认领命令与链接
- `expiresAt`：认领截止时间

## 正式项目部署（开通 Makers 后）

```bash
npm run build
npx edgeone@latest makers deploy ./dist -n musicxml-fingering --site china
```

也可以把仓库接入 EdgeOne 的 Git 构建：构建命令 `npm run build`，输出目录 `dist`。

## GitHub Actions 自动部署

仓库内置 `.github/workflows/deploy-edgeone.yml`：推送 `v*` tag 或手动
`workflow_dispatch` 时，自动构建 `dist/` 并用 API Token 发布。

1. 在 [EdgeOne Pages 控制台](https://console.cloud.tencent.com/edgeone/pages?tab=settings)创建 API Token。
2. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加 `EDGEONE_PAGES_API_TOKEN`。
3. 可选：添加 Repository variable `EDGEONE_PROJECT_NAME`（默认 `musicxml-fingering`）。
4. 打 tag 触发：

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

`.github/workflows/ci.yml` 则在每次 push / PR 时运行 Node 20 与 22 的类型检查、测试（含覆盖率）和构建。

## 备选：MCP `deploy-html`

<https://cloud.tencent.com/developer/mcp/server/10011> 中的 `deploy-html` 只接收单个 HTML
字符串（EdgeOne Pages KV 托管，返回 `https://mcp.edgeone.site/share/<id>`）。本项目是多文件
SPA 且带 Web Worker，未采用该方式；如需使用，需要先把 JS/CSS/Worker 全部内联成单文件 HTML。
