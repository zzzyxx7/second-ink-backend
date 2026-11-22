# v0.4 微调、历史分支与局部复验

本阶段只建设后端。在 v0.3 的 TEAM 调度上新增材料选择、预览后确认的微调／历史分支、节点复用、判定级局部复验及跨分支预算。原 RULES、MODEL、登录、保存文档和确认发布接口保持兼容。前端无需参与即可通过 API 和冒烟脚本验证。

## 生效材料

`POST /api/cases/{id}/material-selection`，ADMIN／HANDLER：

```json
{
  "expectedRevision": 4,
  "activeAttachmentIds": ["当前事项的 MATERIAL 附件 UUID"],
  "reason": "使用补交材料替代旧材料"
}
```

返回 `caseRevision` 和 `activeAttachmentIds`。列表是完整替换，只允许当前事项的业务材料，不允许重复。未创建选择时默认所有材料生效；空列表允许暂存，但没有生效 MATERIAL 时不能发起新运行或分支。REFERENCE 始终作为参考附件保留。

材料替换流程为上传新原件，再选择生效材料。选择后追加上传的 MATERIAL 自动加入生效集合。原文件、解析和人工修正历史均保留；下载接口继续可用。每次 5 件、每件 5 MB、每事项累计 20 件的原限制保持不变，停用材料仍占累计附件数量。填报人可补交文件，选择材料由经办人或管理员完成。

事项详情 `attachments[].active` 与解析查询 `attachments[].active` 标记生效状态。`/records` 仍提供历史材料及修正；新核验和模型证据只使用生效集合。选择修改事项版本，使旧确认失效；旧草稿需重新核验。

## 先预览，再确认分支

`POST /api/runs/{id}/amendments`，ADMIN／HANDLER，返回 HTTP 201：

```json
{
  "kind": "AMEND",
  "expectedRevision": 5,
  "checkpointId": "可选：当前最新稳定检查点 UUID",
  "report": null
}
```

- `AMEND`：来源必须是当前 PAUSED 的 TEAM，只能使用其最新稳定检查点；省略 checkpointId 时自动选择最新。
- `HISTORY`：必须显式指定来源 TEAM 的稳定 checkpointId，可选择较早检查点。当前事项的活动运行必须已经 PAUSED，或没有活动运行。
- 所有事实修改先通过事项更新、上传、字段修正或材料选择 API 完成，再预览。本接口不执行自然语言改数据。
- `teamId`、`teamVersion` 可一起提供，选择同组织、同场景的已发布版本。省略时固定使用来源版本。
- `report` 省略时继承来源完整报告参数；`null` 显式选择规则草稿；对象则完整替换报告设置，包含 documentId、expectedDocumentVersion、blockIds、goal、skillId、skillVersion。文档基准必须仍是当前版本，Skill 必须已发布且未停用。配置模型前可用 `report:null` 完成全部规则流程。

预览不创建文档、提案或发布回执。返回 previewId、previewDigest、expiresAt、当前／下一事项版本、拟定 planVersion、各节点 REUSE／RECOMPUTE 及理由、预计核验统计和根预算余额。预览有效 **5 分钟**；保存当前事项、执行头、控制代次、检查点、证据、团队、Skill、报告、模型配置摘要和预算状态。提交时重新检查，发生变化返回 409，需重新预览。

`POST /api/runs/{id}/branches`，返回 HTTP 202：

```json
{
  "previewId": "预览 UUID",
  "previewDigest": "预览返回的 64 位摘要",
  "commandId": "本次确认命令的唯一 UUID"
}
```

确认者须为预览创建者，并仍有编辑权限。相同 commandId 与相同请求重复提交返回原回执；标识用于不同请求时返回 COMMAND_CONFLICT。同一预览并发使用不同 commandId，只有一个提交成功。确认在事务中完成：

1. 创建独立 child runId、branchId，保留 parentRunId、rootRunId、sourceCheckpointId、递增 planVersion。
2. 旧执行头标记 SUPERSEDED，取消未完成节点、增加 epoch／generation 并清除租约。其 PENDING 模型提案标记 SUPERSEDED，不能接受或拒绝。已接受的版本及原业务回执保留。
3. 增加事项版本，旧发布确认失效，切换唯一执行头。
4. 复制有效只读节点结果及来源摘要；REPORT 始终重新执行，生成新文档草稿或新待审提案。人工接受、确认和正式发布均须重新操作。

