# BossClaw 项目深度分析报告

> 以高级开发者视角，从架构设计、核心技术、实现细节、工程亮点四个维度全面剖析

---

## 一、项目定位与设计哲学

BossClaw 是一款**面向求职者的本地 AI 投递助手**，以 Electron 桌面应用形态交付（v2.5.5，Apache-2.0）。

### 1.1 核心设计哲学："把浏览器还给你"

市面上多数求职自动化工具以浏览器扩展或油猴脚本形态存在——寄生在用户浏览器中，占用标签页、拦截页面、关标签即停。BossClaw 选择了一条完全不同的路：

- **独立桌面应用**：自带内置浏览器（webview），不抢占用户日常浏览器
- **后台持续运行**：切走窗口、最小化，投递/采集不中断
- **本地优先**：所有数据存本机 localStorage + 文件备份，零后端依赖
- **隐私可控**：API Key 仅存本地，AI 调用走用户自己的密钥

### 1.2 产品流程闭环

```
导入简历 → AI 生成职业画像 → 选择投递方向 → 搜索采集岗位
    → AI 四层匹配裁决 → 沟通草稿生成 → 半自动/自动投递 → 进度追踪与异常恢复
```

这条链路将求职中"看岗位 → 判匹配 → 写沟通 → 记状态"的高频重复劳动收敛到一个应用内完成。

---

## 二、整体架构设计

### 2.1 多进程 + 双桥接架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Electron Main Process (CJS)                      │
│  electron/main.cjs                                                  │
│  ┌───────────────┐  ┌───────────────┐  ┌────────────────────────┐  │
│  │ 窗口生命周期    │  │ IPC 安全路由    │  │ 子进程编排              │  │
│  │ BrowserWindow  │  │ safeHandle    │  │ Bridge (Node)          │  │
│  │ frame:false    │  │ safeOn        │  │ Camoufox (Python)      │  │
│  │ 自绘标题栏     │  │ 统一错误包装   │  │ CloakBrowser (Playwright)│ │
│  └───────────────┘  └───────────────┘  └────────────────────────┘  │
│         │                   │                        │              │
│  ┌──────┴──────┐   ┌───────┴────────┐    ┌──────────┴──────────┐  │
│  │Control      │   │ Preload Scripts │    │ OpenClaw Bridge     │  │
│  │Bridge       │   │ contextBridge   │    │ :18765 (Node)       │  │
│  │HTTP :17650  │   │ 安全 IPC 暴露    │    │ OCR/日报/状态恢复    │  │
│  │Token 鉴权   │   │ jc:* 通道规范   │    └─────────────────────┘  │
│  └─────────────┘   └────────────────┘                              │
└─────────────────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┴─────────────┐
                │     Renderer Process       │
                │  React 18 + TypeScript     │
                │  Vite 5 (HMR / Build)     │
                │  Zustand (persist)        │
                │  Ant Design 5            │
                │  61 个业务模块 (bossclaw/) │
                └───────────────────────────┘
```

| 层级 | 组件 | 技术选型 | 职责 |
|------|------|---------|------|
| **主进程** | `main.cjs` (2093行) | Node.js + Electron ^31 (CJS) | 窗口管理、IPC 路由、子进程编排、数据版本重置 |
| **预加载** | `app.cjs` / `webview.cjs` / `platform-adapters.cjs` | contextBridge | 安全暴露 API、webview 注入、多平台 DOM 适配 |
| **渲染进程** | `src/` (React + TS) | Vite + React 18 + Zustand | UI、业务逻辑、AI 调用、状态管理 |
| **控制桥** | `control-bridge.cjs` (379行) | Node http 零依赖 | 外部 Agent/MCP 的本地 HTTP API |
| **隐身引擎** | `camoufox_server.py` (1732行) + `platforms/` | Python + Camoufox + Playwright | 反检测搜索/投递/登录 |
| **MCP 服务** | `mcp/bossclaw-mcp/` | Node.js 零依赖 stdio | JSON-RPC 2.0 协议，8 工具 / 3 组 |

### 2.2 安全隔离模型

```
┌──────────────────────────────────────────────────┐
│ 渲染进程 (不可信)                                  │
│  - 无 Node.js 访问权                               │
│  - contextIsolation: true                         │
│  - nodeIntegration: false                         │
│  - 只能通过 contextBridge 暴露的 API 通信          │
│  - 所有 IPC 通道统一 jc: 前缀（命名断言校验）       │
└──────────────────┬───────────────────────────────┘
                   │ ipcRenderer.invoke / send
