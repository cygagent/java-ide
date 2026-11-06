# Java IDE MVP 开发计划（A 档：薄壳方案）

> 定位：不自研语言引擎、不自研调试器，把成熟组件拼装成产品。
> 目标产物：能「打开 Java 项目 → 编辑 → 运行 → 调试 → 提交」的桌面工具。

---

## 1. 定位与红线

### 做什么
- 打开 Java 项目（Maven / Gradle）
- 编辑（高亮、补全、跳转、诊断、格式化）
- 运行（Run Configuration、控制台输出）
- 调试（断点、变量、调用栈、单步）
- Git（状态、diff、暂存、提交、分支）

### 明确不做（防范围蔓延）
- 不写词法/语法分析器、不写 AST、不写符号索引
- 不实现 JVM 调试协议，只用 DAP
- 不做构建引擎（不解析 pom 依赖树、不做依赖仲裁）
- 不支持 Maven / Gradle 之外的构建体系（Ant、Bazel 一律不支持）
- 不做插件市场、不支持第三方扩展
- 不做重构全家桶，只保留 LSP 白送的（重命名、格式化）
- 不做远程开发、容器开发、WSL

---

## 2. 总体架构：三进程模型

```
┌─────────────────────────────────────────────┐
│  UI 进程（Electron / TypeScript）            │
│  Monaco 编辑器 · 文件树 · Git 面板 · 调试面板 │
└───────┬──────────────┬──────────────┬───────┘
        │ LSP          │ DAP          │ 进程调用
        │ (JSON-RPC)   │ (JSON-RPC)   │
┌───────▼───────┐ ┌────▼──────────┐ ┌─▼──────────────┐
│ JDT LS (JVM)  │ │ java-debug    │ │ 被调试/运行的   │
│ 语言服务       │ │ 调试适配器     │ │ 用户程序 (JVM)  │
│ 独立 workspace │ │ (DAP)         │ │ + JDWP 端口     │
└───────────────┘ └───────────────┘ └────────────────┘
        ▲                                  ▲
        └──── Git 独立走子进程（git CLI / JGit）──┘
```

**为什么必须分进程**
- JDT LS 自己就是一个 JVM，卡死/GC 不能拖垮 UI
- 被调试程序独立进程才能挂 JDWP，重新运行/终止不影响 UI
- 语言服务有独立 workspace 目录，与用户项目目录分离，避免污染

---

## 3. 技术选型

| 能力 | 选型 | 备选 | 选型理由 |
|---|---|---|---|
| 应用外壳 | Electron + TypeScript | JavaFX / Tauri | Monaco 原生是前端组件，Electron 里直接用 |
| 编辑器内核 | Monaco Editor | CodeMirror 6 | VS Code 同源，LSP 集成范式成熟 |
| LSP 客户端 | monaco-languageclient + vscode-languageclient | 自研 JSON-RPC | 省掉 3000+ 行协议对接代码 |
| Java 语言服务 | Eclipse JDT Language Server | 自研 javac 索引 | 产品级：补全/跳转/重构/诊断全覆盖 |
| 调试适配 | java-debug（JDT DAP 适配器） | 直接 JDI 自研 | DAP 客户端可复用；JDI 自研是 3–5 倍工作量 |
| JVM 运行时 | 内置 JDK 17（JDT LS 需 17+） | 探测用户本地 JDK | 避免"用户 JDK 版本不对" |
| 构建 | Maven Wrapper / maven-embedder；Gradle Tooling API | 自研 pom 解析 | 只做模型读取 + 命令行调用 |
| 运行 | ProcessBuilder + 控制台流式输出 | — | 这层很薄 |
| Git | 主：git CLI 子进程；辅：JGit（解析 diff/status） | 纯 JGit | CLI 在 hook / credential / 大仓上兼容性最好 |
| 打包 | electron-builder | — | 三平台产物一键生成 |
| 设置持久化 | electron-store（JSON） | SQLite | 配置量小 |

---

## 4. 模块清单（10 个模块，约 3.8 万行）

| # | 模块 | 职责 | 对外接口 | 依赖 | 估算 |
|---|---|---|---|---|---|
| 1 | 应用外壳 | 主窗口、菜单、可拖拽面板布局、多主题、快捷键 | WindowManager / ThemeService | Electron | 3.0k |
| 2 | 工作区与项目模型 | 打开目录、识别 Maven/Gradle、解析模块与依赖、管理 classpath | WorkspaceService / ProjectModel | Maven/Gradle API | 4.0k |
| 3 | 编辑器内核 | Monaco 实例管理、多标签、脏标记、高亮、查找替换 | EditorService | Monaco | 5.0k |
| 4 | LSP 客户端 | 启停 JDT LS、文档同步、补全/悬停/跳转/诊断/格式化/重命名 | LspClient | JDT LS | 4.0k |
| 5 | 文件系统与文件树 | 目录树、增删改、外部改动监听、路径与 URI 映射 | FileTreeService | Node fs + chokidar | 2.5k |
| 6 | 构建与运行 | Run Configuration、调用 Maven/Gradle、启动用户 JVM（附加 JDWP）、控制台 | RunService / RunConfig | ProcessBuilder | 5.0k |
| 7 | 调试 | DAP 客户端、断点（行/条件/日志）、启动与附加、变量树、调用栈、求值、单步 | DebugService | java-debug | 6.0k |
| 8 | Git 集成 | 状态、行级 diff、暂存/撤销、提交、分支切换、pull/push、冲突提示 | GitService | git CLI + JGit | 5.0k |
| 9 | 设置与持久化 | 编辑器/JDK/构建/Git 配置、最近项目、窗口状态 | SettingsService | electron-store | 2.0k |
| 10 | 打包与分发 | 三平台产物、内置 JDK/语言服务、自动更新、首启引导 | — | electron-builder | 1.5k |

