// Shared shapes for the Bitfocus tab: the Companion button layout FIM-AV
// reads, the small set of actions it can edit, and the audience-display
// trigger configs (official FMS and our custom display).

// #region Companion layout

export interface CompanionAction {
    id: string;
    definitionId: string;
    connectionId: string;
    // Plain option values (Companion stores {value, isExpression}; expressions
    // are not edited here, so only the value is carried).
    options: Record<string, unknown>;
    // Some option is a Companion expression; the editor leaves it alone.
    hasExpression: boolean;
    // Feedbacks only: the one style override this editor writes (a flat
    // background color), undefined when none has been set. Always
    // undefined on an action.
    bgColor?: number;
}

export interface CompanionButton {
    // 'button-layered' is an editable button; page up/down/number are not.
    type: string;
    text: string;
    actions: CompanionAction[];
    // Same shape as an action; Companion keeps feedbacks in their own flat
    // list on the button, not nested in a step/action-set.
    feedbacks: CompanionAction[];
}

export interface CompanionPage {
    number: number;
    name: string;
    rows: number;
    columns: number;
    // `${row}/${column}` -> button
    buttons: Record<string, CompanionButton>;
}

export interface CompanionConnection {
    id: string;
    module: string;
    label: string;
}

export interface CompanionLayout {
    pages: CompanionPage[];
    connections: CompanionConnection[];
    // Version Companion reported, '' when it could not be read
    version: string;
    // Companion is 5.0 to 5.2 (or newer with the same calls and replies).
    // When false the layout is still shown, read only.
    editable: boolean;
    // Editable, but newer than the newest release tested (version.ts)
    untested: boolean;
}

// #endregion

// #region Action catalog

export type ActionFieldType = 'vmixInput' | 'number' | 'select';

export interface ActionField {
    key: string;
    label: string;
    type: ActionFieldType;
    options?: { value: string; label: string }[];
    // Companion stores some numbers as strings (wait time); keep its type.
    asString?: boolean;
    // Unit shown after a number field
    suffix?: string;
}

export interface ActionDef {
    // Stable key for the editor: `${module}:${definitionId}`
    key: string;
    // Companion module id of the connection the action runs on; 'internal' is
    // Companion itself.
    module: string;
    definitionId: string;
    label: string;
    fields: ActionField[];
    // Options set on every save and required to match: one Companion action
    // can stand for several catalog entries (ptzMove is only a preset when
    // functionID is "move to virtual input").
    fixed?: Record<string, string>;
    // Feedbacks only: native option key(s) the one background-color picker
    // writes into, instead of a Companion style override. Only a "boolean"
    // feedback (no options of its own produce a color - xair's mute
    // feedbacks) can take an arbitrary color through a style override;
    // Companion requires a "legacy style" feedback's (vmix's tally
    // feedbacks: type "advanced") override value to be the STRING NAME of
    // one of the properties its own callback produces (e.g. "bgcolor"), not
    // a literal color - confirmed against a live button export, where
    // Companion had already auto-created that exact override pointing at
    // the string "bgcolor". For those, the only way to carry a literal
    // color onto the button is through the feedback's own option Companion
    // already copies from (`bg` on inputLive; `bgPreview`+`bgProgram`, both
    // set to the same color, on overlayStatus - this editor only offers one
    // swatch). A def with no colorOptions uses the style override instead.
    colorOptions?: string[];
}

// studiocoast-vmix v4.2.0's real overlayFunctions schema: `type` (this
// dropdown) and `overlay` (the channel number) are separate options - the
// number is NOT embedded in the dropdown value. An older module version
// combined them into one `functionID` string like "OverlayInput3In"; that
// stopped matching once the installed module moved to this split schema,
// so a saved button silently fell back to Companion's default (plain
// toggle) instead of the chosen operation, on whatever overlay number was
// already stored. Verified against the installed version directly:
// github.com/bitfocus/companion-module-studiocoast-vmix tag v4.2.0,
// src/actions/overlayActions.ts.
const OVERLAY_TYPES = [
    { value: 'OverlayInput', label: 'Toggle on program' },
    { value: 'PreviewOverlayInput', label: 'Toggle on preview' },
    { value: 'In', label: 'Transition in' },
    { value: 'Out', label: 'Transition out' },
    { value: 'Last', label: 'Last input on/off' },
    { value: 'Off', label: 'Off' },
    { value: 'Zoom', label: 'Zoom PIP to/from fullscreen' },
    { value: 'OverlayInputAllOff', label: 'All overlays off' },
];

