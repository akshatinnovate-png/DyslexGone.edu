import { clamp, linspace, rk4, round } from '../../core/mathx.js';

/** Mechanics simulators: real integration, real units, real edge cases. */

export interface Trajectory {
  t: number[];
  x: number[];
  y: number[];
  vx?: number[];
  vy?: number[];
}

export interface ProjectileInput {
  speed: number;            // m/s
  angleDeg: number;
  height?: number;          // m
  gravity?: number;         // m/s^2
  dragCoefficient?: number; // 0 = vacuum
  mass?: number;            // kg
}

export interface ProjectileResult {
  trajectory: Trajectory;
  range: number;
  maxHeight: number;
  flightTime: number;
  impactSpeed: number;
  impactAngleDeg: number;
  vacuumRange: number;
  dragLossPct: number;
  insights: string[];
}

export function simulateProjectile(input: ProjectileInput): ProjectileResult {
  const g = input.gravity ?? 9.81;
  const v0 = Math.max(0, input.speed);
  const theta = (input.angleDeg * Math.PI) / 180;
  const h0 = input.height ?? 0;
  const k = Math.max(0, input.dragCoefficient ?? 0) / Math.max(0.01, input.mass ?? 1);

  const dt = 0.005;
  let state = [0, h0, v0 * Math.cos(theta), v0 * Math.sin(theta)];
  const deriv = (_t: number, s: readonly number[]): number[] => {
    const [, , vx, vy] = s;
    const speed = Math.hypot(vx, vy);
    return [vx, vy, -k * speed * vx, -g - k * speed * vy];
  };

  const t: number[] = [0];
  const xs: number[] = [0];
  const ys: number[] = [h0];
  const vxs: number[] = [state[2]];
  const vys: number[] = [state[3]];

  let time = 0;
  for (let i = 0; i < 20000; i++) {
    const next = rk4(deriv, time, state, dt);
    time += dt;
    if (next[1] < 0) {
      // Land exactly on the ground by linear interpolation.
      const frac = state[1] / Math.max(1e-9, state[1] - next[1]);
      const landX = state[0] + (next[0] - state[0]) * frac;
      const landVx = state[2] + (next[2] - state[2]) * frac;
      const landVy = state[3] + (next[3] - state[3]) * frac;
      t.push(round(time - dt + dt * frac, 4));
      xs.push(round(landX, 4));
      ys.push(0);
      vxs.push(round(landVx, 4));
      vys.push(round(landVy, 4));
      state = [landX, 0, landVx, landVy];
      break;
    }
    state = next;
    t.push(round(time, 4));
    xs.push(round(state[0], 4));
    ys.push(round(state[1], 4));
    vxs.push(round(state[2], 4));
    vys.push(round(state[3], 4));
  }

  const range = xs[xs.length - 1];
  const maxHeight = Math.max(...ys);
  const flightTime = t[t.length - 1];
  const impactSpeed = Math.hypot(vxs[vxs.length - 1], vys[vys.length - 1]);
  const impactAngle = (Math.atan2(-vys[vys.length - 1], vxs[vxs.length - 1]) * 180) / Math.PI;

  // Closed-form vacuum range, for comparison.
  const vacuumRange = h0 === 0
    ? (v0 * v0 * Math.sin(2 * theta)) / g
    : ((v0 * Math.cos(theta)) / g) * (v0 * Math.sin(theta) + Math.sqrt((v0 * Math.sin(theta)) ** 2 + 2 * g * h0));

  const insights: string[] = [];
  if (k === 0) {
    insights.push(`In a vacuum, 45° always gives the longest range from ground level. At ${input.angleDeg}° the range is ${round(range, 2)} m.`);
    if (Math.abs(input.angleDeg - 45) > 1 && h0 === 0) {
      const complement = 90 - input.angleDeg;
      insights.push(`${input.angleDeg}° and ${complement}° give exactly the same range - a high lob and a flat shot can land in the same place.`);
    }
  } else {
    insights.push(`Drag costs ${round(((vacuumRange - range) / Math.max(1e-9, vacuumRange)) * 100, 1)}% of the vacuum range, and it pushes the best angle below 45°.`);
  }
  insights.push(`Horizontal and vertical motion are independent: gravity only ever changes the vertical velocity, which is why the horizontal speed stays near ${round(vxs[0], 2)} m/s.`);
  if (h0 > 0) insights.push(`Starting ${h0} m up adds flight time, so the projectile travels further than the same launch from the ground.`);

  return {
    trajectory: { t, x: xs, y: ys, vx: vxs, vy: vys },
    range: round(range, 3),
    maxHeight: round(maxHeight, 3),
    flightTime: round(flightTime, 3),
    impactSpeed: round(impactSpeed, 3),
    impactAngleDeg: round(impactAngle, 2),
    vacuumRange: round(vacuumRange, 3),
    dragLossPct: round(((vacuumRange - range) / Math.max(1e-9, vacuumRange)) * 100, 2),
    insights,
  };
}

