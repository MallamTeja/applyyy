/* THE AI EDIT CONTRACT on the browser side (2026-10-31): what the review page sends to the
 * `resume-assist` edge function, how its answer is read, and how each proposed op becomes one
 * of the page's own EditActions.
 *
 * WHY THE AI ANSWERS IN EditActions AND NEVER IN RESUMES. Every edit on this page already
 * crosses one guarded write (saveTailoredEdit: shape check, R0 text-only check, status and
 * stamp guards, an append-only event). Mapping the AI's ops onto the SAME actions a click makes
 * means the AI gets no new write path at all: it can only suggest what the operator could have
 * typed, and only the operator's Apply click sends it.
 *
 * WHY SHORT IDS. Bullets go out as "b0", "b1"... and the ref behind each id stays in the
 * browser. Refs are long and cost tokens on every call, and a model that never sees a ref cannot
 * invent one: an id it was not given is simply not in the map.
 *
 * Pure apart from the injected client, so node --test drives it with a fake. */

// Types only: the diff the page renders, and the action vocabulary the save path understands.
import type { ResumeDiff } from './diffModel';
// Type-only import from the view: the action union is declared there, beside the controls.
import type { EditAction } from './DiffView';
/* The auditor's own rule 5 and tokenizer, imported by relative path (as diffAdapter.ts imports
   jd-keywords) so the advice shown before Apply is the audit's definition, never a copy. */
import { bulletGroundingGaps, tokenizeText } from '../../../../../supabase/functions/_shared/audit/detector.ts';

/* The body the edge function validates (resume-assist/assist.ts parseAssistRequest). */
export interface AssistBody {
  // The operator's words.
  readonly instruction: string;
  // The job, reduced to what steers wording.
  readonly job: { readonly title: string; readonly company: string; readonly missing: readonly string[] };
  // The current summary, or null.
  readonly summary: string | null;
  // Current bullet text under short ids.
  readonly bullets: readonly { readonly id: string; readonly text: string }[];
  // The printed skills line.
  readonly skills: string;
  // The master's skill groups.
  readonly categories: readonly string[];
}

/* One proposed change, as the edge function returns it (a closed union, checked on read). */
export type AssistOp =
  // New text for a bullet id or "summary"; `newNumbers` are digits the old text did not have.
  | { readonly op: 'edit'; readonly id: string; readonly text: string; readonly newNumbers: readonly string[] }
  // Drop a bullet.
  | { readonly op: 'remove'; readonly id: string }
  // Add a skill under one of the master's groups.
  | { readonly op: 'add_skill'; readonly name: string; readonly category: string };

/* Billed token counts for one ask; null where Google did not report a number. */
export interface AssistUsage {
  // Input tokens, cached ones included.
  readonly input: number | null;
  // Of those, served from the implicit cache at a discount.
  readonly cached: number | null;
  // Visible output.
  readonly output: number | null;
  // Thinking, billed as output.
  readonly thinking: number | null;
}

/* The answer, read into a closed union; an unreadable answer is an error, never "no changes". */
export type AssistResult =
  // The validated ops, how many the server dropped, the model's note and the bill.
  | { readonly kind: 'ok'; readonly ops: readonly AssistOp[]; readonly dropped: number; readonly note: string; readonly usage: AssistUsage }
  // Anything else, in words the operator can act on.
  | { readonly kind: 'error'; readonly message: string };

/* The request plus the map that turns the answer's ids back into this resume's targets. */
export interface AssistDraft {
  // What is sent.
  readonly body: AssistBody;
  // Short id -> bullet ref. "summary" is not in it; it has its own target.
  readonly refs: ReadonlyMap<string, string>;
  // Short id (and "summary") -> the text the id stood for when the ask was sent.
  readonly before: ReadonlyMap<string, string | null>;
  // Short id -> the master bullet it rewords: what the auditor compares a bullet against.
  readonly masterText: ReadonlyMap<string, string | null>;
  // Every token of every master skill name, which the auditor also allows in any bullet.
  readonly skillTokens: ReadonlySet<string>;
  // Every master skill name, lower-cased, so a card can say whether Apply also adds it to the master.
  readonly masterSkills: ReadonlySet<string>;
}

