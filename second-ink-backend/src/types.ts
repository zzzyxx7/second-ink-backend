import { z } from 'zod';

export const scenarioSchema = z.enum(['WEEKLY_REPORT', 'ONBOARDING']);
export type Scenario = z.infer<typeof scenarioSchema>;
export const roleSchema = z.enum(['ADMIN', 'HANDLER', 'REVIEWER', 'SUBMITTER']);
export type Role = z.infer<typeof roleSchema>;
export const uuid = z.uuid();
export const revision = z.number().int().min(1);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}, '请输入有效日期 YYYY-MM-DD');
export const dataSchema = z.record(z.string().min(1).max(80), z.union([
  z.string().max(4000), z.number().finite(), z.boolean(), z.array(z.string().max(120)).max(50)
])).refine(value => Object.keys(value).length <= 50, '业务字段最多 50 个');
export const blocksSchema = z.array(z.object({
  id: uuid,
  type: z.enum(['heading', 'paragraph']),
  text: z.string().max(12000)
}).strict()).min(1).max(100).refine(blocks => new Set(blocks.map(x => x.id)).size === blocks.length, '区块 ID 不可重复');
export type Block = z.infer<typeof blocksSchema>[number];
export interface Source { attachmentId: string; filename: string; locator: Record<string, string | number>; quote: string }
export interface ParsedRecord { id?: string; fields: Record<string, string>; sources: Record<string, Source>; corrections?: Record<string, {id:string;originalValue:string|null;value:string;reason:string;actorId:string;createdAt:string}> }
export interface ParsedFile { text: string; records: ParsedRecord[]; warnings: string[] }
export interface CheckResult {
  decisions?: import('./incremental.js').Decision[];
  verification?: import('./incremental.js').VerificationStats;
  mode: 'RULES'; ruleRefs: { id: string; version: number; title: string }[];
  issues: { code: string; field: string; message: string; severity: 'ERROR' | 'WARNING'; sources: Source[] }[];
  records: ParsedRecord[]; summary: string;
}
export const ruleSchema = z.object({
  scenario: scenarioSchema, title: z.string().min(1).max(200),
  effectiveFrom: dateSchema, effectiveTo: dateSchema.optional(),
  requiredFields: z.array(z.string().min(1).max(80).refine(value=>!['__proto__','constructor','prototype'].includes(value.trim()),'不可使用保留字段名')).min(1).max(30),
  requirements: z.string().max(12000).default('')
}).strict().refine(x => !x.effectiveTo || x.effectiveTo >= x.effectiveFrom, '制度失效日不能早于生效日');
