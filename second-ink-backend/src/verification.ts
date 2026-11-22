import { id } from './auth.js';
import { canonicalField, fieldLabels } from './parser.js';
import type { Block, CheckResult, ParsedFile, ParsedRecord, Scenario } from './types.js';
import type { SkillContent } from './contracts.js';
import type { TeamDefinition } from './team-contracts.js';
import { incrementalVerify,type Decision } from './incremental.js';

export interface RunInput {
  caseId: string; scenario: Scenario; title: string; businessDate: string;
  data: Record<string, any>; revision: number;
  mode?:'RULES'|'MODEL'|'TEAM'; correctionDigest?:string;
  verificationEngineVersion?:string;
  verificationCache?:{sourceRunId:string;checkpointId:string;decisions:Decision[];fallbackReason?:string};
  team?:{teamId:string;version:number;digest:string;definition:TeamDefinition;route:Record<string,unknown>};
  model?:{documentId:string;baseVersion:number;blocks:Block[];goal:string;agentVersion:string;skill:{skillId:string;version:number;digest:string;content:SkillContent}};
  attachments: { id: string; name: string; purpose: string; sha256: string; parsed: ParsedFile }[];
  rules: { id: string; title: string; version: number; content: { requiredFields: string[]; requirements: string } }[];
}
export function verify(input: RunInput): CheckResult {
  return incrementalVerify(input);
}
/** Independent full traversal used as the regression/audit oracle. */
export function verifyFull(input: RunInput): CheckResult {
  const result: CheckResult = { mode: 'RULES', ruleRefs: input.rules.map(({id,version,title}) => ({id,version,title})), issues: [], records: [], summary: '' };
  const issues = result.issues;
  const requiredFields = [...new Set([
    ...(input.scenario === 'WEEKLY_REPORT' ? ['activityName','activityDate','location','participants','summary'] : ['employeeName','position','startDate']),
    ...input.rules.flatMap(rule => rule.content.requiredFields.map(canonicalField))
  ])];
  const files = input.attachments.filter(x => x.purpose === 'MATERIAL');
  const parsed = files.flatMap(x => x.parsed.records);
  if (input.scenario === 'WEEKLY_REPORT') {
    result.records = parsed;
    if (!parsed.length) issues.push({ code: 'NO_RECORDS', field: '', message: '未识别到周报记录，请使用首行为字段名的标准表格或键值文本', severity: 'ERROR', sources: [] });
    parsed.forEach((record, index) => {
      for (const field of requiredFields) {
        if (!Object.hasOwn(record.fields,field)||!record.fields[field]?.trim()) issues.push({ code: 'MISSING_FIELD', field, message: `第 ${index + 1} 条记录缺少${fieldLabels[field] || field}`, severity: 'ERROR', sources: Object.values(record.sources).slice(0,1) });
      }
      const count = record.fields.participants;
      if (count && (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 100000)) issues.push({ code: 'INVALID_PARTICIPANTS', field: 'participants', message: `第 ${index+1} 条记录的参与人数应为 1–100000 的整数`, severity: 'ERROR', sources: record.sources.participants?[record.sources.participants]:[] });
      const date = record.fields.activityDate;
      if (date && !validDate(date)) issues.push({ code: 'INVALID_DATE', field: 'activityDate', message: `第 ${index+1} 条记录的活动日期格式应为 YYYY-MM-DD`, severity: 'ERROR', sources: record.sources.activityDate?[record.sources.activityDate]:[] });
    });
    const groups = new Map<string, ParsedRecord[]>();
    for (const record of parsed) {
      const { activityName, activityDate } = record.fields;
      if (activityName && activityDate) {
        const key = JSON.stringify([activityName,activityDate]);
        groups.set(key, [...(groups.get(key) || []),record]);
      }
    }
    for (const records of groups.values()) {
      if (records.length < 2) continue;
      for (const field of requiredFields) {
        const values = records.filter(r => r.fields[field]);
        if (new Set(values.map(r => r.fields[field])).size > 1) issues.push({ code: 'SOURCE_CONFLICT', field, message: `${records[0]!.fields.activityName}的${fieldLabels[field] || field}存在不同取值，需要人工核实`, severity: 'ERROR', sources: values.flatMap(r => r.sources[field]?[r.sources[field]!]:[]) });
      }
    }
  } else {
    const fields: Record<string,string> = {};
    for (const [key,value] of Object.entries(input.data)) if (typeof value === 'string') fields[key] = value;
    result.records = [{ fields, sources: {} }, ...parsed];
    for (const field of requiredFields) if (!(Object.hasOwn(fields,field)&&fields[field]?.trim()) && !parsed.some(r => Object.hasOwn(r.fields,field)&&r.fields[field]?.trim())) {
      issues.push({ code: 'MISSING_FIELD', field, message: `缺少${fieldLabels[field] || field}`, severity: 'ERROR', sources: [] });
    }
    const requiredMaterials = Array.isArray(input.data.requiredMaterials) ? input.data.requiredMaterials as string[] : ['身份证明','学历证明'];
    for (const label of requiredMaterials) if (!files.some(f => f.name.includes(label) || f.parsed.text.includes(label))) {
      issues.push({ code: 'MISSING_MATERIAL', field: label, message: `尚未提交可识别的${label}材料`, severity: 'ERROR', sources: [] });
    }
    issues.push({ code: 'MANUAL_AUTHENTICITY', field: '', message: '首版只检查材料清单与可读字段，身份真实性及材料有效性需要人工审核', severity: 'WARNING', sources: [] });
  }
  if (!input.rules.length) issues.push({ code: 'NO_APPLICABLE_RULE', field: '', message: '当前业务日期没有已登记的适用制度，使用内置模板检查，请人工核实制度要求', severity: 'WARNING', sources: [] });
  const errors = issues.filter(i => i.severity === 'ERROR').length;
  result.summary = `规则核验完成：${files.length} 份业务材料，${result.records.length} 条记录，${errors} 项待处理问题，${issues.length-errors} 项提示。`;
  return result;
}
function validDate(value: string) {
  const d = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === value;
}
export function draft(input: RunInput, result: CheckResult): Block[] {
  const block = (type: Block['type'], text: string): Block => ({ id: id(), type, text:text.length>12000?text.slice(0,11940)+'…（本段已截断，完整数据请查看核验记录）':text });
  const blocks:Block[]=[
    block('heading', `${input.title} · 核验草稿`),
    block('paragraph', `办理日期：${input.businessDate}；事项版本：${input.revision}。本草稿由固定规则和模板生成，未调用大模型。`),
    block('paragraph', result.summary),
    ...result.records.slice(0,200).map((r,i) => block('paragraph', `记录 ${i+1}：${Object.entries(r.fields).map(([key,value]) => `${fieldLabels[key] || key}：${value}`).join('；')}`)),
    block('heading', '待核实与补正事项'),
    ...result.issues.map(issue => block('paragraph', `[${issue.severity}] ${issue.message}`)),
    block('heading', '制度与材料来源'),
    ...input.rules.map(rule => block('paragraph', `${rule.title}，版本 ${rule.version}，编号 ${rule.id}`)),
    ...input.attachments.map(file => block('paragraph', `${file.name}；SHA-256：${file.sha256}`)),
    ...result.records.flatMap(record=>Object.entries(record.corrections||{}).map(([field,correction])=>block('paragraph',`人工修正：${fieldLabels[field]||field}，原值 ${correction.originalValue??'缺失'}，采用值 ${correction.value}；理由：${correction.reason}；记录 ${correction.id}`))),
    block('paragraph', '请人工核实上述事实及待处理项，修改草稿后再确认发布。')
  ];
  return blocks.length<=100?blocks:[...blocks.slice(0,99),block('paragraph','草稿超过 100 个区块，仅展示部分内容。完整字段、问题和证据请查看核验运行记录。')];
}