const OVERLAY_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    value: String(n),
    label: `Overlay ${n}`,
}));

const TRANSITIONS = [
    'Cut',
    'Fade',
    'Merge',
    'Zoom',
    'Wipe',
    'Slide',
    'Fly',
    'CrossZoom',
    'FlyRotate',
    'Cube',
    'CubeZoom',
    'VerticalWipe',
    'VerticalSlide',
    'WipeReverse',
    'SlideReverse',
    'VerticalWipeReverse',
    'VerticalSlideReverse',
    'BarnDoor',
    'RollerDoor',
    'AlphaFade',
].map((t) => ({ value: t, label: t }));

const ON_OFF_TOGGLE = (base: string) => [
    { value: base, label: 'Toggle' },
    { value: `${base}On`, label: 'On' },
    { value: `${base}Off`, label: 'Off' },
];

// vMix's audioBusMaster dropdown (utils.ts): the buses an input's audio can
// route to, Master plus A-G, or "Selected" (whichever bus FIM's layout is
// currently routing - instance.routingData.bus).
const AUDIO_BUS_MASTER = [
    'Master',
    'A',
    'B',
    'C',
    'D',
    'E',
    'F',
    'G',
    'Selected',
].map((b) => ({ value: b, label: b }));

const REPLAY_CHANNEL: ActionField = {
    key: 'channel',
    label: 'Channel',
    type: 'select',
    options: ['Current', 'A', 'B'].map((c) => ({ value: c, label: c })),
};

// X-Air: channels mute with 0, mute groups with 1 (the module flips them).
const CHANNEL_MUTE = [
    { value: '0', label: 'Mute' },
    { value: '1', label: 'Unmute' },
    { value: '2', label: 'Toggle' },
];
const GROUP_MUTE = [
    { value: '1', label: 'Mute' },
    { value: '0', label: 'Unmute' },
    { value: '2', label: 'Toggle' },
];

