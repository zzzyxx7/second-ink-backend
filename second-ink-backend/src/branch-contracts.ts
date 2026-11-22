import { z } from 'zod';
import { uuid,revision } from './types.js';
import { reportOptionsSchema } from './team-contracts.js';
export const materialSelectionSchema=z.object({expectedRevision:revision,activeAttachmentIds:z.array(uuid).max(20).refine(ids=>new Set(ids).size===ids.length,'附件不可重复'),reason:z.string().trim().min(1).max(2000)}).strict();
export const amendmentSchema=z.object({
  kind:z.enum(['AMEND','HISTORY']).default('AMEND'),checkpointId:uuid.optional(),
  expectedRevision:revision,teamId:uuid.optional(),teamVersion:revision.optional(),
  report:reportOptionsSchema.nullable().optional()
}).strict().superRefine((data,ctx)=>{
  if(data.kind==='HISTORY'&&!data.checkpointId)ctx.addIssue({code:'custom',path:['checkpointId'],message:'历史恢复需要稳定检查点'});
  if(Boolean(data.teamId)!==Boolean(data.teamVersion))ctx.addIssue({code:'custom',message:'团队标识与版本必须同时提供'});
});
export const branchCommitSchema=z.object({previewId:uuid,previewDigest:z.string().regex(/^[a-f0-9]{64}$/),commandId:uuid}).strict();
export type Amendment=z.infer<typeof amendmentSchema>;
