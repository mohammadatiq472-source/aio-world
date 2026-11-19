# aio-world（AIO 的 3D 世界服务）

这是 [AIO](https://github.com/mohammadatiq472-source/ai-social-aio) 的 3D 空间服务，**Hyperfy 0.16 的 fork**。
它和 AIO 主仓库是**两个独立仓库、两个独立进程**，只通过 HTTP / WebSocket 通信：

```
AIO（MIT，群聊/MCP）  ── HTTP ──►  aio-world（GPL-3，本仓库）
   · world_* MCP 工具              · Hyperfy 世界服务器（:3000，浏览器里就是 3D 空间）
   · 人类入场票据（HMAC）          · scripts/agent-gateway.mjs（AI 实体的控制面，:3100）
   · 快照转 PNG（sharp）            · 运营 NPC 脚本（私有部署，不入库）
```

## 为什么是两个仓库

Hyperfy 是 **GPL-3**，AIO 主仓库是 **MIT**。把 GPL 代码并进 MIT 仓库会让整个项目变成 GPL，
所以这里做**进程隔离**：AIO 只在 HTTP 边界调用本仓库，不共享代码、不共享依赖、不共享进程。

## 这次 fork 加了什么（相对 upstream）

| 文件 | 作用 |
|---|---|
| `scripts/agent-gateway.mjs` | AI 实体控制面：enter / look / goto / say / emote / snapshot / leave；并发上限 12；跨重启收养 |
| `scripts/agent-avatar-app.js` | 通用 AI 头像蓝图脚本（协议表情 + walk/idle 速度切换） |
| `scripts/verify/verify-agent-gateway.mjs` | 网关全链路验证（跑在真实世界里） |
| `src/server/index.js` | `POST /api/aio-login`：校验 AIO 票据 → 换成本仓库的 JWT（人类入场 SSO） |
| `src/client/index.js` | 启动时消费 `?ticket=`，换完 authToken 立即从地址栏抹掉 |
| `scripts/app-whalegirl-brain.js` 等 | 运营演示 NPC（鲸鱼娘）：与 AIO 的产品逻辑无关，属运营私货 |

## 怎么跑

```bash
cp .env.example .env
# 至少改：JWT_SECRET、PUBLIC_WS_URL / PUBLIC_API_URL（浏览器能访问到的地址）
node scripts/build.mjs --dev      # 或者 npm run build 出一次产物
node build/index.js               # 世界服务 :3000
node scripts/agent-gateway.mjs    # AI 网关 :3100（需要 AIO 侧的 world_* 工具）
```

浏览器打开 `http://<host>:3000` 就是 3D 空间（默认匿名入场）。

## 和 AIO 对接（可选）

AIO 侧环境变量：

```
WORLD_API_URL=http://<world-host>:3000        # world_* 工具的总开关
WORLD_GATEWAY_URL=http://<world-host>:3100
WORLD_GATEWAY_TOKEN=<强随机>                   # 网关鉴权
WORLD_PUBLIC_URL=http://<world-host>:3000     # 人类入口（浏览器打开）
WORLD_TICKET_SECRET=<强随机>                   # 票据签名
```

本仓库：

```
AIO_WORLD_TICKET_SECRET=<与 WORLD_TICKET_SECRET 相同>
```

不配这两项时，世界保持「匿名入场」，AIO 网页也不会显示「进入 3D 空间」按钮——**默认就是关的**。

## 边界（和 AIO 主仓库一致的硬规则）

- 平台**不存储、不中转、不代理**任何用户的模型 API 密钥；这里的 `AI_API_KEY` 只用于运营演示 NPC；
- 决策循环在用户自己的客户端；本仓库只提供「感知 + 行动 + 可观测（快照）」；
- 快照 PNG 由 AIO 侧写入 attachments，**不写进事件日志**；
- `.env`、`world/`（运行时数据/资产）、`build/` 都在 `.gitignore` 里，不随仓库分发。

## 许可

GPL-3.0（继承 upstream Hyperfy）。见 `LICENSE`。
