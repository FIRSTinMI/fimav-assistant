import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AutoComplete,
    Button,
    Card,
    ColorPicker,
    Empty,
    Form,
    Input,
    InputNumber,
    Modal,
    Popconfirm,
    Select,
    Space,
    Switch,
    Tabs,
    Tag,
    Tooltip,
    Typography,
    message,
} from 'antd';
import {
    DeleteOutlined,
    EditOutlined,
    ExportOutlined,
    PlusOutlined,
    ReloadOutlined,
} from '@ant-design/icons';
import AddonControlRow from '../../components/AddonControlRow';
import {
    ACTION_DEFS,
    ActionDef,
    CompanionAction,
    CompanionButton,
    CompanionLayout,
    CompanionPage,
    CustomAdConfig,
    CustomAdState,
    FEEDBACK_DEFS,
    FMS_BITFOCUS_EVENTS,
    FmsAutomationConfig,
    matchActionDef,
    matchFeedbackDef,
    migrateLegacyOverlayOptions,
} from '../../../models/Bitfocus';
import {
    FTC_UPDATE_LABELS,
    FTC_UPDATE_TYPES,
    FtcScorekeeperStatus,
    FtcSettings,
    FtcTriggerMap,
} from '../../../models/Ftc';
import { AutoAVStatus, Program } from '../../../models/AutoAVStatus';
import './index.css';

const { Text } = Typography;

// Whose triggers the tab edits: the FTC scorekeeper, the official FMS
// audience display, or our custom one (FRC off-season, picked in Settings).
type TriggerSource = 'fms' | 'customAd' | 'ftc';

// An FMS trigger is a BitfocusStateTypes number; a custom AD trigger is its
// event id string.
type TriggerId = number | string;
interface TriggerOption {
    value: TriggerId;
    label: string;
}

interface Result {
    op: string;
    ok: boolean;
    data?: any;
    error?: string;
}

const send = (channel: string, ...args: unknown[]) =>
    window.electron?.ipcRenderer.sendMessage(channel, args);

const defFor = (a: CompanionAction) =>
    a.hasExpression ? undefined : matchActionDef(a.definitionId, a.options);

const defFeedbackFor = (f: CompanionAction) =>
    f.hasExpression ? undefined : matchFeedbackDef(f.definitionId, f.options);

// A button the editor can change: a normal button whose press actions and
// feedbacks are all in the catalog. Anything else is edited in Companion.
const isEditable = (b: CompanionButton | undefined) =>
    !b ||
    (b.type === 'button-layered' &&
        b.actions.every((a) => defFor(a)) &&
        b.feedbacks.every((f) => defFeedbackFor(f)));

// Companion writes a line break in a label as the two characters "\\n".
const labelToText = (label: string) => label.replace(/\\n/g, '\n');
const textToLabel = (text: string) => text.replace(/\r?\n/g, '\\n');

// FMS commands that press the button at this location.
const commandsAt = (
    fms: FmsAutomationConfig | null,
    page: number,
    row: number,
    column: number
) =>
    (fms?.BitfocusCommands ?? []).filter(
        (c) => c.Page === page && c.Row === row && c.Column === column
    );

// Action picker options, one section per Companion connection.
interface ActionGroup {
    label: string;
    options: { value: string; label: string }[];
}

function actionGroups(
    defs: ActionDef[],
    layout: CompanionLayout | null
): ActionGroup[] {
    const groups: ActionGroup[] = [];
    defs.forEach((d) => {
        const label =
            d.module === 'internal'
                ? 'Companion'
                : layout?.connections.find((c) => c.module === d.module)
                      ?.label ?? d.module;
        let g = groups.find((x) => x.label === label);
        if (!g) {
            g = { label, options: [] };
            groups.push(g);
        }
        g.options.push({ value: d.key, label: d.label });
    });
    return groups;
}

// Custom AD events whose button (in the first sink) is at this location.
const customAdEventsAt = (
    state: CustomAdState | null,
    page: number,
    row: number,
    column: number
): string[] => {
    const sink = state?.config.sinks[0];
    if (!sink) return [];
    return Object.entries(sink.buttons)
        .filter(
            ([, b]) => b.page === page && b.row === row && b.column === column
        )
        .map(([event]) => event);
};

// FTC trigger options: every stream update type, per field when the event
// has more than one. Before the scorekeeper answers, offer two fields (FIM
// runs one or two).
const ftcTriggerOptions = (fieldCount: number): TriggerOption[] =>
    [...Array(fieldCount).keys()].flatMap((i) =>
        FTC_UPDATE_TYPES.map((t) => ({
            value: `${t}:${i + 1}`,
            label:
                fieldCount > 1
                    ? `${FTC_UPDATE_LABELS[t]} · Field ${i + 1}`
                    : FTC_UPDATE_LABELS[t],
        }))
    );

