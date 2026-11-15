// Checks every message the page sends before the app acts on it. The contract
// itself (channels, types) is in bridge-constants.ts.

import { z } from "zod";
import type { Notice } from "./bridge-constants.js";

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

// The schema and the interface the page sees must stay the same shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameShape: Same<z.infer<typeof noticeSchema>, Notice> = true;
void sameShape;
