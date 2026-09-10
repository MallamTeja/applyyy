/* Browser entry point. Mounts the console and nothing else. */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

/* Design tokens before the base sheet, and both before any component sheet,
 * because the primitives in base.css read the custom properties tokens.css
 * defines. Import order here is the cascade order Vite emits. */
import './styles/tokens.css';
import './styles/base.css';

/* The mount point from index.html. */
const container = document.getElementById('root');

/* Throwing rather than optional-chaining into silence: if the root element is
 * missing the app cannot run at all, and a blank page with a clean console is
 * far harder to diagnose than a thrown error naming the missing id. */
if (container === null) {
  throw new Error('applyy console cannot start: no #root element in the page');
}

createRoot(container).render(
  /* StrictMode double-invokes effects in development, which is what surfaces a
   * Realtime subscription that is created without being cleaned up - the exact
   * bug that would otherwise open a second socket per navigation and leak. */
  <StrictMode>
    <App />
  </StrictMode>,
);
