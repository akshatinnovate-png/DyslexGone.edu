import {
  PALETTE, type Channel, type Easing, type Keyframe, type PrimitiveProps,
  type Scene, type SceneNode, type Track,
} from './primitives.js';
import { id as newId } from '../../core/ids.js';
import { round } from '../../core/mathx.js';
import { sentences } from '../../core/textkit.js';

/** Builds a Scene from storyboard beats.
 *
 *  A beat is a pedagogical unit, not a frame: "show the problem", "cut both
 *  bars to twelfths", "count the shaded parts". The compiler lays beats on a
 *  timeline, keeps narration locked to the visuals, and generates captions and
 *  an audio description from the same source - so the accessible versions can
 *  never drift out of sync with the animation. */

export interface Beat {
  /** What this beat teaches. Becomes narration, caption and audio description. */
  say: string;
  /** Seconds this beat lasts. */
  hold?: number;
  /** Nodes introduced in this beat. */
  show?: { primitive: PrimitiveProps; layer?: number; id?: string }[];
  /** Nodes removed at the end of this beat. */
  hide?: string[];
  /** Animations that run during this beat. */
  animate?: {
    target: string;
    channel: Channel;
    from?: number;
    to: number;
    easing?: Easing;
    /** Fraction of the beat to wait before starting, 0..1. */
    delay?: number;
    /** Fraction of the beat the motion occupies, 0..1. */
    span?: number;
  }[];
}

export interface StoryboardOptions {
  title: string;
  width?: number;
  height?: number;
  background?: string;
  /** Slow everything down for a learner who needs processing time. */
  paceMultiplier?: number;
  reduceMotion?: boolean;
  meta?: Record<string, unknown>;
}

export class SceneBuilder {
  private nodes = new Map<string, SceneNode>();
  private narration: Scene['narration'] = [];
  private captions: Scene['captions'] = [];
  private cursor = 0;
  private readonly pace: number;

  constructor(private opts: StoryboardOptions) {
    this.pace = Math.max(0.4, opts.paceMultiplier ?? 1);
  }

  /** Lay one beat on the timeline. */
  beat(b: Beat): this {
    const hold = Math.max(0.4, (b.hold ?? estimateHold(b.say)) * this.pace);
    const start = this.cursor;
    const end = start + hold;

    for (const s of b.show ?? []) {
      const nid = s.id ?? s.primitive.id ?? newId('nd');
      this.nodes.set(nid, {
        id: nid,
        primitive: { ...s.primitive, id: nid },
        tracks: [],
        enter: round(start, 3),
        exit: Number.POSITIVE_INFINITY,
        narration: b.say,
        layer: s.layer ?? 10,
      });
    }

    for (const nid of b.hide ?? []) {
      const node = this.nodes.get(nid);
      if (node) node.exit = round(end, 3);
    }

    for (const a of b.animate ?? []) {
      const node = this.nodes.get(a.target);
      if (!node) continue;
      const delay = Math.min(0.9, Math.max(0, a.delay ?? 0));
      const span = Math.min(1 - delay, Math.max(0.05, a.span ?? 1 - delay));
      const t0 = start + hold * delay;
      const t1 = t0 + hold * span;
      const current = (node.primitive as unknown as Record<string, number>)[a.channel];
      const from = a.from ?? (typeof current === 'number' ? current : 0);

      let track = node.tracks.find((t) => t.channel === a.channel);
      if (!track) {
        track = { channel: a.channel, keyframes: [{ t: 0, value: from }] };
        node.tracks.push(track);
      }
      pushKeyframe(track.keyframes, { t: round(t0, 3), value: from, easing: 'linear' });
      pushKeyframe(track.keyframes, { t: round(t1, 3), value: a.to, easing: a.easing ?? 'ease' });
    }

    if (b.say.trim()) {
      this.narration.push({ at: round(start, 3), text: b.say.trim(), durationSec: round(hold, 3) });
      this.captions.push({ start: round(start, 3), end: round(end, 3), text: b.say.trim() });
    }
    this.cursor = end;
    return this;
  }

  /** A static node present for the whole scene (axes, titles, backdrops). */
  backdrop(primitive: PrimitiveProps, layer = 1, idv?: string): this {
    const nid = idv ?? primitive.id ?? newId('nd');
    this.nodes.set(nid, {
      id: nid, primitive: { ...primitive, id: nid }, tracks: [],
      enter: 0, exit: Number.POSITIVE_INFINITY, layer,
    });
    return this;
  }

  pause(seconds: number): this {
    this.cursor += seconds * this.pace;
    return this;
  }

  build(): Scene {
    const duration = round(Math.max(1, this.cursor), 3);
    const nodes = [...this.nodes.values()].map((nd) => ({
      ...nd,
      exit: Number.isFinite(nd.exit) ? nd.exit : duration,
      tracks: this.opts.reduceMotion ? collapseTracks(nd.tracks) : nd.tracks,
    }));

    return {
      id: newId('scn'),
      title: this.opts.title,
      width: this.opts.width ?? 900,
      height: this.opts.height ?? 520,
      durationSec: duration,
      background: this.opts.background ?? PALETTE.paper,
      palette: PALETTE,
      nodes,
      narration: this.narration,
      captions: this.captions,
      audioDescription: buildAudioDescription(this.opts.title, this.narration),
      meta: { ...(this.opts.meta ?? {}), beats: this.narration.length, reduceMotion: Boolean(this.opts.reduceMotion) },
    };
  }
}

function pushKeyframe(kfs: Keyframe[], kf: Keyframe): void {
  const existing = kfs.findIndex((k) => Math.abs(k.t - kf.t) < 1e-6);
  if (existing >= 0) kfs[existing] = kf;
  else kfs.push(kf);
  kfs.sort((a, b) => a.t - b.t);
}

