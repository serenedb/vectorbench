/* The arrow to the top right after a row label that opens a detail — a
   GENERAL row or a memory row — so the label reads as clickable before the
   pointer finds it. Query rows carry a checkbox instead: theirs draws curves
   beside the table rather than opening anything. Drawn rather than typed, so
   it reads as a mark and not as part of the label's text. */

export function OpensMark() {
  return (
    <svg className="go" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M2 8 8 2M3.5 2H8v4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
