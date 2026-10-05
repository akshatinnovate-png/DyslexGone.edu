# LUMEN OS

**An adaptive accessibility operating system for education.**

Every student receives the same knowledge. The knowledge is transformed into the
representation their brain can actually reach.

Not a chatbot. Not a video generator. Not a dyslexia reader. An intelligence
layer that sits between curriculum and student, works out *why* a learner is
stuck, and changes what it does about it.

```
npm install && npm run build && npm run doctor   # 11/11 checks, ~200ms, no API key needed
npm run demo                                     # the whole loop, narrated
npm start                                        # http://localhost:8080
```

---

## It runs with no API key

Every feature below is computation, not prompting. The curriculum graph, the
learner model, the misconception detectors, the physics solvers, the
accessibility transformer and 21 animations are all deterministic code.

A hosted model is an **upgrade** — it writes animations for topics nobody
hand-authored, and improves prose. It is never a dependency. `npm run doctor`
passes with zero keys configured.

| Provider | Default model | Set |
|---|---|---|
| Groq | `openai/gpt-oss-120b` | `GROQ_API_KEY` |
| Anthropic | `claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |
| Any OpenAI-compatible | `gpt-4o-mini` | `OPENAI_API_KEY`, `OPENAI_BASE_URL` |

---

## What it actually does

### 1. It finds the real problem, not the visible one

A student fails at ratios. Most systems reteach ratios.

```
GET /v1/learners/{id}/gaps/ratios
```
```
"The visible struggle is at the target, but 2 upstream concepts are weak.
 Deepest root cause: Division at 33% mastery, 1 step upstream, blocking 2
 downstream concepts. Repair that before returning to the target."

 repair route: Division → Fractions → Ratios
```

The prerequisite trace walks backwards through the curriculum graph, scores each
gap by depth and by how much it blocks, and returns a repair route ordered
root-cause first.

### 2. It diagnoses the wrong rule, not the wrong answer

`2/3 + 1/4 = 3/7` is not carelessness. It is a consistent, wrong procedure.

```
POST /v1/misconceptions/diagnose  { "stem": "What is 2/3 + 1/4?", "learnerAnswer": "3/7" }
```
```
FRAC_ADD_CROSS  ·  confidence 0.95  ·  source: rule_detector

"Applying 'add the tops, add the bottoms' to 2/3 + 1/4 gives exactly 3/7,
 which is the answer given. The learner is treating a fraction as two
 independent numbers rather than one quantity."
```

15 rule detectors re-derive the learner's answer from a hypothesised faulty
procedure. If the hypothesis reproduces their answer exactly, that is evidence —
not a guess. **A random wrong answer produces no diagnosis at all**, because a
false diagnosis is worse than none.

Repair leads with *contradiction*: the learner watches their own rule break
before anything is corrected.

### 3. It changes the representation when one isn't landing

```
[1] repair_prerequisite  lesson/worked_example   Division       ✗
[2] repair_prerequisite  lesson/diagram          Fractions      ✓  41% → 70%
[3] switch_modality      lesson/manipulative     Division       ✓  26% → 57%
      "Division was already explained once this session without it landing.
       Same concept, different representation — repeating the same explanation
       louder does not work."
[4] switch_modality      lesson/audio            Fractions      ✓  70% → 88%
      UNLOCKED  Equivalent Fractions, Decimals, Percentages, Ratios, Probability
```

Modality is chosen by Thompson sampling over 12 representations, with the
learner's access profile folded in as *pseudo-counts* — so a learner who needs
audio starts with audio ahead, and real evidence can still overturn it.

### 4. It generates the animation, it doesn't store it

`fractionAddition(3/5, 2/7)` finds LCM 35 and builds the correct animation for
those exact numbers. That is what makes targeted remediation possible.

For the other 90% of topics, **the model authors a storyboard and the compiler
renders it**. The model never emits SVG — it composes beats from 29 pedagogical
primitives (a `fractionBar` knows about equal parts, a `forceVector` knows that
length means magnitude), which are then sanitized, clamped, compiled and
audited by code.

Output is a single self-contained **animated SVG**: a few KB, crisp at any zoom,
with `<title>`/`<desc>` for screen readers, synchronised captions, and a
`reduceMotion` render. No video pipeline.

Nothing unaudited reaches a learner. If the audit fails, the issues go back to
the model once; then the curated builder; then a deterministic structural
animation built from the source text alone.

### 5. The labs are real solvers

```
POST /v1/labs/circuit/run  { "preset": "series", "voltage": 12, "resistance1": 100, "resistance2": 200 }
```
```
Total current 0.04 A · Equivalent resistance 300 Ω · R2 voltage 8 V

