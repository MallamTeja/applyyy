/* Tests for extractProfile and extractPdf. */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { extractProfile, extractPdf } from '../src/index.ts';
import {
  heading,
  item,
  page,
} from './fixtures/snapshots.ts';

describe('extractProfile', () => {
  it('extracts structured MasterProfile from a PdfSnapshot', () => {
    const snapshot = {
      producer: 'pdfTeX-1.40.29',
      pages: [
        page([
          item('Jane Doe', 40, 800),
          item('jane@example.com', 40, 780),
          heading('SUMMARY', 750),
          item('Experienced software engineer specializing in backend systems.', 40, 730),
          heading('TECHNICAL SKILLS', 700),
          item('Languages: TypeScript, Python, Go', 40, 680),
          heading('WORK EXPERIENCE', 650),
          item('Staff Engineer - Northwind Systems', 46, 630),
          item('• Developed scalable microservices handling 10M daily requests.', 46, 615),
          heading('EDUCATION', 580),
          item('B.S. in Computer Science - Tech University', 40, 550),
        ]),
      ],
    };

    const { profile, report } = extractProfile(snapshot);

    assert.equal(profile.schema_version, 1);
    assert.equal(profile.identity.full_name, 'Jane Doe');
    assert.equal(profile.identity.email, 'jane@example.com');
    assert.ok(profile.summary !== null);
    assert.ok(profile.summary.text.includes('Experienced software engineer'));
    assert.ok(profile.skills.length > 0);
    assert.equal(profile.skills[0]?.name, 'TypeScript');
    assert.equal(profile.experience.length, 1);
    assert.equal(profile.experience[0]?.role, 'Staff Engineer');
    assert.equal(profile.experience[0]?.company, 'Northwind Systems');
    assert.equal(profile.education.length, 1);
    assert.equal(profile.education[0]?.degree, 'B.S. in Computer Science');
    assert.equal(profile.education[0]?.institution, 'Tech University');
    assert.ok(report.sectionsFound.includes('SUMMARY'));
    assert.ok(report.sectionsFound.includes('TECHNICAL SKILLS'));
    assert.ok(report.sectionsFound.includes('WORK EXPERIENCE'));
    assert.ok(report.sectionsFound.includes('EDUCATION'));
  });

  it('extractPdf parses raw bytes and returns valid MasterProfile', async () => {
    const dummyPdf = new TextEncoder().encode(
      '%PDF-1.4\n(John Smith)\n(john@example.com)\n(TECHNICAL SKILLS)\n(JavaScript, React)\n%%EOF',
    );
    const profile = await extractPdf(dummyPdf);

    assert.equal(profile.schema_version, 1);
    assert.ok(profile.identity.email === 'john@example.com' || profile.identity.full_name === 'John Smith');
    assert.ok(Array.isArray(profile.skills));
    assert.ok(Array.isArray(profile.experience));
    assert.ok(Array.isArray(profile.education));
  });
});
