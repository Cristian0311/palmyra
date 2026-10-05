import React from "react";

export function PalmiMascot({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 180 180" role="img" aria-label="Palmi, el camello guía de PALMYRA" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="palmi-fur" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#D9A86C"/><stop offset="100%" stopColor="#A8673C"/></linearGradient>
        <linearGradient id="palmi-muzzle" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#F4D5A9"/><stop offset="100%" stopColor="#D9A67A"/></linearGradient>
        <filter id="palmi-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="#1E123B" floodOpacity=".18"/></filter>
      </defs>
      <g filter="url(#palmi-shadow)">
        <circle cx="90" cy="90" r="78" fill="#F7F3FF"/>
        <circle cx="90" cy="90" r="72" fill="none" stroke="#6D3BD2" strokeWidth="2.5" strokeDasharray="2 7" opacity=".24"/>
        <path d="M55 66C44 58 34 58 27 65C37 70 43 79 53 88Z" fill="#A8673C"/>
        <path d="M125 66C136 58 146 58 153 65C143 70 137 79 127 88Z" fill="#A8673C"/>
        <path d="M57 61C61 42 74 30 90 30C106 30 119 42 123 61L127 92C128 120 115 145 90 151C65 145 52 120 53 92Z" fill="url(#palmi-fur)"/>
        <path d="M74 42C76 30 82 22 90 22C98 22 104 30 106 42C101 39 96 38 90 38C84 38 79 39 74 42Z" fill="#B97745"/>
        <ellipse cx="72" cy="83" rx="13" ry="16" fill="#FAF7F2"/><ellipse cx="108" cy="83" rx="13" ry="16" fill="#FAF7F2"/>
        <ellipse cx="72" cy="84" rx="5" ry="7" fill="#2A183C"/><ellipse cx="108" cy="84" rx="5" ry="7" fill="#2A183C"/>
        <circle cx="74" cy="81" r="1.8" fill="#fff"/><circle cx="110" cy="81" r="1.8" fill="#fff"/>
        <path d="M62 70C66 64 72 61 79 62M118 70C114 64 108 61 101 62" fill="none" stroke="#6A3B28" strokeWidth="3.5" strokeLinecap="round" opacity=".7"/>
        <path d="M68 112C71 104 78 99 90 99C102 99 109 104 112 112C109 126 101 134 90 136C79 134 71 126 68 112Z" fill="url(#palmi-muzzle)"/>
        <ellipse cx="82" cy="112" rx="5" ry="4" fill="#7C4B32"/><ellipse cx="98" cy="112" rx="5" ry="4" fill="#7C4B32"/>
        <path d="M83 122C86 125 94 125 97 122M84 129C88 132 92 132 96 129" fill="none" stroke="#6B3B2A" strokeWidth="2.4" strokeLinecap="round"/>
        <path d="M64 121C56 123 49 128 44 135M116 121C124 123 131 128 136 135" fill="none" stroke="#A8673C" strokeWidth="7" strokeLinecap="round"/>
        <circle cx="142" cy="45" r="11" fill="#6D3BD2"/><path d="M137 45L141 49L148 40" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/>
      </g>
      <g className="palmi-mascot-blink"><circle cx="72" cy="84" r="1.2" fill="#fff"/><circle cx="108" cy="84" r="1.2" fill="#fff"/></g>
    </svg>
  );
}