┌──────────────────┴───────────────────────────────┐
│ Preload 层 (半可信)                                │
│  - contextBridge.exposeInMainWorld('electron', api)│
│  - IPC 通道命名断言（非 jc: 前缀打 warn）           │
│  - webview preload 路径转 file: URL               │
└──────────────────┬───────────────────────────────┘
                   │ ipcMain.handle / on
┌──────────────────┴───────────────────────────────┐
│ 主进程 (可信)                                      │
│  - safeHandle: 统一 try/catch 包装所有 handler     │
│  - 文件读写、子进程 spawn、系统 API                 │
│  - Control Bridge: Token 鉴权 + 白名单动作         │
└──────────────────────────────────────────────────┘
```

关键安全设计点：

1. **IPC 通道命名规范**：所有通道强制 `jc:` 前缀，preload 层有 `assertIpcChannel` 运行时断言
2. **统一错误包装**：`safeHandle` / `safeOn` 确保 handler 异常不外泄到进程级
3. **全局异常兜底**：`uncaughtException` + `unhandledRejection` 捕获，避免单点崩溃
4. **控制桥默认关闭**：需 `BOSSCLAW_CONTROL=1` 或 `--control-bridge` 显式开启
5. **随机令牌鉴权**：24 字节随机 token，写入 `userData/control-bridge.json`（mode 0o600）
6. **渲染层白名单**：`controlRuntime.ts` 983 行定义了 40+ 白名单动作，硬约束不提供发消息/批量投递/绕过验证码能力

---

## 三、核心技术栈详解

### 3.1 前端技术栈

| 技术 | 版本 | 在项目中的角色 |
|------|------|--------------|
| **Electron** | ^31 | 桌面应用壳；`frame: false` 全自绘标题栏；`webviewTag: true` 内置浏览器 |
| **React** | 18 | UI 框架；lazy + Suspense 路由级代码分割 |
| **TypeScript** | 5.6 | 全量类型安全；538 行 types.ts 定义完整业务类型体系 |
| **Vite** | 5.4 | 构建工具；函数式 manualChunks 分包（react-vendor / antd-vendor） |
| **Ant Design** | 5.21 | UI 组件库；主题系统（浅色/深色/跟随系统） |
| **Zustand** | 4.5 | 状态管理；persist 中间件 → localStorage；6 个独立 Store 分层 |
| **Mammoth** | 1.8 | DOCX 简历解析（渲染进程内动态 import，按需加载） |
| **Playwright-core** | 1.62 | 隐身浏览器自动化（CloakBrowser 引擎） |

### 3.2 后端/桥接技术栈

| 技术 | 用途 |
|------|------|
| **Node.js http** | 控制桥 HTTP 服务（零依赖，127.0.0.1 监听） |
| **Python 3.10+** | Camoufox 隐身引擎桥（HTTP 服务 :18767） |
| **Camoufox** | 反检测浏览器内核（C++ 级指纹伪装 + humanize 类人行为） |
| **Playwright** | 浏览器自动化框架（驱动 Camoufox 内核） |
| **MCP** | Model Context Protocol，零依赖手写 JSON-RPC 2.0 实现 |

### 3.3 状态管理分层设计

```
┌─────────────────────────────────────────────────┐
│              Zustand Store 矩阵                  │
├──────────────────┬──────────────────────────────┤
│ useAppStore      │ 路由、主题、引擎状态、登录态    │ → 部分持久化
│                  │ （运行时探测结果不持久化）       │
├──────────────────┼──────────────────────────────┤
│ useSettingsStore │ 用户配置（城市/AI Key/平台/    │ → 持久化
│                  │ 安全限制/执行模式）             │
├──────────────────┼──────────────────────────────┤
│ useDataStore     │ 简历原文、职业画像、方向计划、  │ → 持久化
│                  │ 岗位队列、任务进度              │
├──────────────────┼──────────────────────────────┤
│ useScheduleStore │ 定时任务条目                   │ → 持久化
├──────────────────┼──────────────────────────────┤
│ useAutoChatStore │ 自动沟通引擎（运行时）          │ → 不持久化
├──────────────────┼──────────────────────────────┤
│ useRuntimeLogsStore│ 日志流、沟通记录             │ → 持久化（独立键）
└──────────────────┴──────────────────────────────┘
```

**设计精髓**：`partialize` 精确控制持久化边界——`bridgeStatus`、`bossLoggedIn`、`platformLogins` 等运行时探测结果不持久化，避免重启后显示上次残留状态。

---

## 四、核心模块实现剖析

### 4.1 "首进常驻"路由架构

这是项目在 UI 层面最精妙的设计之一。传统 SPA 切页 = 卸载旧组件 + 挂载新组件，但 BossClaw 的工作台包含一个 `<webview>` 内置浏览器——卸载 = 销毁 webview = 搜索采集/自动投递中断。

```tsx
// App.tsx 核心路由逻辑

