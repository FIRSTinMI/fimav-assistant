import { isSocketIo, TRPC_SHAPES } from './adapters';
import SocketIoSession from './socketio';
import { TrpcSession } from './trpc';
import { Generation, generationFor, parseVersion } from './version';

// Which Companion is on the other end, and which adapter edits it.
//
// The version comes from the full export when it has one (companionBuild,
// 4.1 and later), else from socket.io's app-version-info (3.0 to 4.0), which
// only reads. The version picks an adapter; a probe then checks that every
// procedure the adapter calls exists, so a release that renamed one shows up
// as read only rather than failing halfway through a save.

export interface CompanionInfo {
    version: string;
    // null: no adapter fits, the layout is read only
    generation: Generation | null;
    // Procedures the version's own adapter needs and this Companion lacks
    missing: string[];
}

export interface ProbeSession {
    has(_kind: 'mutation' | 'subscription', _path: string): Promise<boolean>;
    close(): void;
}

// tRPC procedures from the adapter's list that this Companion lacks.
export async function missingProcedures(
    s: ProbeSession,
    generation: Generation
): Promise<string[]> {
    const shape = TRPC_SHAPES[generation];
    if (!shape) return [];
    const missing: string[] = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const path of shape.mutations) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await s.has('mutation', path))) missing.push(path);
    }
    // eslint-disable-next-line no-restricted-syntax
    for (const path of shape.subscriptions) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await s.has('subscription', path))) missing.push(path);
    }
    return missing;
}

// tRPC generations, newest first: the order a version with no exact match
// tries them in.
const TRPC_ORDER = (Object.keys(TRPC_SHAPES) as Generation[]).reverse();

// Pick the tRPC adapter: the version's own if its probe passes, else the
// newest other one whose probe passes (a patch release that moved a call
// back or forward), else none.
export async function pickTrpc(
    s: ProbeSession,
    wanted: Generation | null
): Promise<{ generation: Generation | null; missing: string[] }> {
    const own = wanted && TRPC_SHAPES[wanted] ? wanted : null;
    const ownMissing = own ? await missingProcedures(s, own) : [];
    if (own && !ownMissing.length) return { generation: own, missing: [] };
    // eslint-disable-next-line no-restricted-syntax
    for (const g of TRPC_ORDER) {
        // eslint-disable-next-line no-continue
        if (g === own) continue;
        // eslint-disable-next-line no-await-in-loop
        if (!(await missingProcedures(s, g)).length) {
            return { generation: g, missing: ownMissing };
        }
    }
    return { generation: null, missing: ownMissing };
}

async function socketIoVersion(baseUrl: string): Promise<string | null> {
    let s: SocketIoSession | null = null;
    try {
        // The array form answers on every socket.io version (see socketio.ts).
        s = await SocketIoSession.open(baseUrl, true);
        const info = await s.call('app-version-info', []);
        return typeof info?.appVersion === 'string' ? info.appVersion : null;
    } catch {
        return null;
    } finally {
        s?.close();
    }
}

export async function detectCompanion(
    baseUrl: string,
    exportJson: any
): Promise<CompanionInfo> {
    const fromExport =
        typeof exportJson?.companionBuild === 'string'
            ? exportJson.companionBuild
            : null;
    const raw = fromExport ?? (await socketIoVersion(baseUrl));
    const version = parseVersion(raw);
    const wanted = version ? generationFor(version) : null;

    if (wanted && isSocketIo(wanted)) {
        // socket.io has no way to ask whether an event exists without
        // running it, so the version alone decides; it was read over the
        // same socket.io the adapter uses.
        return { version: raw ?? '', generation: wanted, missing: [] };
    }

    // 4.1 and later (or a version that could not be read but has /trpc)
    let s: TrpcSession | null = null;
    try {
        s = await TrpcSession.open(baseUrl);
        const picked = await pickTrpc(s, wanted);
        return { version: raw ?? '', ...picked };
    } catch {
        return { version: raw ?? '', generation: null, missing: [] };
    } finally {
        s?.close();
    }
}
