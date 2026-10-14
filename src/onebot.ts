import { createHash } from "node:crypto";
import { z } from "zod";
import { CollectorDatabase, type IngestResult } from "./database.js";

const idSchema = z.union([z.string(), z.number()]).transform(String);

const oneBotHeartbeatSchema = z.object({
  post_type: z.literal("meta_event"),
  meta_event_type: z.literal("heartbeat"),
  status: z.object({
    good: z.boolean(),
    online: z.boolean(),
  }),
});

const groupMessageSchema = z.object({
  post_type: z.literal("message"),
  message_type: z.literal("group"),
  self_id: idSchema,
  group_id: idSchema,
  message_id: idSchema,
  user_id: idSchema,
  time: z.number().int().nonnegative(),
  message: z.array(z.object({
    type: z.string(),
    data: z.record(z.string(), z.unknown()),
  })),
});

export type ParsedOneBotEvent =
  | {
      type: "heartbeat";
      good: boolean;
      online: boolean;
    }
  | {
      type: "ignored";
      reason: "not_group_message" | "group_not_allowed";
    }
  | {
      type: "skipped";
      reason: "no_text";
      messageId: number;
    }
  | {
      type: "message";
      ingest: IngestResult;
    };

export function createOneBotEventHandler(options: {
  store: CollectorDatabase;
  groupWhitelist: ReadonlySet<string>;
  senderSalt: string;
  onHeartbeat?: (good: boolean, online: boolean) => void;
}): (raw: unknown) => ParsedOneBotEvent {
  return (raw: unknown): ParsedOneBotEvent => {
    const heartbeat = oneBotHeartbeatSchema.safeParse(raw);
    if (heartbeat.success) {
      options.onHeartbeat?.(
        heartbeat.data.status.good,
        heartbeat.data.status.online,
      );
      return {
        type: "heartbeat",
        good: heartbeat.data.status.good,
        online: heartbeat.data.status.online,
      };
    }

    const parsed = groupMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return { type: "ignored", reason: "not_group_message" };
    }
    const event = parsed.data;
    if (!options.groupWhitelist.has(event.group_id)) {
      return { type: "ignored", reason: "group_not_allowed" };
    }

    const senderHash = createHash("sha256")
      .update(`${options.senderSalt}:${event.user_id}`)
      .digest("hex");
    const normalizedText = normalizeSegments(event.message);
    if (!normalizedText) {
      const skipped = options.store.ingestSkipped({
        selfId: event.self_id,
        groupId: event.group_id,
        messageId: event.message_id,
        senderHash,
        receivedAt: event.time * 1_000,
        rawSegments: event.message,
      });
      return {
        type: "skipped",
        reason: "no_text",
        messageId: skipped.messageId,
      };
    }

    const ingest = options.store.ingest({
      selfId: event.self_id,
      groupId: event.group_id,
      messageId: event.message_id,
      senderHash,
      receivedAt: event.time * 1_000,
      rawSegments: event.message,
      normalizedText,
    });
    return { type: "message", ingest };
  };
}

export function normalizeSegments(
  segments: Array<{ type: string; data: Record<string, unknown> }>,
): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.type === "text" && typeof segment.data.text === "string") {
      parts.push(segment.data.text);
    } else if (segment.type === "at") {
      parts.push("@用户");
    } else if (
      segment.type === "reply" &&
      (typeof segment.data.id === "string" || typeof segment.data.id === "number")
    ) {
      parts.push(`[回复:${String(segment.data.id)}]`);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
