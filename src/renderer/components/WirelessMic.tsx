// A black handheld wireless mic with a band of coloured electrical tape,
// the way FIM marks the red and blue announcer mics.
export default function WirelessMic({
    tape,
    height = 180,
}: {
    tape: string;
    height?: number;
}) {
    const width = (height * 60) / 200;
    return (
        <svg
            width={width}
            height={height}
            viewBox="0 0 60 200"
            role="img"
            aria-label="Wireless mic"
        >
            {/* Grille */}
            <ellipse cx="30" cy="28" rx="24" ry="26" fill="#3a3a3a" />
            <ellipse cx="30" cy="28" rx="24" ry="26" fill="url(#mic-mesh)" />
            <rect x="8" y="46" width="44" height="8" rx="3" fill="#1c1c1c" />
            {/* Body, tapering to the end cap */}
            <path d="M10 54 L50 54 L42 186 Q30 194 18 186 Z" fill="#141414" />
            <path d="M14 58 L20 58 L22 180 L19 180 Z" fill="#2a2a2a" />
            {/* Tape */}
            <path d="M13.2 120 L46.8 120 L45.6 140 L14.4 140 Z" fill={tape} />
            <path
                d="M13.2 120 L46.8 120 L46.6 123 L13.4 123 Z"
                fill="#ffffff"
                opacity="0.18"
            />
            <defs>
                <pattern
                    id="mic-mesh"
                    width="4"
                    height="4"
                    patternUnits="userSpaceOnUse"
                >
                    <circle cx="2" cy="2" r="0.9" fill="#111" />
                </pattern>
            </defs>
        </svg>
    );
}

WirelessMic.defaultProps = {
    height: 180,
};