旧分支可查询，不能恢复执行或向正文提交迟到结果。旧分支草稿也不能重新确认发布。已发布事项不能创建预览或分支；已完成分支命令的幂等重放仍返回原回执，且不重复执行任何业务动作。

## 查询谱系与复用

`GET /api/runs/{id}/branches` 返回同根分支列表，按 planVersion 排序。事项详情增加 currentRunId（TEAM 执行头）。TEAM 运行查询增加：

| 字段 | 含义 |
| --- | --- |
| lineage | branchId、rootRunId、parentRunId、sourceCheckpointId、planVersion、supersededRunId、isCurrent、currentRunId |
| reuse.nodes | 复用节点、来源运行／检查点、原输出摘要 |
| reuse.verification | FULL／INCREMENTAL／REUSED_NODE 及复用／执行判定数 |
| team.nodes[].reusedFrom | 只读结果来源；未复用时为 null |
| team.modelCalls | 当前分支已预留的模型 HTTP 尝试数 |
| team.rootModelCalls | 同根所有分支累计预留的模型 HTTP 尝试数 |
| team.budget | scope=ROOT_RUN，生效调用上限、失败重试上限、并发度 |

复用节点 `attempt=0`，表示该分支没有重新执行；REPORT 的新执行单独计数。事件中的 runId 同时带 branchId、rootRunId、planVersion。检查点保存 cacheVersion、当时谱系及只读节点输入指纹；历史快照中的 isCurrent 表示创建时状态，当前状态以运行查询为准。

## 两层复验

节点复用依据冻结团队／Agent 版本、角色、业务输入、材料及来源、人工修正和制度摘要，依赖节点也必须可复用。团队版本改变时保守重算全部节点。REPORT 从不复用，不重放人工审阅或正式发布。

VERIFY 保存稳定判定 key、checks@1 引擎版本、依赖 ref／digest、issue 输出摘要。重新核验时按依赖匹配复用判定；其余判定重新计算，结果重新汇总。依赖包括：

- 字段值、原始来源、人工修正，以及影响问题文案的记录顺序。
- 同一活动的候选成员和各字段候选值；单成员时也保存“无冲突”的判定，新增来源可使其失效。
- 材料集合、未出现的字段候选、材料名称／文本，以及“材料尚缺失”的判定。
- 适用制度集合、版本、必填要求和业务日期。

`verification` 返回 mode、reused、executed、total、removed、fallbackReason。整体只读节点复用时 mode=REUSED_NODE；节点重跑但部分判定复用时 mode=INCREMENTAL。元数据缺失或损坏时保守完整复验；缓存超过 5,000 个判定或 1 MB 时不保留判定缓存，标记 DECISION_CACHE_LIMIT。核验问题本身仍完整计算。独立 `verifyFull` 遍历用于回归对照，不调用增量实现。

## 模型预算

一个根 TEAM 及其全部子孙共享模型 HTTP 尝试预算。429／网络错误等重试也占预算；在途取消、进程中断后预算不退还，因为上游可能已计费。子分支使用 `min(根上限, 所选团队上限)`，切换到更大预算团队也不能放大根上限。历史检查点和新 branchId 不重置累计调用数。预览模型分支时余额不足即拒绝；规则分支仍可继续。没有真实价格或用量时不估算成本。

## 升级、验证与边界

升级前停止旧 API／Worker，备份 SQLite 数据库及附件（MySQL 使用数据库备份），使用同一 DATA_DIR 启动 v0.4。迁移 4 自动添加选择、谱系、执行头、根预算、预览、回执和复用表。SQLite 事务互斥、MySQL 库级命名锁保持生效。

v0.3 TEAM 回填为独立根运行，已记录的 model_calls 计入预算。原 input_json、检查点 JSON／摘要、账号、附件、文档和发布回执不改写。旧检查点没有可靠依赖指纹时，创建子分支完整复验，并保留旧检查点供查阅。

验证命令：`npm test`、`npm run smoke:branch`、`npm run smoke:branch:worker`。冒烟使用随机端口和临时 SQLite，验证材料补交选择、微调预览、分支切换、局部复验、模型协议桩、人工接受及幂等发布；测试另覆盖历史分支、旧数据升级、并发、过期预览、迟到结果、团队版本和共享预算。

真实模型语义效果与真实 MySQL 迁移／事务／并发尚未验证，等待本地配置；本地模型桩只验证协议和控制逻辑。Harness、自然语言动态规划、ZIP Skill 包、OCR／PDF 解析、正式 DOCX 导出及业务动作补偿仍属后续阶段。
