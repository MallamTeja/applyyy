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

      <section className="settings-group">
        <h2 className="settings-group__title">Target Roles & Skills</h2>
        <p className="settings-group__note">
          Job titles and technologies to search across your target company boards.
        </p>

        <div className="settings-group__fields">
          <label className="field field--wide">
            <span className="field__label">Target Job Titles</span>
            <span className="field__help">
              Comma-separated titles.
            </span>
            <input
              type="text"
              className="field__control"
              placeholder="Backend Intern, Software Engineer Intern, Graduate Engineer"
            />
          </label>

          <label className="field field--wide">
            <span className="field__label">Keywords & Technologies</span>
            <span className="field__help">
              Prioritized by the Tailor during resume customization.
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
        <h2 className="settings-group__title">Role Constraints & Location</h2>
        <p className="settings-group__note">
          Required working arrangements, experience bounds, and geographic filters.
        </p>

        <div className="settings-group__fields">
          <label className="field">
            <span className="field__label">Employment Type</span>
            <select className="field__control" defaultValue="internship">
              {EMPLOYMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Work Arrangement</span>
            <select className="field__control" defaultValue="onsite">
              {WORK_ARRANGEMENTS.map((arrangement) => (
                <option key={arrangement} value={arrangement}>
                  {arrangement}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">Min Experience (Years)</span>
            <span className="field__help">Minimum required years.</span>
            <input
              type="number"
              className="field__control"
              min={0}
              defaultValue={0}
            />
          </label>

          <label className="field">
            <span className="field__label">Max Experience (Years)</span>
            <span className="field__help">Ceiling enforced by filter cascade.</span>
            <input
              type="number"
              className="field__control"
              min={0}
              defaultValue={1}
            />
          </label>

          <label className="field">
            <span className="field__label">Minimum Annual Salary (INR)</span>
            <span className="field__help">Optional. Leave empty for no floor.</span>
            <input type="number" className="field__control" min={0} />
          </label>

          <label className="field field--wide">
            <span className="field__label">Target Locations</span>
            <span className="field__help">
              Comma-separated target cities or Remote.
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
        <h2 className="settings-group__title">Pipeline Dispatch & Rate Limits</h2>
        <p className="settings-group__note">
          Autonomous execution limits and safety controls.
        </p>

        <div className="settings-group__fields">
          <label className="field field--wide">
            <span className="field__label">Emergency Kill Switch</span>
            <span className="field__help">
              Halts autonomous agent dispatch across Scout, Tailor, and Applier.
            </span>
            <select className="field__control" defaultValue="active">
              <option value="active">Active (normal pipeline execution)</option>
              <option value="disabled">Paused (emergency halt engaged)</option>
            </select>
          </label>

          <label className="field">
            <span className="field__label">Rate-Limit Backoff (Seconds)</span>
            <span className="field__help">
              Cooldown window when HTTP 429 is encountered.
            </span>
            <input
              type="number"
              className="field__control"
              min={10}
              defaultValue={60}
            />
          </label>

          <label className="field">
            <span className="field__label">Daily Submission Cap</span>
            <span className="field__help">
              Maximum applications per rolling 24 hours.
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
