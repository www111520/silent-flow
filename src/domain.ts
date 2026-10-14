import { z } from "zod";

export const jobStatuses = [
  "queued",
  "running",
  "retry_wait",
  "completed",
  "dead_letter",
  "cancelled",
] as const;

export type JobStatus = (typeof jobStatuses)[number];

export const informationTypes = [
  "安全预警",
  "发布更新",
  "弃用与迁移",
  "故障事件",
  "技术突破",
  "教程方案",
  "标准政策",
  "开源动态",
  "行业活动",
  "招聘信息",
  "求助问答",
  "观点讨论",
  "闲聊",
  "其他",
] as const;

export const analysisResultSchema = z.object({
  informationType: z.enum(informationTypes),
  technicalDomains: z.array(z.string().min(1)).max(8),
  evidence: z.array(z.string().min(1)).max(8),
  location: z.string().min(1).nullable().default(null),
  source: z.string().min(1).nullable().default(null),
  product: z.string().min(1).nullable().default(null),
  version: z.string().min(1).nullable().default(null),
  eventTime: z.string().min(1).nullable().default(null),
  needsReview: z.boolean(),
  reviewIssue: z.string().min(1).nullable(),
  summary: z.string().min(1),
}).superRefine((value, context) => {
  if (value.needsReview && value.reviewIssue === null) {
    context.addIssue({
      code: "custom",
      message: "待审核结果必须包含待确认问题",
      path: ["reviewIssue"],
    });
  }
});

export type AnalysisResult = z.infer<typeof analysisResultSchema>;

const incomingMessageBaseSchema = z.object({
  selfId: z.string().min(1),
  groupId: z.string().min(1),
  messageId: z.string().min(1),
  senderHash: z.string().min(16),
  receivedAt: z.number().int().nonnegative(),
  rawSegments: z.array(z.unknown()),
});

export const incomingMessageSchema = incomingMessageBaseSchema.extend({
  normalizedText: z.string().min(1),
});

export const skippedMessageSchema = incomingMessageBaseSchema;

export type IncomingMessage = z.infer<typeof incomingMessageSchema>;
export type SkippedMessage = z.infer<typeof skippedMessageSchema>;

export interface ClaimedJob {
  id: number;
  messageId: number;
  attemptCount: number;
  leaseExpiresAt: number;
  normalizedText: string;
}

export type ReviewAction =
  | { type: "accept"; note?: string }
  | { type: "correct"; result: AnalysisResult; note?: string }
  | { type: "dismiss"; note: string };
