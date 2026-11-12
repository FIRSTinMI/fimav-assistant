import { useEffect, useState } from 'react';
import {
    Button,
    Card,
    Checkbox,
    Modal,
    Slider,
    Space,
    Steps,
    Table,
    Tag,
    Typography,
    message,
} from 'antd';
import { SoundOutlined, UndoOutlined } from '@ant-design/icons';
import WirelessMic from '../../components/WirelessMic';
import useChecks from '../../hooks/checks';
import { dbToLevel, FADER_STEPS, levelToDb } from '../../../utils/xairLaw';
import {
    LevelRow,
    LevelState,
    LevelStep,
    LevelStepStatus,
    WizardState,
} from '../../../models/Levels';

const { Text } = Typography;

const send = (channel: string, ...args: unknown[]) =>
    window.electron?.ipcRenderer.sendMessage(channel, args);

// The fader in dB for the main process; off (-inf) goes as null.
const sendFader = (db: number) =>
    send('levels:fader', Number.isFinite(db) ? db : null);

const MINUS = '−';

// "-18.2" with a real minus; "-" for nothing.
export const fmtDb = (db: number | null | undefined, digits = 1) => {
    if (db === null || db === undefined || !Number.isFinite(db)) return '-';
    const s = Math.abs(db).toFixed(digits);
    if (db < 0 && s !== (0).toFixed(digits)) return `${MINUS}${s}`;
    return s;
};

const fmtChange = (db: number) =>
    `${db >= 0 ? '+' : MINUS}${Math.abs(db).toFixed(1)}`;

// A horizontal level meter, -60..0 dBFS.
function Meter({ label, db }: { label: string; db: number | null }) {
    const pct =
        db === null ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    let color = '#52c41a';
    if (db !== null && db > -6) color = '#faad14';
    if (db !== null && db > -1) color = '#ff4d4f';
    return (
        <div className="levels-meter">
            <Text className="levels-meter-label">{label}</Text>
            <div className="levels-meter-track">
                <div
                    className="levels-meter-fill"
                    style={{ width: `${pct}%`, background: color }}
                />
            </div>
            <Text className="levels-meter-value">
                {db === null ? '-' : `${fmtDb(db)} dBFS`}
            </Text>
        </div>
    );
}

const STATUS: Record<LevelStepStatus, { text: string; color: string }> = {
    listening: { text: 'Listening', color: 'processing' },
    done: { text: 'Done', color: 'success' },
    'no signal': { text: 'No signal', color: 'warning' },
    'no match': { text: 'No match', color: 'default' },
    'match running': { text: 'Match running', color: 'processing' },
};

const LABEL: Record<string, string> = {
    red: 'Red mic',
    blue: 'Blue mic',
    match: 'Match sounds',
    dj: 'DJ',
};

const STEP_TITLE: Record<LevelStep, string> = {
    red: 'Red mic',
    blue: 'Blue mic',
    match: 'Match sounds',
    dj: 'DJ',
    stream: 'Stream',
    check: 'Check',
};

// The step's on-screen control. A fader runs on the X-Air fader law over
// the whole range, off (-inf) to +10 dB, so it moves like the console's own
// and is fine at the bottom (a mic-level venue input can need Master very
// low). A gain runs linear over its range on its own steps (0.5 dB for a
// mic preamp). The buttons move 0.5 dB; the arrow keys one step.
const FINE_DB = 0.5;

type Ctl = NonNullable<WizardState['control']>;

const isGain = (c: Ctl | null) =>
    c?.kind === 'gain' && c.minDb !== null && c.maxDb !== null;

// Slider position for a dB value, and back.
const toPos = (c: Ctl | null, db: number) => {
    if (!c) return 0;
    if (isGain(c)) return Math.min(c.maxDb!, Math.max(c.minDb!, db));
    return dbToLevel(db, FADER_STEPS);
};
const fromPos = (c: Ctl | null, p: number) =>
    c && isGain(c) ? p : levelToDb(p);

