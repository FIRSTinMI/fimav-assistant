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
}

export interface CompanionButton {
    // 'button-layered' is an editable button; page up/down/number are not.
    type: string;
    text: string;
    actions: CompanionAction[];
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
    // Companion is 5.0 or 5.1 (or newer with the same calls). When false the
    // layout is still shown, read only.
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
}

const OVERLAY_FUNCTIONS = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [
    { value: `OverlayInput${n}`, label: `Overlay ${n} toggle` },
    { value: `OverlayInput${n}In`, label: `Overlay ${n} in` },
    { value: `OverlayInput${n}Out`, label: `Overlay ${n} out` },
    { value: `OverlayInput${n}Off`, label: `Overlay ${n} off` },
]);

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
                key: 'functionID',
                label: 'Overlay',
                type: 'select',
                options: OVERLAY_FUNCTIONS,
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

// The catalog entry an existing action is, or undefined if the editor does
// not handle it (then the button is edited in Companion).
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
