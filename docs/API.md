# Second Ink 基础接口

本文描述兼容 v0.1 的基础接口。v0.2 的字段修正、文档提案、Skill 和 MODEL 模式见 [API-V2.md](API-V2.md)，完整机器可读契约见 [openapi.json](openapi.json)。

v0.3 的 TEAM 请求、暂停与检查点见 [API-V3.md](API-V3.md)。原单模式接口继续兼容。

v0.4 的材料选择、微调预览、历史分支、局部复验和跨分支预算见 [API-V4.md](API-V4.md)。当前完整规范由 [openapi.json](openapi.json) 提供。

基础地址 `http://127.0.0.1:3080`。成功响应 `{ "code": 0, "message": "success", "data": ... }`；失败使用对应 HTTP 状态和 `{ "code": "错误标识", "message": "说明", "requestId": "..." }`。ID 使用 UUID，日期使用 `YYYY-MM-DD`，时间使用 UTC ISO 字符串。

除健康检查、注册和登录，接口均要求 Bearer token 或会话 Cookie。跨域前端配置唯一 `FRONTEND_ORIGIN`，Cookie 请求需携带凭据；跨站来源会被拒绝。

## 权限

| 角色 | 权限 |
| --- | --- |
| ADMIN | 组织全部业务、成员添加、制度登记、审核发布 |
| HANDLER | 组织事项创建与修改、材料、运行、文档；不能确认发布 |
| REVIEWER | 组织数据读取、确认与发布；不能改业务数据、运行或正文 |
| SUBMITTER | 读取分配给自己的事项并补交附件；不能发起运行或发布 |

首版尚无成员移除、修改角色、账号找回和字段级权限接口。跨组织资源统一返回 404。

## 账号和组织

| 方法 | 路径 | 请求 |
| --- | --- | --- |
| GET | `/api/health` | 无需登录；返回已实现与待实现能力 |
| POST | `/api/auth/register` | `{username,password}`，用户名 3–32 位字母／数字／下划线，密码 10–128 字符 |
| POST | `/api/auth/login` | 同上，返回 `{user,token,expiresAt}` 并设置 Cookie |
| GET | `/api/auth/profile` | 当前用户和组织列表 |
| POST | `/api/auth/logout` | 撤销当前会话 |
| GET | `/api/organizations` | 当前用户的组织 |
| POST | `/api/organizations` | `{name}`，创建者成为 ADMIN |
| POST | `/api/organizations/{id}/members` | `{username,role}`，目标用户须已注册 |

## 事项和材料

创建事项 `POST /api/cases`：

```json
{
  "orgId": "组织 UUID",
  "title": "社团第十二周周报",
  "scenario": "WEEKLY_REPORT",
  "businessDate": "2026-11-18",
  "data": {}
}
```

`scenario` 为 `WEEKLY_REPORT` 或 `ONBOARDING`；可选 `submitterId` 指向组织内的 SUBMITTER。`data` 最多 50 个业务字段，值为字符串、有限数值、布尔值或字符串数组。

企业入职的 `data` 示例：

```json
{
  "employeeName": "张三",
  "position": "后端开发",
  "startDate": "2026-12-01",
  "requiredMaterials": ["身份证明", "学历证明"]
}
```

| 方法 | 路径 | 请求或返回 |
| --- | --- | --- |
| GET | `/api/cases?orgId=...` | 最近 100 个可访问事项 |
| GET | `/api/cases/{id}` | 事项、revision、附件及解析结果、文档和最近运行 |
| PATCH | `/api/cases/{id}` | `{expectedRevision,title?,businessDate?,data?}`，data 按整体替换 |
| POST | `/api/cases/{id}/attachments` | multipart：`expectedRevision`、`purpose`（MATERIAL 或 REFERENCE，默认 MATERIAL）、重复 `files` |
| GET | `/api/attachments/{id}/download` | 经过鉴权的原始文件 |

上传成功返回 `{attachments,caseRevision}`。每个附件包括 `parsed.text`、`parsed.records`、`parsed.warnings`。记录保存 `fields` 和对应 `sources`；XLSX 的 `locator` 包含 sheet、row、column 和 cell，文本为 line。

XLSX／CSV 首行使用“活动名称、活动日期、活动地点、参与人数、活动总结”。支持对应英文规范字段 `activityName/activityDate/location/participants/summary`。TXT／MD／DOCX 使用一行一个“字段：值”。周报同名同日期活动在不同材料中的值冲突时保留所有证据。首版对 XLSX 公式不取缓存值，要求先粘贴为值。

REFERENCE 附件保留供审阅，不进入材料记录核验，也不会自动成为制度。制度须用下述登记接口添加。

## 制度

`POST /api/organizations/{id}/rules`：

```json
{
  "scenario": "WEEKLY_REPORT",
  "title": "社团周报填报要求",
  "effectiveFrom": "2026-11-01",
  "effectiveTo": "2026-12-31",
  "requiredFields": ["activityName", "activityDate", "location", "participants", "summary"],
  "requirements": "活动地点和实际参与人数必须填写。"
}
```

返回固定条目 ID 和 `version=1`。`effectiveTo` 可省略。

`GET /api/rules?orgId=...&date=2026-11-18&q=周报` 按组织和适用日期过滤，q 为简单关键词包含匹配，最多返回 100 条。

## 运行

`POST /api/agent/requests` 请求：

