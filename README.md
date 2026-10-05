# 古建筑彩绘病害档案（gbmuralarch）

面向文物建筑彩画勘察与修复人员的本地化档案工具：把殿宇内每处彩画层位的病害现状逐条落档，并按工序安排修复先后。

核心动作：**录入殿宇与构件 → 圈定彩画层位 → 判定病害类型与程度 → 挂接修复工序并跟踪进度**。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据），刷新或重启浏览器后仍然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:21801**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbmuralarch}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地，迁移设备请使用应用内「导出 / 导入 JSON 备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 全部页面与组件使用组合式 API |
| 语言 | TypeScript（`strict: true`，无 `any`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、树、表单、对话框、时间线交互 |
| 构建工具 | Vite 6 | 开发服务器端口 21801 |
| 状态管理 | Pinia（setup store） | `hallStore` / `decayStore` / `repairStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 含数据结构版本号与升级迁移逻辑 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:21801
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:21801）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、页面与路由

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/halls` | 殿宇总览 | 新建殿宇、按年代与结构类型筛选，卡片回显病害总数与未修复数 | Hall、Element、PaintLayer、Decay |
| `/halls/:id/elements` | 构件与层位 | 构件树 + 层位表格，新增构件与层位，挂接病害 | Element、PaintLayer、Decay |
| `/decays` | 病害档案台 | 按类型 / 程度 / 颜料 / 殿宇 / 部位组合筛选，批量改严重程度与类型 | Decay、PaintLayer |
| `/repair` | 修复工序时间线 | 拖拽调整工序先后，回填材料与责任人；完成 / 撤回提交只追加施工流水并按基准序号裁决，含待合并区裁决、失败草稿重试、流水历史 | RepairStep、LedgerEntry、PendingMerge、LedgerDraft |
| `/backup` | 本地数据与备份 | 查看本地结构版本、JSON 导入导出、清空与样例数据 | 全部模型 |

`/` 与未匹配路径均重定向到 `/halls`。

---

## 五、数据模型

| 模型 | 文件 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| Hall 殿宇 | `src/types/hall.ts` | `id` `name` `era` `structureType`（大木/小式） `roofType`（庑殿/歇山/悬山） | 新建后进入构件录入 |
| Element 构件 | `src/types/element.ts` | `id` `hallId` `position`（檐下/室内/梁枋/斗拱/天花） `name` `layerCount` `baseLayer` `status`（完好/观察/待修） | 按殿宇与部位二维筛选 |
| PaintLayer 彩画层位 | `src/types/layer.ts` | `id` `elementId` `level`（由外至内） `patternName`（旋子/和玺/苏式） `pigment`（石青/石绿/朱砂/土黄） `thicknessMm` | 层位顺次叠压 |
| Decay 病害记录 | `src/types/decay.ts` | `id` `layerId` `type`（起甲/剥落/空鼓/粉化/龟裂） `severity`（轻度/中度/重度） `areaCm2` `causeGuess` `repaired` | 同层位可叠加多条并汇总到殿宇；`repaired` 为流水对账缓存，不允许页面直接覆写 |
| RepairStep 修复工序 | `src/types/repair.ts` | `id` `decayId` `seq` `name`（除尘/回贴/灌浆/补绘/封护） `material` `operator` `state` `ledgerVersion` | 计划态只保留未开始/进行中；是否已完成以流水折叠为准 |
| LedgerEntry 施工流水 | `src/types/ledger.ts` | `id` `seq`（全局接纳序号） `kind`（complete/revert） `status`（accepted/pending/rejected） `stepId` `decayId` `baseSeq` `clientId` `reversesEntryId` | **只追加**：完成记 complete，撤回记 revert 反向记录；原施工过程永久可查 |
| PendingMerge 待合并区 | `src/types/ledger.ts` | `id` `kind` `stepId` `baseSeq` `actualSeq` `reason` `clientId` | 基准序号过期 / 现状冲突的后到提交整笔落此，裁决前不进统计 |
| LedgerDraft 流水草稿 | `src/types/ledger.ts` | `id` `kind` `stepId` `baseSeq` `lastError` `attempts` | 写入失败后保留，按同一 id 重试、幂等不重复累计 |

### 5.1 施工流水并发约定

组长与记录员常在两个标签页同时提交同一处病害的完成或撤回，系统以只追加流水解决：

