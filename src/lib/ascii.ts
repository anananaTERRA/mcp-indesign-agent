/**
 * ExtendScript reached through `osascript` dies silently on non-ASCII source:
 * the script simply does nothing and no error comes back. Anything we hand to
 * the dispatcher to be used as a name (undo transaction label, checkpoint file
 * tag) goes through here first.
 */

function escapeCodeUnits(ch: string): string {
  let out = "";
  for (let i = 0; i < ch.length; i++) {
    out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
  }
  return out;
}

/** Typography that has an obvious ASCII reading; the label is for humans. */
const PUNCTUATION: Record<string, string> = {
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u2026": "...",
  "\u00a0": " ",
  "\u00ab": '"',
  "\u00bb": '"',
};

/**
 * NFKD folds accents and ordinals ("Renderização nº 8" → "Renderizacao no 8"),
 * common punctuation is mapped by hand, and anything still left becomes \uXXXX
 * so the result is printable 7-bit ASCII.
 */
export function toAscii(value: string): string {
  const mapped = value.replace(
    /[\u00a0\u00ab\u00bb\u2010-\u2015\u2018-\u201e\u2026]/g,
    (ch) => PUNCTUATION[ch] ?? ch,
  );
  const folded = mapped.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  let out = "";
  for (const ch of folded) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += " ";
    } else if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else {
      out += escapeCodeUnits(ch);
    }
  }
  return out;
}

/**
 * ASCII slug safe to drop into a filename (checkpoint tags). Unlike toAscii
 * this drops what it cannot fold instead of escaping it — a checkpoint called
 * "Verbete-u2014-8" helps nobody find the file again.
 */
export function toAsciiTag(value: string, fallback = "batch"): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : fallback;
}