function Fader({ w }: { w: WizardState }) {
    const c = w.control;
    const [drag, setDrag] = useState<number | null>(null);
    const pos = drag ?? (c === null ? 0 : toPos(c, c.db));
    const db = fromPos(c, pos);
    const gain = isGain(c);
    const nudge = (by: number) => {
        let next: number;
        if (gain) next = toPos(c, db + by);
        // From off, the first step up is the fader's lowest step.
        else if (Number.isFinite(db)) next = dbToLevel(db + by, FADER_STEPS);
        else next = (by > 0 ? 1 : 0) / (FADER_STEPS - 1);
        sendFader(fromPos(c, next));
        send('levels:faderDone');
    };
    return (
        <div className="levels-fader">
            <Text strong>{c?.label}</Text>
            <Button
                size="small"
                disabled={c === null || w.busy}
                onClick={() => nudge(FINE_DB)}
            >
                +{FINE_DB} dB
            </Button>
            <Slider
                vertical
                min={gain ? c!.minDb! : 0}
                max={gain ? c!.maxDb! : 1}
                step={gain ? c!.stepDb ?? FINE_DB : 1 / (FADER_STEPS - 1)}
                value={pos}
                disabled={c === null}
                tooltip={{
                    formatter: (v) => `${fmtDb(fromPos(c, v ?? 0))} dB`,
                }}
                onChange={(v: number) => {
                    setDrag(v);
                    sendFader(fromPos(c, v));
                }}
                onChangeComplete={() => {
                    setDrag(null);
                    send('levels:faderDone');
                }}
            />
            <Button
                size="small"
                disabled={c === null || w.busy}
                onClick={() => nudge(-FINE_DB)}
            >
                {MINUS}
                {FINE_DB} dB
            </Button>
            <Text>{Number.isFinite(db) ? `${fmtDb(db)} dB` : 'Off'}</Text>
        </div>
    );
}

function SourceStep({ w }: { w: WizardState }) {
    const row = w.rows.find((r) => r.id === w.step);
    const [laptop, setLaptop] = useState(false);
    const [adapter, setAdapter] = useState(false);
    const st = row ? STATUS[row.status] : null;
    return (
        <div className="levels-step">
            <div className="levels-step-side">
                {w.step === 'red' && <WirelessMic tape="#e0262b" />}
                {w.step === 'blue' && <WirelessMic tape="#1f5fd6" />}
                {w.step === 'dj' && (
                    <Space direction="vertical">
                        <Checkbox
                            checked={laptop}
                            onChange={(e) => setLaptop(e.target.checked)}
                        >
                            Laptop volume 100%
                        </Checkbox>
                        <Checkbox
                            checked={adapter}
                            onChange={(e) => setAdapter(e.target.checked)}
                        >
                            XLR adapter box level 50%
                        </Checkbox>
                    </Space>
                )}
            </div>
            <Space direction="vertical" size={10} className="levels-step-main">
                <Space wrap>
                    {st && <Tag color={st.color}>{st.text}</Tag>}
                    {w.step === 'match' && w.matchRunning && (
                        <Tag>{w.matchRunning}</Tag>
                    )}
                    {(w.step === 'red' || w.step === 'blue') &&
                        !w.noGain.includes(w.step) && <Tag>Gain +20 dB</Tag>}
                    {(w.step === 'red' ||
                        w.step === 'blue' ||
                        w.step === 'dj') &&
                        (w.noGain.includes(w.step) ? (
                            <Tag color="warning">No gain</Tag>
                        ) : (
                            <Tag>Fader 0 dB</Tag>
                        ))}
                    {w.step === 'dj' && w.djSendOff && (
                        <Tag color="warning">DJ Bus 1 send off</Tag>
                    )}
                    {w.step === 'dj' && w.djOnStream && (
                        <Tag color="error">DJ on stream</Tag>
                    )}
                </Space>
                <Meter label="Input" db={w.input} />
                {row?.input !== null && row?.input !== undefined && (
                    <Text type="secondary">Level {fmtDb(row.input)} dBFS</Text>
                )}
            </Space>
            <Fader key={w.step} w={w} />
        </div>
    );
}

const cell = (v: number | null) => fmtDb(v);