const ftcTriggersAt = (
    triggers: FtcTriggerMap,
    page: number,
    row: number,
    column: number
): string[] =>
    Object.entries(triggers)
        .filter(
            ([, b]) => b.page === page && b.row === row && b.column === column
        )
        .map(([id]) => id);

// #region Button editor

interface EditAction {
    key: string; // ActionDef key
    options: Record<string, unknown>;
}

function ActionRow({
    action,
    groups,
    vmixInputs,
    onChange,
    onRemove,
}: {
    action: EditAction;
    groups: ActionGroup[];
    vmixInputs: string[];
    onChange: (_a: EditAction) => void;
    onRemove: () => void;
}) {
    const def = ACTION_DEFS.find((d) => d.key === action.key);
    const setOpt = (k: string, v: unknown) =>
        onChange({ ...action, options: { ...action.options, [k]: v } });
    // AntD's AutoComplete always runs rc-select in "combobox" mode, which
    // hard-ignores any `searchValue` prop and derives the filter text from
    // the current *value* instead (rc-select/BaseSelect.js's mergedSearchValue:
    // `mode !== 'combobox' ? searchValue : displayValues[0].value`) - so a
    // `searchValue`/`onSearch` pair here would compile and look like a fix
    // but never actually affect filtering. The real fix: track "a selection
    // was just made" per field and have filterOption ignore its `input`
    // argument entirely while that's true (showing every option), instead
    // of trying to control what that argument is. onSearch still fires on
    // real typing (confirmed in rc-select's source) and clears the flag, so
    // normal substring filtering resumes as soon as the user types again.
    const [justPicked, setJustPicked] = useState<Record<string, boolean>>({});
    return (
        <div className="bf-action">
            <Select
                style={{ width: 170, flex: 'none' }}
                showSearch
                optionFilterProp="label"
                popupMatchSelectWidth={220}
                value={action.key}
                options={groups}
                onChange={(key) => onChange({ key, options: {} })}
            />
            {def?.fields.map((f) => {
                const v = action.options[f.key];
                if (f.type === 'vmixInput') {
                    // Red, with a tooltip, when vMix has no input by that
                    // name (only once vMix has answered with its inputs).
                    const missing =
                        !!v &&
                        vmixInputs.length > 0 &&
                        !vmixInputs.includes(v as string);
                    return (
                        <Tooltip
                            key={f.key}
                            title={missing ? 'Unknown vMix input' : undefined}
                        >
                            <AutoComplete
                                style={{ flex: 1, minWidth: 0 }}
                                status={missing ? 'error' : undefined}
                                placeholder={f.label}
                                value={(v as string) ?? ''}
                                onSearch={() =>
                                    setJustPicked((prev) =>
                                        prev[f.key]
                                            ? { ...prev, [f.key]: false }
                                            : prev
                                    )
                                }
                                options={vmixInputs.map((i) => ({ value: i }))}
                                filterOption={(input, o) =>
                                    justPicked[f.key] ||
                                    String(o?.value ?? '')
                                        .toLowerCase()
                                        .includes(input.toLowerCase())
                                }
                                onChange={(x) => {
                                    setOpt(f.key, x);
                                    setJustPicked((prev) => ({
                                        ...prev,
                                        [f.key]: true,
                                    }));
                                }}
                            />
                        </Tooltip>
                    );
                }
                if (f.type === 'select') {
                    return (
                        <Select
                            key={f.key}
                            style={{ width: 170, flex: 'none' }}
                            placeholder={f.label}
                            value={v as string | undefined}
                            options={f.options}
                            onChange={(x) => setOpt(f.key, x)}
                        />
                    );
                }
                return (
                    <InputNumber
                        key={f.key}
                        style={{ width: 170, flex: 'none' }}
                        placeholder={f.label}
                        addonAfter={f.suffix}
                        min={0}
                        value={v === undefined || v === '' ? null : Number(v)}
                        onChange={(x) =>
                            setOpt(f.key, f.asString ? String(x ?? '') : x)
                        }
                    />
                );
            })}
            <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={onRemove}
            />
        </div>
    );
}

interface EditFeedback {
    key: string; // FEEDBACK_DEFS key
    options: Record<string, unknown>;
    // undefined = no background override set; Companion's own default style
    // (or whatever was set directly in Companion) stands.
    bgColor?: number;
}

const colorToHex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const hexToColor = (hex: string) => parseInt(hex.slice(1, 7), 16) || 0;
const DEFAULT_BG_COLOR = 0x00aa00;

const BG_COLOR_PRESETS = [
    {
        label: 'Presets',
        colors: [
            '#00aa00',
            '#cc0000',
            '#0066cc',
            '#cccc00',
            '#cc6600',
            '#6a1b9a',
            '#ffffff',
            '#000000',
        ],
    },
];

