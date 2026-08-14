import { ReactNode, useCallback, useEffect, useState } from 'react';
import {
    Button,
    Card,
    Form,
    Input,
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
function Sparkline({ data, width = 240, height = 36 }: {
    data: number[];
    width?: number;
    height?: number;
}) {
    if (data.length < 2) {
        return (
            <Text type="secondary" className="vmix-dim">
                gathering samples
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
                <CloseCircleFilled style={{ color: 'rgba(255,255,255,0.35)' }} />
            )}
            <span className="vmix-status-icon">{icon}</span>
            <Text>{label}</Text>
        </Space>
    );
}

export default function VmixPage() {
    const [status, setStatus] = useState<VmixStatus | null>(null);
    const [bandwidth, setBandwidth] = useState<VmixBandwidth | null>(null);
    const [history, setHistory] = useState<number[]>([]);
    const [form] = Form.useForm<VmixApi>();
    const [testing, setTesting] = useState(false);
    const [settingKeys, setSettingKeys] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [compositeOpen, setCompositeOpen] = useState(false);
    const [inputs, setInputs] = useState<
        { key: string; number: number; title: string; type: string }[]
    >([]);
    const [cameraKey, setCameraKey] = useState<string | undefined>();
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
                setHistory((h) =>
                    [...h, combined / 1000].slice(-MAX_HISTORY)
                );
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
        if (!window.electron) return;
        const { ipcRenderer } = window.electron;
        setTesting(true);
        const off = ipcRenderer.on(
            'vmix:testResult',
            (r: { ok: boolean; message: string }) => {
                off();
                setTesting(false);
                if (r.ok) message.success(r.message);
                else message.error(r.message);
            }
        );
        ipcRenderer.sendMessage('vmix:testConnection', [
            form.getFieldsValue(),
        ]);
    }, [form]);

    const saveConn = useCallback(async () => {
        const values = await form.validateFields();
        window.electron?.ipcRenderer.sendMessage('vmix:saveSettings', [values]);
        message.success('vMix connection saved');
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
                        list.find((i) =>
                            /audience|fms|display/i.test(i.title)
                        )?.key
                );
            }
        );
        const offComp = ipcRenderer.on('vmix:composite', (c: typeof comp) =>
            setComp(c)
        );
        ipcRenderer.sendMessage('vmix:getInputs', []);
        ipcRenderer.sendMessage('vmix:getComposite', []);
        return () => {
            offInputs();
            offComp();
        };
    }, [compositeOpen]);

    const applyComposite = useCallback(() => {
        if (!cameraKey || !fmsKey) {
            message.error('Pick both the FMS input and the camera');
            return;
        }
        window.electron?.ipcRenderer.sendMessage('vmix:applyComposite', [
            { cameraKey, fmsKey, ...comp },
        ]);
        setCompositeOpen(false);
    }, [cameraKey, fmsKey, comp]);

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
                            label="vMix reachable"
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
                                    ? 'Streaming (live)'
                                    : 'Not streaming'}
                            </Text>
                        </Space>
                    </Space>
                </Card>

                <Card size="small" title="Stream keys">
                    <Space direction="vertical" size={10}>
                        {status?.keysSetForEvent ? (
                            <Tag color="success" icon={<KeyOutlined />}>
                                Set for this event
                            </Tag>
                        ) : (
                            <Tag color="warning" icon={<KeyOutlined />}>
                                Not set for this event
                            </Tag>
                        )}
                        <Text type="secondary">
                            Current event: {event?.name ?? 'None detected'}
                        </Text>
                        {status?.streamKeys && (
                            <Text type="secondary" className="vmix-dim">
                                Last set for {status.streamKeys.eventName}
                            </Text>
                        )}

                        {status?.keyValidation?.match === false && (
                            <div className="vmix-key-mismatch">
                                <Text type="danger" strong>
                                    ⚠ Admin key doesn&apos;t match vMix
                                </Text>
                                <Text type="secondary" className="vmix-dim">
                                    vMix using:{' '}
                                    {status.keyValidation.runningKeys
                                        .map(keyTail)
                                        .join(', ') || '-'}
                                </Text>
                                <Text type="secondary" className="vmix-dim">
                                    admin now:{' '}
                                    {status.keyValidation.cloudKeys
                                        .map(keyTail)
                                        .join(', ') || '-'}
                                </Text>
                                <Text type="secondary" className="vmix-dim">
                                    → press Set stream keys
                                </Text>
                            </div>
                        )}
                        {status?.keyValidation?.match === true && (
                            <Text type="success">
                                ✓ Key matches admin
                            </Text>
                        )}

                        <Button
                            icon={<KeyOutlined />}
                            disabled={!reachable || settingKeys}
                            loading={settingKeys}
                            onClick={setStreamKeys}
                        >
                            {settingKeys ? 'Setting keys' : 'Set stream keys'}
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
                                <Text type="secondary">
                                    Loading streaming stats
                                </Text>
                            </Space>
                        );
                    }
                    if (bandwidth.streams.length === 0) {
                        return (
                            <Text type="secondary">No active streams.</Text>
                        );
                    }
                    return (
                    <Space
                        direction="vertical"
                        size={8}
                        style={{ width: '100%' }}
                    >
                        {bandwidth.streams.map((s) => (
                            <div key={s.index} className="vmix-stream-row">
                                <Space size={8}>
                                    <Dot on color="#ff4d4f" />
                                    <Text strong>Stream {s.index}</Text>
                                    <Tag>{s.destination}</Tag>
                                </Space>
                                <Text>
                                    <Text strong>{fmtBitrate(s.liveKbps)}</Text>
                                    <Text type="secondary" className="vmix-dim">
                                        {' '}
                                        / target {fmtBitrate(s.targetKbps)}
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
                                            (sum, s) => sum + (s.liveKbps ?? 0),
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
                vMix inputs
            </Title>
            <Space wrap>
                <Button
                    icon={<AudioOutlined />}
                    disabled={!reachable}
                    onClick={() => send('vmix:addLiveCaptionsInput')}
                >
                    Add Live Captions input
                </Button>
                <Button
                    icon={<DesktopOutlined />}
                    disabled={!reachable}
                    onClick={() => send('vmix:addAudienceDisplayInput')}
                >
                    Add Audience Display input
                </Button>
                <Button
                    icon={<VideoCameraOutlined />}
                    disabled={!reachable}
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
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    <Text type="secondary">
                        Creates an &quot;Alliance Selection Composite&quot; input:
                        a blank base with your FMS/AD input as layer 1 and the
                        camera on top as layer 2, sized to the official AD camera
                        box. Your existing inputs are referenced, not duplicated.
                    </Text>
                    <div>
                        <Text>FMS / audience display input</Text>
                        <Select
                            style={{ width: '100%' }}
                            placeholder="Select FMS/AD input"
                            value={fmsKey}
                            onChange={setFmsKey}
                            options={inputs.map((i) => ({
                                value: i.key,
                                label: `${i.number}. ${i.title}`,
                            }))}
                        />
                    </div>
                    <div>
                        <Text>Main camera input</Text>
                        <Select
                            style={{ width: '100%' }}
                            placeholder="Select camera"
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
                            { required: true, message: 'Enter the vMix API URL' },
                        ]}
                        tooltip="vMix defaults to http://127.0.0.1:8088/api"
                    >
                        <Input placeholder="http://127.0.0.1:8088/api" />
                    </Form.Item>
                    <Space size={12} style={{ display: 'flex' }}>
                        <Form.Item
                            label="Username"
                            name="username"
                            style={{ flex: 1 }}
                        >
                            <Input placeholder="(blank if web auth is off)" />
                        </Form.Item>
                        <Form.Item
                            label="Password"
                            name="password"
                            style={{ flex: 1 }}
                        >
                            <Input.Password placeholder="(blank if web auth is off)" />
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
