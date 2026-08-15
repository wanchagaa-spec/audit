// Google People API helpers (PLAN.md 17.34) — the seventh Google integration
// this bot connects to. Read-only, and deliberately scoped to one job: let
// "ส่งอีเมล ถึง <ชื่อ>" resolve a contact's name to their email address
// instead of always requiring the full address, plus a standalone
// "อีเมลของ<ชื่อ>" lookup command.
//
// People API has a dedicated searchContacts endpoint, but it depends on an
// internal search index that's known to lag behind a freshly-added or
// -edited contact — the same "don't build on unverified/undocumented
// external behavior" caution this bot already applies elsewhere (e.g.
// tasks.ts's due-time uncertainty). Fetches the account's connections
// (contacts) once instead and filters by name client-side — the same
// pattern already used for Task/Gmail keyword lookups, where neither API
// has reliable server-side keyword search either.

const PEOPLE_BASE = "https://people.googleapis.com/v1";

/** Thrown when the linked Google account's refresh token predates the
 * `contacts.readonly` scope — the caller should prompt the user to re-link. */
export class InsufficientContactsScopeError extends Error {}

/** Thrown when the Google Cloud project itself hasn't turned the People API
 * on — re-linking the Google account can't fix this, only enabling the API
 * in Google Cloud Console can (see worker/README.md setup step 3.5). */
export class ContactsApiDisabledError extends Error {}

async function peopleFetch(accessToken: string, path: string): Promise<any> {
  const res = await fetch(`${PEOPLE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) {
    const bodyText = await res.text();
    // Same two-different-problems distinction as calendar.ts/tasks.ts/
    // gmail.ts's own fetch helpers — see their comments for why telling
    // them apart matters for which fix actually applies. Checked here
    // regardless of exact status code too (see gmail.ts's real-world
    // lesson: Gmail didn't always answer a scope problem with a clean
    // 401/403 either), but People API has been consistent about it so far.
    if (/accessNotConfigured|has (not|n't) been used in project|it is disabled/i.test(bodyText)) {
      throw new ContactsApiDisabledError(bodyText);
    }
    throw new InsufficientContactsScopeError(bodyText);
  }
  if (!res.ok) {
    throw new Error(`Google People API error (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export interface Contact {
  name: string;
  email?: string;
}

/** All contacts with a name, up to 1000 (a single page) — plenty for a
 * personal contact list; v1 scope doesn't paginate further for accounts
 * with more than that (see PLAN.md 17.34). */
export async function listContacts(accessToken: string): Promise<Contact[]> {
  const q = new URLSearchParams({
    personFields: "names,emailAddresses",
    pageSize: "1000",
  });
  const data = await peopleFetch(accessToken, `/people/me/connections?${q}`);
  const raw: Array<{ name: string | undefined; email: string | undefined }> = ((data.connections ?? []) as any[]).map(
    (p) => ({
      name: p.names?.[0]?.displayName as string | undefined,
      email: p.emailAddresses?.[0]?.value as string | undefined,
    })
  );
  return raw
    .filter((c): c is { name: string; email: string | undefined } => !!c.name)
    .map((c) => ({ name: c.name, email: c.email }));
}
