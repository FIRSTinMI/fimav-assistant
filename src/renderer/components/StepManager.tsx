import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getStep } from 'renderer/web_utils/step_manager';

const StepManager = () => {
    const nav = useNavigate();

    // On first load, check the current step from local storage
    useEffect(() => {
        console.log('checking step');
        getStep()
            .then((step) => {
                console.log('got step', step);
                if (step > 0) {
                    nav(`/step/${step}`);
                }
            })
            .catch();
    }, []);

    return null;
};

export default StepManager;