export interface PendulumInput {
  lengthM: number;
  initialAngleDeg: number;
  gravity?: number;
  dampingPerSec?: number;
  durationSec?: number;
}

export interface PendulumResult {
  t: number[];
  angleDeg: number[];
  periodSec: number;
  smallAnglePeriodSec: number;
  periodErrorPct: number;
  insights: string[];
}

/** Full nonlinear pendulum, so the small-angle approximation can be *tested*
 *  rather than asserted. */
export function simulatePendulum(input: PendulumInput): PendulumResult {
  const g = input.gravity ?? 9.81;
  const L = Math.max(0.01, input.lengthM);
  const damping = Math.max(0, input.dampingPerSec ?? 0);
  const duration = input.durationSec ?? 10;
  const dt = 0.002;

  let s = [(input.initialAngleDeg * Math.PI) / 180, 0];
  const deriv = (_t: number, y: readonly number[]): number[] => [y[1], -(g / L) * Math.sin(y[0]) - damping * y[1]];

  const t: number[] = [0];
  const angles: number[] = [input.initialAngleDeg];
  const zeroCrossings: number[] = [];
  let time = 0;
  let prev = s[0];

  for (let i = 0; i < Math.round(duration / dt); i++) {
    s = rk4(deriv, time, s, dt);
    time += dt;
    if (prev > 0 && s[0] <= 0) zeroCrossings.push(time);
    prev = s[0];
    if (i % 5 === 0) {
      t.push(round(time, 4));
      angles.push(round((s[0] * 180) / Math.PI, 4));
    }
  }

  const period = zeroCrossings.length >= 2
    ? zeroCrossings[zeroCrossings.length - 1] - zeroCrossings[zeroCrossings.length - 2]
    : 2 * Math.PI * Math.sqrt(L / g);
  const smallAngle = 2 * Math.PI * Math.sqrt(L / g);

  const insights = [
    `The small-angle formula predicts ${round(smallAngle, 3)} s. The real period here is ${round(period, 3)} s.`,
    `Period depends on length and gravity - not on mass, and not on how hard you push it (as long as the swing stays small).`,
  ];
  if (Math.abs(input.initialAngleDeg) > 25) {
    insights.push(`At ${input.initialAngleDeg}° the approximation is visibly off: a wide swing takes longer than the formula says.`);
  }
  if (damping > 0) insights.push('Damping shrinks the amplitude but barely changes the period.');

  return {
    t,
    angleDeg: angles,
    periodSec: round(period, 4),
    smallAnglePeriodSec: round(smallAngle, 4),
    periodErrorPct: round(((period - smallAngle) / smallAngle) * 100, 3),
    insights,
  };
}

export interface InclineInput {
  angleDeg: number;
  massKg: number;
  frictionCoefficient: number;
  gravity?: number;
  appliedForceN?: number;
}

export interface InclineResult {
  weightN: number;
  normalN: number;
  alongSlopeN: number;
  maxStaticFrictionN: number;
  moves: boolean;
  accelerationMs2: number;
  tippingAngleDeg: number;
  forces: { label: string; magnitudeN: number; angleDeg: number }[];
  insights: string[];
}

