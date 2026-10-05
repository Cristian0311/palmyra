import React from "react";

export function PalmiMascot({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 260 300" role="img" aria-label="Palmi, el camello guía de PALMYRA" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="palmi-fur-3d" x1="25%" y1="0%" x2="82%" y2="100%"><stop offset="0%" stopColor="#F4C58A"/><stop offset="48%" stopColor="#C98A52"/><stop offset="100%" stopColor="#945B37"/></linearGradient>
        <linearGradient id="palmi-purple-3d" x1="15%" y1="0%" x2="90%" y2="100%"><stop offset="0%" stopColor="#9A78F0"/><stop offset="55%" stopColor="#6D3BD2"/><stop offset="100%" stopColor="#4F269F"/></linearGradient>
        <radialGradient id="palmi-face-light" cx="50%" cy="35%" r="72%"><stop offset="0%" stopColor="#FFF9EF"/><stop offset="100%" stopColor="#E7B276"/></radialGradient>
        <filter id="palmi-shadow" x="-35%" y="-30%" width="170%" height="180%"><feDropShadow dx="0" dy="12" stdDeviation="10" floodColor="#23133A" floodOpacity=".24"/></filter>
        <filter id="palmi-glow"><feGaussianBlur stdDeviation="5"/></filter>
      </defs>

      <ellipse cx="130" cy="281" rx="84" ry="12" fill="#291442" opacity=".13" filter="url(#palmi-glow)"/>
      <g filter="url(#palmi-shadow)">
        <path d="M83 104C62 88 42 91 26 112C45 112 58 122 72 140Z" fill="#955B38"/>
        <path d="M177 104C198 88 218 91 234 112C215 112 202 122 188 140Z" fill="#955B38"/>
        <path d="M93 111C96 82 108 59 130 59C152 59 164 82 167 111L178 170C182 207 164 236 130 244C96 236 78 207 82 170Z" fill="url(#palmi-fur-3d)"/>
        <path d="M104 87C107 58 116 40 130 40C144 40 153 58 156 87C148 80 140 76 130 76C120 76 112 80 104 87Z" fill="#B87344"/>
        <path d="M92 136C100 110 113 96 130 96C147 96 160 110 168 136L166 175C163 212 151 232 130 239C109 232 97 212 94 175Z" fill="url(#palmi-face-light)"/>
        <ellipse cx="103" cy="137" rx="27" ry="30" fill="#FFFDF8"/><ellipse cx="157" cy="137" rx="27" ry="30" fill="#FFFDF8"/>
        <ellipse cx="104" cy="141" rx="9" ry="12" fill="#261935"/><ellipse cx="156" cy="141" rx="9" ry="12" fill="#261935"/>
        <circle cx="108" cy="136" r="3.2" fill="#FFF"/><circle cx="160" cy="136" r="3.2" fill="#FFF"/>
        <path d="M86 120C92 109 100 104 109 104" fill="none" stroke="#6A3B2A" strokeWidth="5.4" strokeLinecap="round"/><path d="M174 120C168 109 160 104 151 104" fill="none" stroke="#6A3B2A" strokeWidth="5.4" strokeLinecap="round"/>
        <ellipse cx="130" cy="183" rx="39" ry="31" fill="#E7B17A"/>
        <ellipse cx="117" cy="180" rx="8.5" ry="6.5" fill="#72422E"/><ellipse cx="143" cy="180" rx="8.5" ry="6.5" fill="#72422E"/>
        <path d="M119 199C124 204 136 204 141 199" fill="none" stroke="#6A3729" strokeWidth="3.3" strokeLinecap="round"/>
        <path d="M121 209C126 214 134 214 139 209" fill="none" stroke="#6A3729" strokeWidth="2.4" strokeLinecap="round"/>
        <path d="M96 230C101 246 100 262 97 277" fill="none" stroke="#9B6038" strokeWidth="17" strokeLinecap="round"/><path d="M164 230C159 246 160 262 163 277" fill="none" stroke="#9B6038" strokeWidth="17" strokeLinecap="round"/>
        <path d="M102 245C111 233 120 225 130 224C140 225 149 233 158 245L151 284C142 292 118 292 109 284Z" fill="url(#palmi-purple-3d)"/>
        <path d="M97 227C108 237 119 243 130 246C141 243 152 237 163 227L163 254C150 267 110 267 97 254Z" fill="#7853DA" opacity=".95"/>
        <path d="M112 238L130 245L148 238L145 251L130 258L115 251Z" fill="#CDB9FF" opacity=".45"/>
        <rect x="109" y="263" width="42" height="19" rx="8" fill="#F3ECFF"/><path d="M121 274C124 268 128 268 130 271C132 268 136 268 139 274C136 278 124 278 121 274Z" fill="#6D3BD2"/><path d="M127 269C126 266 127 264 130 264C133 264 134 266 133 269" fill="none" stroke="#6D3BD2" strokeWidth="2" strokeLinecap="round"/>
        <path d="M75 230C56 232 45 242 38 256" fill="none" stroke="#A6673F" strokeWidth="12" strokeLinecap="round"/><path d="M185 230C204 232 215 242 222 256" fill="none" stroke="#A6673F" strokeWidth="12" strokeLinecap="round"/>
        <path d="M39 255L28 264" stroke="#F4C58A" strokeWidth="10" strokeLinecap="round"/><path d="M221 255L232 264" stroke="#F4C58A" strokeWidth="10" strokeLinecap="round"/>
        <circle cx="54" cy="71" r="17" fill="#6D3BD2"/><path d="M47 71L52 76L62 65" fill="none" stroke="#FFF" strokeWidth="3.8" strokeLinecap="round" strokeLinejoin="round"/>
      </g>
      <g className="palmi-mascot-blink"><circle cx="104" cy="141" r="2" fill="#FFF"/><circle cx="156" cy="141" r="2" fill="#FFF"/></g>
    </svg>
  );
}