// 1. 工作台"常驻宿主"：始终挂载，CSS 控制显隐
//    切走时 webview 保持存活 → 后台投递/采集不中断
<div className={'workbench-host' + (isWorkbench ? ' is-active' : ' is-background')}>
  <ErrorBoundary label="workbench">
    <Workbench />  {/* 永不卸载 */}
  </ErrorBoundary>
</div>

// 2. 非工作台页"首进常驻"：已访问页保持挂载，CSS display 切换
const [visited, setVisited] = useState({ home: true });
NAV_PAGES.map((key) => {
  if (!visibleSet[key]) return null;  // 未访问过 → 不渲染
  return (
    <div key={key} className={'page page-route' + (activeRoute === key ? ' is-show' : '')}>
      <ErrorBoundary label={key}>
        {/* key 稳定 → ErrorBoundary 不随路由变化 → 已挂载页面 DOM 不被重建 */}
        {key === 'home' && <Home />}
        ...
      </ErrorBoundary>
    </div>
  );
});

// 3. 空闲预加载：900ms 后预取全部页面 chunk
useEffect(() => {
  const t = window.setTimeout(() => {
    PRELOAD_PAGES.forEach((load) => load().catch(() => {}));
  }, 900);
  return () => window.clearTimeout(t);
}, []);
```

**解决的问题链**：
- 切页不重挂载 → 消除 DOM 重建开销
- 工作台 webview 后台保持 → 搜索/投递不中断
- 空闲预加载 → 首次切换零等待
- 侧栏自适应断点（1100px）→ 窄窗口自动收起

### 4.2 安全持久化层（persistSafe.ts）

这是项目中工程质量最高的模块之一，解决了 Zustand persist 在高频写入场景下的致命问题：

**问题**：批量引擎高频写日志时，每次 `addChatLog` 都触发 `JSON.stringify` + `localStorage.setItem`（含 base64 图片简历、16 万字符简历原文、双 500 条日志，单次可达 MB 级），主线程被反复阻塞。

**三层对策**：

```
1. 写防抖（250ms 合批窗口）
   短窗口内多次 set → 合并成一次真实写盘
   序列化次数从 N 次/秒 降到 ~4 次/秒

