# Architecture

How the pieces fit, and why each one is built the way it is.

---

## The one rule

**Pedagogy lives in code. Models are an enhancement.**

Every feature has a deterministic path that works with no API key. A hosted
model makes prose richer and authors animations for topics nobody hand-wrote —
but it can never be the reason a feature exists or fails. `npm run doctor`
passes with zero keys.

This is not a limitation we worked around. It is why the system can be audited,
tested, and trusted with a child's learning.

---

## Layers

```
src/
  core/           kernel: config, events, metrics, jobs, cache, limiter,
                  circuit breaker, numerics, linguistics
  db/             node:sqlite, 34 tables, 5 migrations, typed repositories
  llm/            provider-agnostic router + JSON-Schema engine + offline engine
  domain/         the shared vocabulary everything else speaks

  graph/          curriculum knowledge graph + graph algorithms + seed
  twin/           learner digital twin: BKT, Elo, FSRS, bandit, load, patterns
  misconception/  15 rule detectors + 3-stage diagnosis + repair
  accessibility/  readability, simplification, dyslexia render, SSML, phonics
  assessment/     IRT 3PL, item generation, grading, self-explanation
  engines/        animation (primitives → compiler → SVG), virtual labs, visual
  orchestrator/   adaptive policy + session state machine
  ingestion/      multi-format extraction → concepts → graph
  teacher/        lesson packs, classroom grouping
  analytics/      learner, cohort, and system-effectiveness reporting
  api/            fastify server, guards, routes, generated OpenAPI
  cli/            doctor, demo, seed
```

Dependencies point downward only. `core/` imports nothing from the project.

---

## Key decisions

### node:sqlite, not an ORM

Zero native modules means `npm install` cannot fail on a judge's laptop, and the
whole database is one file you can copy. Repositories give typed access without
the weight of an ORM.

### The model authors, the compiler renders

A hand-written animation per concept does not scale — 21 builders cannot cover
109 concepts, let alone an uploaded chapter.

So the model emits a **storyboard** against a flat JSON schema, and deterministic
code turns it into SVG. The split matters: models are good at deciding *what
explains a concept* and bad at pixel geometry, so geometry stays where it can be
validated.

The schema is deliberately flat. Discriminated unions are the fastest way to get
malformed model output, so every element is one object with optional fields and
a sanitizer does the translation. Complex structures use compact string
encodings (`"C:0,0 O:-28,0"`) for the same reason.

**The sanitizer trusts nothing.** Ids are made unique, animation targets must
resolve, colours must be palette names (raw hex and `javascript:` URLs are
refused), geometry is clamped, a `numberLine` step that would draw 10,000 ticks
is repaired, a `fractionBar` cannot be shaded past its own parts, runaway
runtime is compressed — and every change is recorded, so the result is auditable
rather than mysterious.

### SMIL, not frames

The renderer emits one self-contained animated SVG. No video pipeline, a few KB,
crisp at any zoom (which matters for low vision), with `<title>`/`<desc>` for
screen readers.

SMIL can animate an SVG *attribute* but not geometry-changing channels like "how
many parts of this bar are shaded". Those are **baked**: sampled where the motion
actually is, deduplicated, and cut between with frame-accurate visibility
windows. A discrete channel costs 4 variants, not 40.

### Three-stage misconception diagnosis

Cheapest and most certain first:

1. **Distractor mapping** — the item author already said what each wrong option
   means. Free and exact.
2. **Rule detectors** — re-derive the learner's answer from a hypothesised wrong
   procedure. If `(a+c)/(b+d)` reproduces `3/7` exactly, that is evidence.
3. **Model**, constrained to the documented catalogue, capped *below* rule
   evidence so it can never outrank arithmetic that was literally reproduced.

If nothing explains the answer, nothing is claimed. A false diagnosis is worse
than none.

### Four learning engines, not one

BKT answers "does this learner know X". Elo answers "how hard an item can they
handle" **and calibrates the item bank from the same observation**, which BKT
cannot. FSRS answers "will they still know it in three weeks". The bandit
answers "which representation works for *this* learner".

Running them together means they cross-check: a mis-tagged item shows up as a
divergence between the Elo surprise and the BKT prediction.

### Priority, not a scheduler

The policy scores candidate actions and ranks them by a deliberate priority
order:

```
safety ▸ misconception repair ▸ prerequisite repair ▸ switch representation
       ▸ recovery ▸ review ▸ teach ▸ practise ▸ extend ▸ celebrate
```

A misconception outranks new material because it is a *confident wrong rule*
that will corrupt everything built on top of it. Overload outranks everything,
because pushing on is how a bad session becomes a bad relationship with a
subject.

Every candidate returns its reasoning, so `GET /v1/sessions/:id/decision` shows
what was rejected and why. A teacher can disagree with it.

### Delivery counts prevent loops

A concept already explained this session escalates to a different
representation. One explained twice with nothing to show for it yields to the
next gap. **Repeating the same explanation louder is not repair.**

### Every concept must be assessable

A concept the system can teach but never check stalls the entire adaptation
loop. So item banks are topped up on demand by 24 concept generators plus
generic ones built from the concept's own glossary and description.

Where a misconception is documented, distractors are **computed from the wrong
rule**, so generated items diagnose exactly like hand-authored ones.

### Chapter, don't compress

When an explanation outruns a learner's attention block, it is split on beat
boundaries. Speeding it up for someone who needs processing time is exactly
backwards.

---

## The adaptation loop

```
         ┌──────────────────────────────────────────────┐
         │                                              │
         ▼                                              │
   policy.decide()                                      │
   scores candidates, ranks by priority                 │
         │                                              │
         ▼                                              │
   bandit.selectModality()                              │
   Thompson sampling, access profile as prior           │
         │                                              │
         ▼                                              │
   session.deliver()                                    │
   lesson · repair · lab · review · break · celebration │
         │                                              │
         ▼                                              │
   learner answers                                      │
         │                                              │
         ▼                                              │
   grade → diagnose → BKT → Elo → FSRS → bandit ────────┘
           ↳ misconception noted, or decayed and closed
           ↳ item exposure and calibration updated
           ↳ load and friction recomputed
```

One response updates every engine, calibrates the item, moves the bandit, logs
or closes a misconception, recomputes load and friction, and reports what the
answer just unlocked.

---

## Failure behaviour

| Failure | Response |
|---|---|
| No API key | Offline engine; every feature works |
| Model unreachable | Circuit breaker opens, falls through to offline |
| Model returns malformed JSON | Coerced, validated, repaired, then offline |
| Scene fails its audit | One repair round → curated builder → structural scene |
| Concept has no items | Generated on demand |
| Visual build throws | Lesson is delivered without it |
| Upload is a scan or compressed PDF | States what it would need; writes nothing |
| Spend ceiling hit | Hosted providers skipped, offline continues |
| Uncaught exception | Logged and exits for a supervisor to restart |

Nothing silently degrades into something that *looks* like it worked.

---

## Testing

252 tests. The ones that matter most assert things that would be easy to fake:

- A random wrong answer produces **no** diagnosis
- Every one of the 109 concepts can produce a check
- Generated maths answers are independently recomputed in the test
- 45° maximises projectile range; complementary angles tie
- Momentum is conserved at every restitution; energy only when elastic
- Pendulum period scales with √length; the slipping angle is mass-independent
- IRT recovers a known ability and a known item difficulty
- Hostile model output cannot inject script tags or raw hex
- A sanitized storyboard always compiles and renders
- Prompt scaffolding never leaks into learner-facing narration
- Chaptering never alters scene timing and never loses a beat
