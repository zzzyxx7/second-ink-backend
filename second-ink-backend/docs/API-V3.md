# v0.3 固定团队与检查点接口

本文保留 v0.3 版本说明；v0.4 已加入输入微调与历史分支，相关行为与共享预算以 [API-V4.md](API-V4.md) 为准。

v0.3 在 v0.2 基础上增加固定四角色团队、DAG 调度、团队／依赖分支暂停、最新稳定检查点续办和受限失败重试。原 RULES、MODEL、字段修正与文档发布接口保持兼容。所有团队业务接口要求登录。

## 团队定义与版本

`GET /api/team-templates` 返回周报和入职样例。创建请求提交到 `POST /api/organizations/{id}/teams`：

```json
{
  "name": "周报协作团队",
  "scenario": "WEEKLY_REPORT",
  "concurrency": 2,
  "maxAttempts": 2,
  "maxModelCalls": 4,
  "nodes": [
    { "id": "policy", "role": "POLICY", "dependsOn": [] },
    { "id": "materials", "role": "MATERIALS", "dependsOn": [] },
    { "id": "verify", "role": "VERIFY", "dependsOn": ["policy", "materials"] },
    { "id": "report", "role": "REPORT", "dependsOn": ["verify"] }
  ]
}
```

创建者须为组织 ADMIN。返回 teamId、version=1、DRAFT、定义及摘要。节点默认 required=true、timeoutMs=30000，Agent 版本由角色补齐并固定在版本清单中。四角色必须各出现一次，最多两个独立节点并行，拒绝循环、未知依赖、角色版本不匹配和额外工具定义。

