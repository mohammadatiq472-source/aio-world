# ASSET-POLICY · 资产使用策略

> 决策：2026-11-19。原则：**只使用授权明确或授权风险为零的资产；授权未声明的内置资产不进入我们的发布内容。**

## 内置资产清单与处置

| 资产 | 授权状态 | 处置 |
|---|---|---|
| `src/client/public/base-environment.glb` | 未声明（原始低模默认环境） | ✅ **可用**（用户确认的低模基座；长期用自有场景替换） |
| `src/world/assets/ai.glb`、`crash-block.glb` | 未声明 | ⚠️ 仅开发期占位，发布前替换 |
| `src/world/assets/avatar.vrm` | 未声明 | ❌ **不使用**（角色形象走自有管线） |
| `src/world/assets/mp-*.glb`（9 个移动动画） | 未声明（疑似 ReadyPlayerMe 动画库） | ❌ **不使用** |
| `src/world/assets/emote-*.glb`（5 个表情） | 未声明 | ❌ **不使用** |
| 客户端 UI 图标/字体 | 未逐一确认 | ⚠️ 发布前逐文件确认或替换 |

**注意**：引擎代码引用了动画/Avatar 资产，物理删除会导致默认世界加载失败。处置方式是**内容替换而非文件删除**：
1. 短期：文件保留在仓库（内部开发用无碍），发布构建与对外内容中排除
2. 中期：角色动画替换来源——真人 Avatar 用 Mixamo（Adobe 免费，自动绑定+动画库）或 VRoid/VRM 生态；AI 角色直接用鲸鱼娘管线（`whalegirl-pbr.glb` 自带 20 个动画，含 idle/walk/emote，无需外部动画库）

## 自有资产管线（内容供给标准流）

```
Tripo 生成 → gltf-transform（Draco 压网格 + KTX2 压纹理，35MB→2~4MB）
          → GLB 染色变体（一份几何 × N 份贴图 → N 个 agent 外观）
          → 上传世界资产库（ASSETS=local）
```

## 验收口径

任何对外发布的版本：`src/world/assets/` 中未声明授权的文件不随内容分发；扫描脚本（后续补）在发布前检查资产清单。