function StreamStep({ w }: { w: WizardState }) {
    const p = w.plan;
    const rows = w.rows.filter((r) => r.id !== 'dj');
    return (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Table<LevelRow>
                size="small"
                pagination={false}
                rowKey="id"
                dataSource={rows}
                columns={[
                    { title: 'Source', dataIndex: 'label' },
                    {
                        title: 'Input dBFS',
                        dataIndex: 'input',
                        render: cell,
                    },
                    {
                        title: 'Gain dB',
                        dataIndex: 'gain',
                        render: cell,
                    },
                    {
                        title: 'Bus 1 dBFS',
                        dataIndex: 'bus',
                        render: (v: number | null, r) => (
                            <Space size={4}>
                                {cell(v)}
                                {r.sendLimited === 'max' && (
                                    <Tag color="warning">Send max</Tag>
                                )}
                                {r.sendLimited === 'grp' && (
                                    <Tag color="warning">GRP tap</Tag>
                                )}
                            </Space>
                        ),
                    },
                    {
                        title: 'Stream LUFS',
                        dataIndex: 'stream',
                        render: cell,
                    },
                ]}
            />
            {p ? (
                <Space wrap>
                    <Tag>
                        Bus 1 {fmtDb(p.busFrom)} → {fmtDb(p.busTo)} dB
                    </Tag>
                    <Tag color="blue">Stream {fmtDb(p.lufs)} LUFS</Tag>
                    <Tag>Target {MINUS}14 LUFS</Tag>
                    <Tag>Peak {fmtDb(p.peak)} dBFS</Tag>
                    {p.estimate && <Tag color="warning">Estimate</Tag>}
                    {p.limitedBy === 'peak' && (
                        <Tag color="warning">Peak limit</Tag>
                    )}
                    {p.limitedBy === 'max' && (
                        <Tag color="warning">Bus 1 max</Tag>
                    )}
                </Space>
            ) : (
                <Text type="secondary">Nothing measured</Text>
            )}
            <Space wrap>
                <BusA w={w} />
                <Tag>DJ off stream</Tag>
                {w.toPost.map((id) => (
                    <Tag color="warning" key={id}>
                        {LABEL[id]} send to post-fader
                    </Tag>
                ))}
                {w.madePost.map((id) => (
                    <Tag key={id}>{LABEL[id]} send post-fader</Tag>
                ))}
            </Space>
            <Button
                type="primary"
                disabled={!p || w.busy}
                loading={w.busy}
                onClick={() => send('levels:apply')}
            >
                Apply
            </Button>
        </Space>
    );
}

function BusA({ w }: { w: WizardState }) {
    if (w.busAVolume === null) return <Tag>Bus A -</Tag>;
    if (w.busAVolume === 100) return <Tag color="success">Bus A 0 dB</Tag>;
    return <Tag color="warning">Bus A {w.busAVolume}%</Tag>;
}

function CheckStep({ w }: { w: WizardState }) {
    const v = w.verify;
    return (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap>
                {w.stream.running ? (
                    <Tag color="processing">
                        Stream{' '}
                        {w.stream.momentary === null
                            ? '-'
                            : `${fmtDb(w.stream.momentary)} LUFS`}
                    </Tag>
                ) : (
                    <Tag color="warning">
                        No live stream measurement
                        {w.stream.failed ? `: ${w.stream.failed}` : ''}
                    </Tag>
                )}
                <BusA w={w} />
                <Tag>Talking {v.seconds.toFixed(1)} s</Tag>
                {w.madePost.map((id) => (
                    <Tag key={id}>{LABEL[id]} send post-fader</Tag>
                ))}
            </Space>
            {v.lufs !== null ? (
                <Space wrap>
                    <Tag color="blue">
                        {v.from === 'match' ? 'Match video' : 'Measured'}{' '}
                        {fmtDb(v.lufs)} LUFS
                    </Tag>
                    {v.peak !== null && <Tag>Peak {fmtDb(v.peak)} dBTP</Tag>}
                    <Tag>Target {MINUS}14 LUFS</Tag>
                    {v.residual !== null && (
                        <Tag
                            color={
                                v.state === 'warning' ? 'warning' : 'success'
                            }
                        >
                            Residual {fmtChange(v.residual)} dB
                        </Tag>
                    )}
                </Space>
            ) : (
                <Text type="secondary">No stream measurement</Text>
            )}
            <Button
                disabled={v.residual === null || v.residual === 0 || w.busy}
                onClick={() => send('levels:streamLevel')}
            >
                Stream level
            </Button>
        </Space>
    );
}

