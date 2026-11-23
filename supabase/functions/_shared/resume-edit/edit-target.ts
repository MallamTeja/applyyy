// COPY of the EditTarget union from apps/web/src/features/approval/diffModel.ts (S9i P1, 2026-11-21). Only the type
// travels: the rest of diffModel is the web's view model, which the server-side apply never renders.
// TEMPORARY TWIN: after bundle 2 ships, diffModel.ts re-exports this type, so only one copy remains.

/* What an edit can aim at. A tagged union rather than a bare ref string, because the summary has no ref (it is a
 * string) and a magic 'summary' ref could collide with a real NodeId. There is no arm that could name master_text,
 * identity or a version (R0). */
export type EditTarget =
  /* One bullet, named by its ref - refs are unique across the resume, so the ref alone locates it. */
  | { readonly kind: 'bullet'; readonly ref: string }
  /* The top-level summary paragraph. */
  | { readonly kind: 'summary' }
  /* The skills list as a whole (T3, 2026-10-08): selection edits only, never typed text. */
  | { readonly kind: 'skills' };
