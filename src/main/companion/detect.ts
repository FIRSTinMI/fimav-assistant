import { replyShapeProblems, TRPC_SHAPES } from './adapters';
import { TrpcSession } from './trpc';
import { Generation, generationFor, isUntested, parseVersion } from './version';

// Which Companion is on the other end, and which adapter edits it.
//
// The version comes from the full export's companionBuild. It picks an
// adapter; a probe then checks that every procedure the adapter calls exists,
// and, for a version newer than the newest tested one, a read-only look at
// the replies checks their shape. A release that renamed a call or changed a
// reply shows up as read only rather than failing halfway through a save.

export interface CompanionInfo {
    version: string;
    // null: no adapter fits, the layout is read only
    generation: Generation | null;
    // Procedures the version's own adapter needs and this Companion lacks,
    // or replies it reads that came back in a shape it does not know
    missing: string[];
}

export interface ProbeSession {
    has(_kind: 'mutation' | 'subscription', _path: string): Promise<boolean>;
    // First value of a subscription, for the reply-shape check
    first(_path: string, _input: unknown): Promise<any>;
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

// Pick the adapter: the version's own if its probe passes, else another
// whose probe passes (a patch release that moved a call back or forward),
// else none. Two adapters can share every procedure name (5.1 and 5.2), so
// any adapter other than the version's own must also pass the reply-shape
// check, and so must the version's own when the version is newer than the
// newest tested one.
export async function pickTrpc(
    s: ProbeSession,
    wanted: Generation | null,
    checkOwnShapes = false
): Promise<{ generation: Generation | null; missing: string[] }> {
    const own = wanted;
    let ownMissing: string[] = [];
    if (own) {
        ownMissing = await missingProcedures(s, own);
        if (!ownMissing.length && checkOwnShapes) {
            ownMissing = await replyShapeProblems(s, own);
        }
        if (!ownMissing.length) return { generation: own, missing: [] };
    }
    // eslint-disable-next-line no-restricted-syntax
    for (const g of TRPC_ORDER) {
        // eslint-disable-next-line no-continue
        if (g === own) continue;
        if (
            // eslint-disable-next-line no-await-in-loop
            !(await missingProcedures(s, g)).length &&
            // eslint-disable-next-line no-await-in-loop
            !(await replyShapeProblems(s, g)).length
        ) {
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
        // Above the newest tested release, also check the replies the
        // adapter reads, so a release that kept a name but changed its answer
        // is read only instead of failing halfway through a save.
        const picked = await pickTrpc(s, wanted, isUntested(version!));
        return { version: raw, ...picked };
    } catch {
        return { version: raw, generation: null, missing: [] };
    } finally {
        s?.close();
    }
}