function FeedbackRow({
    feedback,
    groups,
    vmixInputs,
    onChange,
    onRemove,
}: {
    feedback: EditFeedback;
    groups: ActionGroup[];
    vmixInputs: string[];
    onChange: (_f: EditFeedback) => void;
    onRemove: () => void;
}) {
    const def = FEEDBACK_DEFS.find((d) => d.key === feedback.key);
    const setOpt = (k: string, v: unknown) =>
        onChange({ ...feedback, options: { ...feedback.options, [k]: v } });
    // See ActionRow's comment: AutoComplete's `searchValue` is ignored in its
    // always-on combobox mode, so filtering is suppressed via this flag
    // instead, right after a pick.
    const [justPicked, setJustPicked] = useState<Record<string, boolean>>({});
    return (
        <div className="bf-action">
            <Select
                style={{ width: 170, flex: 'none' }}
                showSearch
                optionFilterProp="label"
                popupMatchSelectWidth={220}
                value={feedback.key}
                options={groups}
                onChange={(key) => onChange({ key, options: {} })}
            />
            {def?.fields.map((f) => {
                const v = feedback.options[f.key];
                if (f.type === 'vmixInput') {
                    const missing =
                        !!v &&
                        vmixInputs.length > 0 &&
                        !vmixInputs.includes(v as string);
                    return (
                        <Tooltip
                            key={f.key}
                            title={missing ? 'Unknown vMix input' : undefined}
                        >
                            <AutoComplete
                                style={{ flex: 1, minWidth: 0 }}
                                status={missing ? 'error' : undefined}
                                placeholder={f.label}
                                value={(v as string) ?? ''}
                                onSearch={() =>
                                    setJustPicked((prev) =>
                                        prev[f.key]
                                            ? { ...prev, [f.key]: false }
                                            : prev
                                    )
                                }
                                options={vmixInputs.map((i) => ({ value: i }))}
                                filterOption={(input, o) =>
                                    justPicked[f.key] ||
                                    String(o?.value ?? '')
                                        .toLowerCase()
                                        .includes(input.toLowerCase())
                                }
                                onChange={(x) => {
                                    setOpt(f.key, x);
                                    setJustPicked((prev) => ({
                                        ...prev,
                                        [f.key]: true,
                                    }));
                                }}
                            />
                        </Tooltip>
                    );
                }
                if (f.type === 'select') {
                    return (
                        <Select
                            key={f.key}
                            style={{ width: 170, flex: 'none' }}
                            placeholder={f.label}
                            value={v as string | undefined}
                            options={f.options}
                            onChange={(x) => setOpt(f.key, x)}
                        />
                    );
                }
                return (
                    <InputNumber
                        key={f.key}
                        style={{ width: 170, flex: 'none' }}
                        placeholder={f.label}
                        min={0}
                        value={v === undefined || v === '' ? null : Number(v)}
                        onChange={(x) => setOpt(f.key, x)}
                    />
                );
            })}
            <Space size={4}>
                <Switch
                    size="small"
                    checked={feedback.bgColor !== undefined}
                    onChange={(checked) =>
                        onChange({
                            ...feedback,
                            bgColor: checked ? DEFAULT_BG_COLOR : undefined,
                        })
                    }
                />
                {feedback.bgColor !== undefined && (
                    <ColorPicker
                        value={colorToHex(feedback.bgColor)}
                        presets={BG_COLOR_PRESETS}
                        onChange={(_, hex) =>
                            onChange({ ...feedback, bgColor: hexToColor(hex) })
                        }
                    />
                )}
            </Space>
            <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={onRemove}
            />
        </div>
    );
}

