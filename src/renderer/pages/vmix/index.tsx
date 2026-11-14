import { ReactNode, useCallback, useEffect, useState } from 'react';
import {
    Button,
    Card,
    Form,
    Input,
    InputNumber,
    Modal,
    Select,
    Space,
    Spin,
    Tag,
    Typography,
    message,
} from 'antd';
import {
    ApiOutlined,
    AudioOutlined,
    CheckCircleFilled,
    CloseCircleFilled,
    DesktopOutlined,
    KeyOutlined,
    VideoCameraOutlined,
} from '@ant-design/icons';
import AddonControlRow from '../../components/AddonControlRow';
import AudioSection from './Levels';
import { useOneShot } from '../../hooks/ipc_busy';
import { AutoAVStatus, Program } from '../../../models/AutoAVStatus';
import './index.css';

const { Title, Text } = Typography;

interface VmixApi {
    baseUrl: string;
    username: string;
    password: string;
}

interface StreamKeys {
    eventCode: string;
    eventName: string;
    setAt: number;
}

interface KeyValidation {
    checked: boolean;
    match: boolean | null;
    cloudKeys: string[];
    runningKeys: string[];
}

interface VmixStatus {
    reachable: boolean;
    recording: boolean;
    streaming: boolean;
    currentEvent: { name: string; code: string | null } | null;
    streamKeys: StreamKeys | null;
    keysSetForEvent: boolean;
    keyValidation: KeyValidation;
}

// Show only the tail of a stream key so we don't splash the full secret.
function keyTail(k: string): string {
    return k.length > 6 ? `****${k.slice(-6)}` : k;
}

interface VmixStream {
    index: number;
    targetKbps: number | null;
    maxrateKbps: number | null;
    liveKbps: number | null;
    destination: string;
}

interface VmixBandwidth {
    streams: VmixStream[];
    supported: boolean;
    warming?: boolean;
}

// Adaptive bitrate label: kbps under 1 Mbps (static screens are tens of kbps),
// Mbps with two decimals above.
function fmtBitrate(kbps: number | null): string {
    if (kbps == null) return '-';
    if (kbps < 1000) return `${kbps.toFixed(0)} kbps`;
    return `${(kbps / 1000).toFixed(2)} Mbps`;
}

