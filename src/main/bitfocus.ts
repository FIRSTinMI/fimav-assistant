import zlib from 'zlib';
import { CompanionOps, DownAction, openOps } from './companion/adapters';
import { CompanionInfo, detectCompanion } from './companion/detect';
import { isUntested, parseVersion } from './companion/version';
import {
    CompanionAction,
    CompanionButton,
    CompanionLayout,
    CompanionPage,
    CustomAdConfig,
    CustomAdState,
    FmsAutomationConfig,
    matchActionDef,
} from '../models/Bitfocus';
import { getStore } from './store';

// A version string that parses and is newer than the newest one tested.
function isUntestedRaw(raw: string): boolean {
    const v = parseVersion(raw);
    return !!v && isUntested(v);
}

// Bitfocus Companion + audience-display trigger access for the Bitfocus tab.
//
// Reading: Companion's full config export (GET /int/export/full, gzipped JSON)
// gives every page, button and connection in one request.
//
// Writing: Companion has no public API for editing buttons. Its own web UI
// edits over tRPC on ws://<host>/trpc, and this uses the same calls. The tab
// supports Companion 5.0 and 5.1: companion/ holds an adapter for each,
// picked by the running version and confirmed by a probe. Older versions, or
// a newer one neither probe passes, are shown read only. This runs in the
// main process because
// Companion 5.x refuses a WebSocket whose browser Origin does not match its
// own host, and a Node client sends no Origin.

const FMS_URL = 'http://10.0.100.5';

// Companion runs on the AV machine itself, for FIM-AV and for the FMS audience
// display alike, on the port set in Settings (FIM's default 8888).
export function companionUrl(): string {
    return `http://127.0.0.1:${getStore().get('companionPort', 8888)}`;
}

// The custom audience display is run by AudienceDisplayAddon on this machine.
export const CUSTOM_AD_URL = 'http://127.0.0.1:3001';

// #region Companion read

type Opt = { value?: unknown; isExpression?: boolean } | unknown;

function plain(v: Opt): unknown {
    if (v && typeof v === 'object' && 'value' in (v as object)) {
        return (v as { value: unknown }).value;
    }
    return v;
}

function buttonText(ctl: any): string {
    const layers: any[] = ctl?.style?.layers ?? [];
    const text = layers.find((l) => l?.type === 'text');
    if (text) return String(plain(text.text) ?? '');
    return String(ctl?.style?.text ?? '');
}

function buttonActions(ctl: any): CompanionAction[] {
    const down: any[] = ctl?.steps?.['0']?.action_sets?.down ?? [];
    return down.map((a) => ({
        id: a.id,
        definitionId: a.definitionId ?? a.action,
        connectionId: a.connectionId ?? a.instance,
        options: Object.fromEntries(
            Object.entries(a.options ?? {}).map(([k, v]) => [k, plain(v)])
        ),
        hasExpression: Object.values(a.options ?? {}).some(
            (v: any) => v?.isExpression === true
        ),
    }));
}

// The export's layout, for 5.x and, read only, for older Companions whose
// export has the same per-page shape.
export function parseCompanionExport(
    json: any
): Omit<CompanionLayout, 'version' | 'editable' | 'untested'> {
    const pages: CompanionPage[] = Object.entries(json.pages ?? {})
        .map(([num, p]: [string, any]) => {
            const buttons: Record<string, CompanionButton> = {};
            Object.entries(p.controls ?? {}).forEach(
                ([r, row]: [string, any]) =>
                    Object.entries(row ?? {}).forEach(
                        ([c, ctl]: [string, any]) => {
                            buttons[`${r}/${c}`] = {
                                type: ctl?.type ?? '',
                                text: buttonText(ctl),
                                actions: buttonActions(ctl),
                            };
                        }
                    )
            );
            const grid = p.gridSize ?? {};
            return {
                number: Number(num),
                name: p.name ?? '',
                rows: (grid.maxRow ?? 3) - (grid.minRow ?? 0) + 1,
                columns: (grid.maxColumn ?? 7) - (grid.minColumn ?? 0) + 1,
                buttons,
            };
        })
        .sort((a, b) => a.number - b.number);

    const connections = Object.entries(json.instances ?? {})
        .filter(([, i]: [string, any]) => i?.instance_type || i?.moduleId)
        .map(([id, i]: [string, any]) => ({
            id,
            module: i.instance_type ?? i.moduleId,
            label: i.label ?? id,
        }));

    return { pages, connections };
}

