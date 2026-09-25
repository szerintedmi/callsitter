// Shared by the server (src/web/test-call.ts) and the page (src/web/client/test-call.ts).

/** bump when the page ↔ server protocol changes; an older page is told to reload instead of failing silently */
export const TEST_CALL_PROTOCOL = 2;
