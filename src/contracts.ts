import { z } from 'zod';
import { blocksSchema, dataSchema, dateSchema, revision, roleSchema, scenarioSchema, uuid } from './types.js';
import { teamRequestSchema } from './team-contracts.js';
export const tools=['get_case_snapshot','find_applicable_rules','get_verification_result','propose_document_patch'] as const;
export const credentials=z.object({username:z.string().regex(/^[a-zA-Z0-9_]{3,32}$/).transform(s=>s.toLowerCase()),password:z.string().min(10).max(128)}).strict();
export const createCaseSchema=z.object({orgId:uuid,title:z.string().trim().min(1).max(200),scenario:scenarioSchema,businessDate:dateSchema,data:dataSchema.default({}),submitterId:uuid.optional()}).strict();
export const updateCaseSchema=z.object({expectedRevision:revision,title:z.string().trim().min(1).max(200).optional(),businessDate:dateSchema.optional(),data:dataSchema.optional()}).strict();
export const memberSchema=z.object({username:credentials.shape.username,role:roleSchema}).strict();
export const correctionSchema=z.object({expectedRevision:revision,attachmentId:uuid,recordId:z.string().max(100),field:z.string().trim().min(1).max(80).refine(s=>!['__proto__','constructor','prototype'].includes(s)),value:z.string().max(4000),reason:z.string().trim().min(1).max(2000)}).strict();
export const replacementsSchema=z.array(z.object({blockId:uuid,text:z.string().max(12000)}).strict()).min(1).max(100).refine(items=>new Set(items.map(x=>x.blockId)).size===items.length,'目标区块不可重复');
export const patchSchema=z.object({baseVersion:revision,replacements:replacementsSchema,reason:z.string().trim().min(1).max(2000),evidenceRefs:z.array(z.string().max(200)).max(100).default([])}).strict();
export const modelOutputSchema=patchSchema.omit({baseVersion:true}).extend({evidenceRefs:z.array(z.string().max(200)).min(1).max(100)});
export const skillContentSchema=z.object({scenario:scenarioSchema,description:z.string().trim().min(1).max(1000),instructions:z.string().trim().min(1).max(12000),toolBindings:z.array(z.enum(tools)).length(4).refine(items=>new Set(items).size===4,'需绑定全部四个受限工具')}).strict();
export const skillCreateSchema=skillContentSchema.extend({name:z.string().trim().min(1).max(120)});
export const runRequestSchema=z.union([
  z.object({caseId:uuid,expectedRevision:revision,mode:z.literal('RULES').default('RULES')}).strict(),
  z.object({caseId:uuid,expectedRevision:revision,mode:z.literal('MODEL'),documentId:uuid,expectedDocumentVersion:revision,
    blockIds:z.array(uuid).min(1).max(100),goal:z.string().trim().min(1).max(2000),skillId:uuid,skillVersion:revision}).strict(),
  teamRequestSchema
]);
export type RunRequest=z.infer<typeof runRequestSchema>;
export type PatchInput=z.infer<typeof patchSchema>;
export type SkillContent=z.infer<typeof skillContentSchema>;
export const documentCreateSchema=z.object({expectedRevision:revision,title:z.string().trim().min(1).max(200),blocks:blocksSchema}).strict();
export const documentSaveSchema=z.object({expectedVersion:revision,blocks:blocksSchema}).strict();
export const confirmationSchema=z.object({documentId:uuid,expectedRevision:revision,note:z.string().trim().min(1).max(2000),acknowledgeIssues:z.literal(true)}).strict();
export const commandSchema=z.object({commandId:uuid,caseId:uuid,confirmationId:uuid,expectedRevision:revision,action:z.literal('publish')}).strict();
export const runStatusSchema=z.enum(['QUEUED','RUNNING','PAUSE_REQUESTED','PAUSED','WAITING_FOR_REVIEW','FAILED','CANCELLED','SUPERSEDED']);
export const patchStatusSchema=z.enum(['PENDING','ACCEPTED','REJECTED','SUPERSEDED']);
export const envelopeSchema=z.object({code:z.literal(0),message:z.literal('success'),data:z.unknown()});
export const organizationSchema=z.object({name:z.string().trim().min(1).max(120)}).strict();
export const uploadSchema=z.object({expectedRevision:z.coerce.number().int().min(1),purpose:z.enum(['MATERIAL','REFERENCE']).default('MATERIAL')}).strict();
export const controlSchema=z.object({action:z.literal('cancel')}).strict();
export const restoreSchema=z.object({expectedVersion:revision,sourceVersion:revision}).strict();
export const trialSchema=z.object({caseId:uuid}).strict();
export const decisionSchema=z.object({expectedVersion:revision}).strict();