// Minimal inline sparkline of combined stream bitrate over time.
function Sparkline({
    data,
    width = 240,
    height = 36,
}: {
    data: number[];
    width?: number;
    height?: number;
}) {
    if (data.length < 2) {
        return (
            <Text type="secondary" className="vmix-dim">
                Sampling
            </Text>
        );
    }
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = max - min || 1;
    const step = width / (data.length - 1);
    const points = data
        .map((v, i) => {
            const x = i * step;
            const y = height - ((v - min) / range) * height;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
    return (
        <svg width={width} height={height} className="vmix-sparkline">
            <polyline
                fill="none"
                stroke="#ff4d4f"
                strokeWidth="1.5"
                points={points}
            />
        </svg>
    );
}

Sparkline.defaultProps = {
    width: 240,
    height: 36,
};

function Dot({ on, color = '#52c41a' }: { on: boolean; color?: string }) {
    return (
        <span
            className={`vmix-dot ${on ? 'vmix-dot--on' : 'vmix-dot--off'}`}
            style={on ? { background: color } : undefined}
        />
    );
}

Dot.defaultProps = {
    color: '#52c41a',
};

function StatusLine({
    on,
    label,
    icon,
}: {
    on: boolean;
    label: string;
    icon: ReactNode;
}) {
    return (
        <Space size={8}>
            {on ? (
                <CheckCircleFilled style={{ color: '#52c41a' }} />
            ) : (
                <CloseCircleFilled
                    style={{ color: 'rgba(255,255,255,0.35)' }}
                />
            )}
            <span className="vmix-status-icon">{icon}</span>
            <Text>{label}</Text>
        </Space>
    );
}

// The audience display the "Add ... input" button adds (Settings picks
// FMS or the custom one at FRC off-season events).
const DISPLAY_LABEL: Record<AutoAVStatus['audienceDisplay'], string> = {
    ftcLive: 'FTC Live',
    fms: 'FMS',
    customAd: 'Offseason AD',
};

const ADD_DISPLAY_LABEL: Record<AutoAVStatus['audienceDisplay'], string> = {
    ftcLive: 'Add Audience Display input',
    fms: 'Add FMS input',
    customAd: 'Add Offseason AD input',
};

export default function VmixPage() {
    const [status, setStatus] = useState<VmixStatus | null>(null);
    const [bandwidth, setBandwidth] = useState<VmixBandwidth | null>(null);
    const [history, setHistory] = useState<number[]>([]);
    const [form] = Form.useForm<VmixApi>();
    const [testing, setTesting] = useState(false);
    const [settingKeys, setSettingKeys] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [compositeOpen, setCompositeOpen] = useState(false);
    // null until the first AutoAV status, so FTC never flashes FRC controls.
    const [program, setProgram] = useState<Program | null>(null);
    const [display, setDisplay] = useState<
        AutoAVStatus['audienceDisplay'] | null
    >(null);
    const oneShot = useOneShot();

    // FRC or FTC decides which audience display input the tab adds.
    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const off = ipcRenderer.on('autoav:status', (s: AutoAVStatus) => {
            setProgram(s.program);
            setDisplay(s.audienceDisplay);
        });
        ipcRenderer.sendMessage('autoav:getState', []);
        return off;
    }, []);
    const [inputs, setInputs] = useState<
        { key: string; number: number; title: string; type: string }[]
    >([]);
    const [cameraKey, setCameraKey] = useState<string | undefined>();
    // Offseason AD: its camera box sits under a team grid of one row per 7
    // teams, so the composite needs the event's team count.
    const [teamCount, setTeamCount] = useState<number | null>(null);
    const [fmsKey, setFmsKey] = useState<string | undefined>();
    const [comp, setComp] = useState({
        layer: 1,
        zoom: 0.4398,
        panX: -0.421,
        panY: 0.5061,
    });
    const MAX_HISTORY = 60;

    // Poll status and load settings on mount.
    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;

        const offStatus = ipcRenderer.on('vmix:status', (s: VmixStatus) =>
            setStatus(s)
        );
        const offBandwidth = ipcRenderer.on(
            'vmix:bandwidth',
            (b: VmixBandwidth) => {
                setBandwidth(b);
                // Combined live (instantaneous) bitrate across streams, in Mbps.
                const combined = b.streams.reduce(
                    (sum, s) => sum + (s.liveKbps ?? 0),
                    0
                );
                setHistory((h) => [...h, combined / 1000].slice(-MAX_HISTORY));
            }
        );
        const offSettings = ipcRenderer.on('vmix:settings', (s: VmixApi) =>
            form.setFieldsValue(s)
        );
        const offAction = ipcRenderer.on(
            'vmix:action',
            (r: { ok: boolean; message: string; action?: string }) => {
                if (r.action === 'setStreamKeys') setSettingKeys(false);
                if (r.ok) message.success(r.message);
                else message.error(r.message);
            }
        );

        const poll = () => {
            ipcRenderer.sendMessage('vmix:getStatus', []);
            ipcRenderer.sendMessage('vmix:getBandwidth', []);
        };
        // Key validation hits the admin hub, so poll it slowly (every 30s).
        const pollKeys = () => ipcRenderer.sendMessage('vmix:pollKeys', []);
        ipcRenderer.sendMessage('vmix:getSettings', []);
        poll();
        pollKeys();
        const timer = setInterval(poll, 3000);
        const keyTimer = setInterval(pollKeys, 300000);

        return () => {
            offStatus();
            offBandwidth();
            offSettings();
            offAction();
            clearInterval(timer);
            clearInterval(keyTimer);
        };
    }, [form]);

    const test = useCallback(() => {
        const sent = oneShot<{ ok: boolean; message: string }>(
            'vmix:testResult',
            (r) => {
                setTesting(false);
                if (r.ok) message.success(r.message);
                else message.error(r.message);
            },
            () =>
                window.electron?.ipcRenderer.sendMessage(
                    'vmix:testConnection',
                    [form.getFieldsValue()]
                ),
            () => {
                setTesting(false);
                message.error('Failed: no reply');
            }
        );
        if (sent) setTesting(true);
    }, [form, oneShot]);

    const saveConn = useCallback(async () => {
        const values = await form.validateFields();
        window.electron?.ipcRenderer.sendMessage('vmix:saveSettings', [values]);
        message.success('Saved');
        setSettingsOpen(false);
    }, [form]);

    const send = (channel: string) =>
        window.electron?.ipcRenderer.sendMessage(channel, []);

    const setStreamKeys = useCallback(() => {
        setSettingKeys(true);
        window.electron?.ipcRenderer.sendMessage('vmix:setStreamKeys', []);
    }, []);

    // Load inputs + saved geometry when the composite dialog opens.
    useEffect(() => {
        if (!compositeOpen || !window.electron) return undefined;
        const { ipcRenderer } = window.electron;
        const offInputs = ipcRenderer.on(
            'vmix:inputs',
            (list: typeof inputs) => {
                setInputs(list);
                // Default the FMS layer to an audience-display / FMS input.
                setFmsKey(
                    (prev) =>
                        prev ??
                        list.find((i) => /audience|fms|display/i.test(i.title))
                            ?.key
                );
            }
        );
        const offComp = ipcRenderer.on('vmix:composite', (c: typeof comp) =>
            setComp(c)
        );
        ipcRenderer.sendMessage('vmix:getInputs', []);
        ipcRenderer.sendMessage('vmix:getComposite', []);
        // Offseason AD: pre-fill the team count from FMS's rankings.
        const offTeams = ipcRenderer.on(
            'vmix:teamCount',
            (n: number | null) => {
                if (n) setTeamCount((cur) => cur ?? n);
            }
        );
        if (display === 'customAd')
            ipcRenderer.sendMessage('vmix:getTeamCount', []);
        return () => {
            offInputs();
            offComp();
            offTeams();
        };
    }, [compositeOpen, display]);

    const applyComposite = useCallback(() => {
        if (!cameraKey || !fmsKey) {
            message.error('Display and camera required');
            return;
        }
        if (display === 'customAd' && !teamCount) {
            message.error('Teams required');
            return;
        }
        window.electron?.ipcRenderer.sendMessage('vmix:applyComposite', [
            { cameraKey, fmsKey, ...comp, teamCount },
        ]);
        setCompositeOpen(false);
    }, [cameraKey, fmsKey, comp, display, teamCount]);

    const reachable = !!status?.reachable;
    const event = status?.currentEvent;

    return (
        <>
            <AddonControlRow
                running={reachable}
                statusLabel={reachable ? 'Connected' : 'Not connected'}
                onSettings={() => setSettingsOpen(true)}
            />
            <div className="vmix-page">
                <div className="vmix-cards">
                    <Card size="small" title="Status">
                        <Space direction="vertical" size={10}>
                            <StatusLine
                                on={reachable}
                                label="vMix"
                                icon={<ApiOutlined />}
                            />
                            <Space size={8}>
                                <Dot on={!!status?.recording} color="#ff4d4f" />
                                <VideoCameraOutlined className="vmix-status-icon" />
                                <Text>
                                    {status?.recording
                                        ? 'Recording'
                                        : 'Not recording'}
                                </Text>
                            </Space>
                            <Space size={8}>
                                <Dot on={!!status?.streaming} color="#ff4d4f" />
                                <DesktopOutlined className="vmix-status-icon" />
                                <Text>
                                    {status?.streaming
                                        ? 'Streaming'
                                        : 'Not streaming'}
                                </Text>
                            </Space>
                        </Space>
                    </Card>

                    <Card size="small" title="Stream keys">
                        <Space direction="vertical" size={10}>
                            {status?.keysSetForEvent ? (
                                <Tag color="success" icon={<KeyOutlined />}>
                                    Set
                                </Tag>
                            ) : (
                                <Tag color="warning" icon={<KeyOutlined />}>
                                    Not set
                                </Tag>
                            )}
                            <Text type="secondary">
                                {event?.name
                                    ? `Event: ${event.name}`
                                    : 'No event'}
                            </Text>
                            {status?.streamKeys && (
                                <Text type="secondary" className="vmix-dim">
                                    Last set for {status.streamKeys.eventName}
                                </Text>
                            )}

                            {status?.keyValidation?.match === false && (
                                <div className="vmix-key-mismatch">
                                    <Text type="danger" strong>
                                        Key mismatch
                                    </Text>
                                    <Text type="secondary" className="vmix-dim">
                                        vMix:{' '}
                                        {status.keyValidation.runningKeys
                                            .map(keyTail)
                                            .join(', ') || '-'}
                                    </Text>
                                    <Text type="secondary" className="vmix-dim">
                                        Admin:{' '}
                                        {status.keyValidation.cloudKeys
                                            .map(keyTail)
                                            .join(', ') || '-'}
                                    </Text>
                                </div>
                            )}
                            {status?.keyValidation?.match === true && (
                                <Text type="success">Keys match</Text>
                            )}

                            <Button
                                icon={<KeyOutlined />}
                                disabled={!reachable || settingKeys}
                                loading={settingKeys}
                                onClick={setStreamKeys}
                            >
                                {settingKeys
                                    ? 'Setting keys'
                                    : 'Set stream keys'}
                            </Button>
                        </Space>
                    </Card>
                </div>

                <Title level={5} style={{ margin: '16px 0 8px' }}>
                    Streaming bandwidth
                </Title>
                <Card size="small">
                    {(() => {
                        if (
                            bandwidth == null ||
                            (bandwidth.warming &&
                                bandwidth.streams.length === 0)
                        ) {
                            return (
                                <Space size={10}>
                                    <Spin size="small" />
                                    <Text type="secondary">Loading</Text>
                                </Space>
                            );
                        }
                        if (bandwidth.streams.length === 0) {
                            return <Text type="secondary">No streams</Text>;
                        }
                        return (
                            <Space
                                direction="vertical"
                                size={8}
                                style={{ width: '100%' }}
                            >
                                {bandwidth.streams.map((s) => (
                                    <div
                                        key={s.index}
                                        className="vmix-stream-row"
                                    >
                                        <Space size={8}>
                                            <Dot on color="#ff4d4f" />
                                            <Text strong>Stream {s.index}</Text>
                                            <Tag>{s.destination}</Tag>
                                        </Space>
                                        <Text>
                                            <Text strong>
                                                {fmtBitrate(s.liveKbps)}
                                            </Text>
                                            <Text
                                                type="secondary"
                                                className="vmix-dim"
                                            >
                                                {' '}
                                                / target{' '}
                                                {fmtBitrate(s.targetKbps)}
                                            </Text>
                                        </Text>
                                    </div>
                                ))}

                                <div className="vmix-spark-row">
                                    <Text type="secondary" className="vmix-dim">
                                        Combined live bitrate
                                    </Text>
                                    <Space size={10}>
                                        <Sparkline data={history} />
                                        <Text strong>
                                            {fmtBitrate(
                                                bandwidth.streams.reduce(
                                                    (sum, s) =>
                                                        sum + (s.liveKbps ?? 0),
                                                    0
                                                )
                                            )}
                                        </Text>
                                    </Space>
                                </div>
                            </Space>
                        );
                    })()}
                </Card>

                <Title level={5} style={{ margin: '16px 0 8px' }}>
                    Audio
                </Title>
                <AudioSection />

                <Title level={5} style={{ margin: '16px 0 8px' }}>
                    vMix inputs
                </Title>
                {display && (
                    <div style={{ marginBottom: 8 }}>
                        <Text type="secondary">Audience display: </Text>
                        <Text strong>{DISPLAY_LABEL[display]}</Text>
                    </div>
                )}
                <Space wrap>
                    <Button
                        icon={<AudioOutlined />}
                        disabled={!reachable}
                        onClick={() => send('vmix:addLiveCaptionsInput')}
                    >
                        Add Live Captions input
                    </Button>
                    {program && (
                        <Button
                            icon={<DesktopOutlined />}
                            disabled={!reachable}
                            onClick={() => send('vmix:addAudienceDisplayInput')}
                        >
                            {ADD_DISPLAY_LABEL[display ?? 'fms']}
                        </Button>
                    )}
                    {/* Sized to the FMS or FTC Live display's camera box. */}
                    <Button
                        icon={<VideoCameraOutlined />}
                        disabled={!reachable || !program}
                        onClick={() => setCompositeOpen(true)}
                    >
                        Add Alliance Selection Composite
                    </Button>
                </Space>

                <Modal
                    title="Alliance Selection Composite"
                    open={compositeOpen}
                    onCancel={() => setCompositeOpen(false)}
                    onOk={applyComposite}
                    okText="Apply"
                    width={520}
                >
                    <Space
                        direction="vertical"
                        size={12}
                        style={{ width: '100%' }}
                    >
                        <div>
                            <Text>
                                {program === 'ftc'
                                    ? 'Audience Display input'
                                    : 'FMS / audience display input'}
                            </Text>
                            <Select
                                style={{ width: '100%' }}
                                placeholder="Display"
                                value={fmsKey}
                                onChange={setFmsKey}
                                options={inputs.map((i) => ({
                                    value: i.key,
                                    label: `${i.number}. ${i.title}`,
                                }))}
                            />
                        </div>
                        {display === 'customAd' && (
                            <div>
                                <Text>Teams</Text>
                                <InputNumber
                                    style={{ width: '100%' }}
                                    min={1}
                                    max={200}
                                    value={teamCount}
                                    onChange={(v) => setTeamCount(v ?? null)}
                                />
                            </div>
                        )}
                        <div>
                            <Text>Main camera input</Text>
                            <Select
                                style={{ width: '100%' }}
                                placeholder="Camera"
                                value={cameraKey}
                                onChange={setCameraKey}
                                options={inputs.map((i) => ({
                                    value: i.key,
                                    label: `${i.number}. ${i.title}`,
                                }))}
                            />
                        </div>
                    </Space>
                </Modal>

                <Modal
                    title="vMix connection"
                    open={settingsOpen}
                    onCancel={() => setSettingsOpen(false)}
                    footer={null}
                >
                    <Form
                        form={form}
                        layout="vertical"
                        style={{ marginTop: 12 }}
                    >
                        <Form.Item
                            label="Web API URL"
                            name="baseUrl"
                            rules={[
                                {
                                    required: true,
                                    message: 'Required',
                                },
                            ]}
                        >
                            <Input placeholder="http://127.0.0.1:8088/api" />
                        </Form.Item>
                        <Space size={12} style={{ display: 'flex' }}>
                            <Form.Item
                                label="Username"
                                name="username"
                                style={{ flex: 1 }}
                            >
                                <Input placeholder="Optional" />
                            </Form.Item>
                            <Form.Item
                                label="Password"
                                name="password"
                                style={{ flex: 1 }}
                            >
                                <Input.Password placeholder="Optional" />
                            </Form.Item>
                        </Space>
                        <Space>
                            <Button onClick={test} loading={testing}>
                                Test connection
                            </Button>
                            <Button type="primary" onClick={saveConn}>
                                Save
                            </Button>
                        </Space>
                    </Form>
                </Modal>
            </div>
        </>
    );
}