2. 容错降级
   写盘失败（QuotaExceededError）不抛出
   日志键 → 丢弃整个键重试
   业务键 → 丢弃该次持久化 + 限频告警
   绝不让存储异常冒泡进业务代码

3. 退出兜底
   pagehide / visibilitychange(hidden) 时同步 flush
   防抖窗口内的状态不因关窗/切后台而丢失
```

**写哨兵机制**（与备份模块联动）：

```typescript
// 每次 persist 写盘递增"写代数"
persistWriteEpoch.set(name, epoch + 1);

// 备份模块据此 O(1) 判断是否需要备份
// 全部 key 写代数未变 → 内容必然未变 → 零开销跳过
// 避免每 5 分钟对 MB 级数据做 getItem + stringify
```

### 4.3 本地备份系统（localBackup.ts）

```
localStorage（主存储）
    │
    ├── 每 5 分钟脏检查 → bossclaw-local-backup.json
    │
    ├── 快路径：persistDirtyEpoch 写代数比对
    │   └── 全部 key 代数未变 → O(1) 跳过（零序列化/零 IPC/零写盘）
    │
    ├── 每 4 次快路径跳过后 → 强制一次全量复核（兜底绕过 persist 的直写）
    │
    ├── IPC 直传文本：拼好的 JSON 直传主进程
    │   └── 避免 bundle 对象经结构化克隆 + 主进程二次 JSON.stringify
    │
    ├── requestIdleCallback 让出主线程
    │   └── 心跳先等浏览器空闲，不与用户交互撞车
    │
    └── 主存储缺失时 → 从备份文件回签恢复
        └── 恢复前 discardPendingPersistWrites（防旧值覆盖）
```

### 4.4 多平台采集架构

#### TypeScript 侧：平台适配器模式

```
platform-adapters.cjs（纯数据 + 纯函数）
├── BOSS 直聘：列表内联详情形态（唯一支持详情级采集）
├── 猎聘：列表级采集
├── 智联招聘：列表级 + SSR __INITIAL_STATE__ 注解
└── 前程无忧：列表级采集
```

每个平台声明：列表选择器、链接提取器、字段映射、页面形态选择器——差异集中在数据层，采集引擎代码不分支。

#### Python 侧：分层注册表

```
camoufox/
├── camoufox_server.py     # HTTP 调度基座（/search /send /chat /login）
└── platforms/
    ├── base.py            # CollectorBase 抽象基类（三段骨架：搜索·投递·登录）
    ├── capabilities.py    # 能力矩阵（platform_supports 单一权威查询）
    ├── registry.py        # CollectorRegistry 工厂模式（新增平台加一行）
    ├── progress.py        # 词级断点续采（TTL 24h，宁重复不遗漏）
    ├── filters.py         # 平台过滤器
    ├── liepin.py          # 猎聘差异声明
    ├── zhaopin.py         # 智联差异声明
    └── job51.py           # 前程无忧差异声明
```

**注册表模式**的优雅之处：

```python
class CollectorRegistry:
    def register(self, platform, factory): ...  # 登记
    def get(self, platform) -> CollectorBase: ...  # 工厂获取实例
    def supports(self, platform, capability) -> bool: ...  # 能力查询

# 新增平台只需：
# 1. 写一个 xxx.py 实现 CollectorBase
# 2. 在 build_default_registry() 加一行注册
# 无需改服务端分派逻辑
```

#### 智联招聘的精妙处理

项目对智联招聘新版 PC 搜索页（左列表 + 右内联详情）的处理堪称教科书级：

```javascript
// 问题：新版 .job-card 无详情 URL 锚点 → 去重后只剩 1 个岗位
// 解决：从 __INITIAL_STATE__ SSR 数据提取岗位详情 URL

// 1. 兼容两版字段名
//    新版：name / number / positionUrl
//    旧版：positionName / positionNumber / positionUrl

// 2. 新鲜度闸门（核心创新）
//    智联客户端刷新后 __INITIAL_STATE__ 可能与当前卡片不同步
//    以「激活卡标题 === selectedJobId 岗位名」判定索引可信
//    不可信时关闭盲标兜底，只做逐卡文本精确匹配

