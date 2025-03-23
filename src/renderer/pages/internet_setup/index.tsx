import { Flex, Space, Typography } from 'antd';
import HWPingResponse from 'models/HWPingResponse';
import { Steppable } from 'models/steppable';
import { useEffect, useRef, useState } from 'react';
import ReadyHandler, { ReadyState } from 'renderer/components/ReadyHandler';
import StepBar from 'renderer/components/StepBar';
import SwitchInternetPort from '../../../../assets/photos/switch-internet-port.png';

function InternetSetup({ nextStep, previousStep }: Steppable) {
    const [errors, setErrors] = useState<string[]>([]);
    const pingCount = useRef<number>(0);
    const [pingCountState, setPingCountState] = useState<number>(0);
    const [ready, setReady] = useState<boolean>(navigator.onLine);

    useEffect(() => {
        // We ping for this every 10 seconds, so we want to consistantly listen for it
        window.electron.ipcRenderer.on('hw-change', onHwUpdate);

        // This forces IPC to send us the current status
        window.electron.ipcRenderer.sendMessage('hw-status', []);
    }, []); // only run once


    const onHwUpdate = (status: HWPingResponse) => {
        setReady(status.internet);
        setErrors(status.errors);
        pingCount.current += 1;
        setPingCountState(pingCount.current);
    }

    return (
        <>
            <Space
                direction="vertical"
                style={{ textAlign: 'center', width: '100%' }}
            >
                <Typography.Title level={1}>
                    Venue Internet Setup
                </Typography.Title>

                <Typography.Text>
                    Please plug in the venue ethernet into port <b>7</b> on the
                    Switch on the rear of the AV Cart (4th column, top row, highlighted below)
                </Typography.Text>

                <Flex gap="small" align="center" vertical>
                    <img
                        src={SwitchInternetPort}
                        alt="Switch Port 7"
                        style={{ width: '30%' }}
                    />
                </Flex>

                <Typography.Text>
                    <ReadyHandler
                        ready={ready ? ReadyState.Ready : ReadyState.NotReady}
                    />
                    {ready ? ' Internet Connection Detected!' : ` Waiting for Internet Connection... (Attempt ${pingCountState})`}
                </Typography.Text>

                {errors && errors.length > 0 && (
                    <>
                        <Typography.Text>
                            Don&apos;t worry about any errors below. We&apos;ll help you
                            get these resolved soon!
                        </Typography.Text>
                        {errors.map((error) => (
                            <Typography.Text key={error} type="danger">
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
                nextDisabled={!ready}
            />
        </>
    );
}

export default InternetSetup;
