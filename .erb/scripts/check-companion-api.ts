// Weekly check (.github/workflows/companion-api.yml) that the newest
// Companion release still has every procedure the Bitfocus tab's adapter for
// it calls. Reads Companion's source at that tag; nothing runs.
//
//   ts-node .erb/scripts/check-companion-api.ts <companion checkout> <tag>
//
// Companion's web UI is type-checked against its tRPC router, so a call such
// as `trpc.controls.resetControls.mutationOptions` in webui/src proves the
// procedure exists at that path and kind. A procedure the web UI no longer
// calls is looked for as a declaration (`name: ...Procedure ... .mutation(`)
// under companion/lib instead. Anything found by neither fails the run,
// named, so the adapter can be fixed before a cart installs that release.
//
// The app makes the same check at run time with a probe (see
// src/main/companion/detect.ts); this one only gives warning first.
import fs from 'fs';
import path from 'path';
import { TRPC_SHAPES, TrpcShape } from '../../src/main/companion/adapters';
import {
    Generation,
    generationFor,
    parseVersion,
} from '../../src/main/companion/version';

type Kind = 'mutation' | 'subscription';

function sources(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            return e.name === 'node_modules' ? [] : sources(p);
        }
        return /\.(ts|tsx)$/.test(e.name) ? [fs.readFileSync(p, 'utf8')] : [];
    });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// How the web UI calls a procedure of each kind (tRPC v11 react-query).
const UI_USE: Record<Kind, string> = {
    mutation: '(mutationOptions|mutationKey|useMutation)',
    subscription: '(subscriptionOptions|useSubscription)',
};

export function usedByWebUi(webui: string[], kind: Kind, proc: string) {
    const re = new RegExp(`\\btrpc\\.${escape(proc)}\\.${UI_USE[kind]}\\b`);
    return webui.some((src) => re.test(src));
}

// `leaf: publicProcedure ... .mutation(`: the first .mutation/.subscription/
// .query after the declaration decides its kind
export function declaredInLib(lib: string[], kind: Kind, proc: string) {
    const leaf = proc.split('.').pop()!;
    const re = new RegExp(
        `\\b${escape(
            leaf
        )}\\s*:\\s*\\w*[Pp]rocedure\\b[\\s\\S]{0,4000}?\\.(mutation|subscription|query)\\s*\\(`,
        'g'
    );
    return lib.some((src) =>
        Array.from(src.matchAll(re)).some((m) => m[1] === kind)
    );
}

export function missingFor(
    shape: TrpcShape,
    webui: string[],
    lib: string[]
): { missing: string[]; libOnly: string[] } {
    const missing: string[] = [];
    const libOnly: string[] = [];
    const calls: [Kind, string][] = [
        ...shape.mutations.map((p): [Kind, string] => ['mutation', p]),
        ...shape.subscriptions.map((p): [Kind, string] => ['subscription', p]),
    ];
    calls.forEach(([kind, proc]) => {
        if (usedByWebUi(webui, kind, proc)) return;
        if (declaredInLib(lib, kind, proc)) libOnly.push(`${kind} ${proc}`);
        else missing.push(`${kind} ${proc}`);
    });
    return { missing, libOnly };
}

function main() {
    const [checkout, tag] = process.argv.slice(2);
    if (!checkout || !tag) {
        console.error('usage: check-companion-api.ts <checkout> <tag>');
        process.exit(2);
    }
    const version = parseVersion(tag);
    const generation: Generation | null = version
        ? generationFor(version)
        : null;
    const shape = generation && TRPC_SHAPES[generation];
    if (!shape) {
        console.error(`${tag}: no tRPC adapter for this version`);
        process.exit(1);
    }
    const webui = sources(path.join(checkout, 'webui', 'src'));
    const lib = sources(path.join(checkout, 'companion', 'lib'));
    if (!webui.length || !lib.length) {
        console.error(`${checkout}: no webui/src or companion/lib`);
        process.exit(2);
    }
    const { missing, libOnly } = missingFor(shape, webui, lib);
    libOnly.forEach((c) =>
        console.log(`${tag}: ${c} not called by the web UI, declared in lib`)
    );
    if (missing.length) {
        missing.forEach((c) =>
            console.error(
                `${tag}: ${c} missing (adapter ${generation}); fix src/main/companion/adapters.ts`
            )
        );
        process.exit(1);
    }
    console.log(`${tag}: adapter ${generation} OK`);
}

if (require.main === module) main();
