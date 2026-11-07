// Tests for repairDoubleEncodedUtf8 (src/scout/remote-feeds.ts): RemoteOK ships some text
// double-encoded, and the repair must fix exactly that and leave every other string alone.
//
// The live case (2026-11-07): row 0cccc73a, a UAE-only job, stored its location as
// "Ø¯Ø¨Ù..." and passed the work-auth gate, which could not read a country out of it.
import { describe, expect, it } from 'vitest';
// The repair under test, and the parser that applies it, so the wiring is pinned as well.
import { parseRemoteOK, repairDoubleEncodedUtf8 } from '../src/scout/remote-feeds.ts';

// The real location of the Dubai posting, as Arabic: "Dubai, Dubai Dubai, United Arab Emirates".
const DUBAI = 'دبي, دبي دبي الإمارات العربية المتحدة';

// The same text corrupted the way RemoteOK corrupts it: UTF-8 bytes read back as Latin-1.
const DUBAI_MOJIBAKE = Buffer.from(DUBAI, 'utf8').toString('latin1');

// The first four chars of that location EXACTLY as the RemoteOK API sent them on 2026-11-07:
// the JSON escapes Ø¯Ø¨ (bytes 5c 75 30 30 64 38 ...). Parsing them is
// what res.json() does, so this proves the mojibake is upstream, not a second decode of ours.
const WIRE_PREFIX: string = JSON.parse('"\\u00d8\\u00af\\u00d8\\u00a8"');

describe('repairDoubleEncodedUtf8', () => {
  it('the wire bytes RemoteOK sent ARE the mojibake: one JSON decode already yields "Ø¯Ø¨"', () => {
    // Our single decode of the real escapes equals the start of the corrupted Dubai string.
    expect(DUBAI_MOJIBAKE.startsWith(WIRE_PREFIX)).toBe(true);
  });

  it('repairs the double-encoded Dubai location back to the real Arabic', () => {
    // THE regression: this is the string the work-auth gate could not read.
    expect(repairDoubleEncodedUtf8(DUBAI_MOJIBAKE)).toBe(DUBAI);
  });

  it('repairs the other shapes seen in the same fetch (accents, en dash, curly quote)', () => {
    // Each pair is [corrupted, intended], built by the same corruption as the feed applies.
    for (const intended of ['München', 'Ciudad de México, Mexico', 'ML Inference Engineer – Task Designer', 'Sotheby’s']) {
      // Corrupt it the way RemoteOK does.
      const corrupted = Buffer.from(intended, 'utf8').toString('latin1');
      // And it must come back exactly.
      expect(repairDoubleEncodedUtf8(corrupted)).toBe(intended);
    }
  });

  it('leaves plain ASCII unchanged', () => {
    // No signature char, so nothing to repair.
    expect(repairDoubleEncodedUtf8('Worldwide Remote')).toBe('Worldwide Remote');
  });

  it('leaves correctly encoded "Zürich" unchanged (a lone 0xFC byte is not UTF-8)', () => {
    // A real Latin-1-range accent must survive, or every correct feed would be corrupted.
    expect(repairDoubleEncodedUtf8('Zürich')).toBe('Zürich');
  });

  it('leaves a string with any char above U+00FF unchanged, even beside a signature char', () => {
    // Already-correct Arabic: no Latin-1 encoding exists for it.
    expect(repairDoubleEncodedUtf8(DUBAI)).toBe(DUBAI);
    // A mixed string: the round-trip would be lossy, so it is refused rather than guessed.
    expect(repairDoubleEncodedUtf8(`${DUBAI_MOJIBAKE} — ok`)).toBe(`${DUBAI_MOJIBAKE} — ok`);
  });

  it('leaves Latin-1 text that is not valid UTF-8 when re-decoded unchanged ("Café")', () => {
    // é alone is byte E9, an unfinished UTF-8 lead byte: a fatal decoder refuses it.
    expect(repairDoubleEncodedUtf8('Café')).toBe('Café');
    // Ã followed by a space: 0xC3 0x20 is malformed UTF-8 too, so no repair.
    expect(repairDoubleEncodedUtf8('Ã la carte')).toBe('Ã la carte');
  });
});

describe('parseRemoteOK applies the repair', () => {
  it('a RemoteOK item with a double-encoded location, title and company comes out readable', () => {
    // One item shaped like the live one, behind RemoteOK's legal-notice element.
    const body = [{ legal: 'API terms' }, {
      // Corrupted exactly as the feed sends them.
      position: Buffer.from('Lead – Sales', 'utf8').toString('latin1'),
      company: Buffer.from('Sotheby’s', 'utf8').toString('latin1'),
      location: DUBAI_MOJIBAKE,
      // The rest just has to be a valid posting.
      apply_url: 'https://remoteok.com/remote-jobs/1136217', url: 'https://remoteok.com/remote-jobs/1136217',
      description: 'Sales', date: '2026-11-06T10:00:00+00:00',
    }];
    // The parse result.
    const { jobs, refused } = parseRemoteOK(body);
    // One usable posting, none refused.
    expect([jobs.length, refused]).toEqual([1, 0]);
    // Every repaired field, by value.
    expect([jobs[0]!.location, jobs[0]!.title, jobs[0]!.company]).toEqual([DUBAI, 'Lead – Sales', 'Sotheby’s']);
  });
});