// 3. click 捕获 + 整页导航
//    用户点岗位卡 → 命中索引 → preventDefault + 整页跳转
//    匹配不到不做接管，退回站点原生内联
```

### 4.5 AI 匹配与评分系统

**四层整体裁决**（一次 AI 调用完成全链路判断）：

```
Layer 1: 硬门槛检查（学历/经验/证书等必须条件）
    ↓ 不满足 → unfit（直接淘汰）
Layer 2: 优先条件评估（加分项：大厂经验/相关项目等）
    ↓
Layer 3: 职责信号分析（岗位日常职责与简历的匹配度）
    ↓
Layer 4: 团队信号分析（团队文化/协作风格契合度）
    ↓
fitLevel 档位：strong / match / cautious / unfit
    ↓
分数由档位映射（不跨档），AI 分即最终分
```

**本地五维分**只用于界面展示和 AI 不可用时的兜底，唯一改分能力为硬约束拦截（score ≤ 35 → reject）。

### 4.6 LLM 调用层（llm.ts，1057 行）

这是项目中工程量最大的模块之一，展现了极高的工程成熟度：

```
callModel() 调用链：
├── 1. 主进程代理（jc:llm-proxy）→ 规避渲染层 CORS
├── 2. 无 API Key → 检查 Agent 代答通道
│   ├── 在线（90s 内有心跳）→ 入队等待（30s~240s）
│   └── 离线 → 回落本地规则
├── 3. JSON 解析容错（5 层修复链）
│   ├── 去 BOM / 零宽字符
│   ├── 去尾逗号
│   ├── 转义字符串内裸控制字符
│   ├── 补齐未闭合括号
│   └── 渐进截尾 + 括号平衡扫描
├── 4. Thinking 模型支持（resolveThinkingProfile）
└── 5. 上下文预算管理（contextBudget.ts，352 行）
    └── 按模型 token 窗口动态裁剪简历/JD 输入长度
```

**JSON 修复链的精细度**：

```typescript
// 5 个修复变体依次尝试
const variants = [
  raw,                                                    // 原始
  stripTrailingCommas(raw),                               // 去尾逗号
  escapeControlCharsInStrings(raw),                       // 转义控制字符
  stripTrailingCommas(escapeControlCharsInStrings(raw)),  // 组合
  closeBrackets(stripTrailingCommas(...)),                 // 补括号
];

// 还有括号平衡扫描（定位完整 JSON 末端，去尾随说明文字）
// + 渐进截尾兜底（从最后 8 个 } / ] 位置从后往前截）
```

### 4.7 风控感知系统（safety.ts）

```
封号升级链路（逆向分析结论）：
高频请求 → 限速(1006) → 滑块验证(35) → 账户异常(36) → 封禁(32)

安全不变量：
├── 36/32 之后继续重试 → 升级封禁等级 → 绝不重试
├── 1006 限速 → 立即退避（10 分钟冷却）
├── 平台限速阈值 ~30 次/分钟 → 自动化远低于此 + 人类化抖动
└── 本模块只提供「检测 + 降频 + 冷却 + 上限」，
    不包含任何指纹伪装/验证码绕过/代理池/账号轮换
```

**滑动窗口限速器**：

```typescript
class ActionPacer {
  // 每分钟最多 maxPerMinute 次动作
  // 超限时等待最旧动作滑出窗口 + 随机抖动 0.3~1.2s
  // 避免限速等待节奏完全一致被识别
  async waitForSlot(): Promise<void> {
    if (this.canAct()) { this.record(); return; }
    const oldest = this.timestamps[0];
    const wait = 60_000 - (Date.now() - oldest) + Math.round(300 + Math.random() * 900);
    await new Promise((r) => setTimeout(r, Math.max(300, wait)));
    this.record();
  }
}
```

### 4.8 定时任务调度器（scheduler.ts）

```
心跳 15s → 遍历启用的条目
├── 命中「当前 HH:mm == 设定 time 且星期匹配」
├── 90s 容差窗口内（应对节流/半分延迟）
├── 按 targetMs 去重（lastRunStamp 记录目标时刻 epoch）
└── 触发动作：
    ├── deliver → useAutoChatStore.start()（按平台范围/上限）
    ├── collect → setCollectRequest()（工作台消费触发采集）
    └── backup  → writeLocalBackup()