/* What the audit would say about one AI edit, shown BEFORE Apply. Advice only (2026-10-31):
   it never blocks Apply and never changes the row's status. A closed union so "not checked"
   can never be shown as "clean". */
export type AuditAdvice =
  // Rule 5 ran: the numbers and words the master does not supply (both empty = grounded).
  | { readonly kind: 'checked'; readonly metrics: readonly string[]; readonly terms: readonly string[] }
  // The audit has no rule for this edit, said as such.
  | { readonly kind: 'not_checked'; readonly why: string };

/* The slice of supabase-js this file calls; structural, so a test passes a fake. */
export interface AssistClient {
  readonly functions: {
    // supabase-js adds the session's Authorization header itself.
    invoke(name: string, options: { body: Record<string, unknown> }): Promise<{ data: unknown; error: unknown }>;
  };
}

// The edge function's own caps, mirrored so a long list is trimmed here instead of refused there.
const MAX_LIST = 40;
// Same: the longest keyword or group name the function accepts.
const MAX_ITEM = 80;

/* A line's printed text: its runs joined, exactly as the diff renders them. */
function lineText(runs: readonly { readonly text: string }[]): string {
  // The runs are the tailored text split by verdict; joined, they are the line.
  return runs.map((run) => run.text).join('');
}

/* Short strings only, capped; JD keywords are untrusted and can be anything. */
function shortList(items: readonly string[]): string[] {
  // Trimmed, non-empty, within the function's per-item cap, at most MAX_LIST of them.
  return items.map((item) => item.trim()).filter((item) => item !== '' && item.length <= MAX_ITEM).slice(0, MAX_LIST);
}

/* Build the compact projection the AI sees, from what the page already rendered. */
export function buildAssistDraft(diff: ResumeDiff, categories: readonly string[], instruction: string): AssistDraft {
  // Short id -> ref, filled as bullets are numbered.
  const refs = new Map<string, string>();
  // Short id -> text at ask time.
  const before = new Map<string, string | null>();
  // Short id -> master bullet text, for the audit advice.
  const masterText = new Map<string, string | null>();
  // Master skill tokens; empty until the skills line is read.
  let skillTokens = new Set<string>();
  // Master skill names; empty until the skills line is read.
  let masterSkills = new Set<string>();
  // The bullets sent.
  const bullets: { id: string; text: string }[] = [];
  // The summary, null until a summary line is found.
  let summary: string | null = null;
  // The skills line, empty until found.
  let skills = '';
  // Every line once, in print order.
  for (const line of diff.lines) {
    // A bullet that is still printed and can be edited: the only ones an op could target.
    if (line.kind === 'bullet' && line.editTarget?.kind === 'bullet' && line.editState !== 'removed') {
      // Numbered in print order.
      const id = `b${bullets.length}`;
      // Its current text.
      const text = lineText(line.tailoredRuns);
      // A blank bullet gives the model nothing to work with, and the function refuses it.
      if (text.trim() === '') continue;
      // Remembered so the answer maps back.
      refs.set(id, line.editTarget.ref);
      // Remembered so the panel can show before -> after.
      before.set(id, text);
      // The master bullet this one rewords (diffAdapter sets it from bullet.master_text).
      masterText.set(id, line.masterText);
      // Sent.
      bullets.push({ id, text });
    } else if (line.kind === 'summary') {
      // The one summary line.
      summary = lineText(line.tailoredRuns);
    } else if (line.kind === 'skills') {
      // The printed skills, comma-separated as rendered.
      skills = lineText(line.tailoredRuns);
      // This line's masterText is EVERY master skill name joined (diffAdapter.ts:424), so its
      // tokens are exactly the auditor's MasterIndex.skillTokens.
      skillTokens = new Set(tokenizeText(line.masterText ?? ''));
      // The same joined names, split back into whole names for the "already in your master" check.
      masterSkills = new Set((line.masterText ?? '').split(',').map((name) => name.trim().toLowerCase()).filter((name) => name !== ''));
    }
  }
  // The summary is editable under its reserved id.
  before.set('summary', summary);
  // Every keyword the resume already matches, by any route.
  const matched = new Set([...diff.coverage.honestlyMatched, ...diff.coverage.matchedByFabrication, ...diff.coverage.matchedByEdit]);
  // The keywords still missing: the useful hint, and far cheaper than the whole posting.
  const missing = shortList(diff.coverage.jdKeywords.filter((keyword) => !matched.has(keyword)));
  // The body, every list capped.
  const body: AssistBody = {
    instruction: instruction.trim(),
    job: { title: diff.jobTitle, company: diff.companyName, missing },
    summary,
    bullets,
    skills,
    categories: shortList(categories),
  };
  // Sent with the maps the answer and the audit advice need.
  return { body, refs, before, masterText, skillTokens, masterSkills };
}

