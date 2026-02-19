import { Alert, Button, Card, Flex, Space, Typography } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import HWPingResponse from 'models/HWPingResponse';
import { Steppable } from 'models/steppable';
import { useEffect, useState } from 'react';
import ReadyHandler, { ReadyState } from 'renderer/components/ReadyHandler';
import StepBar from 'renderer/components/StepBar';
import CameraPelicans from '../../../../assets/photos/camera_pelican.jpg';
import FRCField from '../../../../assets/photos/frc_field_2024.png';
import AVVlanHighlighted from '../../../../assets/photos/avvlan-highlighted.png';
import PTZOpticsPower from '../../../../assets/photos/ptzoptics_power.jpg';
import './index.css';

const { Title, Text } = Typography;

const subSteps = [
    {
        text: 'Time to setup the cameras!  Locate the orange camera pelican and take out a camera.',
        img: CameraPelicans,
    },
    {
        text: 'For FRC, the camera should be placed at least 15 feet from the field border. For FTC, the cameras should be roughly 8 feet from the field.',
        img: FRCField,
    },
    {
        text: 'Survey your location and find a good spot for the camera. The camera can be placed either on one of the provided tripods, or using one of the pole mounts.  Note: you only have about 100 feet of ethernet, so keep that in mind!',
        img: FRCField,
    },
    {
        text: 'Once placed, run an ethernet cable to each of the cameras (if you are using multiple) and plug them to a highlighted port (port 13 through 22) of the purple networking switch on the backside of the AV Cart.',
        img: AVVlanHighlighted,
    },
    {
        text: 'Once plugged in, the cameras should spin and come online.  If the camera does not spin, and does not come online below, check that the power switch on the back is flipped on.',
        img: PTZOpticsPower,
    },
    {
        text: 'If you are still having issues, please contact support for further assistance.  You will be able to continue once a camera has been detected below.',
        img: null,
    },
];

interface CameraStatusRowProps {
    label: string;
    state: ReadyState;
}

function CameraStatusRow({ label, state }: CameraStatusRowProps) {
    return (
        <div className="camera-status-row">
            <span className="camera-status-icon">
                <ReadyHandler ready={state} />
            </span>
            <Text>{label}</Text>
        </div>
    );
}

function CameraSetup({ nextStep, previousStep }: Steppable) {
    const [errors, setErrors] = useState<string[]>([]);
    const [cam1, setCam1] = useState<boolean>(false);
    const [cam2, setCam2] = useState<boolean>(false);
    const [subStep, setSubStep] = useState<number>(0);

    useEffect(() => {
        // Fire off HW check and register listener
        window.electron.ipcRenderer.on('hw-change', (arg: HWPingResponse) => {
            setErrors(arg.errors);
            setCam1(arg.camera1);
            setCam2(arg.camera2);
        });
        window.electron.ipcRenderer.sendMessage('hw-status', []);
    }, []); // only run once

    const previous = () => {
        if (subStep > 0) setSubStep(subStep - 1);
    };

    const next = () => {
        if (subStep < subSteps.length - 1) setSubStep(subStep + 1);
    };

    const hasIssues = errors.length > 0;

    return (
        <>
            <Space
                direction="vertical"
                className="camera-setup-page"
                size="large"
            >
                <div>
                    <Title level={1}>Camera Setup</Title>
                    <Text type="secondary" style={{ fontSize: 15 }}>
                        Follow the steps below to place and connect your
                        cameras.
                    </Text>
                </div>

                {/* Sub-step card */}
                <Card className="camera-setup-card">
                    <div className="camera-setup-substep-nav">
                        <Button onClick={previous} disabled={subStep === 0}>
                            Previous
                        </Button>
                        <Text
                            type="secondary"
                            className="camera-setup-substep-counter"
                        >
                            Step {subStep + 1} of {subSteps.length}
                        </Text>
                        <Button
                            onClick={next}
                            disabled={subStep === subSteps.length - 1}
                        >
                            Next
                        </Button>
                    </div>
                    <Text>{subSteps[subStep].text}</Text>
                    {subSteps[subStep].img !== null && (
                        <Flex justify="center">
                            <img
                                src={subSteps[subStep].img ?? ''}
                                alt="Camera Setup"
                                className="camera-setup-photo"
                            />
                        </Flex>
                    )}
                </Card>

                {/* Camera status */}
                <Card className="camera-status-card">
                    <Space
                        direction="vertical"
                        style={{ width: '100%' }}
                        size={8}
                    >
                        <CameraStatusRow
                            label="Camera 1"
                            state={
                                cam1 ? ReadyState.Ready : ReadyState.NotReady
                            }
                        />
                        <CameraStatusRow
                            label="Camera 2"
                            state={
                                cam2 ? ReadyState.Ready : ReadyState.NotReady
                            }
                        />
                        {process.env.NODE_ENV === 'development' && (
                            <CameraStatusRow
                                label="Developer"
                                state={ReadyState.Ready}
                            />
                        )}
                    </Space>
                </Card>

                {/* Issues */}
                {hasIssues && (
                    <div className="camera-setup-issues">
                        <Space
                            direction="vertical"
                            style={{ width: '100%' }}
                            size={8}
                        >
                            <Text
                                type="secondary"
                                className="camera-setup-errors-hint"
                            >
                                <WarningOutlined style={{ marginRight: 6 }} />
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
                        </Space>
                    </div>
                )}
            </Space>

            <StepBar
                nextStep={nextStep}
                previousStep={previousStep}
                showNext
                showPrev
                nextDisabled={
                    !cam1 && !cam2 && process.env.NODE_ENV !== 'development'
                }
            />
        </>
    );
}

export default CameraSetup;
