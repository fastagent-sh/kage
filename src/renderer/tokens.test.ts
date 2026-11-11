import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// docs/ui.md §5 and §7: chrome sizes in `.tsx` arbitrary values only; index.css sets the conversation's own.
const SIZES = new Set([11, 12, 13, 15, 22]);
// Mono sits half a step above the sans beside it, since its x-height is smaller: 12.5, and only on mono.
const MONO_HALF_STEP = 12.5;

function enclosingString(source: string, index: number): string {
  const start = Math.max(source.lastIndexOf('"', index), source.lastIndexOf("`", index));
  const end = source.indexOf(source[start]!, index);
  return source.slice(start, end < 0 ? source.length : end);
}

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

/** 12.5 passes only when the same string sets `font-mono`. */
function sizesOffScale(source: string): string[] {
  const off: string[] = [];
  for (const match of source.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
    const px = Number(match[1]);
    const mono = px === MONO_HALF_STEP && /\bfont-mono\b/.test(enclosingString(source, match.index));
    if (!SIZES.has(px) && !mono) off.push(`line ${lineOf(source, match.index)}: ${px}px`);
  }
  return off;
}

/** Arbitrary radii; a bubble's tail and inline code are the only 4. */
function radiiOffScale(source: string): string[] {
  return [...source.matchAll(/rounded-(?:[a-z]+-)?\[(\d+)px\]/g)]
    .filter((match) => match[1] !== "4")
    .map((match) => `line ${lineOf(source, match.index)}: ${match[1]}px`);
}

function components(dir: string, prefix = ""): { name: string; source: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? components(join(dir, entry.name), `${prefix}${entry.name}/`)
      : entry.name.endsWith(".tsx")
        ? [{ name: `${prefix}${entry.name}`, source: readFileSync(join(dir, entry.name), "utf8") }]
        : [],
  );
}
const sources = components(new URL(".", import.meta.url).pathname);

test("chrome text is set on the size scale, and the half step only on mono", () => {
  const off = sources.flatMap(({ name, source }) => sizesOffScale(source).map((at) => `${name} ${at}`));
  assert.deepEqual(off, [], "sizes off the scale (docs/ui.md §5)");
});

test("corners come from the radius tokens; a bubble's tail and inline code are the only 4", () => {
  const off = sources.flatMap(({ name, source }) => radiiOffScale(source).map((at) => `${name} ${at}`));
  assert.deepEqual(off, [], "arbitrary radii (docs/ui.md §7)");
});

test("the scan reads a whole className: mono is what the string says, not what the file or the line says", () => {
  // Broken across lines, the string still sets font-mono.
  assert.deepEqual(sizesOffScale('<pre className="mt-1.5\n  font-mono\n  text-[12.5px]" />'), []);
  // Another string in the file setting font-mono does not excuse this one.
  assert.deepEqual(sizesOffScale('<b className="font-mono" /><i className="text-[12.5px]" />'), ["line 1: 12.5px"]);
  assert.deepEqual(sizesOffScale('<i className="text-[13.5px] font-mono" />'), ["line 1: 13.5px"]);
  assert.deepEqual(radiiOffScale('<i className="rounded-[4px]" /><b className="rounded-[9px]" />'), ["line 1: 9px"]);
});