/* The audit's verdict on one AI op, or null for an op that changes no wording. */
export function auditAdvice(op: AssistOp, draft: AssistDraft): AuditAdvice | null {
  // A removal or a skill changes no bullet wording; skills are checked by the attest path instead.
  if (op.op !== 'edit') return null;
  /* The auditor checks only the summary's source refs, never its wording, so no verdict is given;
     the server's "numbers new versus the current text" list is the one signal left, so it is shown. */
  if (op.id === 'summary') {
    // Said only when there are any.
    const numbers = op.newNumbers.length > 0 ? ` New numbers: ${op.newNumbers.join(', ')}.` : '';
    // Not a pass: the audit has no rule here.
    return { kind: 'not_checked', why: `The audit does not check summary wording.${numbers}` };
  }
  // The master bullet this one rewords.
  const master = draft.masterText.get(op.id);
  // No master text means no comparison; never reported as clean.
  if (master === undefined || master === null) return { kind: 'not_checked', why: 'No master bullet to compare against.' };
  // Rule 5, the auditor's own function.
  const gaps = bulletGroundingGaps(op.text, master, draft.skillTokens);
  // Each word once: the auditor's list keeps repeats, which only add noise on a card.
  return { kind: 'checked', metrics: [...new Set(gaps.metrics)], terms: [...new Set(gaps.terms)] };
}

/* Turn one op into the page's action, or null when its id is not on this resume. */
export function toEditAction(op: AssistOp, draft: AssistDraft): EditAction | null {
  /* A skill always goes through the attest path: it reuses the master's own node when the latest
     master already has the skill, and otherwise records the operator's vouch as a new master
     version first. Either way the printed skill traces to the master, which the auditor demands. */
  if (op.op === 'add_skill') return { kind: 'attest_skill', keyword: op.name, category: op.category };
  // The summary has its own target; no ref involved (the server never proposes removing it).
  if (op.id === 'summary') return op.op === 'edit' ? { kind: 'edit', target: { kind: 'summary' }, text: op.text } : null;
  // The bullet's ref, from the ask that produced this op.
  const ref = draft.refs.get(op.id);
  // An id we never sent cannot be applied.
  if (ref === undefined) return null;
  // New text for the bullet, or the bullet dropped.
  return op.op === 'edit' ? { kind: 'edit', target: { kind: 'bullet', ref }, text: op.text } : { kind: 'remove', target: { kind: 'bullet', ref } };
}

/* What one ask cost, in one line; unknown counts are left out, never shown as 0. */
export function formatUsage(usage: AssistUsage): string {
  // The parts Google reported, in billing order.
  const parts: string[] = [];
  // Input, with the cached share when known (cached input is billed at a discount).
  if (usage.input !== null) parts.push(usage.cached !== null && usage.cached > 0 ? `${usage.input} in (${usage.cached} cached)` : `${usage.input} in`);
  // Visible output.
  if (usage.output !== null) parts.push(`${usage.output} out`);
  // Thinking, billed as output.
  if (usage.thinking !== null) parts.push(`${usage.thinking} thinking`);
  // Nothing reported is said as such.
  return parts.length === 0 ? 'Token use not reported.' : `Tokens: ${parts.join(', ')}.`;
}

