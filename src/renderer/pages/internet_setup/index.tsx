import { Alert, Card, Flex, Space, Typography } from 'antd';
import {
    CheckCircleOutlined,
    LoadingOutlined,
    WarningOutlined,
} from '@ant-design/icons';
import HWPingResponse from 'models/HWPingResponse';
import { Steppable } from 'models/steppable';
import { useEffect, useRef, useState } from 'react';
import StepBar from 'renderer/components/StepBar';
import SwitchInternetPort from '../../../../assets/photos/switch-internet-port.png';
import './index.css';

const { Title, Text } = Typography;

function InternetSetup({ nextStep, previousStep }: Steppable) {
    const [errors, setErrors] = useState<string[]>([]);
    const pingCount = useRef<number>(0);
    const [pingCountState, setPingCountState] = useState<number>(0);
    const [ready, setReady] = useState<boolean>(navigator.onLine);

    useEffect(() => {
        // We ping for this every 10 seconds, so we want to consistently listen for it
        window.electron.ipcRenderer.on('hw-change', onHwUpdate);

        // This forces IPC to send us the current status
        window.electron.ipcRenderer.sendMessage('hw-status', []);
    }, []); // only run once

    const onHwUpdate = (status: HWPingResponse) => {
        setReady(status.internet);
        setErrors(status.errors);
        pingCount.current += 1;
        setPingCountState(pingCount.current);
    };

    return (
        <>
            <Space
                direction="vertical"
                className="internet-setup-page"
                size="large"
            >
                <div>
                    <Title level={1}>Venue Internet Setup</Title>
                    <Text type="secondary" className="internet-setup-subtitle">
                        Plug in the venue ethernet cable to continue.
                    </Text>
                </div>

                <Card className="internet-setup-card">
                    <Text>
                        Connect the venue ethernet into port <b>7</b> on the
                        Switch on the rear of the AV Cart (4th column, top row,
                        highlighted below).
                    </Text>
                    <Flex justify="center" style={{ marginTop: 16 }}>
                        <img
                            src={SwitchInternetPort}
                            alt="Switch Port 7"
                            className="internet-setup-photo"
                        />
                    </Flex>
                </Card>

                <Card className="internet-setup-card">
                    <Space
                        direction="vertical"
                        style={{ width: '100%' }}
                        size={8}
                    >
                        <div className="internet-setup-status-row">
                            {ready ? (
                                <CheckCircleOutlined className="internet-setup-icon internet-setup-icon--ready" />
                            ) : (
                                <LoadingOutlined
                                    className="internet-setup-icon internet-setup-icon--loading"
                                    spin
                                />
                            )}
                            <Text className="internet-setup-status">
                                {ready
                                    ? 'Internet Connection Detected!'
                                    : `Waiting for Internet Connection... (Attempt ${pingCountState})`}
                            </Text>
                        </div>

                        {errors.length > 0 && (
                            <>
                                <Text
                                    type="secondary"
                                    className="internet-setup-errors-hint"
                                >
                                    <WarningOutlined
                                        style={{ marginRight: 6 }}
                                    />
                                    Don&apos;t worry about any issues
                                    below&mdash;we&apos;ll help you get these
                                    resolved.
                                </Text>
                                {errors.map((error) => (
                                    <Alert
                                        key={error}
                                        type="error"
                                        message={error}
                                        showIcon
                                    />
                                ))}
                            </>
                        )}
                    </Space>
                </Card>
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

export default InternetSetup;
