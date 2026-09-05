# Playweft Extras

创意玩法与持续迭代的小游戏合集，接入 [Playweft](https://github.com/longern/playweft) 平台。
目录与 [playweft-games](https://github.com/longern/playweft-games) 保持一致：游戏放在 `games/`，通信代码放在 `src/`，公共图标和推荐列表放在 `public/`，使用一个 Vite 构建输出独立、带版本的游戏包。

| 游戏 | 玩家 | 开发地址 | 构建产物 |
| --- | --- | --- | --- |
| 光尾蛇 · Light Trails | 2 人，可旁观 | `http://localhost:9140/light-trails/` | `dist/light-trails/index.html` |

## 开发

Node.js 22.12+：

```sh
npm ci
npm run dev
```

访问 `http://localhost:9140/` 浏览游戏列表；在 Playweft 中填写 `http://localhost:9140/light-trails/` 或其 `playweft.json` 地址，再通过平台大厅邀请好友开始。端口 9140 避免与 `playweft-games` 的 9139 冲突。

不启动平台也可以联调光尾蛇：

```sh
npm run dev:light-trails
```

分别在两个可见窗口打开 `http://localhost:9139/__dev/?seat=1` 和 `?seat=2`；`?seat=0` 用于旁观。也可用 `PORT=9141 npm run dev:light-trails` 指定其他端口。该工具执行同一份 Lua 游戏脚本，只用于开发，不包含平台认证和房间安全边界，不进入生产构建。

## 校验与构建

```sh
npm run check
npm run build
```

`dist/` 是一个静态站点，包含首页、`featured-games.json`、公共资源，以及每个游戏的 `index.html`、`help.html`、`playweft.json` 和 `game.lua`。客户端资源由 Vite 打包，所有游戏复用同一个构建流程。

部署 `dist/` 到独立 HTTPS 静态站点即可。`public/_headers` 给推荐列表和 Manifest 配置 CORS；Lua 由平台服务端获取。不要添加阻止平台 iframe 嵌入的 `X-Frame-Options`。本仓库不保存部署账号或凭据。

Cloudflare Workers Builds 使用仓库根目录，部署命令为 `npx wrangler deploy`。仓库内的 `wrangler.jsonc` 明确指定静态资源目录 `dist/`，并在部署前执行 `npm run build`，因此平台的构建命令可以留空。无需 Cloudflare Vite 插件，也无需自动改写 `vite.config.js`。

## 目录

```text
games/light-trails/       游戏页面、渲染、Lua 规则、Manifest、帮助
src/playweft-client.js    共享 MessageChannel / JSON-RPC 客户端
public/                  图标、featured-games.json、静态响应头
build/vite/plugins/      游戏包输出、稳定 URL 映射
scripts/                 仅供开发的联调工具和 Lua 测试适配
tests/                   规则、通信、网络联调和打包验证
vite.config.js           统一多页面构建
```

新增游戏时创建 `games/<name>/`，在 `vite.config.js` 的 `games` 列表加入名字，再更新推荐列表和首页。每个游戏独立维护自己的 Manifest 版本；调整规则和参数后更新版本并创建新房间，避免修改正在运行的对局。

光尾蛇的规则、同步方式和已知限制见 [游戏说明](games/light-trails/README.md)。