function ButtonEditor({
    open,
    page,
    cell,
    button,
    layout,
    vmixInputs,
    triggerOptions,
    savedTriggers,
    saving,
    onSave,
    onSaveTriggers,
    onClear,
    onClose,
}: {
    open: boolean;
    page: CompanionPage | undefined;
    cell: { row: number; column: number } | null;
    button: CompanionButton | undefined;
    layout: CompanionLayout | null;
    vmixInputs: string[];
    // null while the chosen audience display has not answered
    triggerOptions: TriggerOption[] | null;
    savedTriggers: TriggerId[];
    saving: boolean;
    onSave: (
        _text: string,
        _actions: EditAction[],
        _feedbacks: EditFeedback[]
    ) => void;
    onSaveTriggers: (_events: TriggerId[]) => void;
    onClear: () => void;
    onClose: () => void;
}) {
    const [text, setText] = useState('');
    const [actions, setActions] = useState<EditAction[]>([]);
    const [feedbacks, setFeedbacks] = useState<EditFeedback[]>([]);
    const [events, setEvents] = useState<TriggerId[]>([]);
    const savedKey = [...savedTriggers].sort().join();

    useEffect(() => {
        if (!open) return;
        setText(labelToText(button?.text ?? ''));
        setActions(
            (button?.actions ?? []).map((a) => ({
                key: defFor(a)?.key ?? a.definitionId,
                options:
                    a.definitionId === 'overlayFunctions'
                        ? migrateLegacyOverlayOptions(a.options)
                        : a.options,
            }))
        );
        setFeedbacks(
            (button?.feedbacks ?? []).map((f) => ({
                key: defFeedbackFor(f)?.key ?? f.definitionId,
                options: f.options,
                bgColor: f.bgColor,
            }))
        );
    }, [open, button]);

    useEffect(() => {
        if (open) setEvents(savedTriggers);
        // savedKey stands in for the array, which is rebuilt every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, savedKey]);

    const triggersChanged = [...events].sort().join() !== savedKey;

    // An unknown Companion version is shown but never written to.
    const unsupported = layout?.editable === false;
    const editable = !unsupported && isEditable(button);

    // The triggers save on their own, so a button only Companion can edit
    // still gets its triggers.
    const save = () => {
        if (triggersChanged) onSaveTriggers(events);
        if (editable) onSave(textToLabel(text), actions, feedbacks);
        else onClose();
    };

    const triggers = triggerOptions && (
        <Form.Item label="Triggers">
            <Select
                mode="multiple"
                allowClear
                placeholder="Events"
                value={events}
                options={triggerOptions}
                onChange={setEvents}
            />
        </Form.Item>
    );

    // Only actions whose module has a connection in this Companion.
    const defs = useMemo(
        () =>
            ACTION_DEFS.filter(
                (d) =>
                    d.module === 'internal' ||
                    layout?.connections.some((c) => c.module === d.module)
            ),
        [layout]
    );

    const groups = useMemo(() => actionGroups(defs, layout), [defs, layout]);

    // Only feedbacks whose module has a connection in this Companion.
    const feedbackDefs = useMemo(
        () =>
            FEEDBACK_DEFS.filter(
                (d) =>
                    d.module === 'internal' ||
                    layout?.connections.some((c) => c.module === d.module)
            ),
        [layout]
    );

    const feedbackGroups = useMemo(
        () => actionGroups(feedbackDefs, layout),
        [feedbackDefs, layout]
    );

    const title = `${page?.name ?? ''} ${
        cell ? `${cell.row}/${cell.column}` : ''
    }`;

    return (
        <Modal
            title={title}
            open={open}
            onCancel={onClose}
            width={760}
            destroyOnClose
            footer={
                editable ? (
                    <Space>
                        {button && (
                            <Popconfirm
                                title="Clear button"
                                onConfirm={onClear}
                            >
                                <Button danger disabled={saving}>
                                    Clear
                                </Button>
                            </Popconfirm>
                        )}
                        <Button onClick={onClose}>Cancel</Button>
                        <Button type="primary" loading={saving} onClick={save}>
                            Save
                        </Button>
                    </Space>
                ) : (
                    <Space>
                        <Button
                            icon={<ExportOutlined />}
                            onClick={() => send('bitfocus:openCompanion')}
                        >
                            Companion
                        </Button>
                        <Button onClick={onClose}>Cancel</Button>
                        {triggerOptions && (
                            <Button
                                type="primary"
                                loading={saving}
                                disabled={!triggersChanged}
                                onClick={save}
                            >
                                Save
                            </Button>
                        )}
                    </Space>
                )
            }
        >
            {editable ? (
                <Form layout="vertical">
                    <Form.Item label="Label">
                        <Input.TextArea
                            autoSize={{ minRows: 1, maxRows: 4 }}
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                        />
                    </Form.Item>
                    <Form.Item label="Actions">
                        <div className="bf-actions">
                            {actions.map((a, i) => (
                                <ActionRow
                                    // eslint-disable-next-line react/no-array-index-key
                                    key={i}
                                    action={a}
                                    groups={groups}
                                    vmixInputs={vmixInputs}
                                    onChange={(next) =>
                                        setActions(
                                            actions.map((x, j) =>
                                                j === i ? next : x
                                            )
                                        )
                                    }
                                    onRemove={() =>
                                        setActions(
                                            actions.filter((_, j) => j !== i)
                                        )
                                    }
                                />
                            ))}
                            <Button
                                icon={<PlusOutlined />}
                                disabled={!defs.length}
                                onClick={() =>
                                    setActions([
                                        ...actions,
                                        { key: defs[0].key, options: {} },
                                    ])
                                }
                            >
                                Action
                            </Button>
                        </div>
                    </Form.Item>
                    <Form.Item label="Feedbacks">
                        <div className="bf-actions">
                            {feedbacks.map((f, i) => (
                                <FeedbackRow
                                    // eslint-disable-next-line react/no-array-index-key
                                    key={i}
                                    feedback={f}
                                    groups={feedbackGroups}
                                    vmixInputs={vmixInputs}
                                    onChange={(next) =>
                                        setFeedbacks(
                                            feedbacks.map((x, j) =>
                                                j === i ? next : x
                                            )
                                        )
                                    }
                                    onRemove={() =>
                                        setFeedbacks(
                                            feedbacks.filter((_, j) => j !== i)
                                        )
                                    }
                                />
                            ))}
                            <Button
                                icon={<PlusOutlined />}
                                disabled={!feedbackDefs.length}
                                onClick={() =>
                                    setFeedbacks([
                                        ...feedbacks,
                                        {
                                            key: feedbackDefs[0].key,
                                            options: {},
                                        },
                                    ])
                                }
                            >
                                Feedback
                            </Button>
                        </div>
                    </Form.Item>
                    {triggers}
                </Form>
            ) : (
                <Form layout="vertical">
                    <Tag color="gold">
                        {unsupported
                            ? 'Unsupported Companion version'
                            : 'Companion only'}
                    </Tag>
                    <div className="bf-readonly">
                        {(button?.actions ?? []).map((a) => (
                            <div key={a.id}>
                                <Text code>{a.definitionId}</Text>
                            </div>
                        ))}
                        {(button?.feedbacks ?? []).map((f) => (
                            <div key={f.id}>
                                <Text code>feedback: {f.definitionId}</Text>
                            </div>
                        ))}
                    </div>
                    {triggers}
                </Form>
            )}
        </Modal>
    );
}

// #endregion

// #region Button grid

function ButtonGrid({
    page,
    locked,
    hasTriggers,
    onPick,
    onPress,
}: {
    page: CompanionPage;
    // Companion's version has no editor: every button is read only.
    locked: boolean;
    hasTriggers: (_row: number, _column: number) => boolean;
    onPick: (_row: number, _column: number) => void;
    onPress: (_row: number, _column: number) => void;
}) {
    const cells = [];
    for (let r = 0; r < page.rows; r += 1) {
        for (let c = 0; c < page.columns; c += 1) {
            const b = page.buttons[`${r}/${c}`];
            cells.push(
                <div className="bf-cell-wrap" key={`${r}/${c}`}>
                    <button
                        type="button"
                        className={`bf-cell${b ? ' bf-cell--set' : ''}${
                            b && (locked || !isEditable(b))
                                ? ' bf-cell--locked'
                                : ''
                        }${hasTriggers(r, c) ? ' bf-cell--fms' : ''}`}
                        title={`${r}/${c}`}
                        // A button here presses it (the point of the grid);
                        // an empty cell has nothing to press, so it opens
                        // the editor to create one.
                        onClick={() => (b ? onPress(r, c) : onPick(r, c))}
                    >
                        {b ? labelToText(b.text) || b.type : ''}
                    </button>
                    {/* An empty cell's main click already opens the editor
                        (nothing to press), so a pencil there would be a dead
                        duplicate. Gate on `b`, not `locked` - a locked (old/
                        unsupported Companion) layout still needs a way to
                        view an existing button's content/triggers, same as
                        before this grid defaulted to pressing; the dialog
                        itself already renders read-only when locked. */}
                    {b && (
                        <button
                            type="button"
                            className="bf-cell-edit"
                            title="Edit"
                            onClick={(e) => {
                                e.stopPropagation();
                                onPick(r, c);
                            }}
                        >
                            <EditOutlined />
                        </button>
                    )}
                </div>
            );
        }
    }
    return (
        <div
            className="bf-grid"
            style={{ gridTemplateColumns: `repeat(${page.columns}, 1fr)` }}
        >
            {cells}
        </div>
    );
}

// #endregion

// #region Settings

function SettingsDialog({
    open,
    source,
    fms,
    customAd,
    ftc,
    companionPort,
    onSaveFms,
    onSaveCustomAd,
    onClose,
}: {
    open: boolean;
    source: TriggerSource | null;
    fms: FmsAutomationConfig | null;
    customAd: CustomAdState | null;
    ftc: FtcSettings | null;
    companionPort: number;
    onSaveFms: (_c: FmsAutomationConfig) => void;
    onSaveCustomAd: (_c: CustomAdConfig) => void;
    onClose: () => void;
}) {
    const [automations, setAutomations] = useState(false);
    const [port, setPort] = useState(companionPort);

    let enabled = ftc?.automations ?? true;
    if (source === 'fms') enabled = fms?.BitfocusIntegrationEnabled ?? false;
    else if (source === 'customAd') enabled = customAd?.config.enabled ?? false;
    let loaded = ftc !== null;
    if (source === 'fms') loaded = fms !== null;
    else if (source === 'customAd') loaded = customAd !== null;

    useEffect(() => {
        if (open) setAutomations(enabled);
    }, [open, enabled]);

    useEffect(() => {
        if (open) setPort(companionPort);
    }, [open, companionPort]);

    return (
        <Modal
            title="Bitfocus settings"
            open={open}
            onCancel={onClose}
            okText="Save"
            onOk={() => {
                if (port !== companionPort) {
                    send('app:saveSettings', { companionPort: port });
                }
                if (source === 'ftc') {
                    send('ftc:saveSettings', { automations });
                } else if (source && loaded && automations !== enabled) {
                    if (source === 'fms' && fms) {
                        onSaveFms({
                            ...fms,
                            BitfocusIntegrationEnabled: automations,
                        });
                    } else if (customAd) {
                        onSaveCustomAd({
                            ...customAd.config,
                            enabled: automations,
                        });
                    }
                }
                onClose();
            }}
            destroyOnClose
        >
            <Form layout="vertical">
                <Form.Item label="Companion port">
                    <InputNumber
                        min={1}
                        max={65535}
                        precision={0}
                        value={port}
                        onChange={(v) => v != null && setPort(v)}
                    />
                </Form.Item>
                {source && (
                    <Form.Item
                        label={
                            {
                                fms: 'FMS automations',
                                customAd: 'Custom AD automations',
                                ftc: 'FTC automations',
                            }[source]
                        }
                    >
                        {loaded ? (
                            <Switch
                                checked={automations}
                                onChange={setAutomations}
                            />
                        ) : (
                            <Text type="secondary">Not reachable</Text>
                        )}
                    </Form.Item>
                )}
            </Form>
        </Modal>
    );
}

// #endregion

export default function Bitfocus() {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [layout, setLayout] = useState<CompanionLayout | null>(null);
    const [layoutError, setLayoutError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [pageNumber, setPageNumber] = useState(1);
    const [cell, setCell] = useState<{ row: number; column: number } | null>(
        null
    );
    const [saving, setSaving] = useState<string | null>(null);
    const [vmixInputs, setVmixInputs] = useState<string[]>([]);
    const [fms, setFms] = useState<FmsAutomationConfig | null>(null);
    // A save is in flight, so its answer gets a message (a load does not).
    const fmsSaveRef = useRef(false);
    const saveFms = (c: FmsAutomationConfig) => {
        fmsSaveRef.current = true;
        send('bitfocus:saveFms', c);
    };
    const [customAd, setCustomAd] = useState<CustomAdState | null>(null);
    const customAdSaveRef = useRef(false);
    const saveCustomAd = (c: CustomAdConfig) => {
        customAdSaveRef.current = true;
        send('bitfocus:saveCustomAd', c);
    };

    const [ftc, setFtc] = useState<FtcSettings | null>(null);
    // null until the first AutoAV status, so FTC never flashes FRC controls.
    const [program, setProgram] = useState<Program | null>(null);
    const [offSeason, setOffSeason] = useState(false);
    const [frcAd, setFrcAd] = useState<'fms' | 'customAd'>('fms');
    const [companionPort, setCompanionPort] = useState(8888);
    const [ftcStatus, setFtcStatus] = useState<FtcScorekeeperStatus | null>(
        null
    );
    const ftcSaveRef = useRef(false);

    const loadAll = useCallback(() => {
        setLoading(true);
        send('bitfocus:getLayout');
        send('bitfocus:getVmixInputs');
        send('bitfocus:getFms');
        send('bitfocus:getCustomAd');
        send('ftc:getState');
    }, []);

    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const offResult = ipcRenderer.on('bitfocus:result', (r: Result) => {
            if (
                r.op === 'layout' ||
                r.op === 'saveButton' ||
                r.op === 'clearButton'
            ) {
                setLoading(false);
                if (r.ok) {
                    // Same content keeps the same object, so a poll that
                    // finds nothing new does not redraw or reset anything.
                    setLayout((prev) =>
                        prev && JSON.stringify(prev) === JSON.stringify(r.data)
                            ? prev
                            : r.data
                    );
                    setLayoutError(null);
                } else if (r.op === 'layout') {
                    setLayout(null);
                    setLayoutError(r.error ?? 'Not connected');
                } else {
                    message.error(r.error);
                }
                if (r.op !== 'layout') {
                    setSaving((x) => (x === 'button' ? null : x));
                    if (r.ok) {
                        message.success(
                            r.op === 'saveButton' ? 'Saved' : 'Cleared'
                        );
                        setCell(null);
                    }
                }
            }
            if (r.op === 'pressButton' && !r.ok) message.error(r.error);
            if (r.op === 'vmixInputs' && r.ok) setVmixInputs(r.data);
            // Any answer for a section ends that section's save.
            if (r.op === 'fms' || r.op === 'customAd') {
                setSaving((x) => (x === r.op ? null : x));
            }
            // No FMS answer hides the FMS parts; a failed save says so.
            if (r.op === 'fms') {
                if (r.ok) setFms(r.data);
                else if (fmsSaveRef.current) message.error(r.error);
                else setFms(null);
                if (r.ok && fmsSaveRef.current) message.success('Saved');
                fmsSaveRef.current = false;
            }
            if (r.op === 'customAd') {
                if (r.ok) setCustomAd(r.data);
                else if (customAdSaveRef.current) message.error(r.error);
                else setCustomAd(null);
                if (r.ok && customAdSaveRef.current) message.success('Saved');
                customAdSaveRef.current = false;
            }
        });
        const offFtc = ipcRenderer.on('ftc:settings', (f: FtcSettings) => {
            setFtc(f);
            if (ftcSaveRef.current) {
                message.success('Saved');
                ftcSaveRef.current = false;
            }
        });
        const offFtcStatus = ipcRenderer.on(
            'ftc:status',
            (st: FtcScorekeeperStatus) => setFtcStatus(st)
        );
        const offAutoav = ipcRenderer.on(
            'autoav:status',
            (st: AutoAVStatus) => {
                setProgram(st.program);
                setOffSeason(st.season === 'off-season');
                setFrcAd(st.frcAudienceDisplay);
            }
        );
        const offSettings = ipcRenderer.on(
            'app:settings',
            (st: { companionPort: number }) =>
                setCompanionPort(st.companionPort)
        );
        send('autoav:getState');
        send('app:getSettings');
        loadAll();
        return () => {
            offAutoav();
            offSettings();
            offResult();
            offFtc();
            offFtcStatus();
        };
    }, [loadAll]);

    // Follow changes made in Companion itself (an import, an edit in its own
    // UI): re-read the layout every 3 s while the tab is open. Paused while a
    // button dialog is open so an edit in progress is never replaced.
    useEffect(() => {
        if (cell) return undefined;
        const timer = setInterval(() => send('bitfocus:getLayout'), 3000);
        return () => clearInterval(timer);
    }, [cell]);

    const page = layout?.pages.find((p) => p.number === pageNumber);

    // A Companion change can remove the page being shown; fall back to the
    // first one.
    useEffect(() => {
        if (layout?.pages.length && !page) {
            setPageNumber(layout.pages[0].number);
        }
    }, [layout, page]);
    const button = cell
        ? page?.buttons[`${cell.row}/${cell.column}`]
        : undefined;

    const saveButton = (
        text: string,
        actions: EditAction[],
        feedbacks: EditFeedback[]
    ) => {
        if (!cell || !layout) return;
        const connectionFor = (module: string) =>
            module === 'internal'
                ? 'internal'
                : layout.connections.find((c) => c.module === module)?.id ??
                  '';
        const resolved = actions.map((a) => {
            const def = ACTION_DEFS.find((d) => d.key === a.key)!;
            return {
                definitionId: def.definitionId,
                connectionId: connectionFor(def.module),
                // Only the fields the editor shows; Companion fills the rest.
                options: {
                    ...Object.fromEntries(
                        def.fields
                            .filter((f) => a.options[f.key] !== undefined)
                            .map((f) => [f.key, a.options[f.key]])
                    ),
                    ...def.fixed,
                },
            };
        });
        const resolvedFeedbacks = feedbacks.map((f) => {
            const def = FEEDBACK_DEFS.find((d) => d.key === f.key)!;
            return {
                definitionId: def.definitionId,
                connectionId: connectionFor(def.module),
                options: {
                    ...Object.fromEntries(
                        def.fields
                            .filter((fl) => f.options[fl.key] !== undefined)
                            .map((fl) => [fl.key, f.options[fl.key]])
                    ),
                    ...def.fixed,
                },
                bgColor: f.bgColor,
            };
        });
        setSaving('button');
        send('bitfocus:saveButton', {
            page: pageNumber,
            row: cell.row,
            column: cell.column,
            text,
            actions: resolved,
            feedbacks: resolvedFeedbacks,
        });
    };

    // FTC: the scorekeeper. FRC in-season: the FMS audience display only.
    // FRC off-season: the audience display chosen in Settings.
    // null until the program is known: no triggers and no settings yet.
    let triggerSource: TriggerSource | null = null;
    if (program === 'ftc') triggerSource = 'ftc';
    else if (program && offSeason && frcAd === 'customAd')
        triggerSource = 'customAd';
    else if (program) triggerSource = 'fms';
    const ftcFields = ftcStatus?.connected ? ftcStatus.fieldCount : 2;
    let triggerOptions: TriggerOption[] | null = null;
    if (triggerSource === 'fms') triggerOptions = fms && FMS_BITFOCUS_EVENTS;
    else if (triggerSource === 'customAd') {
        triggerOptions =
            customAd &&
            customAd.events.map((e) => ({ value: e.id, label: e.label }));
    } else if (triggerSource === 'ftc')
        triggerOptions = ftc && ftcTriggerOptions(ftcFields);
    const triggersAt = (row: number, column: number): TriggerId[] => {
        if (!triggerSource) return [];
        if (triggerSource === 'fms')
            return commandsAt(fms, pageNumber, row, column).map(
                (c) => c.BfEvent
            );
        if (triggerSource === 'customAd')
            return customAdEventsAt(customAd, pageNumber, row, column);
        return ftcTriggersAt(ftc?.triggers ?? {}, pageNumber, row, column);
    };

    // Point the chosen events at this button: drop what pressed it before,
    // add one entry per event. FMS keeps an existing command's id; the custom
    // AD maps event -> location in its first sink, which always presses the
    // Companion on this machine.
    const saveTriggers = (events: TriggerId[]) => {
        if (!cell || !triggerSource) return;
        const loc = { page: pageNumber, row: cell.row, column: cell.column };
        if (triggerSource === 'fms') {
            if (!fms) return;
            const here = commandsAt(fms, loc.page, loc.row, loc.column);
            const others = fms.BitfocusCommands.filter(
                (c) => !here.includes(c)
            );
            saveFms({
                ...fms,
                BitfocusCommands: [
                    ...others,
                    ...events.map((e) => ({
                        BfId:
                            here.find((c) => c.BfEvent === e)?.BfId ??
                            crypto.randomUUID(),
                        BfEvent: Number(e),
                        Page: loc.page,
                        Row: loc.row,
                        Column: loc.column,
                    })),
                ],
            });
            return;
        }
        if (triggerSource === 'ftc') {
            if (!ftc) return;
            const triggers = { ...ftc.triggers };
            ftcTriggersAt(triggers, loc.page, loc.row, loc.column).forEach(
                (id) => delete triggers[id]
            );
            events.forEach((e) => {
                triggers[String(e)] = loc;
            });
            ftcSaveRef.current = true;
            send('ftc:saveSettings', { triggers });
            return;
        }
        if (!customAd) return;
        const sinks = [...customAd.config.sinks];
        const first = sinks[0] ?? {
            id: 'local',
            label: 'Local',
            address: '',
            enabled: true,
            buttons: {},
        };
        const buttons = { ...first.buttons };
        customAdEventsAt(customAd, loc.page, loc.row, loc.column).forEach(
            (e) => delete buttons[e]
        );
        events.forEach((e) => {
            buttons[String(e)] = loc;
        });
        sinks[0] = {
            ...first,
            address: `http://127.0.0.1:${companionPort}`,
            buttons,
        };
        saveCustomAd({ ...customAd.config, sinks });
    };

    const connected = !!layout;

    return (
        <>
            <AddonControlRow
                running={connected}
                statusLabel={connected ? 'Connected' : 'Not connected'}
                onSettings={() => setSettingsOpen(true)}
                extra={
                    <Space>
                        <Button
                            icon={<ReloadOutlined />}
                            loading={loading}
                            onClick={loadAll}
                        />
                        <Button
                            icon={<ExportOutlined />}
                            onClick={() => send('bitfocus:openCompanion')}
                        >
                            Companion
                        </Button>
                    </Space>
                }
            />
            <div className="bf-page">
                <Card
                    size="small"
                    title="Buttons"
                    extra={
                        layout &&
                        (!layout.editable || layout.untested) && (
                            <Tag
                                color="gold"
                                title={layout.version || undefined}
                            >
                                {layout.editable
                                    ? 'Untested Companion version'
                                    : 'Unsupported Companion version'}
                            </Tag>
                        )
                    }
                >
                    {layout ? (
                        <>
                            <Tabs
                                activeKey={String(pageNumber)}
                                onChange={(k) => setPageNumber(Number(k))}
                                items={layout.pages.map((p) => ({
                                    key: String(p.number),
                                    label: p.name || `Page ${p.number}`,
                                }))}
                            />
                            {page && (
                                <ButtonGrid
                                    page={page}
                                    locked={!layout.editable}
                                    hasTriggers={(r, c) =>
                                        triggersAt(r, c).length > 0
                                    }
                                    onPick={(row, column) =>
                                        setCell({ row, column })
                                    }
                                    onPress={(row, column) =>
                                        send(
                                            'bitfocus:pressButton',
                                            pageNumber,
                                            row,
                                            column
                                        )
                                    }
                                />
                            )}
                        </>
                    ) : (
                        <span title={layoutError ?? undefined}>
                            <Empty
                                description={
                                    layoutError ? 'Not connected' : 'Loading'
                                }
                            />
                        </span>
                    )}
                </Card>
            </div>
            <ButtonEditor
                open={!!cell}
                page={page}
                cell={cell}
                button={button}
                layout={layout}
                vmixInputs={vmixInputs}
                triggerOptions={triggerOptions}
                savedTriggers={cell ? triggersAt(cell.row, cell.column) : []}
                saving={saving === 'button'}
                onSave={saveButton}
                onSaveTriggers={saveTriggers}
                onClear={() => {
                    if (!cell) return;
                    setSaving('button');
                    send(
                        'bitfocus:clearButton',
                        pageNumber,
                        cell.row,
                        cell.column
                    );
                }}
                onClose={() => setCell(null)}
            />
            <SettingsDialog
                open={settingsOpen}
                source={triggerSource}
                fms={fms}
                customAd={customAd}
                ftc={ftc}
                companionPort={companionPort}
                onSaveFms={saveFms}
                onSaveCustomAd={saveCustomAd}
                onClose={() => setSettingsOpen(false)}
            />
        </>
    );
}