function Wizard({ w }: { w: WizardState }) {
    const i = w.steps.indexOf(w.step);
    const status = (s: LevelStep) => {
        const r = w.rows.find((x) => x.id === s);
        if (s === w.step) return 'process';
        if (r?.status === 'done') return 'finish';
        if (r?.status === 'no signal') return 'error';
        if (s === 'stream' && w.applied) return 'finish';
        return 'wait';
    };
    const go = (s: LevelStep) => send('levels:go', s);
    return (
        <Modal
            title="Level wizard"
            open
            width={760}
            maskClosable={false}
            onCancel={() => send('levels:close', true)}
            footer={
                <Space>
                    <Button onClick={() => send('levels:close', true)}>
                        Cancel
                    </Button>
                    <Button
                        icon={<UndoOutlined />}
                        disabled={!w.undo || w.busy}
                        onClick={() => send('levels:undo')}
                    >
                        Undo
                    </Button>
                    <Button
                        disabled={i === 0 || w.busy}
                        onClick={() => go(w.steps[i - 1])}
                    >
                        Back
                    </Button>
                    {i < w.steps.length - 1 ? (
                        <Button
                            type="primary"
                            disabled={w.busy}
                            onClick={() => go(w.steps[i + 1])}
                        >
                            Next
                        </Button>
                    ) : (
                        <Button
                            type="primary"
                            onClick={() => send('levels:close', false)}
                        >
                            Done
                        </Button>
                    )}
                </Space>
            }
        >
            <Steps
                size="small"
                current={i}
                onChange={(n) => !w.busy && go(w.steps[n])}
                items={w.steps.map((s) => ({
                    title: STEP_TITLE[s],
                    status: status(s),
                }))}
                style={{ marginBottom: 16 }}
            />
            {w.error && (
                <Tag color="error" style={{ marginBottom: 12 }}>
                    {w.error}
                </Tag>
            )}
            {['red', 'blue', 'match', 'dj'].includes(w.step) && (
                <SourceStep w={w} />
            )}
            {w.step === 'stream' && <StreamStep w={w} />}
            {w.step === 'check' && <CheckStep w={w} />}
        </Modal>
    );
}

// The vMix / X-Air tab's audio section: X-Air LR and stream bus meters,
// the stream loudness check's verdict, and the level wizard.
export default function AudioSection() {
    const [st, setSt] = useState<LevelState | null>(null);
    const checks = useChecks();
    const loud = checks?.find((c) => c.id === 'stream-loudness');

    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on('levels:state', (s: LevelState) => setSt(s));
        const offErr = ipcRenderer.on('levels:error', (e: string) =>
            message.error(e)
        );
        ipcRenderer.sendMessage('levels:watch', [true]);
        return () => {
            ipcRenderer.sendMessage('levels:watch', [false]);
            off();
            offErr();
        };
    }, []);

    let loudColor = 'default';
    if (loud?.state === 'ok') loudColor = 'success';
    else if (loud?.state === 'warning') loudColor = 'warning';
    else if (loud?.state === 'critical') loudColor = 'error';

    return (
        <Card size="small">
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Meter label="Master out" db={st?.masterOut ?? null} />
                <Meter label="Stream out" db={st?.streamOut ?? null} />
                <div className="levels-loudness">
                    <Text type="secondary">Stream loudness</Text>
                    <Tag color={loudColor}>{loud?.detail || '-'}</Tag>
                </div>
                <Button
                    icon={<SoundOutlined />}
                    disabled={!st?.mixer || !!st?.wizard}
                    onClick={() => send('levels:start')}
                >
                    Level wizard
                </Button>
            </Space>
            {st?.wizard && <Wizard w={st.wizard} />}
        </Card>
    );
}