```

**互斥保护**：引擎为模块级单例，跨页后台运行；若已有批量沟通在运行则跳过本次触发，避免两条 run 争抢岗位。

### 4.9 Agent 控制桥 + MCP 接入

```
外部 Agent（Claude / Cursor / 任意 MCP 客户端）
    │
    ├── 路径 1：控制桥 HTTP API
    │   GET  /health     → 健康检查
    │   GET  /state      → 渲染层实时状态快照
    │   POST /action     → 白名单动作执行
    │   （Token 鉴权 + 127.0.0.1 only）
    │
    └── 路径 2：MCP stdio 协议
        bossclaw-mcp（零依赖 JSON-RPC 2.0）
        ├── 运行控制（3）：start / stop / status
        ├── 应用控制（2）：state / action
        └── Agent 代答（3）：tasks / submit / cancel
```

**MCP 零依赖实现**的动机：仓库历史上 `npm install` 曾被 EBUSY 阻断，零依赖保证服务永远可启动。手写 JSON-RPC 2.0 帧处理，stdout 是协议通道，所有日志走 stderr。

### 4.10 浏览器注册表模式（browserRegistry.ts）

解耦 `controlRuntime`（全局控制运行时）与 `BrowserView`（webview 组件）：

```
BrowserView 组件挂载 → registerBrowser(handle)
controlRuntime      → getBrowser() → 拿到句柄执行操作
BrowserView 组件卸载 → unregisterBrowser()
```

`BrowserHandle` 接口定义了完整的能力边界：mode / tabs / loadURL / joblist / jobCard / readPage / prefillGreeting / sendApply / uiExec——只暴露"只读探索 + 半自动预填 + 触发自动投递"，真正的发送校验由 webview preload 执行。

### 4.11 AI Skills 系统

```
skills/
├── resume-profile/    # 职业画像生成
├── job-analysis/      # 岗位分析
├── greetings/         # 打招呼语生成
├── tailor-cv/         # 定制简历
├── jd-reading/        # JD 阅读
├── great-resume/      # 优秀简历标准
└── job-match/         # 岗位匹配

每个技能 = SKILL.md（frontmatter 元数据 + 指令正文）
├── 按 scope 注入（profile / job-analysis / greetings / assistant）
├── 内置 7 项 + 支持自定义导入/新建/删除
├── 自定义技能优先覆盖内置同名（热更新友好）
└── 路径穿越防护：SKILL_ID_RE = /^[a-z0-9-]+$/
```

---

## 五、工程亮点总结

### 5.1 "引擎闸门"双通道架构

```
设置项：camoufox.enabled
├── true  → Camoufox 隐身引擎（Python 桥，C++ 级指纹伪装）
│           用于搜索/投递/登录，不占内置浏览器标签
└── false → 内置浏览器 webview（可视化采集）
            用户可直观看到操作过程

两条通道共享同一套安全不变量
```

Camoufox 依赖自愈机制：

```
启动 → 检测 Python → 探测依赖 → 缺失？
├── 是 → 后台安装（去重 Promise），请求立刻返回"安装中"
│       不阻塞在 IPC 请求里（避免前端按钮无限转圈）
└── 否 → 标记就绪，跨启动持久化到 engine-state.json
```

### 5.2 隐身引擎依赖自愈 + 状态持久化

```typescript
// 启动时加载持久化的「已就绪」状态
// 仅当「跨启动校验通过、依赖确实就绪」时才预拉 Python 进程
// 避免每次启动无条件 spawn（否则 CPU/内存占用升高）
// 依赖缺失场景交给首次使用时 ensureCamoufoxDeps 自愈
```

### 5.3 故障隔离策略

```
平台级故障（未登录 / 4xx·5xx / 风控码）
├── 只收口当前平台 → 后续平台继续
└── 各平台独立登录态与每日配额

