/**
 * Truncation recovery for tool-call argument JSON cut off mid-structure
 * (typically when the model hits max_tokens before finishing the JSON object).
 *
 * Strategy is purely local: balance braces, close strings, fill missing values
 * with `null`. We deliberately do NOT make a continuation API call here — that
 * decision belongs to the loop, which knows about budgets.
 */

export interface TruncationRepairResult {
  repaired: string;
  changed: boolean;
  notes: string[];
}

export function repairTruncatedJson(input: string): TruncationRepairResult {
  const notes: string[] = [];
  if (!input || !input.trim()) {
    return { repaired: "{}", changed: input !== "{}", notes: ["empty input → {}"] };
  }
  // Fast path: already parseable.
  try {
    JSON.parse(input);
    return { repaired: input, changed: false, notes: [] };
  } catch {
    /* fall through */
  }

  const stack: ("{" | "[" | '"')[] = [];
  let escaped = false;
  let inString = false;
  let lastSignificant = -1;

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (!/\s/.test(c)) lastSignificant = i;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        stack.pop();
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      stack.push('"');
      continue;
    }
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }

  let s = input.slice(0, lastSignificant + 1);

  // Trim a trailing comma which would block re-parse.
  if (/,$/.test(s)) {
    s = s.replace(/,$/, "");
    notes.push("trimmed trailing comma");
  }

  // If we ended on a key without a value: "foo": → "foo": null
  if (/"\s*:\s*$/.test(s)) {
    s += " null";
    notes.push("filled dangling key with null");
  }

  // If we ended inside a string, close it.
  if (inString) {
    s += '"';
    stack.pop();
    notes.push("closed unterminated string");
  }

  // Pop remaining open structures in reverse order.
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === "{") s += "}";
    else if (top === "[") s += "]";
    else if (top === '"') s += '"';
  }

  try {
    JSON.parse(s);
    return { repaired: s, changed: true, notes };
  } catch (err) {
    notes.push(`fallback to {}: ${(err as Error).message}`);
    return { repaired: "{}", changed: true, notes };
  }
}