POLICY 读取适用制度，MATERIALS 读取材料及人工修正，VERIFY 汇合两者执行规则核验，REPORT 生成草稿或请求模型提交修订。协调器为 coordinator@1。制度角色可配置 required=false，其他角色为必需节点。角色可以使用确定性工具，不代表每个角色都调用大模型。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/organizations/{id}/teams` | 组织团队及版本列表 |
| POST | `/api/teams/{id}/versions` | 提交同结构但省略 name，形成新草稿版本 |
| GET | `/api/teams/{id}/versions/{version}` | 读取固定版本 |
| POST | `/api/teams/{id}/versions/{version}/publish` | ADMIN 提交 `{}` 发布通过结构与 DAG 校验的定义 |
| POST | `/api/teams/{id}/versions/{version}/disable` | ADMIN 提交 `{}` 停用版本 |

发布版本的内容不覆盖，修改创建新版本；新版本不会自动替换在途运行。停用阻止新加载与续办，活动节点会在检查或提交时停止。

## TEAM 运行

`POST /api/agent/requests`：

```json
{
  "caseId": "事项 UUID",
  "expectedRevision": 2,
  "mode": "TEAM",
  "teamId": "团队 UUID",
  "teamVersion": 1
}
```

ADMIN／HANDLER 可以发起同组织同场景的已发布团队，至少需要一份 MATERIAL。返回 HTTP 202。默认使用规则工具完成四角色流程，最后产生独立文档草稿，仍需人工确认发布。

如需模型报告，添加 `report`，字段为 v0.2 MODEL 参数中的 documentId、expectedDocumentVersion、blockIds、goal、skillId、skillVersion。前三个节点仍使用规则工具，最后报告节点调用模型并生成待审提案。目标文档和 Skill 必须属于当前事项／组织。未配置模型时明确拒绝带 report 的请求，纯规则 TEAM 可离线使用。

运行固定保存业务快照、材料与修正、规则、团队、Agent、Skill 和文档基准版本。路由记录包含 L0–L5 六层的身份范围、明确事项、固定意图、版本绑定、资源预算和人工确认要求；这是显式模板路由，尚非自然语言自动分类或任意动态任务规划。

## 查询进度

`GET /api/runs/{id}` 增加 mode=TEAM 和 team 对象：

- teamId、teamVersion、teamDigest、coordinatorVersion。
- controlRevision、controlEpoch、pausedNodes、modelCalls、budget。
- route：显式模板的分层判断与版本清单。
- nodes：角色、Agent 版本、依赖、状态、尝试次数、generation、结构化 output、错误和时间。

顶层 steps 同步投影真实节点状态；无需从输出字数推断进度。状态增加 PAUSE_REQUESTED 和 PAUSED。WAITING_FOR_REVIEW 仍表示等待人工处理。

必需节点失败阻塞下游，保留已完成产物。可选节点失败为 SKIPPED，保留异常，核验保留缺少适用制度的提示。maxAttempts 限制每节点失败尝试次数；正常暂停或进程中断计为 INTERRUPTED，不消耗失败次数，但已经预约或发送的模型请求仍占用 maxModelCalls。

maxModelCalls 为整个运行的持久化模型请求预算，含失败、重试和中断请求，不在续办时重置。调用前预约预算，达到上限明确失败，未知 Token 和费用保持 null。未支持在原运行内追加预算，需新建更大预算的团队版本和运行。

## 暂停、恢复、重试和取消

`POST /api/runs/{id}/control`：

```json
{
  "action": "pause",
  "scope": "team",
  "controlId": "客户端生成 UUID",
  "expectedControlRevision": 1
}
```

- action 为 pause／resume／retry／cancel。
- scope 为 team（默认）或 branch。branch 需要 nodeId，包含该节点及其全部下游。
- retry 需要 nodeId，针对失败节点；只允许在失败次数上限内重试。
- resume 可指定 checkpointId，但本阶段只允许最新稳定检查点。
- cancel 仅作用于整个团队；兼容旧请求 `{ "action": "cancel" }`。

返回 receiptId、controlRevision、controlEpoch、state 和 affectedNodes。相同用户对同一 controlId 重试返回原回执；改变内容或跨运行复用标识返回 CONTROL_CONFLICT。旧 expectedControlRevision 返回 CONTROL_VERSION_CONFLICT。自动节点推进不增加用户控制版本。

排队且无活动节点的团队可立即 PAUSED；运行中的团队先 PAUSE_REQUESTED，停止派发新节点并中止在途只读请求，收尾完成后推送 run.paused。分支暂停时独立节点可以继续；没有可执行节点后运行进入 PAUSED。回执代表受理时状态，客户端须查询当前运行或订阅事件核实。

暂停／取消变更执行代次及目标节点 generation，提交时再次校验，旧 Worker 和迟到模型响应不能写入新结果。模型接口终止本地请求不保证上游已经执行的推理撤销或免计费。同步规则计算会在可中断边界收尾；独立 Worker 可避免其占用 API 进程。

## 检查点与重启

`GET /api/runs/{id}/checkpoints` 按 eventSeq 倒序返回稳定检查点，包含输入摘要、证据摘要、冻结输入的事项版本、团队摘要、已完成／跳过节点产物及摘要、目标文档版本、控制代次和事件序号。检查点在创建、节点批次收尾、暂停与结束时保存，临时模型内容不作为稳定产物。

resume 保留已完成节点，仅重新调度未完成部分，并复核权限、定义状态、材料、规则、修正、文档基准和产物摘要。业务输入改变返回 RESUME_INPUT_CHANGED，检查点摘要或产物损坏返回 CHECKPOINT_CORRUPT，选择旧检查点返回 CHECKPOINT_CONFLICT。需改变输入时，先取消旧运行再按新事项版本新建计划；断点微调与历史分支留到后续。

Worker 异常退出后，租约过期可由新 Worker 接管。已完成节点输出不清空，在途尝试记为 INTERRUPTED，旧拥有者不能提交。API 与 Worker 同时启动使用编号迁移互斥，不重建旧业务表。多个 Worker 对同一运行使用事务领取，最终文档或修订与报告节点成功状态在同一事务提交，避免重复产物。

## 事件与边界

新增 run.checkpoint、run.control_received、run.paused、team.node_started、team.node_completed、team.node_failed，继续使用原 run.started／run.review_required／run.failed 和 SSE 序号补发。客户端以 seq 去重，并重新读取运行快照。

已提交的人工发布命令与业务回执保持独立。暂停、恢复和文档内容恢复不会撤回或重放正式业务动作。当前只支持固定一层角色、四节点 DAG 和最新检查点续办；多层递归、任意工具插件、断点微调和历史分支尚未实现。