队列级故障（风控码 32·35·36 / 环境异常 37·38）
├── 立即中止整批 → 交人工处理
└── 未知码 fail-safe 上报

单条定时任务异常
└── 不影响其余条目与整个间隔循环
```

### 5.4 数据版本号 + 跨版本迁移

```typescript
// 渲染层
const DATA_VERSION = 'v3-rebuild-20260815';
// 首次启动检测版本变化 → clearAllData() + 写标记 + reload

// 主进程
// resetDataForVersion()：清 BOSS 登录态 + Camoufox cookie + CloakBrowser profile
// 写标记文件避免重复清理
// clearStorageData 必须 await（旧实现"发起即返回"导致并发问题）
```

### 5.5 窗口控制与诊断体系

```
frame: false → 完全自绘标题栏
├── 最小化/最大化/关闭/置顶
├── 侧栏自适应断点（1100px）
├── 失焦时暂停非必要微动效（is-blurred class）
└── 窗口置顶状态订阅与同步

白屏诊断（BOSSCLAW_DEBUG=1）：
├── console-message 转发
├── did-fail-load 记录
├── DOM-CHECK（2.5s 后检查 root 节点长度）
├── WEBVIEW 加载时序（did-attach-webview → navigation → navigate → finish）
└── debug-render.log 完整记录渲染链路
```

### 5.6 Vite 分包策略

```typescript
// 函数式 manualChunks：按 node_modules 实际路径精确分组
// 修复对象式 manualChunks 中 react/react-dom 只捕获入口门面
// （产出 0.03KB 空 chunk）的问题
manualChunks(id) {
  if (id.includes('/react/') || id.includes('/react-dom/')) return 'react-vendor';
  if (id.includes('/antd/') || id.includes('/@ant-design/')) return 'antd-vendor';
  // mammoth 通过动态 import 单独成 chunk，按需加载
}
```

### 5.7 业务模块矩阵（61 个 .ts 文件）

`src/lib/bossclaw/` 目录包含 61 个 TypeScript 业务模块，覆盖：

| 领域 | 模块 |
|------|------|
| AI 调用 | `llm.ts`(1057行) / `agentAnswer.ts` / `thinkingCapability.ts` / `contextBudget.ts` |
| 简历处理 | `resumeParser.ts` / `resumePdf.ts`(612行) / `docxParser.ts` / `resumeContact.ts` / `resumeDesensitize.ts` / `resumeMatch.ts` / `resumeToImage.ts` |
| 岗位匹配 | `matching.ts`(705行) / `jobMatch.ts`(822行) / `fitLevel.ts` / `priority.ts` |
| 平台能力 | `platforms.ts` / `searchUrl.ts` / `platformUrls.ts` / `camoufox.ts` |
| 安全防护 | `safety.ts` / `deliveryLock.ts` / `browserWhitelist.ts` |
| 方向规划 | `directions.ts` / `directionCatalog.ts` / `directionKeywordsAI.ts` / `directionDetailAI.ts` |
| 数据统计 | `statsAggregate.ts`(707行) / `statsExport.ts` / `statsReport.ts` |
| 技能系统 | `skills.ts` / `skillTaxonomy.ts` |
| 其他 | `profile.ts`(577行) / `jobAssistant.ts`(832行) / `greetings.ts` / `jdCleaner.ts` / `salaryCalibration.ts` / `schoolTier.ts` / `workSchedule.ts` |

---

## 六、架构设计亮点总结

### 6.1 关注点分离的极致实践

- **平台差异数据化**：`platform-adapters.cjs` 纯数据 + 纯函数，采集引擎代码不分支
- **浏览器控制解耦**：`browserRegistry.ts` 注册表模式，组件与控制运行时零耦合
- **安全边界清晰**：preload 只暴露白名单 API，主进程 safeHandle 统一包装
- **Store 按职责分层**：6 个独立 Store，持久化策略各不相同

### 6.2 防御性编程贯穿始终

- 全局 `uncaughtException` / `unhandledRejection` 兜底
- IPC 统一错误包装，异常不外泄
- localStorage 写失败容错降级，不冒泡
- 定时任务单条异常不影响整体循环
- 备份恢复前丢弃 pending writes，防旧值覆盖
- JSON 解析 5 层修复链

### 6.3 性能意识

- 写防抖（250ms 合批）→ 主线程不被大 stringify 卡住
- 备份快路径（写代数 O(1) 判断）→ 空闲周期零开销
- requestIdleCallback 让出主线程 → 心跳不与用户交互撞车
- 路由级 lazy + 空闲预加载 → 首屏快、切页快
- 页面"首进常驻" → 避免 DOM 重建开销
- IPC 直传文本 → 避免结构化克隆 + 二次序列化

### 6.4 安全设计

- 不绕过验证码/账户验证（硬约束）
- 风控码 32/35/36 立即停止交人工（绝不重试）
- 控制桥默认关闭 + Token 鉴权 + 白名单动作
- Agent 代答只搬运「提示词 ↔ 生成文本」，回填仍过全部校验链
- API Key 掩码展示（`maskKey`）
- 安全上限不可被轻易突破（`MAX_SAFE_DAILY` 硬编码）

---

## 七、技术选型评价

| 选型 | 评价 |
|------|------|
| Electron + React | 桌面应用标配，React 生态成熟；`frame: false` 自绘标题栏实现高度自定义 UI |
| Zustand（非 Redux/MobX） | 轻量、无 boilerplate、persist 中间件天然适配 localStorage 场景 |
| Vite（非 Webpack） | 开发体验极佳（HMR 秒级），构建分包灵活 |
| Ant Design | 企业级 UI 组件库，主题系统完善（浅色/深色/跟随系统） |
| Python 桥（Camoufox） | 反检测浏览器生态 Python 最成熟（Playwright 驱动），通过 HTTP 桥与 Electron 通信 |
| 零依赖 MCP | 手写 JSON-RPC 2.0，保证服务永远可启动，不依赖 npm 生态 |
| CommonJS（主进程） | Electron 主进程传统选择，兼容性好；渲染进程走 ESM（Vite） |
| localStorage（非 SQLite） | 轻量、零依赖、适合桌面应用单机场景；配合文件备份兜底 |

---

## 八、总结

BossClaw 是一个**工程质量极高的 Electron 桌面应用**，从以下维度可以看出作者的深厚功底：

1. **架构设计**：多进程 + 双桥接 + 注册表模式 + 浏览器解耦，层次清晰、职责分明
2. **安全意识**：从 IPC 通道命名规范到控制桥白名单，从风控码处理到 Agent 代答校验链，安全思维贯穿始终
3. **性能优化**：写防抖、备份快路径、requestIdleCallback、路由常驻、分包策略——每一处都针对真实瓶颈
4. **防御性编程**：全局异常兜底、容错降级、JSON 5 层修复链、数据版本号迁移——考虑到了各种边界情况
5. **可扩展性**：平台注册表模式、AI Skills 系统、MCP 接入——新增平台/技能/Agent 几乎零改动
6. **产品思维**："把浏览器还给你"的差异化定位、安全不变量的坚守、用户验收流程的设计——不只是技术实现，更是对产品边界的思考

这是一个将"求职自动化"这个需求做到极致的开源项目，在架构设计、工程质量、安全意识、性能优化四个维度都达到了相当高的水准。
