import { Alert, Button, Card, Space, Typography } from 'antd';
import { LinkOutlined, WarningOutlined } from '@ant-design/icons';
import HWPingResponse from 'models/HWPingResponse';
import { Steppable } from 'models/steppable';
import { useEffect, useState } from 'react';
import ReadyHandler, { ReadyState } from 'renderer/components/ReadyHandler';
import StepBar from '../../components/StepBar';
import './index.css';

const { Title, Text } = Typography;

interface HWStatusRowProps {
    label: string;
    state: ReadyState;
}

function HWStatusRow({ label, state }: HWStatusRowProps) {
    return (
        <div className="docs-status-row">
            <span className="docs-status-icon">
                <ReadyHandler ready={state} />
            </span>
            <Text>{label}</Text>
        </div>
    );
}

function FallbackToDocs({ nextStep, previousStep }: Steppable) {
    const [hw, setHw] = useState<HWPingResponse>({
        camera1: false,
        camera2: false,
        mixer: false,
        switch: false,
        internet: false,
        errors: [],
        ip_warnings: [],
        ip_errors: [],
    });

    useEffect(() => {
        // We ping for this every 10 seconds, so we want to consistently listen for it
        window.electron.ipcRenderer.on('hw-change', setHw);

        // This forces IPC to send us the current status
        window.electron.ipcRenderer.sendMessage('hw-status', []);
    }, []);

    return (
        <>
            <Space direction="vertical" className="docs-page" size="large">
                <div>
                    <Title level={1}>Check Out the Documentation</Title>
                    <Text type="secondary" className="docs-subtitle">
                        The FiM AV Docs can help you finish setting up your
                        event.
                    </Text>
                </div>

                <Button
                    type="primary"
                    size="large"
                    icon={<LinkOutlined />}
                    href="https://docs.fimav.us/docs/day--1-and-0/"
                    target="_blank"
                >
                    Visit the Docs
                </Button>

                <Card className="docs-card">
                    <Space
                        direction="vertical"
                        style={{ width: '100%' }}
                        size={8}
                    >
                        <HWStatusRow
                            label="Camera 1"
                            state={
                                hw.camera1 ? ReadyState.Ready : ReadyState.Error
                            }
                        />
                        <HWStatusRow
                            label="Camera 2"
                            state={
                                hw.camera2 ? ReadyState.Ready : ReadyState.Error
                            }
                        />
                        <HWStatusRow
                            label="Mixer"
                            state={
                                hw.mixer ? ReadyState.Ready : ReadyState.Error
                            }
                        />
                        <HWStatusRow
                            label="Switch"
                            state={
                                hw.switch ? ReadyState.Ready : ReadyState.Error
                            }
                        />
                        <HWStatusRow
                            label="Internet"
                            state={
                                hw.internet
                                    ? ReadyState.Ready
                                    : ReadyState.Error
                            }
                        />
                    </Space>
                </Card>

                {hw.ip_errors.length > 0 && (
                    <Card className="docs-card">
                        <Space
                            direction="vertical"
                            style={{ width: '100%' }}
                            size={8}
                        >
                            <Text
                                type="secondary"
                                className="docs-section-label"
                            >
                                <WarningOutlined style={{ marginRight: 6 }} />
                                IP configuration errors detected:
                            </Text>
                            {hw.ip_errors.map((err) => (
                                <Alert
                                    key={err}
                                    type="error"
                                    message={err}
                                    showIcon
                                />
                            ))}
                        </Space>
                    </Card>
                )}

                {hw.ip_warnings.length > 0 && (
                    <Card className="docs-card">
                        <Space
                            direction="vertical"
                            style={{ width: '100%' }}
                            size={8}
                        >
                            <Text
                                type="secondary"
                                className="docs-section-label"
                            >
                                <WarningOutlined style={{ marginRight: 6 }} />
                                IP configuration warnings:
                            </Text>
                            {hw.ip_warnings.map((warn) => (
                                <Alert
                                    key={warn}
                                    type="warning"
                                    message={warn}
                                    showIcon
                                />
                            ))}
                        </Space>
                    </Card>
                )}
            </Space>

            <StepBar nextStep={nextStep} previousStep={previousStep} showPrev />
        </>
    );
}

export default FallbackToDocs;
