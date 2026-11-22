import { fingerprint } from './fingerprint.js';
import type { RunInput } from './verification.js';
import type { TeamNode } from './team-contracts.js';
import { checkEngineVersion } from './incremental.js';

export const nodeCacheVersion='node-cache@1';
export function nodeFingerprint(input:RunInput,node:TeamNode):string|null {
  if(input.verificationEngineVersion!==checkEngineVersion||node.role==='REPORT')return null;
  const base={version:nodeCacheVersion,teamDigest:input.team!.digest,nodeId:node.id,agentVersion:node.agentVersion,role:node.role};
  if(node.role==='POLICY')return fingerprint({...base,businessDate:input.businessDate,rules:input.rules});
  if(node.role==='MATERIALS')return fingerprint({...base,attachments:input.attachments});
  return fingerprint({...base,scenario:input.scenario,businessDate:input.businessDate,data:input.data,rules:input.rules,attachments:input.attachments});
}
