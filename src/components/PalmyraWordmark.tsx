import { useId } from "react";
import { cn } from "../lib/utils";

export function PalmyraWordmark({ className }: { className?: string }) {
  // Unique per instance so a hidden copy (mobile bar behind lg:hidden) cannot
  // hijack the gradient IDs of the visible sidebar wordmark.
  const gradientId = `palmyra-wordmark-glow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="992"
      height="256"
      viewBox="0 0 992 256"
      role="img"
      aria-labelledby="palmyra-wordmark-title palmyra-wordmark-desc"
      className={cn("block shrink-0 object-contain", className)}
      aria-label="PALMYRA"
    >
      <title id="palmyra-wordmark-title">PALMYRA</title>
      <desc id="palmyra-wordmark-desc">Logo de PALMYRA: camello real moderno en círculo violeta junto al nombre PALMYRA en letras geométricas modernas.</desc>
      <defs>
        <radialGradient id={gradientId} cx="128" cy="128" r="130" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#A37BF4" />
          <stop offset="70%" stop-color="#8B4DDD" />
          <stop offset="100%" stop-color="#602BB5" />
        </radialGradient>
      </defs>
      <circle id="palmyra-wordmark-disc" cx="128" cy="128" r="124" fill={`url(#${gradientId})`} />
      <g id="palmyra-wordmark-camel" fill="#FFFFFF" transform="translate(128 128) scale(0.7) translate(-128 -128) scale(0.5)">
        <path d="M420.8 26.91c-11.4.76-23.7 4.65-33.6 10.29c-5.3-4.86-13.5-10.52-19.3-6.11c-12.5 9.46-2.4 20.76 6.8 27.94c5.5 35.86 20.7 93.17-9.8 105.97C317 183.1 308.4 36.14 241 37.94c-40.4 1.08-22.6 59.65-62.6 61.65c-29.5 1.51-27.3-54.51-51.9-55.36c-25.9-.9-44.62 18.9-57.71 86.97c-25.63-.1-35.73 20.1-47.42 59.2c-11.686 39-3 115.6 1.2 162.4l7.87-76.3c2.43 12 6.19 24.1 11.91 36.7c3.91 18.7 5.44 37.4 5.81 56c-8.2 10.2-8.8 26.2-.42 35.5c-.92 26.8-2.67 53.5-1.68 80.3c34.48.5 66.04-1 99.54 0c1.8-11.9-14.9-20.4-34.3-30.3c.3-13.7.2-30.5 0-47.5c8.8-10.2 9-28.1-.2-36.8c.1-21.3.8-38.6 3.3-43.9c8-17.1 20.6-31.9 29.1-47.2c28.7 5.3 59.7 2.9 91.9-4.7l.7 85.5c-7.7 11.3-8 27.7.3 37.8c4.7 29 .6 58.1.8 87.1h58c2.3-15-22.5-23.1-34.6-30.1c0-22.1-3.9-38.8-.4-60.3c5-9.9 5.3-21.5.4-30.8c.9-33 3.3-66 10.7-99c1.6-.6 7.9-3.7 9.3-5.3l10.9 98.4c-5.6 11.9-4.4 27.3 4 36.7c6.6 30.1 4.5 59.5 7.9 89.6l61.2.8c.3-12.3-29.1-20-40.3-25.5c-6.4-21.4-5.7-43.1-6.7-64.9c8-12.1 7.6-28.9-1.1-39.5c.5-38.3 5.5-76.8 18.4-114.6c106.6-5.9 96.2-72 99.3-133.2c1.4-27.24 55.5 1.7 60-11.61c2.4-6.92 3.6-13.89 0-21.84c-8.6-19.29-23.9-20.32-36.7-20.63c-12.3-7.36-22.6-25.96-35.5-26.31zm6.7 19.58c4.9 2.64 3.8 7.47 2.7 10.11c-6.6 1.96-16.3-1.08-20.8-4.59c3.9-2.99 12.2-5.39 18.1-5.52M80.6 302.3c3.05 7.8 5.74 15.6 7.35 23.2c3.22 15.3 4.91 30.7 5.72 46.2c-7.48 10.3-7.78 26.1.59 35c-.25 21.6-1.3 43.2-1.52 64.7c-4.54-7.5-12.92-14-24.94-17.1c.16-14.4-.44-32.4-1.08-50.6c6.91-10.2 7.01-25.6-1.11-34.3c-.67-27-.34-49.4 3.78-54.1c3.95-4.5 7.67-8.8 11.21-13" />
      </g>
      <g id="palmyra-wordmark-text" fill="#9660D6" fill-rule="evenodd" transform="translate(292 58) scale(1 1.077)">
        <path d="M0 130V0H40C67 0 82 16 82 43C82 69 66 85 41 85H26V130ZM26 24V63H39C51 63 58 56 58 43C58 31 51 24 39 24Z" />
        <path transform="translate(94)" d="M0 130L36 0H64L100 130H74L66 105H36L28 130ZM34 83H66L50 34Z" />
        <path transform="translate(200)" d="M0 0H26V109H66V132H0Z" />
        <path transform="translate(274)" d="M0 132V0H27L55 60L83 0H108V132H84V49L63 93H47L26 49V132Z" />
        <path transform="translate(390)" d="M0 0H29L49 49L69 0H96L61 77V132H37V77Z" />
        <path transform="translate(494)" d="M0 132V0H40C67 0 82 16 82 43C82 62 73 75 58 81L88 132H60L34 86H26V132ZM26 24V63H39C51 63 58 56 58 43C58 31 51 24 39 24Z" />
        <path transform="translate(590)" d="M0 132L36 0H64L100 132H74L66 105H36L28 132ZM34 83H66L50 34Z" />
      </g>
    </svg>
  );
}
