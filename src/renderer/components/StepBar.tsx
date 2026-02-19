import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { Button, Col, Row } from 'antd';
import { Steppable } from 'models/steppable';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { storeStep } from 'renderer/web_utils/step_manager';
import './StepBar.css';

interface IProps extends Steppable {
    showNext?: boolean;
    showPrev?: boolean;
    nextDisabled?: boolean;
    prevDisabled?: boolean;
    beforeNext?: () => Promise<boolean>; // Things to execute before next step.  Returning true will advance, false will not
    beforePrev?: () => Promise<boolean>; // Things to execute before previous step.  Returning true will go back, false will not
}

function StepBar({
    nextStep,
    previousStep,
    showNext,
    showPrev,
    beforeNext,
    beforePrev,
    nextDisabled,
    prevDisabled,
}: IProps) {
    const nav = useNavigate();
    const [loading, setLoading] = useState<boolean>(false);

    const handleNext = async () => {
        if (beforeNext) {
            setLoading(true);
            const shouldAdvance = await beforeNext();
            if (shouldAdvance) {
                storeStep(nextStep);
                nav(`/step/${nextStep}`);
            } else {
                setLoading(false);
            }
        } else {
            storeStep(nextStep);
            nav(`/step/${nextStep}`);
        }
    };

    const handlePrevious = async () => {
        if (beforePrev) {
            setLoading(true);
            const shouldGoBack = await beforePrev();
            if (shouldGoBack) {
                navBack();
            } else {
                setLoading(false);
            }
        } else {
            navBack();
        }
    };

    const navBack = () => {
        if (previousStep < 1) {
            storeStep(0);
            nav('/');
        } else {
            storeStep(previousStep);
            nav(`/step/${previousStep}`);
        }
    };

    return (
        <Row gutter={2} className="step-bar">
            <Col span={8}>
                {showPrev && (
                    <Button
                        type="primary"
                        ghost
                        loading={loading}
                        size="large"
                        onClick={handlePrevious}
                        disabled={prevDisabled}
                        icon={<LeftOutlined />}
                    >
                        Previous
                    </Button>
                )}
            </Col>
            <Col span={8} offset={8} className="step-bar-next-col">
                {showNext && (
                    <Button
                        type="primary"
                        loading={loading}
                        size="large"
                        onClick={handleNext}
                        disabled={nextDisabled}
                        className="step-bar-next-btn"
                    >
                        Next
                        <RightOutlined />
                    </Button>
                )}
            </Col>
        </Row>
    );
}

StepBar.defaultProps = {
    showNext: false,
    showPrev: false,
    nextDisabled: false,
    prevDisabled: false,
    beforeNext: undefined,
    beforePrev: undefined,
} as Partial<IProps>;

export default StepBar;