/* True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  // Arrays and null are not records.
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* A token count or null; anything else is not a count. */
function count(value: unknown): number | null {
  // Shape-checked like every other field of the answer.
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/* One op from the wire, or null when it is not one of the three shapes. */
function readOp(value: unknown): AssistOp | null {
  // Must be an object.
  if (!isRecord(value)) return null;
  // An edit carries an id, text and a list of new numbers.
  if (value.op === 'edit' && typeof value.id === 'string' && typeof value.text === 'string' && Array.isArray(value.newNumbers)) {
    // Every flagged number must be a string, or the warning shown would be wrong.
    const newNumbers = value.newNumbers.filter((n): n is string => typeof n === 'string');
    // A list that lost entries is malformed, not "fewer warnings".
    return newNumbers.length === value.newNumbers.length ? { op: 'edit', id: value.id, text: value.text, newNumbers } : null;
  }
  // A remove carries only an id.
  if (value.op === 'remove' && typeof value.id === 'string') return { op: 'remove', id: value.id };
  // A skill carries a name and a group.
  if (value.op === 'add_skill' && typeof value.name === 'string' && typeof value.category === 'string') {
    // Exactly those two fields kept.
    return { op: 'add_skill', name: value.name, category: value.category };
  }
  // Any other shape.
  return null;
}

/* supabase-js hides a non-2xx body behind error.context (a fetch Response); read it defensively.
   ponytail: same reader as WebScoutPanel's private one; export a shared one if a third caller appears. */
async function readErrorBody(error: unknown): Promise<unknown> {
  // The Response, if there is one.
  const context = isRecord(error) ? error.context : null;
  // Only an object with a json() method can be read; checked before it is called.
  if (!isRecord(context) || typeof context.json !== 'function') return null;
  // A non-JSON body must not throw out of the ask.
  try {
    // Called as a method so `this` is the Response.
    return await (context as { json(): Promise<unknown> }).json();
  } catch {
    // Unreadable: the caller's generic message applies.
    return null;
  }
}

/* Ask the edge function. Never throws: every outcome is an AssistResult. */
export async function requestAssist(client: AssistClient | null, body: AssistBody): Promise<AssistResult> {
  // No client means the app is not configured; nothing can be asked.
  if (client === null) return { kind: 'error', message: 'The app is not connected to the database.' };
  // The call.
  try {
    // The function validates the body again; nothing here is trusted by it.
    const { data, error } = await client.functions.invoke('resume-assist', { body: { ...body } });
    // A non-2xx answer: read the function's own message when it sent one.
    if (error) {
      // The JSON body behind the error, if readable.
      const errBody = (await readErrorBody(error)) ?? data;
      // The function's message, verbatim, when it has the expected shape.
      if (isRecord(errBody) && typeof errBody.message === 'string') return { kind: 'error', message: errBody.message };
      // Otherwise a plain sentence; the gateway's 404 for an undeployed function lands here.
      return { kind: 'error', message: 'The AI request failed and returned no readable message.' };
    }
    // A 200 must be the ok shape.
    if (!isRecord(data) || data.status !== 'ok' || !Array.isArray(data.ops)) return { kind: 'error', message: 'The AI answer had an unexpected shape.' };
    // Each op read on its own.
    const ops = data.ops.map(readOp);
    // One unreadable op means the contract drifted; say so rather than show a partial list.
    if (ops.some((op) => op === null)) return { kind: 'error', message: 'The AI answer had an unexpected shape.' };
    // The bill, every count checked.
    const usage = isRecord(data.usage) ? data.usage : {};
    // The validated answer.
    return {
      kind: 'ok',
      ops: ops.filter((op): op is AssistOp => op !== null),
      dropped: count(data.dropped) ?? 0,
      note: typeof data.note === 'string' ? data.note : '',
      usage: { input: count(usage.input), cached: count(usage.cached), output: count(usage.output), thinking: count(usage.thinking) },
    };
  } catch (cause) {
    // A network drop or a thrown fetch.
    return { kind: 'error', message: `The AI request failed: ${cause instanceof Error ? cause.message : 'no answer'}.` };
  }
}