/** Reduced motion: keep the end state, drop the travel. */
function collapseTracks(tracks: Track[]): Track[] {
  return tracks.map((t) => {
    const last = t.keyframes[t.keyframes.length - 1];
    return { channel: t.channel, keyframes: last ? [{ t: 0, value: last.value }] : [] };
  });
}

/** Narration time budget: ~2.6 words per second plus a beat to look at it. */
export function estimateHold(say: string): number {
  const words = (say.match(/\S+/g) ?? []).length;
  return Math.max(1.6, words / 2.6 + 0.9);
}

function buildAudioDescription(title: string, narration: Scene['narration']): string {
  if (!narration.length) return `${title}. An animated diagram with no narration.`;
  const steps = narration.map((nar, i) => `Step ${i + 1}: ${nar.text}`);
  return `${title}. This animation has ${narration.length} steps. ${steps.join(' ')}`;
}

/** Narration script as plain prose, for the audio engine. */
export function narrationScript(scene: Scene): string {
  return scene.narration.map((nar) => nar.text).join(' ');
}

/** Does this scene actually explain anything, or is it decoration?
 *  Runs before a scene is ever shown to a learner. */
export interface SceneAudit {
  ok: boolean;
  score: number;
  issues: string[];
  notes: string[];
}

export function auditScene(scene: Scene): SceneAudit {
  const issues: string[] = [];
  const notes: string[] = [];

  if (!scene.nodes.length) issues.push('scene has no visual content');
  if (!scene.narration.length) issues.push('scene has no narration, so it is unusable without sight');
  if (scene.durationSec > 150) issues.push(`scene runs ${Math.round(scene.durationSec)}s - over the 150s attention budget`);
  if (scene.durationSec < 3) issues.push('scene is too short to read');

  const described = scene.nodes.filter((nd) => nd.primitive.describe).length;
  if (scene.nodes.length > 3 && described === 0) {
    notes.push('no node carries a spoken description; the scene description carries the whole load');
  }

  const labels = scene.nodes.filter((nd) => nd.primitive.kind === 'label').length;
  if (labels === 0 && scene.nodes.length > 2) notes.push('no text labels - add them for learners who need the words');

  const overlapping = scene.narration.filter((nar, i) => {
    const next = scene.narration[i + 1];
    return next && nar.at + nar.durationSec > next.at + 0.05;
  });
  if (overlapping.length) issues.push(`${overlapping.length} narration beat(s) overlap`);

  const tooFast = scene.narration.filter((nar) => {
    const words = (nar.text.match(/\S+/g) ?? []).length;
    return words / nar.durationSec > 3.6;
  });
  if (tooFast.length) issues.push(`${tooFast.length} beat(s) narrate faster than 3.6 words/second`);

  const sentencesPerBeat = scene.narration.map((nar) => sentences(nar.text).length);
  if (sentencesPerBeat.some((s) => s > 3)) notes.push('some beats carry 4+ sentences; consider splitting them');

  const score = round(Math.max(0, 1 - issues.length * 0.25 - notes.length * 0.06), 3);
  return { ok: issues.length === 0, score, issues, notes };
}

export interface SceneSegment {
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  beats: number;
  narration: string;
  title: string;
}

/** Split a scene into attention-sized chapters on beat boundaries.
 *
 *  When a scene runs longer than a learner's attention block, the answer is to
 *  deliver it in parts - NOT to speed it up. Compressing an explanation for
 *  someone who needs processing time is exactly backwards. */
export function segmentScene(scene: Scene, maxSeconds: number): SceneSegment[] {
  if (!scene.narration.length || scene.durationSec <= maxSeconds) {
    return [{
      index: 0, startSec: 0, endSec: scene.durationSec, durationSec: scene.durationSec,
      beats: scene.narration.length, narration: scene.narration.map((n) => n.text).join(' '),
      title: scene.title,
    }];
  }

  const segments: SceneSegment[] = [];
  let current: { start: number; texts: string[]; beats: number } | null = null;

  const flush = (end: number) => {
    if (!current || !current.beats) return;
    segments.push({
      index: segments.length,
      startSec: round(current.start, 3),
      endSec: round(end, 3),
      durationSec: round(end - current.start, 3),
      beats: current.beats,
      narration: current.texts.join(' '),
      title: `${scene.title} — part ${segments.length + 1}`,
    });
    current = null;
  };

  for (const beat of scene.narration) {
    const end = beat.at + beat.durationSec;
    if (!current) current = { start: beat.at, texts: [], beats: 0 };
    // Keep a beat whole: never cut an explanation mid-sentence.
    if (end - current.start > maxSeconds && current.beats > 0) {
      flush(beat.at);
      current = { start: beat.at, texts: [], beats: 0 };
    }
    current.texts.push(beat.text);
    current.beats += 1;
  }
  flush(scene.durationSec);
  return segments;
}

/** Slow a finished scene down (or speed it up) without rebuilding it. */
export function repace(scene: Scene, multiplier: number): Scene {
  const m = Math.max(0.3, multiplier);
  return {
    ...scene,
    durationSec: round(scene.durationSec * m, 3),
    nodes: scene.nodes.map((nd) => ({
      ...nd,
      enter: round(nd.enter * m, 3),
      exit: round(nd.exit * m, 3),
      tracks: nd.tracks.map((t) => ({
        ...t,
        keyframes: t.keyframes.map((k) => ({ ...k, t: round(k.t * m, 3) })),
      })),
    })),
    narration: scene.narration.map((nar) => ({ ...nar, at: round(nar.at * m, 3), durationSec: round(nar.durationSec * m, 3) })),
    captions: scene.captions.map((c) => ({ ...c, start: round(c.start * m, 3), end: round(c.end * m, 3) })),
  };
}
