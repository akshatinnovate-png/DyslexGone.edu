import type { FastifyInstance } from 'fastify';

/** A real OpenAPI document generated from the routes Fastify actually has,
 *  plus hand-written descriptions. Generated rather than maintained by hand, so
 *  it cannot drift out of date with the code. */
export function buildOpenApi(app: FastifyInstance): () => unknown {
  let cached: unknown;

  const DESCRIPTIONS: Record<string, { summary: string; tag: string }> = {
    'GET /': { summary: 'Service banner', tag: 'meta' },
    'GET /health': { summary: 'Liveness and basic checks', tag: 'meta' },
    'GET /health/deep': { summary: 'Graph health, model router state, jobs and event counts', tag: 'meta' },
    'GET /metrics': { summary: 'Prometheus metrics', tag: 'meta' },
    'GET /v1/capabilities': { summary: 'Everything this deployment can do: modalities, needs, labs, animations, models', tag: 'meta' },
    'GET /v1/events/stream': { summary: 'Server-sent stream of every domain event as it happens', tag: 'events' },
    'GET /v1/events/recent': { summary: 'Recent domain events', tag: 'events' },
    'GET /v1/concepts': { summary: 'List concepts', tag: 'curriculum' },
    'POST /v1/concepts': { summary: 'Create a concept', tag: 'curriculum' },
    'GET /v1/concepts/:id': { summary: 'Concept detail with prerequisites, terms, misconceptions and centrality', tag: 'curriculum' },
    'POST /v1/concepts/:id/links': { summary: 'Link two concepts (cycles are rejected)', tag: 'curriculum' },
    'GET /v1/graph': { summary: 'The whole curriculum graph, optionally overlaid with one learner mastery', tag: 'graph' },
    'GET /v1/graph/health': { summary: 'Cycles, orphans, components and sequencing errors', tag: 'graph' },
    'GET /v1/graph/central': { summary: 'Load-bearing concepts by PageRank and bottlenecks by betweenness', tag: 'graph' },
    'GET /v1/graph/path': { summary: 'Shortest learning path between two concepts', tag: 'graph' },
    'POST /v1/learners': { summary: 'Create a learner and derive their access profile', tag: 'learners' },
    'GET /v1/learners/:id/twin': { summary: 'The full digital twin: mastery, modality evidence, load, friction, decay', tag: 'learners' },
    'GET /v1/learners/:id/gaps/:conceptId': { summary: 'Prerequisite trace: the root cause behind a struggle', tag: 'learners' },
    'GET /v1/learners/:id/frontier': { summary: 'What this learner is ready to learn next', tag: 'learners' },
    'POST /v1/sessions': { summary: 'Start an adaptive session', tag: 'sessions' },
    'POST /v1/sessions/:id/next': { summary: 'Decide and deliver the next experience', tag: 'sessions' },
    'GET /v1/sessions/:id/decision': { summary: 'The policy decision, without delivering it', tag: 'sessions' },
    'POST /v1/sessions/:id/answer': { summary: 'Record an answer; updates every engine and diagnoses errors', tag: 'sessions' },
    'GET /v1/sessions/:id/trace': { summary: 'Why the system chose each step', tag: 'sessions' },
    'POST /v1/accessibility/transform': { summary: 'The Universal Accessibility Transformer', tag: 'accessibility' },
    'POST /v1/accessibility/analyze': { summary: 'Eight readability formulas plus per-sentence difficulty', tag: 'accessibility' },
    'POST /v1/accessibility/simplify': { summary: 'Rule-based simplification with an audit of every change', tag: 'accessibility' },
    'POST /v1/accessibility/speech': { summary: 'SSML, word timings and WebVTT captions', tag: 'accessibility' },
    'POST /v1/visuals': { summary: 'Build an animated explanation for any concept or topic', tag: 'visuals' },
    'GET /v1/labs': { summary: 'Interactive experiments backed by real solvers', tag: 'labs' },
    'POST /v1/labs/:id/run': { summary: 'Run an experiment', tag: 'labs' },
    'POST /v1/misconceptions/diagnose': { summary: 'Work out which wrong rule produced an answer', tag: 'misconceptions' },
    'POST /v1/ingest': { summary: 'Turn raw curriculum into concepts, links, items and an accessibility report', tag: 'ingestion' },
    'POST /v1/teacher/lesson-pack': { summary: 'A full teaching pack for a concept', tag: 'teacher' },
    'GET /v1/classrooms/:id/grouping': { summary: 'Split a class into teaching groups by what they actually need', tag: 'classroom' },
  };

  return () => {
    if (cached) return cached;

    const paths: Record<string, Record<string, unknown>> = {};
    const routes = app.printRoutes({ commonPrefix: false });
    void routes;

    for (const route of collectRoutes(app)) {
      const openapiPath = route.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const key = `${route.method} ${route.url}`;
      const meta = DESCRIPTIONS[key];
      const params = [...route.url.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
        name: m[1], in: 'path', required: true, schema: { type: 'string' },
      }));
      paths[openapiPath] ??= {};
      paths[openapiPath][route.method.toLowerCase()] = {
        summary: meta?.summary ?? `${route.method} ${route.url}`,
        tags: [meta?.tag ?? inferTag(route.url)],
        parameters: params,
        responses: {
          200: { description: 'Success' },
          400: { description: 'Validation failed' },
          404: { description: 'Not found' },
          429: { description: 'Rate limited' },
        },
      };
    }

    cached = {
      openapi: '3.1.0',
      info: {
        title: 'LUMEN OS',
        version: '0.1.0',
        description:
          'An adaptive accessibility operating system for education.\n\n'
          + 'Every student receives the same knowledge, transformed into the representation '
          + 'their brain can access most effectively.\n\n'
          + 'Runs fully offline: a hosted model is an upgrade, never a dependency.',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
      },
      paths,
    };
    return cached;
  };
}

interface RouteInfo { method: string; url: string; }

function collectRoutes(app: FastifyInstance): RouteInfo[] {
  const out: RouteInfo[] = [];
  const seen = new Set<string>();
  // Fastify exposes the route table through its own printer; parse it so the
  // spec is derived from reality rather than from a parallel list.
  const tree = app.printRoutes({ commonPrefix: false, includeHooks: false });
  const stack: string[] = [];
  for (const line of tree.split('\n')) {
    const depth = (line.match(/[│ ]{4}/g) ?? []).length;
    const text = line.replace(/^[│├└─\s]+/, '').trim();
    if (!text) continue;
    const methodMatch = text.match(/^(.*?)\s+\((.+)\)$/);
    const segment = methodMatch ? methodMatch[1] : text;
    stack.length = depth;
    stack[depth] = segment;
    if (methodMatch) {
      const url = `/${stack.filter(Boolean).join('').replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
      for (const method of methodMatch[2].split(',').map((m) => m.trim())) {
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        const key = `${method} ${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ method, url: url === '' ? '/' : url });
      }
    }
  }
  return out;
}

function inferTag(url: string): string {
  const m = url.match(/^\/v1\/([a-z-]+)/);
  return m ? m[1] : 'meta';
}
