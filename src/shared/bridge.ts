// Checks every message the page sends before the app acts on it. The contract
// itself (channels, types) is in bridge-constants.ts.

import { z } from "zod";
import { ASSISTANT_MODELS, ATTACHMENT_TYPES, type AssistantStart, type Notice } from "./bridge-constants.js";

export * from "./bridge-constants.js";

/** A path inside the app ("/rotina"), never another site ("//x.com", "https://…"). */
const appPath = z
  .string()
  .max(500)
  .regex(/^\/(?![/\\])/, "caminho dentro do app");

export const noticeSchema = z.object({
  tag: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  body: z.string().max(1000).optional(),
  url: appPath.optional(),
  taskId: z.string().min(1).max(100).optional(),
});

export const badgeSchema = z.number().int().min(0).max(1_000_000);

/** A name the page gives one of its conversations; it only ever picks an engine among the app's own. */
export const assistantChannelSchema = z.string().regex(/^[a-z0-9-]{1,40}$/, "canal do assistente");

export const assistantStartSchema = z.strictObject({
  systemPrompt: z.string().min(1).max(60_000),
  // Only a conversation token of the ANI-9 server; it ends up in a header, so no spaces or quotes.
  token: z.string().regex(/^ani9a_[A-Za-z0-9_.-]{20,600}$/, "token do assistente"),
  model: z.enum(ASSISTANT_MODELS),
  channel: assistantChannelSchema.optional(),
});

export const assistantTextSchema = z.string().min(1).max(200_000);

/** Up to 5 files, about 24 MB each (the engine's own limit for a PDF is 32 MB). */
export const assistantAttachmentsSchema = z
  .array(
    z.strictObject({
      name: z.string().min(1).max(200),
      mediaType: z.enum(ATTACHMENT_TYPES),
      data: z
        .string()
        .min(4)
        .max(32_000_000)
        .regex(/^[A-Za-z0-9+/]+=*$/, "base64"),
    }),
  )
  .max(5);

/** A piece of what the microphone heard: up to 2 s at 16 kHz. */
export const voiceAudioSchema = z
  .instanceof(Float32Array)
  .refine((samples) => samples.length > 0 && samples.length <= 32_000, "áudio");
export const voiceSaySchema = z.tuple([
  z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  z.string().min(1).max(4000),
]);

// The schema and the interface the page sees must stay the same shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameShape: Same<z.infer<typeof noticeSchema>, Notice> = true;
void sameShape;
const sameStart: Same<z.infer<typeof assistantStartSchema>, AssistantStart> = true;
void sameStart;
