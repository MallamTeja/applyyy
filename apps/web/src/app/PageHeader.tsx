/* Page title plus its one line of orientation.
 *
 * The lede comes from the route table rather than being written per page, so
 * the sentence the operator reads under a title is the same one the rail was
 * built from and there is only one copy to keep true. */

import type { ReactElement } from 'react';

import { ALL_ROUTES } from './routes';

export function PageHeader({ path }: { readonly path: string }): ReactElement {
  /* Look the route up rather than passing the title in: a page that knows its
     own path cannot be given a heading that disagrees with its rail entry. */
  const route = ALL_ROUTES.find((candidate) => candidate.path === path);

  /* A page whose path is not in the table is a routing bug, and saying so is
     more useful than rendering a blank heading. */
  if (route === undefined) {
    return (
      <header>
        <h1 className="page__title">Unknown screen</h1>
        <p className="page__lede">
          No route is registered for &quot;{path}&quot;. This is a bug in the
          console, not something you did.
        </p>
      </header>
    );
  }

  return (
    <header>
      <h1 className="page__title">{route.label}</h1>
      <p className="page__lede">{route.lede}</p>
    </header>
  );
}
