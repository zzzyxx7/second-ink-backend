# v0.2 字段修正与单 Agent 接口

所有接口沿用 [API.md](API.md) 的鉴权、角色和响应封装。完整请求与响应结构以 [openapi.json](openapi.json) 为准。默认 RULES 请求兼容 v0.1。

## 字段修正

`GET /api/cases/{id}/records` 返回按附件分组的解析记录，每条包含稳定 id、生效 fields、原始 sources 和 corrections。ID 由附件 ID 和固定解析序号派生；旧数据读取时补齐，不修改原文件。

`POST /api/cases/{id}/field-corrections`：

```json
{
  "expectedRevision": 3,
  "attachmentId": "附件 UUID",
  "recordId": "记录查询接口返回的 id",
  "field": "location",
  "value": "B205",
  "reason": "核对通知后更正活动场地"
}
```

ADMIN／HANDLER 可提交。field 使用 activityName／activityDate／location／participants／summary 等规范字段，可为缺失字段补值。仅允许 MATERIAL 记录。每次追加历史，最新修正生效；返回 correctionId、originalValue、value 和新 caseRevision。原值始终是材料原值，sources 不被覆盖。

修正后重新运行 RULES；旧草稿确认返回 EVIDENCE_STALE。v0.2 完整重跑；v0.4 的 TEAM 分支支持判定级局部复验，见 [API-V4.md](API-V4.md)。

## 文档修订

`GET /api/documents/{id}/diff?fromVersion=1&toVersion=2` 返回按稳定区块 ID 比较的 ADDED／DELETED／MODIFIED，以及 before／after 区块。尚无字符级差异和移动识别。

`POST /api/documents/{id}/patches`：

```json
{
  "baseVersion": 1,
  "replacements": [{ "blockId": "现有区块 UUID", "text": "建议的新内容" }],
  "reason": "修改理由",
  "evidenceRefs": ["attachment:附件UUID"]
}
```

只替换现有 heading／paragraph 区块，不直接创建正文新版本。返回 PENDING 提案，事项版本增加。有效引用格式：`attachment:{id}`、`record:{recordId}`、`rule:{id}@{version}`、`correction:{id}`；必须属于同一事项或当前适用制度。人工提案可不带引用；模型提案必须至少引用一项。

- `GET /api/documents/{id}/patches` 查询全部提案。
- `POST /api/patches/{id}/accept` 请求 `{ "expectedVersion": 1 }`，接受并创建新版本。
- `POST /api/patches/{id}/reject` 请求同上，拒绝提案；过期提案可按当前版本拒绝。

处理角色为 ADMIN／HANDLER。重复同方向决定返回原结果，反向决定返回 PATCH_DECIDED。接受时基准过期返回 VERSION_CONFLICT。同一文档有 PENDING 提案时，确认或发布返回 PATCH_REVIEW_REQUIRED。

## Skill

`GET /api/skill-templates` 返回两个样例；examples 目录也提供周报和入职 JSON。

```json
{
  "name": "周报补正草稿",
  "scenario": "WEEKLY_REPORT",
  "description": "起草周报补正建议",
  "instructions": "只依据证据提出修订，不编造数据。",
  "toolBindings": ["get_case_snapshot", "find_applicable_rules", "get_verification_result", "propose_document_patch"]
}
```

当前固定报告流程需要上述四个白名单工具全部绑定，执行顺序由服务端控制；技能正文不能增加工具或权限。

| 方法 | 路径 | 内容 |
| --- | --- | --- |
| POST | `/api/organizations/{id}/skills` | 管理员创建版本 1，状态 DRAFT |
| GET | `/api/organizations/{id}/skills` | 列出组织技能和版本 |
| POST | `/api/skills/{id}/versions` | 同结构省略 name，编辑为新版本 |
| GET | `/api/skills/{id}/versions/{version}` | 查询内容、摘要和状态 |
| POST | `/api/skills/{id}/versions/{version}/trials` | `{caseId}`，管理员／经办人进行同组织同场景离线试跑 |
| POST | `/api/skills/{id}/versions/{version}/publish` | `{}`，管理员发布已通过试跑的版本 |
| POST | `/api/skills/{id}/versions/{version}/disable` | `{}`，管理员停用版本 |

试跑返回 kind=OFFLINE_CONTRACT、passed、actualTools、modelCalled=false 和具体异常；检查工具与产物契约，不调用模型。新版本必须重新试跑。历史回退通过在新 MODEL 请求中明确选择旧的已发布版本实现；停用旧版本后可由管理员重新发布。没有隐式“最新版”别名。

## MODEL 请求

先完成 RULES 核验并取得文档，再提交至 `POST /api/agent/requests`：

```json
{
  "caseId": "事项 UUID",
  "expectedRevision": 4,
  "mode": "MODEL",
  "documentId": "文档 UUID",
  "expectedDocumentVersion": 1,
  "blockIds": ["待改写区块 UUID"],
  "goal": "保留已核实事实，精简这段补正说明",
  "skillId": "技能 UUID",
  "skillVersion": 1
}
```

默认 RULES 只需 caseId、expectedRevision；MODEL 的额外参数全部必填。返回 HTTP 202。未配置模型返回 MODEL_NOT_CONFIGURED，未发布／停用技能返回 SKILL_DISABLED。

运行固定绑定 report-agent@1、Skill 摘要、业务快照、目标文档和区块。MODEL 会将必要业务字段、核验结果和 Skill 正文发送给配置的模型服务，不把 API 密钥、系统环境或未授权对象内容放入模型上下文。

`GET /api/runs/{id}` 返回实际 mode、definition、usage.attempts 和 cost=null。上游未提供 Token 用量时为 null，不估算。成功进入 WAITING_FOR_REVIEW，output 返回 patchId、documentId、baseVersion 和 actualTools；原正文版本不变。

模型输出必须为 JSON：

```json
{
  "replacements": [{ "blockId": "请求允许的区块 UUID", "text": "替换内容" }],
  "reason": "根据证据提出的修改理由",
  "evidenceRefs": ["attachment:合法附件UUID"]
}
```

系统检查结构、目标与引用存在性，事实正确性仍需人工审阅。技能停用、事项或文档变化、取消及租约丢失均阻止提交提案。模型错误明确进入 FAILED，原正文保留。

人工接受后，读取最新事项 revision，使用原确认／发布接口。发布仅在平台内归档，不向外部系统派单或发邮件。

## 事件与错误补充

新增事件 field.corrected、patch.created、patch.accepted、patch.rejected。原 run.step／run.review_required 继续使用，MODEL 最后步骤为 MODEL_PATCH。Skill 管理记录保存在版本和试跑表，不通过事项 SSE 广播。

新增错误包括 INVALID_BLOCK、INVALID_EVIDENCE、PATCH_REVIEW_REQUIRED、PATCH_DECIDED、SKILL_TRIAL_REQUIRED、SKILL_DISABLED、SCENARIO_MISMATCH、MODEL_NOT_CONFIGURED。运行失败信息还可能包含 MODEL_INPUT_LIMIT、MODEL_OUTPUT_LIMIT、MODEL_OUTPUT_INVALID、MODEL_TIMEOUT 或上游 HTTP 状态说明。
