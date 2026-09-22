import type { NativeContext } from "./native-state.js";
import { z } from "zod";

export const requestSchema = z.object({
  id: z.string().uuid(),
  harness: z.enum(["claude", "codex", "pi"]),
  prompt: z.string().min(1).max(64_000),
});
export const stopSchema = z.object({
  type: z.literal("stop"),
  requestId: z.string().uuid(),
});
export type Request = z.infer<typeof requestSchema>;
export type Turn = Request & {
  status: "completed" | "failed" | "stopped";
  text: string;
};
export type Output =
  | {
      type: "lifecycle";
      phase: "suspending" | "resumed";
      bootId: string;
      turns: number;
      workspaceRestored?: boolean;
    }
  | {
      type: "native";
      requestId: string;
      harness: Request["harness"];
      id: string;
      resumed: boolean;
      restored: boolean;
    }
  | {
      type: "started";
      requestId: string;
      harness: Request["harness"];
      attempt?: number;
    }
  | {
      type: "event";
      requestId: string;
      harness: Request["harness"];
      event: unknown;
    }
  | {
      type: "result";
      requestId: string;
      harness: Request["harness"];
      status: Turn["status"];
      text: string;
    }
  | { type: "committed"; requestId: string; commitKey: string }
  | { type: "text"; requestId: string; text: string; replace?: boolean }
  | {
      type: "tool";
      requestId: string;
      harness: Request["harness"];
      name: string;
    }
  | { type: "retrying"; requestId: string; attempt: number };
export type Harness = (
  prompt: string,
  emit: (event: unknown) => void,
  signal: AbortSignal,
  workspace: string,
  native?: NativeContext,
) => Promise<string>;