export async function readCompanionExport(baseUrl: string): Promise<any> {
    const res = await fetch(`${baseUrl}/int/export/full`, {
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Companion export: HTTP ${res.status}`);
    // Gzipped without a Content-Encoding header, so it arrives compressed.
    const raw = Buffer.from(await res.arrayBuffer());
    return JSON.parse(
        (raw[0] === 0x1f && raw[1] === 0x8b
            ? zlib.gunzipSync(raw)
            : raw
        ).toString('utf8')
    );
}

// #endregion

// #region Companion write

export interface ButtonEdit {
    page: number;
    row: number;
    column: number;
    text: string;
    // In order; options hold plain values.
    actions: {
        definitionId: string;
        connectionId: string;
        options: Record<string, unknown>;
    }[];
}

// Write one button: create it if the cell is empty, set its label, and replace
// its press actions with the given list. Only buttons whose actions are all in
// the catalog are edited this way (the tab checks), so replacing the list
// cannot drop an action the editor does not show.
export async function saveButtonWith(
    ops: CompanionOps,
    edit: ButtonEdit
): Promise<void> {
    let controlId = await ops.controlIdAt(edit.page, edit.row, edit.column);
    if (!controlId) {
        await ops.createButton(edit.page, edit.row, edit.column);
        controlId = await ops.controlIdAt(edit.page, edit.row, edit.column);
        if (!controlId) throw new Error('Companion did not create the button');
    }

    const config = await ops.readButton(controlId);
    if (config?.type !== 'button-layered') {
        throw new Error('Not an editable button');
    }
    const current = config.actions;
    const editable = (a: DownAction) =>
        !Object.values(a.options).some((v: any) => v?.isExpression === true) &&
        matchActionDef(
            a.definitionId,
            Object.fromEntries(
                Object.entries(a.options).map(([k, v]) => [k, plain(v)])
            )
        );
    if (current.some((a) => !editable(a))) {
        throw new Error('Button has actions only Companion can edit');
    }

    await ops.setText(controlId, config, edit.text);

    // Replace the press actions. The new list is added first (add appends,
    // so order is kept) and the old ones are removed only once every new
    // action and option is in. If anything fails while adding, the actions
    // added so far are removed again, so a failed save leaves the button with
    // its old actions rather than none.
    const added: string[] = [];
    try {
        // eslint-disable-next-line no-restricted-syntax
        for (const a of edit.actions) {
            // eslint-disable-next-line no-await-in-loop
            const actionId = await ops.addAction(
                controlId,
                a.connectionId,
                a.definitionId
            );
            added.push(actionId);
            // eslint-disable-next-line no-restricted-syntax
            for (const [key, v] of Object.entries(a.options)) {
                // eslint-disable-next-line no-await-in-loop
                await ops.setOption(controlId, actionId, key, v);
            }
        }
    } catch (e) {
        // eslint-disable-next-line no-restricted-syntax
        for (const actionId of added) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await ops.removeAction(controlId, actionId);
            } catch {
                // best effort; the original error is what is reported
            }
        }
        throw e;
    }
    // eslint-disable-next-line no-restricted-syntax
    for (const a of current) {
        // eslint-disable-next-line no-await-in-loop
        await ops.removeAction(controlId, a.id);
    }
}

// The adapter for the Companion at baseUrl, found once per Companion build:
// the layout poll every few seconds re-reads the export, which carries the
// build, so detection runs again only when the build changes or a call fails.
let known: { baseUrl: string; build: string; info: CompanionInfo } | null =
    null;

export async function companionInfo(
    baseUrl: string,
    exportJson: any
): Promise<CompanionInfo> {
    const build = String(exportJson?.companionBuild ?? '');
    if (known && known.baseUrl === baseUrl && known.build === build) {
        return known.info;
    }
    const info = await detectCompanion(baseUrl, exportJson);
    known = { baseUrl, build, info };
    return info;
}

export function forgetCompanion() {
    known = null;
}

async function withOps<T>(
    baseUrl: string,
    run: (_ops: CompanionOps) => Promise<T>
): Promise<T> {
    const info = await companionInfo(
        baseUrl,
        await readCompanionExport(baseUrl)
    );
    if (!info.generation) {
        throw new Error(`Unsupported Companion version ${info.version}`.trim());
    }
    const ops = await openOps(baseUrl, info.generation);
    try {
        return await run(ops);
    } catch (e) {
        // A call that failed may mean Companion changed under us; check the
        // version again on the next read.
        forgetCompanion();
        throw e;
    } finally {
        ops.close();
    }
}

export function saveCompanionButton(
    baseUrl: string,
    edit: ButtonEdit
): Promise<void> {
    return withOps(baseUrl, (ops) => saveButtonWith(ops, edit));
}

export function clearCompanionButton(
    baseUrl: string,
    page: number,
    row: number,
    column: number
): Promise<void> {
    return withOps(baseUrl, (ops) => ops.clearButton(page, row, column));
}

export async function readCompanionLayout(
    baseUrl: string
): Promise<CompanionLayout> {
    let json: any;
    try {
        json = await readCompanionExport(baseUrl);
    } catch (e) {
        forgetCompanion();
        throw e;
    }
    const info = await companionInfo(baseUrl, json);
    return {
        ...parseCompanionExport(json),
        version: info.version,
        editable: !!info.generation,
        untested: !!info.generation && isUntestedRaw(info.version),
    };
}

// #endregion

// #region Audience-display triggers

// Official FMS audience display. The whole ConfigValue is read and written
// back, so only AutomationConfig changes.
export async function readFmsAutomation(): Promise<FmsAutomationConfig> {
    const res = await fetch(
        `${FMS_URL}/api/v1.0/audience/get/GetAudienceDisplayConfigs`,
        { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) throw new Error(`FMS: HTTP ${res.status}`);
    const body = await res.json();
    const primary = (body?.Configs ?? []).find(
        (c: any) => c.ConfigId === 'Primary'
    );
    if (!primary) throw new Error('FMS: no Primary audience display config');
    return primary.ConfigValue.AutomationConfig;
}

export async function saveFmsAutomation(
    automation: FmsAutomationConfig
): Promise<FmsAutomationConfig> {
    const res = await fetch(
        `${FMS_URL}/api/v1.0/audience/get/GetAudienceDisplayConfigs`,
        { signal: AbortSignal.timeout(5000) }
    );
    const body = await res.json();
    const primary = (body?.Configs ?? []).find(
        (c: any) => c.ConfigId === 'Primary'
    );
    if (!primary) throw new Error('FMS: no Primary audience display config');
    const next = {
        ...primary.ConfigValue,
        AutomationConfig: {
            ...automation,
            BitfocusIntegrationAddress: companionUrl(),
        },
    };
    const save = await fetch(
        `${FMS_URL}/api/v1.0/audience/set/SaveAudienceDisplayConfig/Primary`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
            signal: AbortSignal.timeout(5000),
        }
    );
    if (!save.ok) throw new Error(`FMS save: HTTP ${save.status}`);
    return readFmsAutomation();
}

// Our custom audience display.
export async function readCustomAd(baseUrl: string): Promise<CustomAdState> {
    const res = await fetch(`${baseUrl}/api/companion/config`, {
        signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    if (!body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return { config: body.config, events: body.events };
}

export async function saveCustomAd(
    baseUrl: string,
    config: CustomAdConfig
): Promise<CustomAdState> {
    const res = await fetch(`${baseUrl}/api/companion/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
        signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    if (!body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return readCustomAd(baseUrl);
}

// #endregion
