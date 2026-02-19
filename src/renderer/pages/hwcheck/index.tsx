import { Alert, Card, Col, Modal, Row, Space, Spin, Typography } from 'antd';
import {
    CheckCircleOutlined,
    ExclamationCircleOutlined,
    LoadingOutlined,
    WarningOutlined,
} from '@ant-design/icons';
import HWCheckResponse, { StaticIpInfo } from 'models/HWCheckResponse';
import { IpConfigState } from 'models/HWPingResponse';
import { Steppable } from 'models/steppable';
import { useEffect, useState } from 'react';
import StepBar from 'renderer/components/StepBar';
import { ReadyState } from 'renderer/components/ReadyHandler';
import AVTotes from '../../../../assets/photos/av_tote.jpg';
import CameraPelicans from '../../../../assets/photos/camera_pelican.jpg';
import './index.css';

const { Title, Text } = Typography;

interface CheckItemProps {
    label: string;
    state: ReadyState;
}

function CheckItem({ label, state }: CheckItemProps) {
    let icon: ReturnType<typeof CheckCircleOutlined>;
    let iconClass: string;

    switch (state) {
        case ReadyState.Ready:
            icon = <CheckCircleOutlined />;
            iconClass = 'check-item-icon--ready';
            break;
        case ReadyState.Error:
            icon = <ExclamationCircleOutlined />;
            iconClass = 'check-item-icon--error';
            break;
        default:
            icon = <LoadingOutlined spin />;
            iconClass = 'check-item-icon--loading';
            break;
    }

    return (
        <div className="check-item">
            <span className={`check-item-icon ${iconClass}`}>{icon}</span>
            <Text className="check-item-label">{label}</Text>
        </div>
    );
}