// The actions FIM's Companion profiles use. Anything else on a button is left
// alone and edited in Companion itself.
export const ACTION_DEFS: ActionDef[] = [
    {
        key: 'studiocoast-vmix:programCut',
        module: 'studiocoast-vmix',
        definitionId: 'programCut',
        label: 'Cut',
        fields: [{ key: 'input', label: 'Input', type: 'vmixInput' }],
    },
    {
        key: 'studiocoast-vmix:quickPlay',
        module: 'studiocoast-vmix',
        definitionId: 'quickPlay',
        label: 'Quick play',
        fields: [{ key: 'input', label: 'Input', type: 'vmixInput' }],
    },
    {
        key: 'studiocoast-vmix:previewInput',
        module: 'studiocoast-vmix',
        definitionId: 'previewInput',
        label: 'Preview',
        fields: [{ key: 'input', label: 'Input', type: 'vmixInput' }],
    },
    {
        key: 'studiocoast-vmix:overlayFunctions',
        module: 'studiocoast-vmix',
        definitionId: 'overlayFunctions',
        label: 'Overlay',
        fields: [
            {
                key: 'type',
                label: 'Function',
                type: 'select',
                options: OVERLAY_TYPES,
            },
            {
                key: 'overlay',
                label: 'Overlay',
                type: 'select',
                options: OVERLAY_NUMBERS,
            },
            { key: 'input', label: 'Input', type: 'vmixInput' },
        ],
    },
    {
        key: 'studiocoast-vmix:transitionMix',
        module: 'studiocoast-vmix',
        definitionId: 'transitionMix',
        label: 'Transition',
        fields: [
            {
                key: 'functionID',
                label: 'Transition',
                type: 'select',
                options: TRANSITIONS,
            },
            {
                key: 'duration',
                label: 'Duration',
                type: 'number',
                asString: true,
                suffix: 'ms',
            },
            { key: 'input', label: 'Input', type: 'vmixInput' },
        ],
    },
    {
        key: 'studiocoast-vmix:ptzMove',
        module: 'studiocoast-vmix',
        definitionId: 'ptzMove',
        label: 'PTZ preset',
        fields: [{ key: 'input', label: 'PTZ input', type: 'vmixInput' }],
        fixed: { functionID: 'PTZMoveToVirtualInputPosition' },
    },
    {
        key: 'studiocoast-vmix:audio',
        module: 'studiocoast-vmix',
        definitionId: 'audio',
        label: 'Input audio',
        fields: [
            { key: 'input', label: 'Input', type: 'vmixInput' },
            {
                key: 'functionID',
                label: 'Audio',
                type: 'select',
                options: ON_OFF_TOGGLE('Audio'),
            },
        ],
    },
    {
        key: 'studiocoast-vmix:audioBus',
        module: 'studiocoast-vmix',
        definitionId: 'audioBus',
        label: 'Input audio to bus',
        fields: [
            { key: 'input', label: 'Input', type: 'vmixInput' },
            {
                key: 'value',
                label: 'Bus',
                type: 'select',
                options: AUDIO_BUS_MASTER,
            },
            {
                key: 'functionID',
                label: 'Mix',
                type: 'select',
                options: [
                    { value: 'AudioBus', label: 'Toggle' },
                    { value: 'AudioBusOn', label: 'On' },
                    { value: 'AudioBusOff', label: 'Off' },
                ],
            },
        ],
    },
    {
        key: 'studiocoast-vmix:busXAudio',
        module: 'studiocoast-vmix',
        definitionId: 'busXAudio',
        label: 'Bus audio',
        fields: [
            {
                key: 'value',
                label: 'Bus',
                type: 'select',
                options: ['Master', 'A', 'B', 'C', 'D', 'E', 'F', 'G'].map(
                    (b) => ({ value: b, label: b })
                ),
            },
            {
                key: 'functionID',
                label: 'Audio',
                type: 'select',
                options: ON_OFF_TOGGLE('BusXAudio'),
            },
        ],
    },
    {
        key: 'studiocoast-vmix:replayRecording',
        module: 'studiocoast-vmix',
        definitionId: 'replayRecording',
        label: 'Replay record',
        fields: [
            {
                key: 'functionID',
                label: 'Recording',
                type: 'select',
                options: [
                    { value: 'ReplayStartRecording', label: 'Start' },
                    { value: 'ReplayStopRecording', label: 'Stop' },
                    { value: 'ReplayStartStopRecording', label: 'Toggle' },
                ],
            },
        ],
    },
    {
        key: 'studiocoast-vmix:replayPlay',
        module: 'studiocoast-vmix',
        definitionId: 'replayPlay',
        label: 'Replay play',
        fields: [REPLAY_CHANNEL],
    },
    {
        key: 'studiocoast-vmix:replayPause',
        module: 'studiocoast-vmix',
        definitionId: 'replayPause',
        label: 'Replay pause',
        fields: [REPLAY_CHANNEL],
    },
    {
        key: 'studiocoast-vmix:replayChangeDirection',
        module: 'studiocoast-vmix',
        definitionId: 'replayChangeDirection',
        label: 'Replay direction',
        fields: [REPLAY_CHANNEL],
    },
    {
        key: 'studiocoast-vmix:replayFastForwardBackward',
        module: 'studiocoast-vmix',
        definitionId: 'replayFastForwardBackward',
        label: 'Replay speed',
        fields: [
            {
                key: 'functionID',
                label: 'Direction',
                type: 'select',
                options: [
                    { value: 'ReplayFastForward', label: 'Forward' },
                    { value: 'ReplayFastBackward', label: 'Backward' },
                ],
            },
            REPLAY_CHANNEL,
            { key: 'value', label: 'Speed', type: 'number', suffix: 'x' },
        ],
    },
    {
        key: 'internal:wait',
        module: 'internal',
        definitionId: 'wait',
        label: 'Wait',
        fields: [
            {
                key: 'time',
                label: 'Time',
                type: 'number',
                asString: true,
                suffix: 'ms',
            },
        ],
    },
    {
        key: 'internal:set_page',
        module: 'internal',
        definitionId: 'set_page',
        label: 'Page',
        fields: [{ key: 'page', label: 'Page', type: 'number' }],
    },
    {
        key: 'behringer-xair:mute',
        module: 'behringer-xair',
        definitionId: 'mute',
        label: 'Mute channel',
        fields: [
            { key: 'num', label: 'Channel', type: 'number' },
            {
                key: 'mute',
                label: 'Mute',
                type: 'select',
                options: CHANNEL_MUTE,
            },
        ],
    },
    {
        key: 'behringer-xair:mute_grp',
        module: 'behringer-xair',
        definitionId: 'mute_grp',
        label: 'Mute group',
        fields: [
            { key: 'mute_grp', label: 'Group', type: 'number', asString: true },
            { key: 'mute', label: 'Mute', type: 'select', options: GROUP_MUTE },
        ],
    },
];

