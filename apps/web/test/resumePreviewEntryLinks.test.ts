/* The master-profile preview shows certification and achievement links (2026-11-01).
 *
 * masterAsResume maps the stored master into the renderer's resolved shape FIELD BY
 * FIELD, so a field it does not name is silently dropped: before this change a
 * credential URL on a cert never reached the preview, whatever the renderer could do.
 * And every stored master v1-v8 has no `links` key on its certs or achievements, so
 * the mapping must turn an absent key into [] rather than crash or emit undefined.
 *
 * Separate from resumePreview.test.ts so this parcel owns the whole file it writes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The module under test, by path with its extension, as node's ESM resolver requires.
import { masterAsResume } from '../src/features/resume-preview/renderPreview.ts';
// The shared renderer, to prove the link reaches the HTML the preview shows.
import { renderResumeHtml } from '../../../packages/resume-template/src/index.ts';

// A minimal stored master. One cert WITH a credential link (the v9 shape), one cert
// WITHOUT a links key, and one achievement without one (the v1-v8 shape).
function storedMaster(): Record<string, unknown> {
  return {
    schema_version: 1,
    identity: { full_name: 'Ada Lovelace', headline: null, email: 'ada@example.com', phone: null, location: null, links: [] },
    summary: null,
    skills: [],
    experience: [],
    projects: [],
    education: [],
    // v1-v8 shape: no links key at all.
    achievements: [{ id: 'ach_first', label: 'First program', description: null, bullets: [] }],
    certifications: [
      // v9 shape: the credential link sits on its own cert.
      {
        id: 'cert_ml', label: 'Machine Learning', description: 'IBM SkillsBuild', bullets: [],
        links: [{ id: 'link_cert_ml', label: 'Credential', url: 'https://www.credly.com/badges/example' }],
      },
      // v1-v8 shape again, alongside it.
      { id: 'cert_sql', label: 'SQL', description: null, bullets: [] },
    ],
    links: [],
  };
}

describe('masterAsResume carries cert and achievement links', () => {
  it('copies a cert credential link into the resolved cert', () => {
    // Map at version 9.
    const resume = masterAsResume(storedMaster() as never, 9);
    // The link, exactly as stored.
    assert.deepEqual(resume.certifications[0]?.links, [
      { id: 'link_cert_ml', label: 'Credential', url: 'https://www.credly.com/badges/example' },
    ]);
  });

  it('renders that link as a clickable anchor in the preview HTML', () => {
    // The full preview path: map, then the shared renderer.
    const html = renderResumeHtml(masterAsResume(storedMaster() as never, 9));
    // Clickable, labelled.
    assert.ok(html.includes('<a href="https://www.credly.com/badges/example">Credential</a>'));
  });

  it('maps an absent links key to [] on a v8-shaped cert and achievement', () => {
    // Must not throw on the key-absent entries.
    const resume = masterAsResume(storedMaster() as never, 8);
    // Explicit empty, not undefined, on the key-absent cert.
    assert.deepEqual(resume.certifications[1]?.links, []);
    // And on the key-absent achievement.
    assert.deepEqual(resume.achievements[0]?.links, []);
  });
});