export function simulateIncline(input: InclineInput): InclineResult {
  const g = input.gravity ?? 9.81;
  const theta = (input.angleDeg * Math.PI) / 180;
  const W = input.massKg * g;
  const normal = W * Math.cos(theta);
  const along = W * Math.sin(theta) + (input.appliedForceN ?? 0);
  const maxFriction = input.frictionCoefficient * normal;
  const moves = Math.abs(along) > maxFriction;
  const net = moves ? Math.abs(along) - maxFriction : 0;
  const accel = moves ? net / Math.max(1e-9, input.massKg) : 0;
  const tipping = (Math.atan(input.frictionCoefficient) * 180) / Math.PI;

  return {
    weightN: round(W, 3),
    normalN: round(normal, 3),
    alongSlopeN: round(along, 3),
    maxStaticFrictionN: round(maxFriction, 3),
    moves,
    accelerationMs2: round(accel, 4),
    tippingAngleDeg: round(tipping, 2),
    forces: [
      { label: 'weight', magnitudeN: round(W, 2), angleDeg: -90 },
      { label: 'normal', magnitudeN: round(normal, 2), angleDeg: 90 - input.angleDeg },
      { label: 'friction', magnitudeN: round(Math.min(maxFriction, Math.abs(along)), 2), angleDeg: 180 - input.angleDeg },
    ],
    insights: [
      moves
        ? `Gravity pulls ${round(Math.abs(along), 2)} N down the slope but friction can only hold back ${round(maxFriction, 2)} N, so it slides at ${round(accel, 2)} m/s².`
        : `Gravity pulls ${round(Math.abs(along), 2)} N down the slope and friction can resist up to ${round(maxFriction, 2)} N, so nothing moves.`,
      `It starts sliding at ${round(tipping, 1)}° - and that angle depends only on the friction coefficient, not on the mass. Doubling the mass doubles both the pull and the grip.`,
      `The normal force is NOT the weight once the surface tilts: here it is ${round(normal, 2)} N against a weight of ${round(W, 2)} N.`,
    ],
  };
}

export interface CollisionInput {
  m1: number; v1: number;
  m2: number; v2: number;
  restitution: number;    // 1 = perfectly elastic, 0 = they stick
}

export interface CollisionResult {
  v1After: number;
  v2After: number;
  momentumBefore: number;
  momentumAfter: number;
  kineticEnergyBefore: number;
  kineticEnergyAfter: number;
  energyLostJ: number;
  energyLostPct: number;
  insights: string[];
}

export function simulateCollision(input: CollisionInput): CollisionResult {
  const { m1, v1, m2, v2 } = input;
  const e = clamp(input.restitution, 0, 1);
  const totalM = m1 + m2;
  const v1a = (m1 * v1 + m2 * v2 + m2 * e * (v2 - v1)) / totalM;
  const v2a = (m1 * v1 + m2 * v2 + m1 * e * (v1 - v2)) / totalM;

  const pBefore = m1 * v1 + m2 * v2;
  const pAfter = m1 * v1a + m2 * v2a;
  const keBefore = 0.5 * m1 * v1 ** 2 + 0.5 * m2 * v2 ** 2;
  const keAfter = 0.5 * m1 * v1a ** 2 + 0.5 * m2 * v2a ** 2;

  const insights = [
    `Momentum before: ${round(pBefore, 3)} kg·m/s. After: ${round(pAfter, 3)}. Momentum is always conserved, whatever kind of collision this is.`,
    e >= 0.99
      ? 'Perfectly elastic: kinetic energy is conserved too. This is the only case where both quantities survive.'
      : e <= 0.01
        ? `Perfectly inelastic: they move off together and ${round(keBefore - keAfter, 3)} J went into deformation, heat and sound.`
        : `Partly elastic: ${round(((keBefore - keAfter) / Math.max(1e-9, keBefore)) * 100, 1)}% of the kinetic energy was lost, but none of the momentum was.`,
  ];
  if (Math.abs(pBefore - pAfter) > 1e-6) insights.push('Momentum mismatch detected - check the inputs.');

  return {
    v1After: round(v1a, 4),
    v2After: round(v2a, 4),
    momentumBefore: round(pBefore, 4),
    momentumAfter: round(pAfter, 4),
    kineticEnergyBefore: round(keBefore, 4),
    kineticEnergyAfter: round(keAfter, 4),
    energyLostJ: round(keBefore - keAfter, 4),
    energyLostPct: round(((keBefore - keAfter) / Math.max(1e-9, keBefore)) * 100, 2),
    insights,
  };
}

/** Sample a trajectory down to N points for plotting. */
export function decimate(traj: Trajectory, points = 60): Trajectory {
  if (traj.t.length <= points) return traj;
  const idx = linspace(0, traj.t.length - 1, points).map((v) => Math.round(v));
  const pick = <T,>(arr: T[] | undefined) => (arr ? idx.map((i) => arr[i]) : undefined);
  return {
    t: idx.map((i) => traj.t[i]),
    x: idx.map((i) => traj.x[i]),
    y: idx.map((i) => traj.y[i]),
    vx: pick(traj.vx),
    vy: pick(traj.vy),
  };
}