// X-Air mute feedbacks' `state` option: which state lights the button.
// Verified against the installed module (v3.0.1, buildStripDefs.js): the
// same {id:'1',label:'On'}/{id:'0',label:'Off'} dropdown on every strip's
// mute feedback ('ch', 'config_mute', ...).
const MUTE_STATE = [
    { value: '1', label: 'On' },
    { value: '0', label: 'Off' },
];

// vMix's general connection-status feedback (generalFeedbacks.ts): one
// dropdown of named states. "streaming" has its own stream-number sub-field
// (which stream of up to 5); left out here and fixed to '' (Any), matching
// this editor's one-field-per-source policy.
const VMIX_STATUS = [
    'connection',
    'fadeToBlack',
    'recording',
    'external',
    'streaming',
    'multiCorder',
    'fullscreen',
    'playList',
].map((s) => ({ value: s, label: s }));

// Feedback catalog: same shape as an action (ActionDef/ActionField), reusing
// those types - a feedback is a Companion entity with a definitionId and
// options, same as an action, just stored in its own list on the button
// instead of a step's action_sets. Deliberately small (Filip, 2026-11-14):
// pick a source and a background color - nothing about text or the other
// style-override properties Companion's own "Style Overrides" section can
// already change directly in Companion if wanted.
// Verified against the real installed modules: studiocoast-vmix v4.2.0
// (src/feedbacks/tallyFeedbacks.ts, generalFeedbacks.ts upstream) and
// behringer-xair v3.0.1 (buildStripDefs.js/defStrip.js/index.js upstream).
export const FEEDBACK_DEFS: ActionDef[] = [
    {
        key: 'studiocoast-vmix:inputLive',
        module: 'studiocoast-vmix',
        definitionId: 'inputLive',
        label: 'In program',
        fields: [{ key: 'input', label: 'Input', type: 'vmixInput' }],
        colorOptions: ['bg'],
    },
    {
        key: 'studiocoast-vmix:overlayStatus',
        module: 'studiocoast-vmix',
        definitionId: 'overlayStatus',
        label: 'Overlay on',
        fields: [
            { key: 'input', label: 'Input (blank = any)', type: 'vmixInput' },
            {
                key: 'overlay',
                label: 'Overlay',
                type: 'select',
                options: [{ value: '0', label: 'Any' }, ...OVERLAY_NUMBERS],
            },
        ],
        // One swatch for both; Companion keeps separate preview/program
        // options, this editor doesn't offer a second color.
        colorOptions: ['bgPreview', 'bgProgram'],
    },
    {
        key: 'studiocoast-vmix:status',
        module: 'studiocoast-vmix',
        definitionId: 'status',
        label: 'vMix status',
        fields: [
            {
                key: 'status',
                label: 'Status',
                type: 'select',
                options: VMIX_STATUS,
            },
        ],
        fixed: { value: '' },
    },
    {
        key: 'studiocoast-vmix:inputAudio',
        module: 'studiocoast-vmix',
        definitionId: 'inputAudio',
        label: 'Input audio muted',
        fields: [{ key: 'input', label: 'Input', type: 'vmixInput' }],
    },
    {
        key: 'studiocoast-vmix:inputBusRouting',
        module: 'studiocoast-vmix',
        definitionId: 'inputBusRouting',
        label: 'Input audio on bus',
        fields: [
            { key: 'input', label: 'Input', type: 'vmixInput' },
            {
                key: 'value',
                label: 'Bus',
                type: 'select',
                options: AUDIO_BUS_MASTER,
            },
        ],
    },
    {
        key: 'behringer-xair:ch',
        module: 'behringer-xair',
        definitionId: 'ch',
        label: 'Channel mute',
        fields: [
            { key: 'theChannel', label: 'Channel', type: 'number' },
            {
                key: 'state',
                label: 'When',
                type: 'select',
                options: MUTE_STATE,
            },
        ],
    },
    {
        key: 'behringer-xair:config_mute',
        module: 'behringer-xair',
        definitionId: 'config_mute',
        label: 'Group mute',
        fields: [
            { key: 'theChannel', label: 'Group', type: 'number' },
            {
                key: 'state',
                label: 'When',
                type: 'select',
                options: MUTE_STATE,
            },
        ],
    },
    {
        key: 'behringer-xair:snap_color',
        module: 'behringer-xair',
        definitionId: 'snap_color',
        label: 'Current scene',
        fields: [
            {
                key: 'theSnap',
                label: 'Scene number',
                type: 'number',
                asString: true,
            },
        ],
    },
];

