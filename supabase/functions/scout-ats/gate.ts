// The scout's run gate, in a module of its own: index.ts executes Deno.serve on import,
// so `node --test` can only reach logic that lives outside it (same pattern as
// email-tracker-intake/decide.ts).

/**
 * Whether this run is halted by the kill switch (`system_settings.system_enabled`).
 * `force` is accepted and DELIBERATELY ignored for the halt itself: since 2026-10-23 the
 * kill switch is absolute — a switch a query param can bypass is not a kill switch
 * (CLAUDE.md §6: a guard that can pass vacuously is not a guard). The parameter stays in
 * the signature so this contract is pinned by a named test rather than by a comment:
 * reintroducing `&& !force` turns that test red.
 */
export function haltedByKillSwitch(systemEnabled: boolean, _force: boolean): boolean {
  // Disabled halts every caller, forced or not.
  return !systemEnabled;
}
