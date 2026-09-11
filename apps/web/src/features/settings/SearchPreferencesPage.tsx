/* Search preferences - what counts as a job worth finding (section 15).
 *
 * This page and the Filters page are two halves of one decision, kept apart on
 * purpose. THIS page says what to go looking for; Filters says what to throw
 * away once found. Merged, they would be one screen of thirty controls where
 * the operator cannot tell which ones cost money - search terms drive how many
 * jobs arrive, filters drive how many reach Gemini. */

import type { ReactElement } from 'react';

import { PageHeader } from '../../app/PageHeader';
import { EMPLOYMENT_TYPES, WORK_ARRANGEMENTS } from '../../data/contract';

import './settings.css';

export function SearchPreferencesPage(): ReactElement {
  return (
    <div className="page">
      <PageHeader path="search-preferences" />

      <p className="not-wired">
        These controls are laid out but not yet reading or writing{' '}
        <span className="identifier">search_preferences</span>. Changing one
        does nothing until the page is wired up.
      </p>

      <section className="settings-group">
        <h2 className="settings-group__title">What to look for</h2>
        <p className="settings-group__note">
          Titles and keywords are matched against the boards on your watchlist.
          Being broad here is cheap - the filters do the rejecting, before
          anything costs an AI call.
        </p>

        <div className="settings-group__fields">
          <label className="field field--wide">
            <span className="field__label">Job titles to hunt</span>
            <span className="field__help">
              Separate with commas. Matched loosely, so &quot;backend&quot;
              also finds &quot;Backend Engineer I&quot;.
            </span>
            <input
              type="text"
              className="field__control"
              placeholder="Backend Intern, Software Engineer Intern, Graduate Engineer"
            />
          </label>

          <label className="field field--wide">
            <span className="field__label">Keywords</span>
            <span className="field__help">
              These also become the keywords the Tailor emphasises, so they are
              what the coverage figure on the diff view is measured against.
            </span>
            <input
              type="text"
              className="field__control"
              placeholder="Node.js, React, TypeScript, REST APIs"
            />
          </label>
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">What you would accept</h2>
        <p className="settings-group__note">
          The bounds of a job you would actually take. Anything outside these is
          rejected before it is read.
        </p>

        <div className="settings-group__fields">
          <label className="field">
            <span className="field__label">Kind of role</span>
            {/* Options come from the schema stream's enum, so this list cannot
                offer a value the database will refuse. */}
            <select className="field__control" defaultValue="internship">
              {EMPLOYMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {/* Underscores are a column-name artefact, not something to
                      show a person. */}
                  {type.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Where you would work</span>
            <select className="field__control" defaultValue="onsite">
              {WORK_ARRANGEMENTS.map((arrangement) => (
                <option key={arrangement} value={arrangement}>
                  {arrangement}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Least experience asked for</span>
            <span className="field__help">Years. Usually zero.</span>
            <input
              type="number"
              className="field__control"
              min={0}
              defaultValue={0}
            />
          </label>

          <label className="field">
            <span className="field__label">Most experience asked for</span>
            <span className="field__help">
              Years. The Filters page enforces this as a hard ceiling.
            </span>
            <input
              type="number"
              className="field__control"
              min={0}
              defaultValue={1}
            />
          </label>

          <label className="field">
            <span className="field__label">Salary floor</span>
            <span className="field__help">
              Rupees per year. Leave blank to keep jobs that publish no figure -
              most Indian listings do not, so a floor here quietly drops a lot
              of real jobs.
            </span>
            <input type="number" className="field__control" min={0} />
          </label>

          <label className="field field--wide">
            <span className="field__label">Locations</span>
            <span className="field__help">
              An allowlist, not a blocklist: a city you forget to add is a city
              you never see.
            </span>
            <input
              type="text"
              className="field__control"
              placeholder="Hyderabad, Bangalore, Remote"
            />
          </label>
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">Pipeline safety & dispatch controls</h2>
        <p className="settings-group__note">
          Circuit-breakers and timing rules governing autonomous agent tasks.
        </p>

        <div className="settings-group__fields">
          <label className="field field--wide">
            <span className="field__label">Emergency kill switch</span>
            <span className="field__help">
              Immediately halts autonomous agent dispatch (Scout, Tailor, Applier). Running jobs terminate cleanly and pending items remain safely queued.
            </span>
            <select className="field__control" defaultValue="active">
              <option value="active">Active (normal pipeline execution)</option>
              <option value="disabled">Paused (emergency halt engaged)</option>
            </select>
          </label>

          <label className="field">
            <span className="field__label">Rate-limit backoff (seconds)</span>
            <span className="field__help">
              Cooldown window enforced when an LLM or ATS endpoint returns HTTP 429 before attempting key rotation.
            </span>
            <input
              type="number"
              className="field__control"
              min={10}
              defaultValue={60}
            />
          </label>

          <label className="field">
            <span className="field__label">Daily submission cap</span>
            <span className="field__help">
              Maximum successful applications permitted within a rolling 24-hour window to protect fit quality.
            </span>
            <input
              type="number"
              className="field__control"
              min={1}
              max={100}
              defaultValue={35}
            />
          </label>
        </div>
      </section>
    </div>
  );
}
