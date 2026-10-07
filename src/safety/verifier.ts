import type { Concept } from '../domain/types.js';
import { analyzeReadability } from '../accessibility/readability.js';
import { sentences, words, truncate } from '../core/textkit.js';
import { clamp, round } from '../core/mathx.js';

/** THE EXPLANATION QUALITY CHECKER
 *
 *  Generated educational content is not shown to a child because a model
 *  produced it. It is shown because it survived this.
 *
 *  Every check is deterministic and names its evidence, so a teacher can see
 *  exactly why something was blocked - and overrule it. */

export type Severity = 'block' | 'warn' | 'note';

export interface Finding {
  check: string;
  severity: Severity;
  message: string;
  evidence?: string;
}

export interface VerificationResult {
  verdict: 'approved' | 'approved_with_warnings' | 'rejected';
  score: number;
  findings: Finding[];
  checked: string[];
  summary: string;
}

export interface VerifyInput {
  text: string;
  concept?: Concept;
  grade: number;
  /** Vocabulary that must survive. */
  keyTerms?: string[];
  /** The misconception this content is supposed to attack. */
  misconception?: string;
  kind?: 'lesson' | 'remediation' | 'item' | 'narration' | 'feedback';
}

/* ------------------------------ the checks -------------------------------- */

const UNSAFE = [
  { re: /\b(kill|suicide|self[- ]harm|weapon|bomb|explosive|poison yourself)\b/i, label: 'harmful content' },
  { re: /\b(stupid|idiot|dumb|lazy|worthless|retard)\b/i, label: 'language that demeans the learner' },
  { re: /\byou (?:are|'re) (?:bad|terrible|hopeless|never going to)\b/i, label: 'discouraging framing' },
];

const HEDGES = /\b(?:I think|maybe|probably|it seems|I'm not sure|possibly|might be|could be)\b/gi;
const META = /\b(?:as an AI|language model|I cannot|I don't have access|as requested|here is the|in this (?:lesson|response))\b/i;
const PLACEHOLDER = /\[(?:insert|your|topic|concept|description|TODO|placeholder|xxx)[^\]]*\]|\{\{[^}]+\}\}|lorem ipsum/i;
const ABSOLUTE = /\b(?:always|never|all|none|every single|impossible|without exception)\b/gi;

/** Claims that are flatly wrong and appear constantly in generated content. */
const KNOWN_FALSEHOODS: { re: RegExp; correction: string }[] = [
  { re: /heavier objects?\s+(?:\w+\s+){0,2}fall(?:s)? faster/i, correction: 'in the absence of air resistance, all objects fall at the same rate' },
  { re: /seasons? (?:are |is )?caused by (?:the )?distance/i, correction: 'seasons are caused by axial tilt, not distance' },
  { re: /current is used up/i, correction: 'charge is conserved; energy is what is transferred' },
  { re: /plants (?:get|take) (?:their )?food from (?:the )?soil/i, correction: 'plants build food from carbon dioxide and water using light' },
  { re: /blood is blue/i, correction: 'deoxygenated blood is dark red, never blue' },
  { re: /we (?:only )?use 10 ?% of our brains?/i, correction: 'this is a myth with no basis' },
  { re: /\bbigger denominators? (?:mean|means|make) (?:a )?bigger fractions?/i, correction: 'more parts means smaller parts' },
  { re: /multiplication\s+(?:\w+\s+){0,2}makes? (?:numbers )?bigger/i, correction: 'multiplying by a value below one makes it smaller' },
  { re: /dividing\s+(?:\w+\s+){0,2}makes? (?:numbers )?smaller/i, correction: 'dividing by a value below one makes it larger' },
];

export function verify(input: VerifyInput): VerificationResult {
  const findings: Finding[] = [];
  const checked: string[] = [];
  const text = input.text ?? '';
  const push = (check: string, severity: Severity, message: string, evidence?: string) =>
    findings.push({ check, severity, message, evidence });

  /* ---------------------------- 1. substance ----------------------------- */
  checked.push('substance');
  const wordCount = words(text).length;
  if (wordCount < 8) {
    push('substance', 'block', `Only ${wordCount} words - there is no explanation here.`);
  }
  if (PLACEHOLDER.test(text)) {
    push('substance', 'block', 'Contains an unfilled placeholder.', text.match(PLACEHOLDER)?.[0]);
  }

  /* ------------------------------ 2. safety ------------------------------ */
  checked.push('safety');
  for (const u of UNSAFE) {
    const m = text.match(u.re);
    if (m) push('safety', 'block', `Contains ${u.label}.`, m[0]);
  }

  /* ---------------------------- 3. factuality ---------------------------- */
  checked.push('factuality');
  for (const f of KNOWN_FALSEHOODS) {
    const m = text.match(f.re);
    if (!m) continue;
    // A sentence that NAMES the falsehood in order to refute it is fine - that
    // is exactly what good remediation does.
    // The refutation almost always arrives in the NEXT sentence ("...fall
    // faster. That is not true: ..."), so look at a window, not one sentence.
    const all = sentences(text);
    const at = all.findIndex((s) => f.re.test(s));
    const window = at < 0 ? text : all.slice(Math.max(0, at - 1), at + 3).join(' ');
    const sentence = at < 0 ? truncate(text, 160) : all[at];
    const refuting = /\b(?:not|isn't|is not|wrong|myth|incorrect|does not|cannot|untrue|mistake|trap|tempting|actually|in fact|common error)\b/i.test(window);
    if (refuting) {
      push('factuality', 'note', 'Names a known misconception in order to correct it, which is intended.', truncate(sentence, 120));
    } else {
      push('factuality', 'block', `States a known falsehood: ${f.correction}.`, truncate(sentence, 160));
    }
  }

  /* --------------------------- 4. meta-language -------------------------- */
  checked.push('voice');
  if (META.test(text)) {
    push('voice', 'block', 'Breaks character - talks about the system instead of teaching.', text.match(META)?.[0]);
  }
  const hedges = text.match(HEDGES) ?? [];
  if (hedges.length >= 3) {
    push('voice', 'warn', `${hedges.length} hedging phrases. A learner reads uncertainty as "this might be wrong".`, hedges.slice(0, 3).join(', '));
  }

  /* ------------------------- 5. reading level ---------------------------- */
  checked.push('reading_level');
  if (wordCount >= 15) {
    const r = analyzeReadability(text, input.grade);
    const gap = r.gradeLevel - input.grade;
    if (gap > 4) {
      push('reading_level', 'block', `Reads at grade ${r.gradeLevel}, ${round(gap, 1)} above the target of ${input.grade}.`);
    } else if (gap > 2) {
      push('reading_level', 'warn', `Reads at grade ${r.gradeLevel}, ${round(gap, 1)} above target.`);
    }
    const longest = sentences(text).reduce((a, s) => Math.max(a, words(s).length), 0);
    if (longest > 40) {
      push('reading_level', 'warn', `Longest sentence is ${longest} words.`);
    }
  }

  /* ------------------------ 6. vocabulary survived ----------------------- */
  if (input.keyTerms?.length) {
    checked.push('vocabulary');
    const lower = text.toLowerCase();
    const missing = input.keyTerms.filter((t) => !lower.includes(t.toLowerCase()));
    if (missing.length === input.keyTerms.length) {
      push('vocabulary', 'block', `None of the subject vocabulary survived: ${missing.join(', ')}.`);
    } else if (missing.length) {
      push('vocabulary', 'warn', `Subject vocabulary dropped: ${missing.join(', ')}.`);
    }
  }

  /* --------------------- 7. does it address the target? ------------------ */
  if (input.concept) {
    checked.push('relevance');
    const head = input.concept.label.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const lower = text.toLowerCase();
    const hits = head.filter((w) => lower.includes(w)).length;
    if (head.length && hits === 0) {
      push('relevance', 'warn', `Never mentions "${input.concept.label}". It may be explaining something else.`);
    }
  }

  /* --------------------- 8. does it attack the misconception? ------------ */
  if (input.misconception && input.kind === 'remediation') {
    checked.push('targets_misconception');
    const contrasts = /\b(?:not|wrong|but|however|instead|actually|watch|trap|tempting|does not)\b/i.test(text);
    if (!contrasts) {
      push('targets_misconception', 'warn',
        'Remediation never contrasts the wrong idea with the right one. Being told something is wrong does not dislodge it - watching it fail does.');
    }
  }

  /* --------------------------- 9. overclaiming --------------------------- */
  checked.push('overclaiming');
  const absolutes = text.match(ABSOLUTE) ?? [];
  if (absolutes.length >= 4) {
    push('overclaiming', 'note', `${absolutes.length} absolute claims. Science rarely deals in "always" and "never".`, absolutes.slice(0, 3).join(', '));
  }

  /* ---------------------------- 10. age fit ------------------------------ */
  checked.push('age_appropriate');
  if (input.grade <= 6 && /\b(?:derivative|integral|logarithm|quantum|stochastic|epistemolog|entropy of)\b/i.test(text)) {
    push('age_appropriate', 'warn', 'Uses concepts well beyond this grade band.');
  }

  /* ----------------------------- verdict --------------------------------- */
  const blocks = findings.filter((f) => f.severity === 'block');
  const warns = findings.filter((f) => f.severity === 'warn');
  const score = round(clamp(1 - blocks.length * 0.4 - warns.length * 0.12 - findings.filter((f) => f.severity === 'note').length * 0.03), 3);

  const verdict: VerificationResult['verdict'] = blocks.length ? 'rejected'
    : warns.length ? 'approved_with_warnings' : 'approved';

  return {
    verdict,
    score,
    findings,
    checked,
    summary: blocks.length
      ? `Rejected: ${blocks.map((b) => b.message).join(' ')}`
      : warns.length
        ? `Approved with ${warns.length} warning(s): ${warns[0].message}`
        : `Approved. ${checked.length} checks passed.`,
  };
}

/* ---------------------------- privacy + injection -------------------------- */

/** `keep` names a capture group that is preserved; everything else the
 *  pattern matched is replaced. It exists so a cue word can qualify a weak
 *  number pattern without being swallowed by the redaction. */
const PII_PATTERNS: { label: string; re: RegExp; keep?: number }[] = [
  { label: 'email address', re: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g },
  // The leading boundary is captured and kept so a bracketed area code is
  // removed whole, rather than leaving an orphan "(" behind.
  { label: 'phone number', re: /(^|[^\w)])(?:\+?\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/g, keep: 1 },
  // A seven-digit local number is too weak a pattern to redact on sight - it
  // would eat "100 2000" out of a maths worksheet - so it only counts when a
  // cue word says it is a number to call. The cue is kept; the digits go.
  {
    label: 'phone number',
    re: /\b((?:call|phone|telephone|tel|text|dial|contact|reach(?:ed|es)? (?:me|us|him|her|them))\b[^\n]{0,24}?)\b\d{3}[ -]\d{4}\b/gi,
    keep: 1,
  },
  { label: 'national id', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: 'card number', re: /\b(?:\d{4}[ -]?){3}\d{4}\b/g },
  { label: 'postal address', re: /\b\d{1,5}\s+[A-Z][a-z]+\s+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr)\b/g },
  { label: 'date of birth', re: /\b(?:0?[1-9]|[12]\d|3[01])[/-](?:0?[1-9]|1[012])[/-](?:19|20)\d{2}\b/g },
];

export interface RedactionResult {
  text: string;
  found: { label: string; count: number }[];
  redacted: boolean;
}

/** Student work goes to a hosted model. Their phone number does not. */
export function redactPii(text: string): RedactionResult {
  let out = text;
  const found: { label: string; count: number }[] = [];
  const counts = new Map<string, number>();
  for (const p of PII_PATTERNS) {
    const matches = out.match(p.re);
    if (!matches?.length) continue;
    counts.set(p.label, (counts.get(p.label) ?? 0) + matches.length);
    out = p.keep === undefined
      ? out.replace(p.re, `[${p.label} removed]`)
      : out.replace(p.re, (...args) => `${args[p.keep!]}[${p.label} removed]`);
  }
  for (const [label, count] of counts) found.push({ label, count });
  return { text: out, found, redacted: found.length > 0 };
}

const INJECTION = [
  /ignore (?:all |any )?(?:previous|prior|above) instructions/i,
  /disregard (?:your|the) (?:instructions|rules|system prompt)/i,
  /you are now (?:a|an|in) /i,
  /\bsystem\s*:\s*/i,
  /<\|im_start\|>|<\|endoftext\|>|\[\/?INST\]/i,
  /reveal (?:your|the) (?:system )?prompt/i,
  /pretend (?:you are|to be)/i,
];

export interface InjectionCheck {
  suspicious: boolean;
  patterns: string[];
  /** The text with the suspicious spans neutralised. */
  sanitized: string;
}

/** Uploaded curriculum is untrusted input. A textbook PDF can contain anything. */
export function checkInjection(text: string): InjectionCheck {
  const patterns: string[] = [];
  let sanitized = text;
  for (const re of INJECTION) {
    const m = text.match(re);
    if (!m) continue;
    patterns.push(m[0]);
    sanitized = sanitized.replace(re, '[instruction-like text removed]');
  }
  return { suspicious: patterns.length > 0, patterns, sanitized };
}
