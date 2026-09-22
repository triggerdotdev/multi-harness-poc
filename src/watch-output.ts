import { setTimeout as delay } from "node:timers/promises";
import { sessions } from "@trigger.dev/sdk";

type Part<T> = { id: string; chunk: T; timestamp: number };

/** Published SDK reads finish at idle EOF. Keep the browser stream open across those windows. */
export async function* watchOutput<T>(
  sessionId: string,
  options: {
    signal: AbortSignal;
    lastEventId?: string;
    onPart?: (part: Part<T>) => void;
  },
) {
  let cursor = options.lastEventId;
  let emptyWindows = 0;
  while (!options.signal.aborted) {
    const stream = await sessions.open(sessionId).out.read<T>({
      signal: options.signal,
      lastEventId: cursor,
      onPart: (part) => {
        cursor = part.id;
        emptyWindows = 0;
        options.onPart?.(part);
      },
    });
    for await (const chunk of stream) yield chunk;
    if (options.signal.aborted) return;
    try {
      await delay(
        Math.min(100 * 2 ** Math.min(emptyWindows++, 6), 5_000),
        undefined,
        { signal: options.signal },
      );
    } catch (error) {
      if (options.signal.aborted) return;
      throw error;
    }
  }
}
