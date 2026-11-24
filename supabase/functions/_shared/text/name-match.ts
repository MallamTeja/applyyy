// "Did the owner name this?": ONE matcher for the server and the web (2026-11-21).
//
// WHY IT EXISTS: resume-assist's ownerNamed (server) and the web's shouldAutoApply (apps/web aiEdit.ts) answered the
// same question two ways. The server forgave a typo and read split words ("rm  vs cod e" -> VS Code); the web wanted
// every word typed exactly, so Teja's removal waited for an Apply click he had already asked to skip (ruling 2026-11-21
// 14:36: "if i say rm something ... it need to directly remove"). The helpers moved here unchanged from
// resume-assist/assist.ts, so both sides now read a name the same way, and a fix to one is a fix to both.
//
// PURE: no Deno or DOM API, so the edge function, the web (by relative path) and node --test all run it.

// Lower case, letters, digits, "+" and "#" only: the form two spellings of one skill name share.
export function compactName(text: string): string {
  // Everything else is spacing or punctuation.
  return text.toLowerCase().replace(/[^a-z0-9+#]/g, "");
}

// True when a and b differ by at most one insertion, deletion or substitution.
export function withinOneEdit(a: string, b: string): boolean {
  // Two or more letters apart in length cannot be one edit.
  if (Math.abs(a.length - b.length) > 1) return false;
  // Walk both until the first difference.
  let i = 0;
  // The shared prefix.
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  // After it, the rest must match with one letter substituted, dropped from a, or dropped from b.
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1);
}

/* At most two edits apart, an adjacent swap counting as ONE (optimal string alignment distance), for the long names
   namedIn checks (2026-11-11: "type grpahy" -> "typography" is a substitution plus a swap). Bounded: two strings
   more than 2 letters apart in length are never within 2. */
export function withinTwoEdits(a: string, b: string): boolean {
  // A length gap over 2 needs 3+ edits.
  if (Math.abs(a.length - b.length) > 2) return false;
  // dp[i][j]: edits between a's first i and b's first j letters; row 0 and column 0 are the pure insert/delete costs.
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  // Every prefix pair.
  for (let i = 1; i <= a.length; i += 1) {
    // Every b prefix.
    for (let j = 1; j <= b.length; j += 1) {
      // Substitution costs nothing on a match.
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      // Delete, insert, substitute.
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
      // An adjacent swap.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i]![j] = Math.min(dp[i]![j]!, dp[i - 2]![j - 2]! + 1);
    }
  }
  // Within two.
  return dp[a.length]![b.length]! <= 2;
}

/* namedIn's typo budget on two already-compacted names, shared so namedIn and sameName can never drift apart:
   exact, one edit on a target of 6+ characters, two (a swap is one) on 8+. Short names stay exact because one edit
   from "C", "Go" or the group "AI" is a different name. */
function closeCompact(compact: string, target: string): boolean {
  // Exact, or one typo on a 6+ name, or two (a swap is one) on an 8+ name.
  return compact === target || (target.length >= 6 && withinOneEdit(compact, target)) || (target.length >= 8 && withinTwoEdits(compact, target));
}

/* Is `a` the same name as `b` (2026-11-23, move_skill)? Whole name against whole name, with namedIn's typo budget
   measured on b, the printed name: the AI's "harnes engineering" is the resume's "Harness Engineering". namedIn
   searches a sentence for runs; this compares two names, so a skill named inside a longer phrase never matches. */
export function sameName(a: string, b: string): boolean {
  // The printed name compacted; empty (pure punctuation) is never a name, as in namedIn.
  const target = compactName(b);
  // Nothing to match, else the shared budget.
  return target !== "" && closeCompact(compactName(a), target);
}

/* Did any of these texts NAME `name` (ownerNamed's rule, 2026-11-09)? Matched on runs of 1-4 consecutive words, so
   "tailwind css" names "Tailwind CSS" and "vs cod e" names "VS Code" (the run compacts to "vscode"). Whole runs only,
   never a substring: "can" must not name "C", "good" must not name "Go". One typo is forgiven on names of 6+
   characters ("anguar js"), two (a swap counts as one) on 8+ ("type grpahy"); a short name must match exactly,
   because one edit away from "C" or "Go" is half the language. No alias matching: a looser match only widens what
   an unasked change can slip through. The CALLER chooses the texts: only the owner's own words, never the AI's. */
export function namedIn(name: string, texts: readonly string[]): boolean {
  // The name with case, spaces and punctuation gone; + and # stay, so "C++" and "C#" are not "C".
  const target = compactName(name);
  // Nothing left to match (a name of pure punctuation): never "named".
  if (target === "") return false;
  // Every text, word by word.
  for (const text of texts) {
    // Split on spaces and punctuation that never sits inside a skill name; "." "+" "#" stay for "node.js", "c++".
    const words = text.toLowerCase().split(/[\s,;:!?()"'\/]+/).filter((word) => word !== "");
    // Each run of 1-4 words starting at each word.
    for (let start = 0; start < words.length; start += 1) {
      // Runs longer than 4 words are sentences, not names.
      for (let end = start + 1; end <= Math.min(start + 4, words.length); end += 1) {
        // The run compacted the same way as the name.
        const compact = compactName(words.slice(start, end).join(""));
        // Exact, or one typo on a 6+ name, or two (a swap is one) on an 8+ name.
        if (closeCompact(compact, target)) return true;
      }
    }
  }
  // Nobody named it.
  return false;
}