"Every component carries the same current, which is what 'in series' means.
 The voltage is what gets shared out."
```

DC circuits by **modified nodal analysis**. Projectiles by **RK4** with drag. A
**full nonlinear pendulum**, so the small-angle approximation can be tested
rather than asserted. Chemical equations balanced by **exact-fraction integer
nullspace**. Titration curves, Punnett squares, Hardy-Weinberg.

A student can ask something the author never anticipated and get a true answer.

### 6. One transform, every doorway

```
POST /v1/accessibility/transform
```
Returns, from one call: simplified text at the target grade, an "explain it like
I'm 7" retelling, a structural outline, bullets, the single load-bearing
sentence, a Socratic question ladder, a glossary with syllable breaks,
grapheme-phoneme decoding support, a typography + WCAG palette plan, eye-span
reading chunks, bionic emphasis, SSML with word-level timings, WebVTT captions,
alt text, and a ranked list of which modalities suit this learner and this text.

Simplification is **rule-based and auditable** — every change is listed with its
reason. Passive→active rewriting uses a curated verb table and *refuses* to
transform a verb it doesn't know, because guessing a conjugation is how
simplifiers invent non-words.

### 7. It tells a teacher what to do in the next 40 minutes

```
POST /v1/classrooms/{id}/grouping  { "concepts": ["fraction-addition"] }
```
```
12 students, 3 groups. Your time goes to "Rebuild: Division" — that group
cannot access today's lesson at all until it is fixed.
Access needs in the room: dyslexia (4), working memory (1), adhd (2).

  Repair: Adding numerators and denominators separately   (4 students, 5 min)
    Run the repair sequence. Start by making their own rule fail in front of them.

  Rebuild: Division                                       (6 students, 15 min)
    Pull this group aside and rebuild Division with a concrete model before
    they attempt the main task.
```

Groups are formed from **mastery vectors**, not an overall score — "struggling at
maths" is not an instruction; "these six are missing division" is.

`POST /v1/teacher/lesson-pack` returns the whole Sunday-evening job: objective,
success criteria, a hook that opens with the misconception, the lesson at three
differentiated reading levels, a quiz whose answer key says *what it means if
they chose B*, a worksheet, the misconceptions to watch for, and an activity.

### 8. Seven agents, one blackboard, QA with veto

```
POST /v1/agents/forge  { "conceptSlug": "fraction-addition", "learnerId": "..." }
```

| Agent | Its one question |
|---|---|
| Curriculum | What must be taught, and what must come first? |
| Learner | What does *this* student need right now? |
| Accessibility | How should it be presented? |
| Language | What do the words have to become? |
| Animation | How can it be shown? |
| Assessment | How will we know it landed? |
| **QA / Safety** | **Is this fit to put in front of a child?** |

Most of them call engines rather than models — the agent framing buys
orchestration and traceability, not a reason to prompt for something we can
compute. Every step records what it did and why; `GET /v1/agents/runs/:id`
returns the whole trace.

The QA agent has **veto**. Nothing ships that it rejects. It runs ten
deterministic checks — known falsehoods, demeaning language, meta-language that
breaks character, unfilled placeholders, reading level, whether the subject
vocabulary survived, whether remediation actually contrasts the wrong idea with
the right one — and each finding names its evidence.

Content that *names* a misconception in order to refute it is allowed. Content
that states one is blocked.

Uploaded curriculum is treated as untrusted input: PII is redacted before
anything reaches a hosted model, and instruction-like text in a PDF is
neutralised rather than obeyed.

### 9. It runs experiments on itself

```
POST /v1/experiments/compare-modalities
  { "conceptId": "fraction-addition", "modalities": ["animation", "text"] }
```
```
"animation" is best with 97% probability (mean reward 0.89 against 0.21).
That is a 324% lift over the control. Ship it.
```

Arms are assigned by Thompson sampling, so a losing arm stops consuming
learners as evidence accumulates. Conclusions use Bayesian probability-of-
superiority, because a teacher asks "how sure are we that A is better", not
"would we reject the null".

It refuses to conclude without enough evidence, and reports genuinely
equivalent arms as **inconclusive** rather than inventing a winner.

---

## The architecture

```
  CURRICULUM IN  ──▶  INGESTION  ──▶  KNOWLEDGE GRAPH  ──┐
  md·html·pdf·csv    concepts,        109 concepts,      │
                     hard sections,   179 links,         │
                     vocabulary       0 cycles           │
                                                         ▼
  LEARNER  ──────▶  DIGITAL TWIN  ─────────────▶  ORCHESTRATOR
  responses         BKT · Elo · FSRS · bandit     "what next, and why?"
                    load · friction · patterns            │
                                                          ▼
         ┌────────────────┬───────────────┬───────────────┬──────────────┐
         ▼                ▼               ▼               ▼              ▼
   ACCESSIBILITY     ANIMATION       VIRTUAL LAB     ASSESSMENT    MISCONCEPTION
   TRANSFORMER       model-authored  real solvers    IRT 3PL       15 detectors
   8 formulas        SVG runtime     10 experiments  item gen      + repair
         └────────────────┴───────────────┴───────────────┴──────────────┘
                                   │
                                   ▼
                          CONTINUOUS FEEDBACK ──▶ back into the twin