function HWCheck({ nextStep, previousStep }: Steppable) {
    const [networkReady, setNetworkReady] = useState(ReadyState.NotReady);
    const [ipReady, setIpReady] = useState(ReadyState.NotReady);
    const [audioReady, setAudioReady] = useState(ReadyState.NotReady);
    const [errors, setErrors] = useState<string[]>([]);
    const [ipErrors, setIpErrors] = useState<string[]>([]);
    const [ipWarnings, setIpWarnings] = useState<string[]>([]);
    const [ready, setReady] = useState<boolean>(false);
    const [modal, contextHolder] = Modal.useModal();

    useEffect(() => {
        // Fire off HW check and register listener
        window.electron.ipcRenderer.once<HWCheckResponse>(
            'hwcheck-response',
            async (arg: HWCheckResponse) => {
                if (arg.static_venue_ip.static) {
                    await promptStaticIp(false, arg.static_venue_ip);
                }

                setNetworkReady(
                    arg.av_ip_ready && arg.field_ip_ready && arg.venue_ip_ready
                        ? ReadyState.Ready
                        : ReadyState.Error
                );
                setIpReady(
                    arg.nics_found.length > 3
                        ? ReadyState.Ready
                        : ReadyState.Error
                );
                setAudioReady(
                    arg.audio_ready ? ReadyState.Ready : ReadyState.Error
                );
                setErrors(arg.errors);
                if (arg.ip_config) {
                    setIpErrors(arg.ip_config.errors);
                    setIpWarnings(arg.ip_config.warnings);
                }
                setReady(true);
            }
        );
        window.electron.ipcRenderer.sendMessage('hwcheck', []);

        // Subscribe to ongoing IP config anomaly events
        const unsubscribe = window.electron.ipcRenderer.on(
            'ip-config-changed',
            (arg: IpConfigState) => {
                setIpErrors(arg.errors);
                setIpWarnings(arg.warnings);
            }
        );

        return () => {
            unsubscribe();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const promptStaticIp = (failPrev: boolean, staticVenueIp: StaticIpInfo) => {
        return modal.confirm({
            title: 'Static IP Detected',
            cancelText: 'Leave It',
            okText: 'Enable DHCP (Recommended)',
            closable: false,
            keyboard: false,
            content: (
                <Space direction="vertical">
                    {failPrev && (
                        <Text type="danger">
                            The previous attempt to enable DHCP failed. Please
                            be sure to click &quot;Yes&quot; on the Windows
                            popup that appears.
                        </Text>
                    )}
                    <Text>
                        Your IP address is set to a static address of{' '}
                        <code>{staticVenueIp.ip}</code>. If this is intentional,
                        please click &quot;Leave It&quot; to continue.
                        Otherwise, click &quot;Enable DHCP&quot; to allow the
                        system to configure the network adapter to use DHCP.
                    </Text>
                </Space>
            ),
            onOk: async () => {
                window.electron.ipcRenderer.sendMessage('set-venue-ip-dhcp', [
                    staticVenueIp,
                ]);
                return new Promise<void>((resolve) => {
                    window.electron.ipcRenderer.once(
                        'set-venue-ip-dhcp-response',
                        (success) => {
                            resolve();
                            if (!success) {
                                promptStaticIp(true, staticVenueIp);
                            }
                        }
                    );
                });
            },
        });
    };

    const hasIssues =
        errors.length > 0 || ipErrors.length > 0 || ipWarnings.length > 0;

    return (
        <>
            {contextHolder}
            <Space direction="vertical" className="hwcheck-page" size="large">
                <div className="hwcheck-header">
                    <Title level={1}>Hardware Self-Check</Title>
                    <Text type="secondary" className="hwcheck-subtitle">
                        Hang tight&mdash; we&apos;re making sure your AV
                        computer is ready for this event.
                    </Text>
                </div>

                {/* Status checks */}
                <Card
                    className="hwcheck-status-card"
                    styles={{ body: { padding: '12px 16px' } }}
                >
                    <Space
                        direction="vertical"
                        style={{ width: '100%' }}
                        size={8}
                    >
                        <CheckItem
                            label="Network Adapters"
                            state={networkReady}
                        />
                        <CheckItem label="IP Addresses" state={ipReady} />
                        <CheckItem label="Audio Devices" state={audioReady} />
                        {!ready && (
                            <div className="hwcheck-running">
                                <Spin
                                    indicator={
                                        <LoadingOutlined
                                            style={{ fontSize: 16 }}
                                            spin
                                        />
                                    }
                                    size="small"
                                />{' '}
                                <Text
                                    type="secondary"
                                    className="hwcheck-running-text"
                                >
                                    Running checks...
                                </Text>
                            </div>
                        )}
                    </Space>
                </Card>

                {/* Issues section */}
                {hasIssues && (
                    <div className="hwcheck-issues">
                        <Space
                            direction="vertical"
                            style={{ width: '100%' }}
                            size={8}
                        >
                            <Text
                                type="secondary"
                                className="hwcheck-issues-hint"
                            >
                                <WarningOutlined style={{ marginRight: 6 }} />
                                Don&apos;t worry about any issues
                                below&mdash;we&apos;ll help you get these
                                resolved.
                            </Text>
                            {[...errors, ...ipErrors].map((error) => (
                                <Alert
                                    key={error}
                                    type="error"
                                    message={error}
                                    showIcon
                                />
                            ))}
                            {ipWarnings.map((warning) => (
                                <Alert
                                    key={warning}
                                    type="warning"
                                    message={warning}
                                    showIcon
                                />
                            ))}
                        </Space>
                    </div>
                )}

                {/* Meanwhile section */}
                <div>
                    <Title level={4} className="hwcheck-meanwhile-title">
                        Meanwhile, locate your AV Tote and orange camera
                        pelican.
                    </Title>
                    <Row gutter={24} justify="center">
                        <Col span={12}>
                            <img
                                src={AVTotes}
                                alt="Gray AV Tote"
                                className="hwcheck-photo"
                            />
                            <div className="hwcheck-photo-label">
                                <Text type="secondary">AV Tote</Text>
                            </div>
                        </Col>
                        <Col span={12}>
                            <img
                                src={CameraPelicans}
                                alt="Camera pelican"
                                className="hwcheck-photo"
                            />
                            <div className="hwcheck-photo-label">
                                <Text type="secondary">Camera Pelican</Text>
                            </div>
                        </Col>
                    </Row>
                </div>
            </Space>

            <StepBar
                nextStep={nextStep}
                previousStep={previousStep}
                showNext
                showPrev
                nextDisabled={!ready}
            />
        </>
    );
}

export default HWCheck;
