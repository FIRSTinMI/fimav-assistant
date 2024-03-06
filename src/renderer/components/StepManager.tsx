import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getStep } from 'renderer/web_utils/step_manager';

function StepManager() {
    const nav = useNavigate();

    // On first load, check the current step from local storage
    useEffect(() => {
        getStep()
            .then((step) => {
                if (step > 0) {
                    nav(`/step/${step}`);
                }

                return null;
            })
            .catch(() => { });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return null;
}

export default StepManager;
