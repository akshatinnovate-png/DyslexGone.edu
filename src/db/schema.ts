/** Full relational schema for LUMEN OS. Applied as ordered, idempotent migrations. */
export interface Migration { version: number; name: string; sql: string; }

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core_curriculum',
    sql: `
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_ref TEXT,
      subject TEXT,
      grade INTEGER NOT NULL DEFAULT 6,
      raw_text TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      readability REAL,
      meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documents_subject ON documents(subject);

    CREATE TABLE IF NOT EXISTS doc_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'prose',
      heading TEXT,
      text TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      readability REAL,
      difficulty REAL,
      meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON doc_chunks(document_id, idx);

    CREATE TABLE IF NOT EXISTS concepts (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT 'general',
      grade_min INTEGER NOT NULL DEFAULT 1,
      grade_max INTEGER NOT NULL DEFAULT 12,
      difficulty REAL NOT NULL DEFAULT 0.5,
      bloom TEXT NOT NULL DEFAULT 'understand',
      tags TEXT NOT NULL DEFAULT '[]',
      standards TEXT NOT NULL DEFAULT '[]',
      document_id TEXT,
      meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_concepts_subject ON concepts(subject, grade_min);

    CREATE TABLE IF NOT EXISTS concept_edges (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      rationale TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(from_id, to_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_from ON concept_edges(from_id, kind);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON concept_edges(to_id, kind);

    CREATE TABLE IF NOT EXISTS concept_terms (
      id TEXT PRIMARY KEY,
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      term TEXT NOT NULL,
      definition TEXT NOT NULL DEFAULT '',
      kid_definition TEXT NOT NULL DEFAULT '',
      syllables TEXT NOT NULL DEFAULT '',
      importance REAL NOT NULL DEFAULT 0.5,
      UNIQUE(concept_id, term)
    );

    CREATE TABLE IF NOT EXISTS concept_examples (
      id TEXT PRIMARY KEY,
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '{}',
      quality REAL NOT NULL DEFAULT 0.5
    );
    CREATE INDEX IF NOT EXISTS idx_examples_concept ON concept_examples(concept_id, kind);

    CREATE TABLE IF NOT EXISTS misconceptions (
      id TEXT PRIMARY KEY,
      concept_id TEXT REFERENCES concepts(id) ON DELETE SET NULL,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT 'general',
      severity TEXT NOT NULL DEFAULT 'moderate',
      detector TEXT NOT NULL DEFAULT 'llm',
      signature TEXT NOT NULL DEFAULT '{}',
      remediation TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    `,
  },
  {
    version: 2,
    name: 'learners_and_twin',
    sql: `
    CREATE TABLE IF NOT EXISTS learners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      grade INTEGER NOT NULL DEFAULT 6,
      locale TEXT NOT NULL DEFAULT 'en',
      reading_level REAL NOT NULL DEFAULT 0,
      needs TEXT NOT NULL DEFAULT '[]',
      profile TEXT NOT NULL DEFAULT '{}',
      ability REAL NOT NULL DEFAULT 0,
      ability_se REAL NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learner_mastery (
      learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      p_known REAL NOT NULL DEFAULT 0.15,
      elo REAL NOT NULL DEFAULT 1200,
      attempts INTEGER NOT NULL DEFAULT 0,
      correct INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      stability REAL NOT NULL DEFAULT 0,
      fsrs_difficulty REAL NOT NULL DEFAULT 5,
      reps INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      last_seen TEXT,
      due_at TEXT,
      first_mastered_at TEXT,
      PRIMARY KEY (learner_id, concept_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mastery_due ON learner_mastery(learner_id, due_at);

    CREATE TABLE IF NOT EXISTS learner_modality (
      learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
      modality TEXT NOT NULL,
      alpha REAL NOT NULL DEFAULT 1,
      beta REAL NOT NULL DEFAULT 1,
      trials INTEGER NOT NULL DEFAULT 0,
      reward_sum REAL NOT NULL DEFAULT 0,
      last_at TEXT,
      PRIMARY KEY (learner_id, modality)
    );

    CREATE TABLE IF NOT EXISTS learner_error_patterns (
      learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
      pattern TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      weight REAL NOT NULL DEFAULT 0,
      last_at TEXT,
      PRIMARY KEY (learner_id, pattern)
    );

    CREATE TABLE IF NOT EXISTS learner_misconceptions (
      learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
      misconception_id TEXT NOT NULL,
      concept_id TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      occurrences INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      first_at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      repaired_at TEXT,
      PRIMARY KEY (learner_id, misconception_id)
    );

    CREATE TABLE IF NOT EXISTS learner_events (
      id TEXT PRIMARY KEY,
      learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      concept_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_levents ON learner_events(learner_id, at DESC);

    CREATE TABLE IF NOT EXISTS twin_snapshots (
      id TEXT PRIMARY KEY,
      learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      label TEXT,
      snapshot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots ON twin_snapshots(learner_id, at DESC);
    `,
  },
  {
    version: 3,
    name: 'content_assessment_sessions',
    sql: `
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      stem TEXT NOT NULL,
      choices TEXT NOT NULL DEFAULT '[]',
      answer TEXT NOT NULL DEFAULT '{}',
      rubric TEXT NOT NULL DEFAULT '{}',
      difficulty REAL NOT NULL DEFAULT 0,
      discrimination REAL NOT NULL DEFAULT 1,
      guessing REAL NOT NULL DEFAULT 0.0,
      misconception_map TEXT NOT NULL DEFAULT '{}',
      bloom TEXT NOT NULL DEFAULT 'apply',
      exposures INTEGER NOT NULL DEFAULT 0,
      p_correct REAL,
      accessibility TEXT NOT NULL DEFAULT '{}',
      meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_concept ON items(concept_id, difficulty);

    CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY,
      learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
      item_id TEXT,
      concept_id TEXT,
      session_id TEXT,
      raw TEXT NOT NULL DEFAULT '',
      correct INTEGER NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      hints_used INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 1,
      misconception_id TEXT,
      modality TEXT,
      feedback TEXT NOT NULL DEFAULT '{}',
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_responses_learner ON responses(learner_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_responses_concept ON responses(concept_id, at DESC);

    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      learner_id TEXT,
      modality TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT 'direct',
      title TEXT NOT NULL,
      grade INTEGER NOT NULL DEFAULT 6,
      body TEXT NOT NULL,
      accessibility TEXT NOT NULL DEFAULT '{}',
      verification TEXT NOT NULL DEFAULT '{}',
      provenance TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_concept ON lessons(concept_id, modality);

    CREATE TABLE IF NOT EXISTS experiences (
      id TEXT PRIMARY KEY,
      learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
      session_id TEXT,
      concept_id TEXT,
      kind TEXT NOT NULL,
      modality TEXT,
      ref_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      rationale TEXT NOT NULL DEFAULT '{}',
      delivered_at TEXT NOT NULL,
      completed_at TEXT,
      reward REAL
    );
    CREATE INDEX IF NOT EXISTS idx_experiences_learner ON experiences(learner_id, delivered_at DESC);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
      goal_concept_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      plan TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT '{}',
      metrics TEXT NOT NULL DEFAULT '{}',
      step INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_learner ON sessions(learner_id, started_at DESC);
    `,
  },
  {
    version: 4,
    name: 'experiments_classroom_platform',
    sql: `
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hypothesis TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT 'learner',
      scope TEXT NOT NULL DEFAULT 'global',
      scope_ref TEXT,
      arms TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'running',
      allocation TEXT NOT NULL DEFAULT 'thompson',
      winner TEXT,
      created_at TEXT NOT NULL,
      concluded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS experiment_assignments (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      subject_id TEXT NOT NULL,
      arm TEXT NOT NULL,
      at TEXT NOT NULL,
      UNIQUE(experiment_id, subject_id)
    );

    CREATE TABLE IF NOT EXISTS experiment_observations (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      subject_id TEXT NOT NULL,
      arm TEXT NOT NULL,
      reward REAL NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_obs_exp ON experiment_observations(experiment_id, arm);

    CREATE TABLE IF NOT EXISTS classrooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      teacher TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT 'general',
      grade INTEGER NOT NULL DEFAULT 6,
      meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
      learner_id TEXT NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      PRIMARY KEY (classroom_id, learner_id)
    );

    CREATE TABLE IF NOT EXISTS lesson_packs (
      id TEXT PRIMARY KEY,
      classroom_id TEXT,
      concept_id TEXT,
      document_id TEXT,
      title TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      input TEXT NOT NULL DEFAULT '{}',
      output TEXT,
      trace TEXT NOT NULL DEFAULT '[]',
      cost_usd REAL NOT NULL DEFAULT 0,
      steps INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs ON agent_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS llm_calls (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT '',
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0,
      ms INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 1,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_calls ON llm_calls(at DESC);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',
      rate_limit INTEGER,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'anonymous',
      action TEXT NOT NULL,
      target TEXT,
      status INTEGER,
      ms INTEGER,
      ip TEXT,
      meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_audit ON audit_log(at DESC);

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      failures INTEGER NOT NULL DEFAULT 0,
      last_status INTEGER,
      last_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      route TEXT NOT NULL,
      status INTEGER NOT NULL,
      response TEXT NOT NULL,
      at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL,
      at TEXT NOT NULL
    );
    `,
  },
  {
    version: 5,
    name: 'search_index',
    sql: `
    CREATE TABLE IF NOT EXISTS search_index (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      terms TEXT NOT NULL DEFAULT '',
      subject TEXT,
      grade INTEGER,
      at TEXT NOT NULL,
      UNIQUE(kind, ref_id)
    );
    CREATE INDEX IF NOT EXISTS idx_search_kind ON search_index(kind);
    `,
  },
];
