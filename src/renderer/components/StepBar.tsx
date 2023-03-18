import { LeftOutlined, RightOutlined } from "@ant-design/icons"
import { Button, Col, Row, Space } from "antd"
import { Steppable } from "models/steppable"
import { useState } from "react"
import { useNavigate } from "react-router-dom"


interface IProps extends Steppable {
    showNext?: boolean
    showPrev?: boolean
    nextDisabled?: boolean
    prevDisabled?: boolean
    beforeNext?: () => Promise<boolean> // Things to execute before next step.  Returning true will advance, false will not
    beforePrev?: () => Promise<boolean> // Things to execute before previous step.  Returning true will go back, false will not
}

const StepBar = ({ nextStep, previousStep, showNext, showPrev, beforeNext, beforePrev, nextDisabled, prevDisabled }: IProps) => {

    const nav = useNavigate();
    const [loading, setLoading] = useState<boolean>(false);

    const handleNext = async () => {
        if (beforeNext) {
            setLoading(true);
            const shouldAdvance = await beforeNext();
            if (shouldAdvance) {
                nav(`/step/${nextStep}`);
            } else {
                setLoading(false);
            }
        } else {
            nav(`/step/${nextStep}`);
        }
    }

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
    }

    const navBack = () => {
        if (previousStep < 1) {
            nav("/");
        } else {
            nav(`/step/${previousStep}`);
        }
    }

    return (
        <Row style={{ position: "absolute", bottom: "43px", left: 0, width: '100%' }}>
            <Col span={8}>
                {showPrev &&
                    <Button
                        type="primary"
                        danger
                        loading={loading}
                        size={"large"}
                        onClick={handlePrevious}
                        disabled={prevDisabled}
                        icon={<LeftOutlined />}
                    >
                        Previous
                    </Button>
                }
            </Col>
            <Col span={8} offset={8} style={{display: "flex"}}>
                {showNext &&
                    <Button
                        type="primary"
                        loading={loading}
                        size={"large"}
                        onClick={handleNext}
                        disabled={nextDisabled}
                        style={{ marginLeft: "auto", marginRight: "5px" }}
                    >
                        Next
                        <RightOutlined />
                    </Button>
                }
            </Col>
        </Row>
    )

}

export default StepBar;