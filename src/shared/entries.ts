import type { ContentPart } from "@fastagent-sh/fastagent";

/** The words of a message's content. An image is not a word, and its bytes never get this far. */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as ContentPart[]).map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}
