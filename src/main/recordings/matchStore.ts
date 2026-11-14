import fs from 'fs';
import path from 'path';
import log from 'electron-log';
import { MatchRecord } from '../../models/MatchRecord';

// Per-event match state lives in a JSON manifest that sits IN the recording
// folder alongside the videos, not in a global app store. That way the Auto AV
// tab's history simply reflects whatever folder the app is currently pointed at:
// a new event means a new folder, which means a fresh (empty) history, with no
// manual clearing needed. The manifest holds each match's metadata (teams,
// cards) and its cut state.
const MANIFEST = 'fimav-matches.json';

function manifestPath(folder: string): string {
    return path.join(folder, MANIFEST);
}

// The youtube-tba-upload process writes into this SAME file (its per-match
// `upload` state), so both processes coordinate through one advisory lock and
// only ever touch their own fields. This lock file + protocol MUST stay
// identical to the uploader's acquireManifestLock/writeFileAtomic in db.go:
// exclusive `.lock` create, steal after 10s, 5s deadline, 40ms retries, and a
// temp-file rename for the write itself.
const LOCK_STALE_MS = 10_000;
const LOCK_DEADLINE_MS = 5_000;
const LOCK_RETRY_MS = 40;

// Synchronous sleep. matchStore is fully synchronous and the lock is held for
// microseconds, so a brief block here (only under real contention) is fine.
function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Run fn while holding the cross-process manifest lock. On timeout it proceeds
// unlocked rather than losing the write — same last-resort behaviour a stuck
// lock would force anyway, and writes are seconds apart in practice.
function withManifestLock<T>(folder: string, fn: () => T): T {
    const lock = `${manifestPath(folder)}.lock`;
    const deadline = Date.now() + LOCK_DEADLINE_MS;
    let held = false;
    for (;;) {
        let created = false;
        try {
            fs.closeSync(fs.openSync(lock, 'wx')); // O_CREAT|O_EXCL
            created = true;
        } catch {
            created = false;
        }
        if (created) {
            held = true;
            break;
        }
        // Held by someone else: steal it if it is stale, else retry until the
        // deadline. A vanished lock (stat throws) just means retry the create.
        let stale = false;
        try {
            const st = fs.statSync(lock);
            stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
        } catch {
            stale = true; // gone; loop and re-create immediately
        }
        if (stale) {
            fs.rmSync(lock, { force: true });
        } else if (Date.now() > deadline) {
            log.warn('manifest lock busy; writing without it');
            break;
        } else {
            sleepSync(LOCK_RETRY_MS);
        }
    }
    try {
        return fn();
    } finally {
        if (held) {
            try {
                fs.rmSync(lock, { force: true });
            } catch (e) {
                log.warn('releasing manifest lock failed', e);
            }
        }
    }
}

// The manifest's records; [] when there is no manifest yet. Any other
// failure (a file locked by antivirus, half-written JSON from another tool)
// returns null, so a read-modify-write skips its write instead of replacing
// every record (and the uploader's upload state) with an empty list.
function readManifestOrNull(folder: string): MatchRecord[] | null {
    const p = manifestPath(folder);
    try {
        if (!fs.existsSync(p)) return [];
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(data?.matches) ? data.matches : [];
    } catch (e) {
        log.warn('readManifest failed', e);
        return null;
    }
}

function readManifest(folder: string): MatchRecord[] {
    return readManifestOrNull(folder) ?? [];
}

// Atomic write via temp + rename, matching the uploader. Readers on the other
// process therefore never see a half-written file.
function writeManifest(folder: string, matches: MatchRecord[]): void {
    try {
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
        const p = manifestPath(folder);
        const tmp = `${p}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, matches }, null, 2));
        fs.renameSync(tmp, p);
    } catch (e) {
        log.warn('writeManifest failed', e);
    }
}

// All recorded matches in a folder, newest first. Empty when the folder is
// unknown or has no manifest yet.
export function listMatches(folder: string | null): MatchRecord[] {
    if (!folder) return [];
    return [...readManifest(folder)].sort((a, b) => b.startedAt - a.startedAt);
}

// One record by id, or null.
export function getMatch(folder: string | null, id: string): MatchRecord | null {
    if (!folder) return null;
    return readManifest(folder).find((m) => m.id === id) ?? null;
}

// Insert a new record or replace an existing one with the same id. The read,
// merge and write happen under the shared lock so a concurrent uploader write is
// never lost, and the uploader-owned `upload` field is carried over verbatim
// (FIM-AV never authors it, so replacing the record whole would otherwise drop
// it).
export function upsertMatch(folder: string, record: MatchRecord): void {
    withManifestLock(folder, () => {
        const matches = readManifestOrNull(folder);
        if (!matches) {
            log.warn(`upsertMatch: manifest unreadable, ${record.id} not saved`);
            return;
        }
        const idx = matches.findIndex((m) => m.id === record.id);
        if (idx >= 0) {
            const kept =
                record.upload !== undefined
                    ? record
                    : { ...record, upload: matches[idx].upload };
            matches[idx] = kept;
        } else {
            matches.push(record);
        }
        writeManifest(folder, matches);
    });
}

// Merge a partial patch into an existing record. Returns the updated record, or
// null if no record with that id exists in this folder. Locked read-modify-write
// for the same reason as upsertMatch; the spread preserves `upload` unless the
// patch names it.
export function updateMatch(
    folder: string,
    id: string,
    patch: Partial<MatchRecord>
): MatchRecord | null {
    return withManifestLock(folder, () => {
        const matches = readManifestOrNull(folder);
        if (!matches) return null;
        const idx = matches.findIndex((m) => m.id === id);
        if (idx < 0) {
            log.warn(`updateMatch: no record ${id} in ${folder}`);
            return null;
        }
        const updated = { ...matches[idx], ...patch };
        matches[idx] = updated;
        writeManifest(folder, matches);
        return updated;
    });
}
