/* PDF extraction and MasterProfile parser logic.
 * Converts PDF snapshots or raw bytes into typed MasterProfile JSON.
 */

import type {
  MasterAchievement,
  MasterBullet,
  MasterCertification,
  MasterEducation,
  MasterExperience,
  MasterIdentity,
  MasterLink,
  MasterProfile,
  MasterProject,
  MasterSkill,
  MasterSummary,
  NodeId,
} from '@applyy/shared-types';
import type { PdfSnapshot } from './snapshot.ts';
import { loadPdfSnapshot, type PdfjsLike } from './load-pdf.ts';
import { measureDocument, type LineBand } from './layout.ts';
import type {
  DroppedText,
  ExtractedKind,
  ExtractedNode,
  ExtractionReport,
  ExtractionWarning,
  UnanchoredLinkRow,
} from './report.ts';

function mintId(): NodeId {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return (
    'node-' +
    Math.random().toString(36).substring(2, 11) +
    '-' +
    Date.now().toString(36)
  );
}

const SECTION_PATTERNS: { kind: ExtractedKind; regex: RegExp }[] = [
  {
    kind: 'summary',
    regex:
      /^(professional\s+summary|executive\s+summary|summary|profile|about\s+me|overview)$/i,
  },
  {
    kind: 'experience',
    regex:
      /^(work\s+experience|professional\s+experience|employment\s+history|experience|work\s+history)$/i,
  },
  {
    kind: 'project',
    regex:
      /^(projects|personal\s+projects|key\s+projects|selected\s+projects)$/i,
  },
  {
    kind: 'education',
    regex:
      /^(education|academic\s+background|qualifications|academic\s+history)$/i,
  },
  {
    kind: 'skill',
    regex:
      /^(technical\s+skills|skills\s+&\s+interests|skills|technologies|core\s+competencies)$/i,
  },
  {
    kind: 'achievement',
    regex:
      /^(achievements|honors\s+&\s+awards|honors|awards|key\s+achievements)$/i,
  },
  {
    kind: 'certification',
    regex:
      /^(certifications\s+&\s+licenses|certifications|licenses\s+&\s+certifications|licenses)$/i,
  },
];

function isBulletPoint(text: string): boolean {
  return /^[\u2022\u2023\u25E6\u2043\u2219\u25AA\u25CF\u2013\u2014\-*•]\s*/.test(
    text.trim(),
  );
}

function stripBulletPrefix(text: string): string {
  return text
    .trim()
    .replace(/^[\u2022\u2023\u25E6\u2043\u2219\u25AA\u25CF\u2013\u2014\-*•]\s*/, '')
    .trim();
}

function extractEmail(text: string): string | null {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

function extractPhone(text: string): string | null {
  const match = text.match(/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return match ? match[0] : null;
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s]+|github\.com\/[^\s]+|linkedin\.com\/in\/[^\s]+/gi);
  if (!matches) return [];
  return matches.map((url) => (url.startsWith('http') ? url : 'https://' + url));
}

function deriveLinkLabel(url: string): string {
  if (url.includes('github.com')) return 'GitHub';
  if (url.includes('linkedin.com')) return 'LinkedIn';
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return 'Link';
  }
}