export function matchFeedbackDef(
    definitionId: string,
    options: Record<string, unknown>
): ActionDef | undefined {
    return FEEDBACK_DEFS.find(
        (d) =>
            d.definitionId === definitionId &&
            Object.entries(d.fixed ?? {}).every(([k, v]) => options[k] === v)
    );
}

// The catalog entry an existing action is, or undefined if the editor does
// not handle it (then the button is edited in Companion).
// Before the type+overlay split (this session, 2026-11-14), the editor wrote
// a single combined `functionID` like "OverlayInput3In" - a button saved
// under that shape has no `type`/`overlay` at all, so the Select for each
// renders blank. Saving a blank-but-unchanged selection would send no type/
// overlay and reproduce the exact "falls back to toggle" bug this was fixing,
// this time self-inflicted. Derive a starting guess from the old value so the
// editor shows what the button already does instead of blanking it out.
export function migrateLegacyOverlayOptions(
    options: Record<string, unknown>
): Record<string, unknown> {
    if (options.type !== undefined || options.overlay !== undefined)
        return options;
    const legacy = options.functionID;
    if (typeof legacy !== 'string') return options;
    const m = /^OverlayInput(\d+)(In|Out|Off)?$/.exec(legacy);
    if (!m) return options;
    return {
        ...options,
        type: m[2] ?? 'OverlayInput',
        overlay: m[1],
    };
}

export function matchActionDef(
    definitionId: string,
    options: Record<string, unknown>
): ActionDef | undefined {
    return ACTION_DEFS.find(
        (d) =>
            d.definitionId === definitionId &&
            Object.entries(d.fixed ?? {}).every(([k, v]) => options[k] === v)
    );
}

// #endregion

// #region Audience-display triggers

// Official FMS audience display: BitfocusStateTypes, in enum order.
export const FMS_BITFOCUS_EVENTS: { value: number; label: string }[] = [
    { value: 1, label: 'Prestart' },
    { value: 2, label: 'Match Preview' },
    { value: 3, label: 'Score Bar' },
    { value: 4, label: 'Field Ready' },
    { value: 5, label: 'Match Start' },
    { value: 6, label: 'Teleop Start' },
    { value: 7, label: 'Endgame Start' },
    { value: 8, label: 'Match End' },
    { value: 9, label: 'Abort Match' },
    { value: 10, label: 'Post Result' },
    { value: 11, label: 'Alliance Selection' },
    { value: 12, label: 'Award' },
    { value: 13, label: 'Award Reveal' },
    { value: 14, label: 'Playoff Bracket' },
    { value: 15, label: 'Red Wins' },
    { value: 16, label: 'Blue Wins' },
    { value: 17, label: 'Tie Match' },
];

export interface FmsBitfocusCommand {
    BfId: string;
    BfEvent: number;
    Page: number;
    Row: number;
    Column: number;
}

export interface FmsAutomationConfig {
    BitfocusIntegrationEnabled: boolean;
    BitfocusIntegrationAddress: string;
    BitfocusCommands: FmsBitfocusCommand[];
    SetMatchNameCustomVariable: boolean;
    MatchNameCustomVariableName: string;
}

// Our custom audience display (/api/companion/config)
export interface CustomAdSink {
    id: string;
    label: string;
    address: string;
    enabled: boolean;
    buttons: Record<string, { page: number; row: number; column: number }>;
}

export interface CustomAdConfig {
    enabled: boolean;
    variablesEnabled: boolean;
    liveScores: boolean;
    sinks: CustomAdSink[];
}

export interface CustomAdState {
    config: CustomAdConfig;
    events: { id: string; label: string }[];
}

// #endregion
