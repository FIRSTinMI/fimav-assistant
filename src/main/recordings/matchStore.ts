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

function readManifest(folder: string): MatchRecord[] {
    try {
        const p = manifestPath(folder);
        if (!fs.existsSync(p)) return [];
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(data?.matches) ? data.matches : [];
    } catch (e) {
        log.warn('readManifest failed', e);
        return [];
    }
}

function writeManifest(folder: string, matches: MatchRecord[]): void {
    try {
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(
            manifestPath(folder),
            JSON.stringify({ version: 1, matches }, null, 2)
        );
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

// Insert a new record or replace an existing one with the same id.
export function upsertMatch(folder: string, record: MatchRecord): void {
    const matches = readManifest(folder);
    const idx = matches.findIndex((m) => m.id === record.id);
    if (idx >= 0) matches[idx] = record;
    else matches.push(record);
    writeManifest(folder, matches);
}

// Merge a partial patch into an existing record. Returns the updated record, or
// null if no record with that id exists in this folder.
export function updateMatch(
    folder: string,
    id: string,
    patch: Partial<MatchRecord>
): MatchRecord | null {
    const matches = readManifest(folder);
    const idx = matches.findIndex((m) => m.id === id);
    if (idx < 0) {
        log.warn(`updateMatch: no record ${id} in ${folder}`);
        return null;
    }
    const updated = { ...matches[idx], ...patch };
    matches[idx] = updated;
    writeManifest(folder, matches);
    return updated;
}
