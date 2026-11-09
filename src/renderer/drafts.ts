import { message } from "./message.ts";

const KEY = "kage.drafts";
const UNREADABLE = "kage.drafts.unreadable";

export function createDraftStorage() {
  let entries: [string, string][] = [];
  let saved: string | undefined;
  let blocked: string | undefined;
  let recovered: string | undefined;
  const storage = () => {
    const value = globalThis.localStorage;
    if (!value) throw new Error("Browser storage is unavailable");
    return value;
  };
  try {
    const stored = storage().getItem(KEY);
    if (stored !== null) {
      try {
        const parsed: unknown = JSON.parse(stored);
        const pair = (entry: unknown) =>
          Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string";
        if (!Array.isArray(parsed) || !parsed.every(pair)) throw new Error("expected a list of [conversation, text] pairs");
        entries = parsed as [string, string][];
        saved = stored;
      } catch (error) {
        storage().setItem(UNREADABLE, stored);
        recovered = `Unreadable drafts were preserved in ${UNREADABLE}: ${message(error)}`;
      }
    }
  } catch (error) {
    blocked = `The original drafts are protected until you reload with working storage: ${message(error)}`;
  }
  return {
    entries,
    save(entries: [string, string][]): string | undefined {
      if (blocked) return blocked;
      const value = JSON.stringify(entries);
      if (value === saved) return recovered;
      try {
        storage().setItem(KEY, value);
        saved = value;
        return recovered;
      } catch (error) {
        return `Drafts have not been saved: ${message(error)}`;
      }
    },
  };
}
