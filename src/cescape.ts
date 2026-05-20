// Decode a C-escaped string of the form strace emits for write() arguments.
// Input: the bytes between the opening and closing double-quotes (no quotes).
// strace uses: \n \r \t \v \f \a \b \\ \" plus \ooo (octal, 1-3 digits) and \xHH.
// Anything else passes through verbatim.

export function decodeCEscaped(src: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src.charCodeAt(i);
    if (ch !== 0x5c /* \ */) {
      // strace produces ASCII-clean output; high bytes only appear via escapes.
      // But just in case, encode any > 0x7f char as UTF-8.
      if (ch < 0x80) out.push(ch);
      else {
        const enc = new TextEncoder().encode(src[i]!);
        for (const b of enc) out.push(b);
      }
      continue;
    }
    const next = src[i + 1];
    if (next === undefined) {
      out.push(0x5c);
      break;
    }
    if (next === "n") { out.push(0x0a); i++; continue; }
    if (next === "r") { out.push(0x0d); i++; continue; }
    if (next === "t") { out.push(0x09); i++; continue; }
    if (next === "v") { out.push(0x0b); i++; continue; }
    if (next === "f") { out.push(0x0c); i++; continue; }
    if (next === "a") { out.push(0x07); i++; continue; }
    if (next === "b") { out.push(0x08); i++; continue; }
    if (next === "0" || next === "1" || next === "2" || next === "3" ||
        next === "4" || next === "5" || next === "6" || next === "7") {
      // octal, up to 3 digits
      let j = i + 1;
      let end = Math.min(i + 4, src.length);
      let val = 0;
      while (j < end) {
        const c = src.charCodeAt(j);
        if (c < 0x30 || c > 0x37) break;
        val = val * 8 + (c - 0x30);
        j++;
      }
      out.push(val & 0xff);
      i = j - 1;
      continue;
    }
    if (next === "x") {
      let j = i + 2;
      let val = 0;
      let count = 0;
      while (j < src.length && count < 2) {
        const c = src.charCodeAt(j);
        let d: number;
        if (c >= 0x30 && c <= 0x39) d = c - 0x30;
        else if (c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
        else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
        else break;
        val = val * 16 + d;
        j++;
        count++;
      }
      out.push(val & 0xff);
      i = j - 1;
      continue;
    }
    // \\ \" and any other literal escape
    out.push(src.charCodeAt(i + 1));
    i++;
  }
  return new Uint8Array(out);
}

// Find the matching closing quote for a C-escaped string starting at `start`
// (the char after the opening quote). Returns the index of the closing quote.
// Returns -1 if not found.
export function findCloseQuote(s: string, start: number): number {
  let i = start;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x5c /* \ */) { i += 2; continue; }
    if (c === 0x22 /* " */) return i;
    i++;
  }
  return -1;
}
