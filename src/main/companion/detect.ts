import { TRPC_SHAPES } from './adapters';
import { TrpcSession } from './trpc';
import { Generation, generationFor, parseVersion } from './version';

// Which Companion is on the other end, and which adapter edits it.
//
// The version comes from the full export's companionBuild. It picks an
// adapter; a probe then checks that every procedure the adapter calls exists,
// so a release that renamed one shows up as read only rather than failing
// halfway through a save.

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

// Procedures from the adapter's list that this Companion lacks.
export async function missingProcedures(
    s: ProbeSession,
    generation: Generation
): Promise<string[]> {
    const shape = TRPC_SHAPES[generation];
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

// Newest first: the order the other adapter is tried in.
const TRPC_ORDER = (Object.keys(TRPC_SHAPES) as Generation[]).reverse();

// Pick the adapter: the version's own if its probe passes, else the other
// one if its probe passes (a patch release that moved a call back or
// forward), else none.
export async function pickTrpc(
    s: ProbeSession,
    wanted: Generation | null
): Promise<{ generation: Generation | null; missing: string[] }> {
    const own = wanted;
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

export async function detectCompanion(
    baseUrl: string,
    exportJson: any
): Promise<CompanionInfo> {
    const raw =
        typeof exportJson?.companionBuild === 'string'
            ? exportJson.companionBuild
            : '';
    const version = parseVersion(raw);
    const wanted = version ? generationFor(version) : null;

    // Before 5.0 (and before 4.1 the export has no companionBuild at all):
    // read only, without opening /trpc, which 4.0 and older never answer.
    if (!wanted) return { version: raw, generation: null, missing: [] };

    let s: TrpcSession | null = null;
    try {
        s = await TrpcSession.open(baseUrl);
        return { version: raw, ...(await pickTrpc(s, wanted)) };
    } catch {
        return { version: raw, generation: null, missing: [] };
    } finally {
        s?.close();
    }
}
