import { Button, Space, Typography, Flex } from 'antd';
import HWPingResponse from 'models/HWPingResponse';
import { Steppable } from 'models/steppable';
import { useEffect, useState } from 'react';
import ReadyHandler, { ReadyState } from 'renderer/components/ReadyHandler';
import StepBar from 'renderer/components/StepBar';
import CameraPelicans from '../../../../assets/photos/camera_pelican.jpg';
import FRCField from '../../../../assets/photos/frc_field_2024.png';
import AVVlanHighlighted from '../../../../assets/photos/avvlan-highlighted.png';
import PTZOpticsPower from '../../../../assets/photos/ptzoptics_power.jpg';

const subSteps = [
    { text: "Time to setup the camera(s)!  Locate the orange camera pelican and take out a camera.", img: CameraPelicans },
    { text: "For FRC, the camera should be placed at least 15 feet from the field border. For FTC, the cameras should be roughly 8 feet from the field.", img: FRCField },
    { text: "Survey your location and find a good spot for the camera. The camera can be placed either on one of the provided tripods, or using one of the pole mounts.  Note: you only have about 100 feet of ethernet, so keep that in mind!", img: FRCField },
    { text: "Once placed, run an ethernet cable to each of the cameras (if you are using multiple) and plug them to a highlighted port (port 13 through 22) of the purple networking switch on the backside of the AV Cart.", img: AVVlanHighlighted },
    { text: "Once plugged in, the cameras should spin and come online.  If the camera does not spin, and does not come online below, check that the power switch on the back is flipped on.", img: PTZOpticsPower },
    { text: "If you are still having issues, please contact support for further assistance.  You will be able to continue once a camera has been detected below.", img: null }
]

function InternetSetup({ nextStep, previousStep }: Steppable) {
    const [errors, setErrors] = useState<string[]>([]);
    const [cam1, setCam1] = useState<boolean>(false);
    const [cam2, setCam2] = useState<boolean>(false);
    const [subStep, setSubStep] = useState<number>(0);

    useEffect(() => {
        // Fire off HW check and register listener
        window.electron.ipcRenderer.on(
            'hw-change',
            (arg: HWPingResponse) => {
                setErrors(arg.errors);
                setCam1(arg.camera1);
                setCam2(arg.camera2);
            }
        );
        window.electron.ipcRenderer.sendMessage('hw-status', []);
    }, []); // only run once

    const previous = () => {
        if (subStep > 0) {
            setSubStep(subStep - 1);
        }
    }

    const next = () => {
        if (subStep < subSteps.length - 1) {
            setSubStep(subStep + 1);
        }
    }

    return (
        <>
            <Space
                direction="vertical"
                style={{ textAlign: 'center', width: '100%' }}
            >
                <Typography.Title level={1}>
                    Camera Setup
                </Typography.Title>

                <Flex gap="small" align="center" vertical>
                    <Flex gap="small" wrap="wrap">
                        <Button onClick={previous} disabled={subStep === 0}>
                            Previous
                        </Button>
                        {subStep < subSteps.length - 1 && (
                            <Button onClick={next} disabled={subStep === subSteps.length - 1}>
                                Next
                            </Button>
                        )}
                    </Flex>
                </Flex>

                <Typography.Text>
                    {subSteps[subStep].text}
                </Typography.Text>

                {subSteps[subStep].img !== null &&
                    <Flex gap="small" align="center" vertical>
                        <img
                            src={subSteps[subStep].img ?? ""}
                            alt="Camera Setup"
                            style={{ width: '30%' }}
                        />
                    </Flex>
                }

                <Typography.Text>
                    <ReadyHandler
                        ready={cam1 ? ReadyState.Ready : ReadyState.NotReady}
                    />{' '}
                    Camera 1
                </Typography.Text>

                <Typography.Text>
                    <ReadyHandler
                        ready={cam2 ? ReadyState.Ready : ReadyState.NotReady}
                    />{' '}
                    Camera 2
                </Typography.Text>

                {errors && errors.length > 0 && (
                    <>
                        <Typography.Text>
                            Don&apos;t worry about any errors below. We&apos;ll help you
                            get these resolved soon!
                        </Typography.Text>
                        {errors.map((error) => (
                            <Typography.Text type="danger">
                                {error}
                            </Typography.Text>
                        ))}
                    </>
                )}
            </Space>

            <StepBar
                nextStep={nextStep}
                previousStep={previousStep}
                showNext
                showPrev
                nextDisabled={!cam1 || !cam2}
            />
        </>
    );
}

export default InternetSetup;
