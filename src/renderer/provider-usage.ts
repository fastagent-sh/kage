import type { KageApi, ProviderUsage } from "../preload/index.ts";
import { message } from "./message.ts";

export type PlanUsageView = Record<string, { data?: ProviderUsage; error?: string }>;

export function createProviderUsage(api: KageApi, publish: (patch: { usage: PlanUsageView }) => void) {
  let usage: PlanUsageView = {};
  const requests = new Map<string, object>();
  return {
    forget(provider: string) {
      requests.delete(provider);
      const { [provider]: _gone, ...remaining } = usage;
      usage = remaining;
      publish({ usage });
    },
    async loadUsage(provider: string) {
      const request = {};
      requests.set(provider, request);
      let answer: PlanUsageView[string];
      try {
        answer = { data: await api.providerUsage(provider) };
      } catch (error) {
        answer = { error: message(error) };
      }
      if (requests.get(provider) !== request) return;
      usage = { ...usage, [provider]: answer };
      publish({ usage });
    },
  };
}
