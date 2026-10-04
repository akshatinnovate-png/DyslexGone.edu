import { round } from '../../core/mathx.js';

/** Punnett squares and inheritance probability, computed rather than memorised. */

export interface PunnettInput {
  parent1: string;        // e.g. 'Aa' or 'AaBb'
  parent2: string;
  traitNames?: Record<string, { dominant: string; recessive: string }>;
}

export interface PunnettResult {
  ok: boolean;
  genes: string[];
  gametes1: string[];
  gametes2: string[];
  grid: { rowGamete: string; colGamete: string; genotype: string }[][];
  genotypeRatios: { genotype: string; count: number; probability: number; fraction: string }[];
  phenotypeRatios: { phenotype: string; count: number; probability: number; fraction: string; description: string }[];
  total: number;
  insights: string[];
  error?: string;
}

const normalizeGenotype = (g: string): string =>
  g.replace(/\s+/g, '').match(/[A-Za-z]{2}/g)?.join('') ?? '';

function geneLetters(genotype: string): string[] | null {
  const pairs = genotype.match(/[A-Za-z]{2}/g);
  if (!pairs) return null;
  const letters: string[] = [];
  for (const p of pairs) {
    if (p[0].toLowerCase() !== p[1].toLowerCase()) return null;
    letters.push(p[0].toUpperCase());
  }
  return letters;
}

/** All gametes for a genotype, by independent assortment. */
export function gametes(genotype: string): string[] {
  const pairs = genotype.match(/[A-Za-z]{2}/g) ?? [];
  let out = [''];
  for (const p of pairs) {
    const next: string[] = [];
    for (const g of out) {
      next.push(g + p[0]);
      if (p[1] !== p[0]) next.push(g + p[1]);
      else next.push(g + p[1]);
    }
    out = next;
  }
  return out;
}

const sortAllelePair = (a: string, b: string): string =>
  (a === a.toUpperCase() ? a + b : b === b.toUpperCase() ? b + a : a + b);

export function punnett(input: PunnettInput): PunnettResult {
  const p1 = normalizeGenotype(input.parent1);
  const p2 = normalizeGenotype(input.parent2);
  const g1 = geneLetters(p1);
  const g2 = geneLetters(p2);

  if (!g1 || !g2 || !p1 || !p2) {
    return {
      ok: false, genes: [], gametes1: [], gametes2: [], grid: [], genotypeRatios: [],
      phenotypeRatios: [], total: 0, insights: [],
      error: 'genotypes must be allele pairs for the same gene, e.g. "Aa" or "AaBb"',
    };
  }
  if (g1.length !== g2.length || g1.some((l, i) => l !== g2[i])) {
    return {
      ok: false, genes: [], gametes1: [], gametes2: [], grid: [], genotypeRatios: [],
      phenotypeRatios: [], total: 0, insights: [],
      error: `both parents must carry the same genes - got ${g1.join(',')} and ${g2.join(',')}`,
    };
  }

  const gam1 = gametes(p1);
  const gam2 = gametes(p2);

  const grid = gam1.map((r) => gam2.map((c) => {
    const genotype = r.split('').map((allele, i) => sortAllelePair(allele, c[i])).join('');
    return { rowGamete: r, colGamete: c, genotype };
  }));

  const total = gam1.length * gam2.length;
  const genoCount = new Map<string, number>();
  const phenoCount = new Map<string, number>();

  for (const row of grid) {
    for (const cell of row) {
      genoCount.set(cell.genotype, (genoCount.get(cell.genotype) ?? 0) + 1);
      const pheno = (cell.genotype.match(/[A-Za-z]{2}/g) ?? [])
        .map((pair) => (/[A-Z]/.test(pair) ? pair[0].toUpperCase() : pair[0].toLowerCase()))
        .join('');
      phenoCount.set(pheno, (phenoCount.get(pheno) ?? 0) + 1);
    }
  }

  const frac = (count: number): string => {
    const g = gcd(count, total);
    return `${count / g}/${total / g}`;
  };

  const genotypeRatios = [...genoCount.entries()]
    .map(([genotype, count]) => ({ genotype, count, probability: round(count / total, 4), fraction: frac(count) }))
    .sort((a, b) => b.count - a.count || a.genotype.localeCompare(b.genotype));

  const phenotypeRatios = [...phenoCount.entries()]
    .map(([key, count]) => {
      const description = key.split('').map((ch) => {
        const names = input.traitNames?.[ch.toUpperCase()];
        if (!names) return /[A-Z]/.test(ch) ? `dominant ${ch.toUpperCase()}` : `recessive ${ch}`;
        return /[A-Z]/.test(ch) ? names.dominant : names.recessive;
      }).join(', ');
      return { phenotype: key, count, probability: round(count / total, 4), fraction: frac(count), description };
    })
    .sort((a, b) => b.count - a.count || a.phenotype.localeCompare(b.phenotype));

  const insights: string[] = [];
  const genes = g1;
  insights.push(`${genes.length === 1 ? 'Monohybrid' : `${genes.length}-gene`} cross: ${gam1.length} × ${gam2.length} = ${total} equally likely combinations.`);

  const recessive = phenotypeRatios.find((p) => p.phenotype === p.phenotype.toLowerCase());
  if (recessive) {
    insights.push(`The recessive phenotype shows in ${recessive.fraction} of offspring - it needs two recessive alleles, so one copy is never enough.`);
  } else {
    insights.push('No offspring shows the recessive phenotype here: at least one parent passes a dominant allele every time.');
  }
  if (genes.length === 1 && p1.toUpperCase() !== p1 && p1 === p2 && /[A-Z]/.test(p1) && /[a-z]/.test(p1)) {
    insights.push('Two heterozygotes always give the classic 3:1 phenotype ratio and a 1:2:1 genotype ratio.');
  }
  if (genes.length === 2) {
    insights.push('Each gene assorts independently, which is why the two-gene ratio is just the one-gene ratio multiplied by itself.');
  }
  insights.push('These are probabilities, not guarantees. Four children can easily all show the same trait - the square predicts the long run, not one family.');

  return { ok: true, genes, gametes1: gam1, gametes2: gam2, grid, genotypeRatios, phenotypeRatios, total, insights };
}

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) || 1 : gcd(b, a % b));

/** Hardy-Weinberg: allele frequencies across a population. */
export interface HardyWeinbergResult {
  p: number; q: number;
  homozygousDominant: number;
  heterozygous: number;
  homozygousRecessive: number;
  carriers: number;
  insights: string[];
}

export function hardyWeinberg(recessivePhenotypeFrequency: number): HardyWeinbergResult {
  const q2 = Math.min(1, Math.max(0, recessivePhenotypeFrequency));
  const q = Math.sqrt(q2);
  const p = 1 - q;
  return {
    p: round(p, 4),
    q: round(q, 4),
    homozygousDominant: round(p * p, 4),
    heterozygous: round(2 * p * q, 4),
    homozygousRecessive: round(q2, 4),
    carriers: round(2 * p * q, 4),
    insights: [
      `${Math.round(q2 * 100)}% show the recessive trait, so the recessive allele frequency q is ${round(q, 3)}.`,
      `Carriers - heterozygotes who show nothing - make up ${Math.round(2 * p * q * 100)}% of the population. That is usually far more people than show the trait.`,
      'This holds only with no selection, no mutation, no migration, random mating and a large population. Every real population breaks at least one.',
    ],
  };
}
