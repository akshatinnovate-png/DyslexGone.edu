import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { validate } from './core.routes.js';
import { TeacherCopilot } from '../../teacher/copilot.js';
import { ClassroomOrchestrator } from '../../teacher/classroom.js';
import { AnalyticsService } from '../../analytics/service.js';
import { ALL_NEEDS, type AccessNeed } from '../../domain/types.js';
import { badRequest, notFound } from '../../core/errors.js';

const needsArray = z.array(z.enum(ALL_NEEDS as [AccessNeed, ...AccessNeed[]]));

export async function teachingRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const copilot = new TeacherCopilot(ctx.repos, ctx.graph, ctx.assessment, ctx.misconceptions, ctx.visual);
  const classrooms = new ClassroomOrchestrator(ctx.repos, ctx.graph, ctx.twin, ctx.misconceptions);
  const analytics = new AnalyticsService(ctx.repos, ctx.graph);

  /* ============================ teacher copilot ========================== */

  /** Everything a teacher would otherwise build by hand for one concept. */
  app.post('/v1/teacher/lesson-pack', async (req) => {
    const body = validate(z.object({
      conceptId: z.string().optional(),
      conceptSlug: z.string().optional(),
      grade: z.number().int().min(1).max(13).optional(),
      differentiateFor: z.array(needsArray).max(6).optional(),
      includeVisual: z.boolean().optional(),
      questionCount: z.number().int().min(1).max(20).optional(),
      classroomId: z.string().optional(),
      save: z.boolean().optional(),
    }), req.body);

    if (!body.conceptId && !body.conceptSlug) throw badRequest('conceptId or conceptSlug is required');
    const pack = await copilot.lessonPack(body);
    if (body.save !== false) copilot.save(pack, body.classroomId);
    return pack;
  });

  app.get('/v1/teacher/lesson-packs', async (req) => {
    const q = req.query as { classroomId?: string };
    return { packs: copilot.list(q.classroomId) };
  });

  app.get('/v1/teacher/lesson-packs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const pack = copilot.get(id);
    if (!pack) throw notFound('lesson pack', id);
    return pack;
  });

  /** Differentiated versions of any text a teacher pastes in. */
  app.post('/v1/teacher/differentiate', async (req) => {
    const body = validate(z.object({
      text: z.string().min(1).max(40_000),
      grade: z.number().int().min(1).max(13).optional(),
      profiles: z.array(needsArray).min(1).max(6).optional(),
    }), req.body);
    return {
      versions: copilot.differentiate(
        body.text,
        body.grade ?? 6,
        body.profiles ?? [['dyslexia'], ['language_learner'], ['working_memory']],
      ),
    };
  });

  /* =============================== classroom ============================== */

  app.post('/v1/classrooms', async (req, reply) => {
    const body = validate(z.object({
      name: z.string().min(1).max(100),
      teacher: z.string().max(100).optional(),
      subject: z.string().max(40).optional(),
      grade: z.number().int().min(0).max(13).optional(),
    }), req.body);
    reply.status(201);
    return classrooms.create(body);
  });

  app.get('/v1/classrooms', async () => ({ classrooms: classrooms.list() }));

  app.get('/v1/classrooms/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { classroom: classrooms.get(id), roster: classrooms.roster(id) };
  });

  app.post('/v1/classrooms/:id/enroll', async (req) => {
    const { id } = req.params as { id: string };
    const body = validate(z.object({ learnerIds: z.array(z.string()).min(1).max(200) }), req.body);
    return classrooms.enroll(id, body.learnerIds);
  });

  /** Split the class into groups by what each group actually needs. */
  app.post('/v1/classrooms/:id/grouping', async (req) => {
    const { id } = req.params as { id: string };
    const body = validate(z.object({
      concepts: z.array(z.string()).min(1).max(10),
      maxGroups: z.number().int().min(1).max(8).optional(),
    }), req.body);
    return classrooms.group(id, body.concepts, { maxGroups: body.maxGroups });
  });

  app.get('/v1/classrooms/:id/grouping', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { concepts?: string; maxGroups?: string };
    if (!q.concepts) throw badRequest('concepts is required (comma separated ids or slugs)');
    return classrooms.group(id, q.concepts.split(',').map((s) => s.trim()).filter(Boolean), {
      maxGroups: q.maxGroups ? Number(q.maxGroups) : undefined,
    });
  });

  app.get('/v1/classrooms/:id/heatmap', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { concepts?: string };
    return classrooms.heatmap(id, q.concepts?.split(',').map((s) => s.trim()).filter(Boolean));
  });

  app.get('/v1/classrooms/:id/at-risk', async (req) => {
    const { id } = req.params as { id: string };
    return { learners: classrooms.atRisk(id) };
  });

  /* =============================== analytics ============================== */

  app.get('/v1/analytics/learners/:id', async (req) => {
    const { id } = req.params as { id: string };
    return analytics.learner(id);
  });

  app.get('/v1/analytics/cohort', async (req) => {
    const q = req.query as { subject?: string; sinceDays?: string };
    return analytics.cohort({
      subject: q.subject,
      sinceDays: q.sinceDays ? Number(q.sinceDays) : undefined,
    });
  });

  /** Is the system itself working? Measures the OS, not the student. */
  app.get('/v1/analytics/effectiveness', async (req) => {
    const q = req.query as { sinceDays?: string };
    return analytics.systemEffectiveness(q.sinceDays ? Number(q.sinceDays) : 30);
  });
}
