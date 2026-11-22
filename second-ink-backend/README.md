# Second Ink 后端 v0.4

Second Ink 独立后端工程，位于现有工作区的 `second-ink-backend` 子目录。提供业务基础、材料补正、文档审阅、Skill 和可配置单 Agent 流程，供前端联调使用。

v0.4 增加生效材料选择、五分钟微调预览、历史运行分支、判定级局部复验、唯一执行头和跨分支模型预算。原件和历史检查点保留，报告重新生成后仍须人工审阅与确认发布。接口、升级与联调流程见 [API-V4.md](docs/API-V4.md)。

v0.3 增加固定四角色团队、DAG 并行调度、团队／分支暂停、最新稳定检查点续办、失败节点受限重试和进程异常接管。规则角色与可选模型报告明确区分。新增接口及控制语义见 [API-V3.md](docs/API-V3.md)。

v0.2 完整流程为：上传材料 → 人工修正 → RULES 重新核验 → 基础草稿 → MODEL 修订提案 → 人工接受 → 确认发布。默认无需模型密钥即可使用规则与人工操作。新增参数和权限见 [API-V2.md](docs/API-V2.md)；机器可读接口规范见 [openapi.json](docs/openapi.json)，运行时由 `/api/openapi.json` 提供。

## 启动

需要 Node.js 24.14 或更高版本。在 PowerShell 中执行：

```powershell
Set-Location 'D:\code\workflow-agent-backend\second-ink-backend'
npm ci
npm run build
npm start
```

健康检查：`http://127.0.0.1:3080/api/health`。没有前端页面，所有业务接口位于 `/api`。默认使用 `storage/second-ink.sqlite`，附件保存在 `storage/attachments`，重启后保留。无需配置数据库或模型密钥即可验证流程。

配置模板为 `.env.example`，需要调整时复制为 `.env`。不读取或迁移旧 DocSure 的数据库、账号和密钥。默认仅监听本机地址。

```powershell
npm run dev       # 初次编译后，同时监听 TypeScript 和编译产物
npm run check     # TypeScript 检查
npm test          # 隔离数据库的 API 集成测试
npm run smoke     # 编译后启动独立服务，验证完整请求流程并清理临时数据
npm run smoke:worker # 使用独立 API 和 Worker 进程验证相同完整流程
npm run smoke:team # 内嵌 Worker 验证团队 DAG、暂停、检查点续办与发布
npm run smoke:team:worker # 独立 API/Worker 验证团队控制完整流程
npm run smoke:branch # 材料选择、微调预览、分支与局部复验至人工发布
npm run smoke:branch:worker # 独立 API/Worker 验证相同分支流程
npm run openapi   # 重新生成 docs/openapi.json
```

## 已实现

- 注册、登录、HttpOnly 会话 Cookie 和 Bearer token；密码采用带盐 scrypt 保存，退出撤销当前会话。
- 组织、成员、ADMIN／HANDLER／REVIEWER／SUBMITTER 角色和事项访问校验。
- 社团周报与企业入职两种事项；业务数据及事项版本校验。
- TXT、MD、CSV、XLSX、DOCX 上传、解析和原件下载。每次最多 5 个文件、每个 5 MB，每个事项最多 20 个附件。
- XLSX 字段保留工作表、行、列和单元格位置；文本保留行号。Office 文件检查压缩包大小和路径，公式单元格拒绝导入。
- 制度登记、业务日期和组织过滤、简单关键词检索。制度条目首版不可修改，每条固定为版本 1。
- 后台固定流程：读取证据 → 规则核验 → 模板草稿。周报检查缺项、人数、日期及相同活动的来源冲突；企业入职检查基础字段与材料清单。
- 持久化任务队列、取消、运行租约及过期任务重新领取；支持内嵌 Worker 和独立 Worker。
- 文档区块、不可变版本、人工修改、历史内容恢复和指定版本 TXT 导出。
- 人工确认后发布；确认绑定事项版本、文档版本、摘要和确认人，15 分钟有效。命令幂等，发布后保留原版本和回执。
- 持久化事件、轮询与 SSE，支持 `Last-Event-ID` 补发；事件流每批重新校验会话。
- 稳定解析记录 ID、字段修正与理由，保留原件、原值和来源；修正增加事项版本，重新核验后生成新草稿。
- 按区块比较文档版本、提交修订提案、人工接受／拒绝、重复接受幂等与过期基准检查。
- 组织内 Skill 草稿和新版本、离线契约试跑、发布、停用、显式选择历史发布版本。
- 内置 report-agent@1，读取授权快照、制度与核验结果，调用可配置模型并生成待审提案；不直接修改正文或发布。
- 编号数据库迁移及启动互斥，旧版账号、附件、文档和回执保留。
- 团队草稿／发布／停用及版本固定，制度和材料并行、核验汇合、报告产出；保留明确的六层模板路由记录。
- TEAM 的暂停、分支控制、控制幂等、执行代次、稳定检查点和续办；恢复时复用有效已完成节点。
- 生效材料选择、微调／历史分支两阶段确认、唯一执行头、旧分支提案隔离、判定依赖与局部复验；模型预算在同根分支间累计。

默认运行标记 `mode=RULES`，模板草稿注明没有调用模型；显式 MODEL 模式记录实际模式、Agent／Skill 版本、尝试耗时及上游 Token 用量。未知用量和费用保持 null。存在待审提案时不能确认或发布。审核人必须提交说明并明确确认已审阅。

## 模型配置与升级

