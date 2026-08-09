import Store from 'electron-store';
import log from 'electron-log';
import { MatchRecord } from '../../models/MatchRecord';

// Keep the recorded-match history in its own store file (recordings.json in
// userData), separate from the schema-validated app config store. History can
// grow to a few hundred entries over an event, so it doesn't belong in config.
const MAX_RECORDS = 300;

type RecordingsSchema = {
    matches: MatchRecord[];
};

let store: Store<RecordingsSchema> | undefined;

function getRecordingsStore(): Store<RecordingsSchema> {
    if (store === undefined) {
        store = new Store<RecordingsSchema>({
            name: 'recordings',
            defaults: { matches: [] },
        });
    }
    return store;
}

// Return all recorded matches, newest first.
export function listMatches(): MatchRecord[] {
    const matches = getRecordingsStore().get('matches', []);
    return [...matches].sort((a, b) => b.startedAt - a.startedAt);
}

// Insert a new record or replace an existing one with the same id.
export function upsertMatch(record: MatchRecord): void {
    const s = getRecordingsStore();
    const matches = s.get('matches', []);
    const idx = matches.findIndex((m) => m.id === record.id);
    if (idx >= 0) {
        matches[idx] = record;
    } else {
        matches.push(record);
    }
    // Prune oldest beyond the cap
    const pruned = matches
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(-MAX_RECORDS);
    s.set('matches', pruned);
}

// Merge a partial patch into an existing record. Returns the updated record,
// or null if no record with that id exists.
export function updateMatch(
    id: string,
    patch: Partial<MatchRecord>
): MatchRecord | null {
    const s = getRecordingsStore();
    const matches = s.get('matches', []);
    const idx = matches.findIndex((m) => m.id === id);
    if (idx < 0) {
        log.warn(`updateMatch: no record with id ${id}`);
        return null;
    }
    const updated = { ...matches[idx], ...patch };
    matches[idx] = updated;
    s.set('matches', matches);
    return updated;
}

// Wipe all recorded matches (manual/dev reset).
export function clearMatches(): void {
    getRecordingsStore().set('matches', []);
}
