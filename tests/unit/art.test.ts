import { describe, expect, it } from 'vitest';
import { hasWarm } from '../../src/engine/art';
import { CATS, data, one, seeds } from './helpers';

const body = (c: string, b: ReturnType<typeof one>) =>
  c === 'creature' ? (data.tables['creature.body'].entries.find((e) => e.id === b.fields.bodyPlan.entryId)!.tags ?? []) : [];

describe('technical direction never contradicts the card', () => {
  it('blobs, gases and oozes never get shoulders, strides, skeletons, heads or faces', () => {
    let blobs = 0;
    for (const s of seeds(4000, 'blob')) {
      const b = one('creature', s);
      const tags = body('creature', b);
      if (!tags.some((t) => ['amorphous', 'ooze', 'gaseous'].includes(t))) continue;
      blobs++;
      const text = [b.art!.shape, b.art!.camera, b.art!.deliverable, b.art!.light].join(' | ');
      expect(text, text).not.toMatch(/shoulder|stride|skeleton|anatomy|head study|head close-up|face|arms clear|A-pose|side profile/i);
    }
    expect(blobs).toBeGreaterThan(20);
  });
  it('weapons are never "grown with no straight lines"; nothing lights a face', () => {
    for (const s of seeds(2000, 'weap')) {
      const b = one('prop', s);
      const tags = data.tables['prop.object'].entries.find((e) => e.id === b.fields.objectType.entryId)!.tags ?? [];
      if (tags.includes('weapon')) expect(b.art!.shape).not.toMatch(/no straight lines/);
      expect(b.art!.light).not.toMatch(/face/);
    }
  });
  it('"the only warm note" only appears when the palette really has a warm colour', () => {
    for (const s of seeds(3000, 'warm')) {
      const b = one(CATS[s.charCodeAt(0) % 5], s);
      if (/only warm note/.test(b.art!.focal)) expect(hasWarm(b.palette.hex), b.palette.name).toBe(true);
    }
    expect(hasWarm(['#121418', '#F07A1E'])).toBe(true);
    expect(hasWarm(['#121410', '#2A2F24', '#4F5A40', '#8A9A6A', '#D6DDB8'])).toBe(false);
  });
});

describe('the purpose drives the job', () => {
  it.each(CATS)('%s: camera and deliverables always belong to the rolled purpose; the ask names the subject', (c) => {
    const purposes = data.tables['shared.art-purpose'].entries;
    const cams = data.tables['shared.art-camera'].entries;
    const dels = data.tables['shared.art-deliverable'].entries;
    for (const s of seeds(400, `pur-${c}`)) {
      const b = one(c, s);
      const p = purposes.find((x) => x.label === b.art!.purpose)!;
      expect(p, b.art!.purpose).toBeDefined();
      expect(cams.find((x) => x.text === b.art!.camera)!.purposes).toContain(p.id);
      expect(dels.find((x) => x.text === b.art!.deliverable)!.purposes).toContain(p.id);
      expect(b.art!.ask).toContain(b.fields.name.text.replace(/^The /, 'the '));
      expect(b.plainText).toContain(`\nThe ask: ${b.art!.ask}.`);
      expect(b.art!.focal).not.toMatch(/[{}]/);
    }
  });
  it('scenes never get a 3D turnaround or codex job', () => {
    for (const s of seeds(600, 'scene-pur')) expect(one('scene', s).art!.purpose).not.toMatch(/3D turnaround|Codex/);
  });
});

describe('job selector', () => {
  it('a chosen job is used on every card it fits; an unfitting one falls back to a rolled job', () => {
    for (const s of seeds(200, 'job-tcg')) expect(one('creature', s, { job: 'tcg' }).art!.purpose).toBe('TCG card art');
    for (const s of seeds(200, 'job-bad')) {
      const b = one('scene', s, { job: 'turnaround' });
      expect(b.art!.purpose).not.toBe('3D turnaround');
      expect(b.art!.purpose).toBeTruthy();
    }
  });
  it('the job survives line and art rerolls', async () => {
    const { rerollArt, rerollSlots } = await import('../../src/engine/generate');
    let b = one('prop', 'JOBKEP', { job: 'miniature' });
    expect(b.art!.purpose).toBe('Miniature concept');
    b = rerollSlots(data, b, ['origin'], 'sometimes');
    expect(b.art!.purpose).toBe('Miniature concept');
    b = rerollArt(data, b, 'sometimes');
    expect(b.art!.purpose).toBe('Miniature concept');
  });
  it('deadlines scale with the size of the work', () => {
    for (const s of seeds(800, 'deadline')) {
      const b = one(CATS[s.charCodeAt(2) % 5], s);
      const d = b.art!.deliverable!;
      const dl = b.art!.deadline!;
      expect(b.plainText).toContain(`\nDeadline: ${dl}`);
      if (/90 minutes/.test(d)) expect(['tomorrow', '2 days']).toContain(dl);
      if (/about [56] hours/.test(d)) expect(['1 week', '10 days', '2 weeks']).toContain(dl);
    }
  });
});