```

### The four engines inside the twin

They run together and cross-check each other.

| Engine | Answers | Why both |
|---|---|---|
| **BKT** | Does this learner know concept X? | Per-concept belief with slip/guess |
| **Elo** | How hard an item can they handle? | Self-calibrates the item bank, which BKT cannot |
| **FSRS** | Will they still know it in three weeks? | Drives review and Knowledge Recovery |
| **Bandit** | Which representation works *for them*? | Thompson sampling, access profile as prior |

Plus cognitive load decomposed into eight contributors, and behavioural friction
signals — retry storms, error streaks, long pauses, hint dependence,
speed-running — each carrying its own evidence string.

**This is behaviour, never emotion inference.** The system responds to friction;
it does not label the child. Every intervention names the signal that triggered
it.

---

## API

110 operations. `GET /v1/openapi.json` is generated from the live route table.

```
GET  /health /health/deep /metrics /v1/capabilities
GET  /v1/events/stream                    server-sent, every domain event live

POST /v1/learners                         create, derive access profile
GET  /v1/learners/:id/twin                the full digital twin
GET  /v1/learners/:id/gaps/:conceptId     prerequisite trace
GET  /v1/learners/:id/frontier            what they are ready for

POST /v1/sessions                         start against a goal
GET  /v1/sessions/:id/decision            inspect the policy without delivering
POST /v1/sessions/:id/next                decide and deliver
POST /v1/sessions/:id/answer              grade, diagnose, update every engine
GET  /v1/sessions/:id/trace               why each step happened

POST /v1/accessibility/transform          every doorway at once
POST /v1/visuals                          animation for any concept or topic
GET  /v1/visuals/:slug.svg                directly renderable
POST /v1/labs/:id/run                     real solvers
POST /v1/misconceptions/diagnose          which wrong rule produced this
POST /v1/ingest                           curriculum in, graph out

POST /v1/teacher/lesson-pack              the whole teaching pack
POST /v1/classrooms/:id/grouping          who needs what, right now
GET  /v1/analytics/effectiveness          is the OS itself working?

POST /v1/agents/forge                     seven agents, QA with veto
GET  /v1/agents/runs/:id                  the full reasoning trace
POST /v1/safety/verify                    is this fit for a child, and why
POST /v1/safety/redact                    strip PII, neutralise injections
POST /v1/experiments/compare-modalities   which explanation actually works
POST /v1/webhooks                         subscribe another platform
```

Guards: API keys, token-bucket rate limiting (generation costs more), full
idempotency replay, an audit log of every write, and one error shape that never
leaks a stack trace.

---

## It measures itself

`GET /v1/analytics/effectiveness` reports on the system, not the student — and
it is willing to say it is failing:

```
misconceptions  4 detected, 0 repaired
                "Detection is outpacing repair. Check whether repair steps are
                 actually being delivered."

item bank       325 items, 8% diagnostic
                "Few items carry diagnostic distractors, so most wrong answers
                 cannot be explained."
```

---

## Honest limits

- **Images and audio need OCR/ASR**, which this build does not ship. An upload
  says exactly what it would need rather than returning an empty document that
  looks like success.
- **Compressed PDF text streams** are not decoded. It says so.
- Generated prose from the offline engine is *structural*, not eloquent. With a
  model key it gets good; without one it stays correct and plain.
- Concept detection from headings is good; from unstructured prose it is
  serviceable. A model pass improves recall.

---

## Stack

TypeScript on Node 22. **Zero native dependencies** — storage is `node:sqlite`,
so there is nothing to compile. Three runtime dependencies: `fastify`, `zod`,
`@anthropic-ai/sdk`.

286 tests covering convergence bounds, spacing effects, bandit convergence,
Ohm's law, momentum conservation, 9:3:3:1 dihybrid ratios, IRT ability recovery,
hostile model output, prompt-injection neutralisation, and that a random wrong
answer is **not** diagnosed.

```
npm run doctor      11 self-checks
npm test            286 tests
npm run demo        the full loop, narrated
npm run seed        idempotent curriculum seed
npm start           the API
```

See `ARCHITECTURE.md` for how the pieces fit, and `.env.example` for every knob.