**强耦合点提醒**：模块 3 ↔ 4 ↔ 7 之间的「URI ↔ 文件路径 ↔ Monaco model URI ↔ 文档版本」映射，必须在模块 5 里统一收口成一个 `UriMapper`，其余模块一律不自己拼路径。这是最容易出 bug 的地方。

---

## 5. 内存优化清单（按收益排序）

A 路线降不到 100MB 级，但可从默认 3GB+ 压到约 1.2GB。

| # | 措施 | 预期收益 | 说明 |
|---|---|---|---|
| 1 | 给 JDT LS 设堆上限 `-Xmx1g` | 省 500MB–1.5GB | 最立竿见影；JVM 默认堆上限可吃 2–4GB |
| 2 | 索引排除目录（.git / target / build / node_modules） | 省 300MB–800MB | 索引体积直接决定语言服务内存 |
| 3 | 调试会话结束强制 kill 被调试 JVM | 省 200MB–1GB | 防残留进程堆积（最常见的"越用越卡"原因） |
| 4 | 单实例锁：一个窗口只起一个 JDT LS | 省 400MB+ | 多开会线性增长 |
| 5 | 构建进程策略二选一 | 省 300MB 或省启动时间 | Gradle daemon 复用省时间但常驻占内存；**默认建议禁 daemon** |
| 6 | Monaco 限制大文件为只读（>2MB） | 防爆内存 | 大文件会让渲染进程内存失控 |
| 7 | Electron 侧调优（减渲染进程、--disable-gpu） | 省 50–150MB | 收益有限，别在此花太多精力 |

**目标**：空闲 1.2–1.8GB，运行/调试时 2–2.5GB。

---

## 6. 阶段划分

| 阶段 | 交付物 | 验收标准 |
|---|---|---|
| M1 骨架 | 窗口 + 文件树 + Monaco 显示文件 | 打开真实 Maven 项目，能看到目录树、点开 .java 有高亮 |
| M2 语言智能 | JDT LS 接入 | 输入 `list.` 出补全；Ctrl+点击跳转定义；错误行有波浪线 |
| M3 运行 | Run Configuration + 控制台 | 选中含 `main` 的类点 Run，控制台出输出；异常打印堆栈 |
| M4 调试 | 断点 + DAP | 打断点 → 启动 → 停在断点 → 变量树正确 → 单步 → 结束 |
| M5 Git | Git 面板 | 改文件 → 状态区出现 → 看 diff → 暂存 → 提交 → 记录可见 |
| M6 打包 | 三平台安装包 | 干净机器装完能完成 M1–M5 全流程 |

每个阶段都要求「可运行的真实闭环」，不允许跳过验证进入下一阶段。

---

## 7. 风险与降级

| 风险 | 影响 | 降级方案 |
|---|---|---|
| JDT LS 启动慢（大项目首次索引数十秒） | 体验差 | 首启显示索引进度 + 后台预热，UI 不阻塞 |
| 内置 JDK 体积大 | 安装包 > 200MB | 首启引导"使用本地 JDK" |
| git CLI 未安装 | Git 功能全废 | 内置便携版 git 或降级为 JGit 只读模式 |
| java-debug 与被调试 JDK 版本不匹配 | 调试失败 | 锁定内置 JDK 版本，不做跨版本兼容 |
| LSP 增量同步丢事件 | 补全错乱 | 降级为全量同步（TextDocumentSyncKind.Full） |
| 大文件（>5MB）卡 UI | 卡死 | Monaco 层限制大小，超出转只读预览 |

---

## 8. 仓库结构

```
java-ide/
├── src/main/            # UI 主进程（Electron main）
│   ├── services/        # 模块 1/2/5/6/8/9 的服务实现
│   └── ipc/             # 前后端 IPC 协议定义
├── src/renderer/        # 渲染进程（Monaco + 各面板 UI）
│   ├── editor/          # 模块 3
│   ├── lsp/             # 模块 4
│   ├── debug/           # 模块 7
│   └── panels/          # Git / Run / 文件树 面板
├── src/shared/          # 共用类型与常量（UriMapper 放这里）
├── runtime/             # 内置 JDK + JDT LS + java-debug
└── build/               # electron-builder 配置
```

---

## 9. 开工前的前置动作（按顺序）

1. **验证 JDT LS 独立跑通**：不经 UI，命令行起 JDT LS，用脚本发 `initialize` + `completion`，确认能出补全。
   顺带采集：补全响应耗时、JDT LS 实际内存占用、启动到 ready 的时长。
   **这一步不通，后面全是空转。**
2. **跑通一个 DAP 会话**：用 java-debug 对一个 hello world 断点，确认 DAP 消息流正确。
3. **最后才写 UI**：UI 是最不重要的部分，却最容易先动手。

---

## 10. 待补充的后续设计

- `docs/design/lsp-client.md`：模块 4 详细设计（进程生命周期、传输分帧、URI 映射、文档同步、诊断分发、时序图）
- 内存优化清单中的具体参数需在步骤 1 验证后回填实测值