复制 `.env.example` 为 `.env`，填写 `MODEL_BASE_URL`、`MODEL_NAME`、`MODEL_API_KEY`。base URL 填写到 `/chat/completions` 之前。`MODEL_TIMEOUT_MS` 默认 30000。需要兼容非流式聊天协议并按提示返回 JSON 的模型；密钥只通过本地配置提供，不返回给客户端。

输入上限 32,000 字符，HTTP 响应正文上限 128 KB，输出 Token 请求上限为 2000。网络错误、429 和 5xx 最多重试一次；超时、无效 JSON 和不合格内容明确失败。模型未配置时拒绝 MODEL，RULES 保持可用；模型失败不伪装成规则成功。

模型等待期间续租，并检查取消、权限、输入版本和技能状态。取消会终止本地请求并阻止结果提交，不能保证上游已执行请求被撤回或免计费。进程崩溃后重算可能再次调用上游，已记录尝试仍可查询。

从 v0.1／v0.2／v0.3 升级时，先停止旧 API 和全部旧 Worker，并备份数据库与附件，再安装、编译并用原 DATA_DIR 启动 v0.4。不能混用不同版本的 Worker。启动自动应用迁移，不清空业务表，不改写旧运行的输入和检查点。旧 TEAM 回填谱系及已用预算，缺少依赖元数据时保守完整复验。SQLite 使用事务和进程内串行队列，MySQL 使用按库命名锁，DDL 可重入执行。

冒烟脚本的单 Agent、团队续办和微调分支模式均使用隔离临时数据、随机端口及本地模型桩。协议桩测试不代表真实模型的语义效果。

## 首次联调顺序

1. `POST /api/auth/register`，取得 token；后续携带 `Authorization: Bearer <token>`。
2. `POST /api/organizations`，当前用户成为组织管理员。
3. 可选：`POST /api/organizations/{id}/rules` 登记适用制度。
4. `POST /api/cases` 创建事项，记录 `revision`。
5. `POST /api/cases/{id}/attachments` 上传业务材料，使用返回的 `caseRevision`。
6. `POST /api/agent/requests` 发起规则运行，轮询 `/api/runs/{runId}` 或订阅事件。
7. 运行到 `WAITING_FOR_REVIEW` 后，读取返回的 `documentId`，检查证据并修改草稿。
8. 重新读取事项取得最新 `revision`，请求 `/api/cases/{id}/confirmations`。
9. 用确认 ID 和唯一 `commandId` 请求 `/api/commands`，得到发布回执。
10. `/api/documents/{id}/export?version=1` 下载指定版本；业务回执中的 `documentVersion` 为正式发布版本。

完整参数、权限和错误说明见 [API.md](docs/API.md)。可上传的样例在 [examples](examples/weekly-report.csv)。

## MySQL 和独立 Worker

设置 `DATABASE_URL=mysql://用户名:密码@地址:端口/数据库` 后启用 MySQL；目标数据库需预先建立并使用 `utf8mb4`。启动应用编号迁移至版本 4，不会自动搬迁 SQLite 数据。不要连接现有业务数据库。

提供了本地开发用 `compose.yml`：

```powershell
docker compose up -d mysql
$env:DATABASE_URL='mysql://secondink:secondink_dev@127.0.0.1:3307/second_ink'
npm start
```

Compose 默认密码仅用于本地开发。服务端 SQL 已提供两种方言适配；本次本机验证使用 SQLite，**MySQL 尚未完成实际连接验证**。

本地默认内嵌 Worker。独立运行时先编译，然后在两个终端使用相同数据库和绝对 `DATA_DIR`：

```powershell
$env:EMBEDDED_WORKER='false'
npm start
```

```powershell
npm run worker
```

Worker 租约为 60 秒。旧 RULES／MODEL 模式仍从固定流程起点重算；TEAM 已完成节点保留，在途节点按新代次接管，暂停后可从最新稳定检查点续办。业务输入改变通过预览建立新分支，模型调用预算跨恢复及同根分支累计，正式发布始终独立由人工命令执行。

如需对 MySQL 执行测试，可将 `TEST_DATABASE_URL` 指向专用空测试数据库后运行 `npm test`。测试会写入测试用户和事项，不清空该数据库，不得指向正式数据库。

## 当前边界与下一步

- 已提供可配置单 Agent、固定四角色团队及最小 Skill 生命周期；真实模型效果待配置后验证。六层记录目前针对显式模板，尚无自然语言自动路由、自由规划、ZIP 技能包和 Harness。
- TEAM 支持团队／依赖节点暂停、最新检查点续办、输入改变后的微调及历史分支；旧单 Agent 模式只支持取消。业务动作补偿尚未实现。
- 尚未实现 OCR、PDF 解析、DOCX 导出和表格正文编辑。修订仅替换现有标题／段落区块；DOCX 导入提取纯文本，原件保留。草稿超过 100 个区块或单段 12,000 字符时明确标注截断，完整核验数据仍可查询。
- 企业材料清单采用名称／文本包含匹配，只能作初筛，不能证明材料真实性。当前请求按事项及组织授权，尚未实现字段级授权。
- 制度正文只用于检索与展示，首版规则执行 `requiredFields`，不把自由文本自动转成校验逻辑；制度更新通过新增条目完成，替代关系尚未实现。
- 事项、制度和事件查询仍有数量上限，尚无分页管理。材料替换通过补交原件与生效选择完成，不物理删除，累计附件数上限保持 20。
- 附件使用本地目录，尚未接对象存储。生产环境还需完成备份恢复、HTTPS 反代、MySQL 集成验证和容量测试。

后续优先：连接配置就绪后进行真实模型与 MySQL 验证 → Harness 与扩展技能接入 → 正式文档导出及部署容量验证。自然语言动态规划仍需独立设计与验收。