```json
{ "caseId": "事项 UUID", "expectedRevision": 2 }
```

返回 HTTP 202 和 `{runId,status:"QUEUED",mode:"RULES",steps:[...]}`。默认模式运行固定规则模板，不调用模型；v0.2 可以显式使用 MODEL 模式，详见补充接口文档。存在排队或运行任务时拒绝重复启动。

`GET /api/runs/{id}` 返回 `QUEUED/RUNNING/WAITING_FOR_REVIEW/FAILED/CANCELLED`、三个步骤状态、错误和 output。

output 包含 `ruleRefs`、`records`、`issues`、`summary`、`documentId`、`documentVersion` 和 `caseRevision`。issue 包含 code、field、message、severity 和来源 sources。`WAITING_FOR_REVIEW` 只代表核验和草稿生成结束，事项仍未发布。

`POST /api/runs/{id}/control` 仅接受 `{ "action": "cancel" }`。失败后按最新事项版本重新调用请求接口，生成独立运行。Worker 崩溃后等待租约过期，会从固定流程起点重新计算；无检查点恢复功能。

## 文档

区块格式为 `{ "id": "UUID", "type": "heading 或 paragraph", "text": "正文" }`。区块 ID 不能重复。

| 方法 | 路径 | 请求或返回 |
| --- | --- | --- |
| POST | `/api/cases/{id}/documents` | 手工建文档 `{expectedRevision,title,blocks}` |
| GET | `/api/documents/{id}` | 当前版本、blocks、digest、作者及 sourceRunId |
| GET | `/api/documents/{id}/versions` | 历史版本元信息 |
| GET | `/api/documents/{id}/versions/{version}` | 指定历史版本内容 |
| PUT | `/api/documents/{id}` | `{expectedVersion,blocks}`，成功生成新版本 |
| POST | `/api/documents/{id}/restore` | `{expectedVersion,sourceVersion}`，复制历史内容为新版本 |
| GET | `/api/documents/{id}/export?version=1` | UTF-8 TXT，version 省略时为当前版本 |

保存或恢复返回 `{documentId,version,blocks,digest,caseRevision}`。文档变更也增加事项 revision。恢复不会覆盖历史记录，不会恢复业务动作。发布后的事项首版禁止继续修改，历史文件仍可下载。

## 确认与发布

`POST /api/cases/{id}/confirmations`：

```json
{
  "documentId": "文档 UUID",
  "expectedRevision": 3,
  "note": "已逐项核实，已知问题的处理意见……",
  "acknowledgeIssues": true
}
```

返回 `{confirmationId,expiresAt,documentVersion,caseRevision}`。确认有效期 15 分钟，绑定当前用户、当前事项和文档版本。若生成草稿后材料、业务字段或适用制度已变化，要求重新核验。人工创建的独立文档由审核人自行核对。

`POST /api/commands`：

```json
{
  "commandId": "客户端生成 UUID",
  "caseId": "事项 UUID",
  "confirmationId": "确认 UUID",
  "expectedRevision": 3,
  "action": "publish"
}
```

返回带 documentVersion、digest、publishedAt 和新 caseRevision 的发布回执。相同用户对相同命令重试获得同一回执；同 commandId 对应不同请求返回 409。确认后内容变化、适用制度变化、确认过期均拒绝执行。发布仅产生平台内归档状态，不会向外部平台派单或发邮件。

## 事件

`GET /api/events?caseId=...&after=0` 返回该事项 after 之后的最多 100 条事件，按 seq 升序；数量达到 100 时继续以最后一个 seq 拉取。

`GET /api/events?caseId=...&stream=true&after=0` 建立 SSE；也支持 `Last-Event-ID`，其优先级高于 after。每个事项的 seq 独立，切换事项必须重新建立连接。请求使用 Bearer token，浏览器原生 EventSource 可使用同源 Cookie。

```text
id: 2
event: attachments.added
data: {"seq":2,"type":"attachments.added","caseId":"...","data":{"ids":["..."],"revision":2},"...":"..."}
```

客户端以 seq 去重，并在重连后重新读取事项和运行快照。首版定时从持久化事件表读取并推送；Nginx 反代时关闭事件流缓冲。

## 常用错误

| HTTP | code | 处理 |
| --- | --- | --- |
| 401 | UNAUTHENTICATED | 重新登录 |
| 403 | FORBIDDEN / ORIGIN_FORBIDDEN | 检查角色或请求来源 |
| 404 | NOT_FOUND | 对象不存在或不可访问 |
| 409 | VERSION_CONFLICT | 读取最新事项或文档版本，人工比较后重试 |
| 409 | EVIDENCE_STALE | 材料、字段、标题、日期或适用制度已变，重新核验 |
| 409 | CONFIRMATION_STALE / CONFIRMATION_REQUIRED | 重新确认当前内容 |
| 409 | RUN_ACTIVE / INVALID_STATE | 先查询运行状态 |
| 409 | COMMAND_CONFLICT | 原命令重试保持原请求；新动作生成新 commandId |
| 413 | 上传限制或 BODY_TOO_LARGE | 缩小请求 |
| 415 | UNSUPPORTED_FILE | 使用支持的文件类型 |
| 422 | VALIDATION_ERROR / PARSE_FAILED / ARCHIVE_LIMIT | 按错误说明修正参数或材料 |
| 429 | RATE_LIMIT | 减少请求频率后重试 |