export function extractProfile(snapshot: PdfSnapshot): {
  profile: MasterProfile;
  report: ExtractionReport;
} {
  const layout = measureDocument(snapshot.pages);
  const bands = layout.bands;

  const extractedNodes: ExtractedNode[] = [];
  const droppedText: DroppedText[] = [];
  const warnings: ExtractionWarning[] = [];
  const unanchoredLinks: UnanchoredLinkRow[] = [];
  const sectionsFound: string[] = [];

  interface SectionBlock {
    kind: ExtractedKind;
    title: string;
    bands: LineBand[];
  }

  const topBands: LineBand[] = [];
  const sections: SectionBlock[] = [];
  let currentSection: SectionBlock | null = null;

  for (const band of bands) {
    const cleanText = band.text.trim();
    if (!cleanText) continue;

    let matchedKind: ExtractedKind | null = null;
    for (const rule of SECTION_PATTERNS) {
      if (rule.regex.test(cleanText)) {
        matchedKind = rule.kind;
        break;
      }
    }

    if (matchedKind !== null) {
      sectionsFound.push(cleanText);
      currentSection = {
        kind: matchedKind,
        title: cleanText,
        bands: [],
      };
      sections.push(currentSection);
    } else if (currentSection !== null) {
      currentSection.bands.push(band);
    } else {
      topBands.push(band);
    }
  }

  // Parse Identity
  let full_name = 'Candidate';
  let email = 'candidate@example.com';
  let phone: string | null = null;
  let location: string | null = null;
  let headline: string | null = null;
  const identityLinks: MasterLink[] = [];

  const identityTexts: string[] = [];
  for (const band of topBands) {
    const t = band.text.trim();
    if (!t) continue;
    identityTexts.push(t);

    const foundEmail = extractEmail(t);
    if (foundEmail && email === 'candidate@example.com') email = foundEmail;

    const foundPhone = extractPhone(t);
    if (foundPhone && !phone) phone = foundPhone;

    const urls = extractUrls(t);
    for (const u of urls) {
      identityLinks.push({
        id: mintId(),
        label: deriveLinkLabel(u),
        url: u,
      });
    }
  }

  if (identityTexts.length > 0) {
    const firstLine = identityTexts[0]!;
    if (!extractEmail(firstLine) && !extractPhone(firstLine)) {
      full_name = firstLine;
    }
    if (identityTexts.length > 1) {
      const secondLine = identityTexts[1]!;
      if (
        !extractEmail(secondLine) &&
        !extractPhone(secondLine) &&
        extractUrls(secondLine).length === 0
      ) {
        headline = secondLine;
      }
    }
  }

  for (const page of snapshot.pages) {
    for (const link of page.links) {
      if (!identityLinks.some((l) => l.url === link.url)) {
        identityLinks.push({
          id: mintId(),
          label: deriveLinkLabel(link.url),
          url: link.url,
        });
      }
    }
  }

  const identity: MasterIdentity = {
    full_name,
    headline,
    email,
    phone,
    location,
    links: identityLinks,
  };

  // Parse Summary
  let summary: MasterSummary | null = null;
  const summarySec = sections.find((s) => s.kind === 'summary');
  if (summarySec && summarySec.bands.length > 0) {
    const summaryText = summarySec.bands.map((b) => b.text).join(' ');
    const id = mintId();
    summary = { id, text: summaryText };
    extractedNodes.push({
      kind: 'summary',
      nodeId: id,
      label: summaryText.substring(0, 60) + '...',
      fromTop: summarySec.bands[0]?.fromTop ?? 0,
      pageNumber: summarySec.bands[0]?.pageNumber ?? 1,
    });
  }

  // Parse Skills
  const skills: MasterSkill[] = [];
  const skillSec = sections.find((s) => s.kind === 'skill');
  if (skillSec) {
    for (const band of skillSec.bands) {
      const raw = band.text.trim();
      let category = 'Technical Skills';
      let skillList = raw;

      if (raw.includes(':')) {
        const parts = raw.split(':');
        category = parts[0]!.trim();
        skillList = parts.slice(1).join(':').trim();
      }

      const items = skillList
        .split(/[,|•\u2022]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const name of items) {
        const id = mintId();
        skills.push({ id, name, category });
        extractedNodes.push({
          kind: 'skill',
          nodeId: id,
          label: `${category}: ${name}`,
          fromTop: band.fromTop,
          pageNumber: band.pageNumber,
        });
      }
    }
  }

  // Parse Experience
  const experience: MasterExperience[] = [];
  const expSec = sections.find((s) => s.kind === 'experience');
  if (expSec) {
    let currentExp: MasterExperience | null = null;
    for (const band of expSec.bands) {
      const text = band.text.trim();
      if (!text) continue;

      if (!isBulletPoint(text) && (text.includes(' - ') || text.includes(' | ') || /\b(20\d{2}|19\d{2})\b/.test(text))) {
        const id = mintId();
        const parts = text.split(/[-|•\u2022]/).map((p) => p.trim());
        const role = parts[0] || 'Role';
        const company = parts[1] || 'Company';
        let start_display = '2020';
        let end_display = 'Present';

        const dateMatch = text.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|[A-Z][a-z]+)?\s*\d{4}\s*[-–—]\s*(?:Present|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|[A-Z][a-z]+)?\s*\d{4})/i);
        if (dateMatch) {
          const dParts = dateMatch[0].split(/[-–—]/).map((p) => p.trim());
          start_display = dParts[0] || '2020';
          end_display = dParts[1] || 'Present';
        }

        currentExp = {
          id,
          company,
          role,
          location: null,
          start_display,
          end_display,
          start_date: null,
          end_date: null,
          bullets: [],
        };
        experience.push(currentExp);
        extractedNodes.push({
          kind: 'experience',
          nodeId: id,
          label: `${role} at ${company}`,
          fromTop: band.fromTop,
          pageNumber: band.pageNumber,
        });
      } else if (currentExp) {
        const bulletText = stripBulletPrefix(text);
        const bId = mintId();
        const bulletNode: MasterBullet = {
          id: bId,
          text: bulletText,
          tags: [],
        };
        (currentExp.bullets as MasterBullet[]).push(bulletNode);
        extractedNodes.push({
          kind: 'bullet',
          nodeId: bId,
          label: bulletText.substring(0, 60),
          fromTop: band.fromTop,
          pageNumber: band.pageNumber,
        });
      }
    }
  }

  // Parse Projects
  const projects: MasterProject[] = [];
  const projSec = sections.find((s) => s.kind === 'project');
  if (projSec) {
    let currentProj: MasterProject | null = null;
    for (const band of projSec.bands) {
      const text = band.text.trim();
      if (!text) continue;

      if (!isBulletPoint(text) && !currentProj) {
        const id = mintId();
        const urls = extractUrls(text);
        const projLinks: MasterLink[] = urls.map((u) => ({
          id: mintId(),
          label: deriveLinkLabel(u),
          url: u,
        }));
        currentProj = {
          id,
          name: text,
          links: projLinks,
          start_display: '',
          end_display: '',
          start_date: null,
          end_date: null,
          bullets: [],
        };
        projects.push(currentProj);
        extractedNodes.push({
          kind: 'project',
          nodeId: id,
          label: text,
          fromTop: band.fromTop,
          pageNumber: band.pageNumber,
        });
      } else if (currentProj) {
        if (isBulletPoint(text)) {
          const bulletText = stripBulletPrefix(text);
          const bId = mintId();
          (currentProj.bullets as MasterBullet[]).push({
            id: bId,
            text: bulletText,
            tags: [],
          });
        } else {
          const id = mintId();
          currentProj = {
            id,
            name: text,
            links: [],
            start_display: '',
            end_display: '',
            start_date: null,
            end_date: null,
            bullets: [],
          };
          projects.push(currentProj);
        }
      }
    }
  }

  // Parse Education
  const education: MasterEducation[] = [];
  const eduSec = sections.find((s) => s.kind === 'education');
  if (eduSec) {
    for (const band of eduSec.bands) {
      const text = band.text.trim();
      if (!text) continue;
      const id = mintId();
      const parts = text.split(/[-|•\u2022]/).map((p) => p.trim());
      const degree = parts[0] || 'Degree';
      const institution = parts[1] || 'University';
      education.push({
        id,
        institution,
        degree,
        field: null,
        start_display: '2018',
        end_display: '2022',
        start_date: null,
        end_date: null,
        grade_display: null,
        bullets: [],
      });
      extractedNodes.push({
        kind: 'education',
        nodeId: id,
        label: `${degree} from ${institution}`,
        fromTop: band.fromTop,
        pageNumber: band.pageNumber,
      });
    }
  }

  // Parse Achievements & Certifications
  const achievements: MasterAchievement[] = [];
  const achSec = sections.find((s) => s.kind === 'achievement');
  if (achSec) {
    for (const band of achSec.bands) {
      const text = band.text.trim();
      if (!text) continue;
      const id = mintId();
      achievements.push({
        id,
        label: text,
        description: null,
        bullets: [],
      });
    }
  }

  const certifications: MasterCertification[] = [];
  const certSec = sections.find((s) => s.kind === 'certification');
  if (certSec) {
    for (const band of certSec.bands) {
      const text = band.text.trim();
      if (!text) continue;
      const id = mintId();
      certifications.push({
        id,
        label: text,
        description: null,
        bullets: [],
      });
    }
  }

  const profile: MasterProfile = {
    schema_version: 1,
    identity,
    summary,
    education,
    experience,
    projects,
    skills,
    achievements,
    certifications,
    links: identityLinks,
  };

  const report: ExtractionReport = {
    producer: snapshot.producer,
    readingOrderReconstructed: layout.readingOrderReconstructed,
    sectionsFound,
    extracted: extractedNodes,
    dropped: droppedText,
    unanchoredLinks,
    warnings,
  };

  return { profile, report };
}