1. **提交带基准序号**：页面提交完成/撤回时携带当时所见的最新流水序号 `baseSeq`。
2. **数据库按接纳顺序认第一条**：事务内重新计数，序号 `seq` 全局递增、只增不改；第一条正常入账并回写工序 / 病害现状。
3. **后到提交进待合并区**：若最新序号已变化（`head > baseSeq`），或现状已被对方改写（重复完成 / 对未完成工序撤回），整笔写入 `pendingMerges`，**绝不覆盖**已完成的工序或病害现状；在工序时间线顶部由人工「接纳 / 驳回」，驳回也会在流水里追加 `rejected` 留痕。
4. **完成次数按正式流水累计**：撤回生成 `revert` 反向记录并指向被冲销的完成记录，完成次数只数正式 `complete`，当前完成态 = 完成数 − 撤回数 > 0；原施工记录继续可查（工序卡片「流水」按钮）。
5. **写入失败保留草稿**：事务异常时落 `ledgerDrafts`，重试沿用同一主键，入账事务先查重，绝不重复累计。
6. **统计只认对账结果**：档案台、工序时间线、殿宇总览、备份导入导出读取的完成态 / 修复率全部由 `accepted` 流水折叠，未裁决项一律不进修复统计。
7. **旧数据升级**：数据结构版本 `DB_VERSION = 3`（`src/utils/db.ts`）。v2 → v3 迁移时，缺少流水版本的旧工序按现状补初始记录（旧为「已完成」的工序各补一条 `migration-v3` 来源的正式完成流水），病害修复态随后统一按流水对账重算，无流水支撑的旧 `repaired` 标记退回未修复。

---

## 六、目录结构

```
sologsb-1101/
├── frontend/                     # 前端源码
│   ├── src/
│   │   ├── types/                # hall.ts element.ts layer.ts decay.ts repair.ts ledger.ts
│   │   ├── stores/               # hallStore.ts decayStore.ts repairStore.ts ledgerStore.ts
│   │   ├── components/common/    # SeverityTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
│   │   ├── hooks/                # useDecayFilter.ts useIdbTable.ts
│   │   ├── pages/                # HallList.vue ElementDetail.vue DecayBoard.vue RepairPlan.vue BackupView.vue
│   │   ├── router/               # index.ts
│   │   ├── utils/                # severity.ts db.ts export.ts ledger.ts
│   │   ├── scripts/              # 施工流水并发 / v3 迁移测试（npm run test:ledger）
│   │   ├── styles/               # main.css
│   │   ├── App.vue main.ts env.d.ts
│   ├── public/favicon.svg
│   ├── index.html package.json tsconfig.json vite.config.ts
├── Dockerfile                    # 多阶段构建（node:20-alpine → nginx:alpine）
├── nginx.conf                    # SPA fallback + gzip + 静态资源缓存
├── docker-compose.yml            # 顶层 name、container_name、端口映射
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── README.md
```

分层约定：页面只读 store，跨页状态不留在组件内部；IndexedDB 读写统一走 `useIdbTable()` 封装；筛选派生逻辑统一走 `useDecayFilter()`。

---

## 七、数据存储说明

- **IndexedDB（Dexie，数据库名 `gbmuralarch`）**：5 张业务表 `halls` / `elements` / `layers` / `decays` / `repairSteps` 与 3 张流水表 `ledgerEntries`（只追加正式流水）/ `pendingMerges`（待合并区）/ `ledgerDrafts`（失败草稿），由 `src/utils/db.ts` 统一定义 schema、版本号与升级迁移；普通增删改查通过 `src/hooks/useIdbTable.ts` 封装并用 `liveQuery` 响应式订阅，施工完成 / 撤回统一走 `src/stores/ledgerStore.ts` 的事务提交。
- **localStorage**：仅存元数据 —— `gbmuralarch:db-version`（本地结构版本）、`gbmuralarch:last-backup-at`（最近一次导出时间）、`gbmuralarch:ui-prefs`（当前选中殿宇、工序排序方式）；`sessionStorage` 另存标签页级 `gbmuralarch:client-id`，用于流水溯源是哪位在哪台终端提交。
- **备份**：`/backup` 页面导出的 JSON 含 8 张表全量数据与结构版本，导入时先校验 `app` 字段与各集合数组完整性；支持「覆盖导入」与「追加导入（重新分配 id，流水序号在本地 head 之后顺延、反向引用同步改指向）」两种模式，导入完成后统一执行一次全量对账。
- **隐私与无状态**：数据不上传任何服务器，容器不挂载命名卷；清理浏览器站点数据或更换浏览器会丢失档案，请定期导出备份。

---

## 八、开发提示

- 类型检查与构建：`cd frontend && npm run build`（含 `vue-tsc --noEmit`，必须零错误）。
- 流水逻辑测试：`cd frontend && npm run test:ledger`（fake-indexeddb 下覆盖并发提交、序号过期、撤回反向记录、幂等重试与 v2 → v3 迁移对账）。
- 端口一致性：开发服务器（`vite.config.ts`）、预览服务、compose 的 `FRONTEND_PORT` 默认值均为 `21801`。
- 若部署在中文路径下，`docker-compose.yml` 顶层的 `name: gbmuralarch` 可保证项目名不为空，`docker compose config --quiet` 不会报错。
