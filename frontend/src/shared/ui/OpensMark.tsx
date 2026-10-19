/* The arrow to the top right after a row label that opens a modal — the row's
   curves, or a GENERAL row's detail — so the label reads as clickable before
   the pointer finds it. Drawn rather than typed: the cells already print `↗`
   for the recall a curve reaches, and this is a different thing. */

export function OpensMark() {
  return (
    <svg className="go" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M2 8 8 2M3.5 2H8v4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