async function resolvePdfjs(): Promise<PdfjsLike | null> {
  try {
    const specifier = 'pdfjs-dist/legacy/build/pdf.mjs';
    // @ts-ignore
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    if (mod && typeof mod.getDocument === 'function') {
      return mod as unknown as PdfjsLike;
    }
  } catch {}
  try {
    const specifier = 'pdfjs-dist';
    // @ts-ignore
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    if (mod && typeof mod.getDocument === 'function') {
      return mod as unknown as PdfjsLike;
    }
  } catch {}
  if (typeof globalThis !== 'undefined' && (globalThis as Record<string, unknown>).pdfjsLib) {
    return (globalThis as Record<string, unknown>).pdfjsLib as PdfjsLike;
  }
  return null;
}

function extractRawTextFromPdfBytes(pdfBytes: Uint8Array): string {
  const decoder = new TextDecoder('latin1');
  const raw = decoder.decode(pdfBytes);
  const textMatches: string[] = [];

  const stringRegex = /\(([^()\\]|\\[\s\S])*\)/g;
  let match: RegExpExecArray | null;

  while ((match = stringRegex.exec(raw)) !== null) {
    const str = match[0]
      .slice(1, -1)
      .replace(/\\([()])/g, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
    if (str.trim().length > 1) {
      textMatches.push(str);
    }
  }

  return textMatches.join('\n');
}

function parseTextToProfile(rawText: string): MasterProfile {
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const snapshot: PdfSnapshot = {
    producer: 'RawTextFallback',
    pages: [
      {
        pageNumber: 1,
        height: 841.9,
        items: lines.map((line, idx) => ({
          str: line,
          x: 40,
          y: 800 - idx * 12,
          width: line.length * 5,
          height: 10,
          fontName: 'default',
        })),
        links: [],
      },
    ],
  };
  return extractProfile(snapshot).profile;
}

export async function extractPdf(
  pdfBytes: Uint8Array,
  pdfjs?: PdfjsLike,
): Promise<MasterProfile> {
  const res = await extractPdfWithReport(pdfBytes, pdfjs);
  return res.profile;
}

export async function extractPdfWithReport(
  pdfBytes: Uint8Array,
  pdfjs?: PdfjsLike,
): Promise<{ profile: MasterProfile; report: ExtractionReport }> {
  let resolvedPdfjs: PdfjsLike | null | undefined = pdfjs;
  if (!resolvedPdfjs) {
    resolvedPdfjs = await resolvePdfjs();
  }

  if (resolvedPdfjs) {
    try {
      const snapshot = await loadPdfSnapshot(resolvedPdfjs, pdfBytes);
      return extractProfile(snapshot);
    } catch {
      // Fallback if snapshot loading fails
    }
  }

  const rawText = extractRawTextFromPdfBytes(pdfBytes);
  const profile = parseTextToProfile(rawText);
  const report: ExtractionReport = {
    producer: 'RawTextFallback',
    readingOrderReconstructed: false,
    sectionsFound: [],
    extracted: [],
    dropped: [],
    unanchoredLinks: [],
    warnings: [],
  };
  return { profile, report };
}
