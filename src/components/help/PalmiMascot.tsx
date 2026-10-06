import React from "react";

/** Numa: mascota vectorial propia de PALMYRA. Mantenerla en SVG evita dependencias externas y conserva nitidez en cualquier DPI. */
export type NumaMood = "idle" | "thinking" | "waiting" | "success" | "alert";

export function PalmiMascot({ className = "", mood = "idle" }: { className?: string; mood?: NumaMood }) {
  return (
    <svg className={`${className} numa-mascot numa-mood-${mood}`} viewBox="0 0 280 320" role="img" aria-label="Numa, el camello guía de PALMYRA" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="numa-halo" cx="50%" cy="35%" r="70%"><stop offset="0%" stopColor="#F4ECFF"/><stop offset="72%" stopColor="#E8D9FF"/><stop offset="100%" stopColor="#D8C4FA"/></radialGradient>
        <linearGradient id="numa-fur" x1="18%" y1="0%" x2="82%" y2="100%"><stop offset="0%" stopColor="#FFD39B"/><stop offset="38%" stopColor="#E8A96C"/><stop offset="72%" stopColor="#C77D4B"/><stop offset="100%" stopColor="#9D5A38"/></linearGradient>
        <radialGradient id="numa-face" cx="45%" cy="24%" r="82%"><stop offset="0%" stopColor="#FFFDF6"/><stop offset="65%" stopColor="#F0C38C"/><stop offset="100%" stopColor="#D58E55"/></radialGradient>
        <linearGradient id="numa-scarf" x1="10%" y1="0%" x2="90%" y2="100%"><stop offset="0%" stopColor="#A482F3"/><stop offset="45%" stopColor="#7443DA"/><stop offset="100%" stopColor="#5224A8"/></linearGradient>
        <linearGradient id="numa-patch" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#F7EEFF"/><stop offset="100%" stopColor="#E1CEFF"/></linearGradient>
        <filter id="numa-shadow" x="-35%" y="-30%" width="170%" height="185%"><feDropShadow dx="0" dy="14" stdDeviation="11" floodColor="#241235" floodOpacity=".24"/></filter>
        <filter id="numa-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7"/></filter>
      </defs>

      <ellipse cx="140" cy="299" rx="91" ry="12" fill="#2B1745" opacity=".12" filter="url(#numa-glow)"/>
      <circle cx="140" cy="142" r="122" fill="url(#numa-halo)"/>
      <circle cx="140" cy="142" r="111" fill="none" stroke="#7A50DD" strokeWidth="1.5" strokeDasharray="2 9" opacity=".22"/>

      <g className="numa-mascot-body" filter="url(#numa-shadow)">
        <path d="M89 111C66 94 45 97 27 119C49 118 62 129 77 147Z" fill="#9C5D3A"/>
        <path d="M191 111C214 94 235 97 253 119C231 118 218 129 203 147Z" fill="#9C5D3A"/>
        <path d="M100 116C103 82 117 55 140 55C163 55 177 82 180 116L191 176C195 219 174 250 140 258C106 250 85 219 89 176Z" fill="url(#numa-fur)"/>
        <path d="M111 94C113 61 124 35 140 35C156 35 167 61 169 94C160 86 151 82 140 82C129 82 120 86 111 94Z" fill="#B97245"/>
        <path d="M99 141C106 113 121 97 140 97C159 97 174 113 181 141L179 184C176 224 160 244 140 251C120 244 104 224 101 184Z" fill="url(#numa-face)"/>

        <ellipse cx="111" cy="139" rx="29" ry="32" fill="#FFFEFA"/>
        <ellipse cx="169" cy="139" rx="29" ry="32" fill="#FFFEFA"/>
        <ellipse cx="112" cy="144" rx="10" ry="13" fill="#251733"/>
        <ellipse cx="168" cy="144" rx="10" ry="13" fill="#251733"/>
        <ellipse cx="114" cy="142" rx="2.3" ry="3.2" fill="#FFF"/>
        <ellipse cx="170" cy="142" rx="2.3" ry="3.2" fill="#FFF"/>

        <path d="M92 121C99 110 107 105 118 105" fill="none" stroke="#6E3B2B" strokeWidth="5.8" strokeLinecap="round"/>
        <path d="M188 121C181 110 173 105 162 105" fill="none" stroke="#6E3B2B" strokeWidth="5.8" strokeLinecap="round"/>
        <path d="M91 164C100 171 104 172 109 174" fill="none" stroke="#D9915F" strokeWidth="3.5" strokeLinecap="round" opacity=".7"/>
        <path d="M189 164C180 171 176 172 171 174" fill="none" stroke="#D9915F" strokeWidth="3.5" strokeLinecap="round" opacity=".7"/>

        <ellipse cx="140" cy="189" rx="41" ry="32" fill="#EAB47E"/>
        <ellipse cx="126" cy="186" rx="9" ry="7" fill="#74422F"/>
        <ellipse cx="154" cy="186" rx="9" ry="7" fill="#74422F"/>
        <path d="M126 207C133 214 147 214 154 207" fill="none" stroke="#6B382A" strokeWidth="3.2" strokeLinecap="round"/>
        <path d="M130 217C136 222 144 222 150 217" fill="none" stroke="#7A4330" strokeWidth="2.2" strokeLinecap="round"/>
        <circle cx="107" cy="198" r="5" fill="#E89291" opacity=".24"/><circle cx="173" cy="198" r="5" fill="#E89291" opacity=".24"/>

        <path d="M104 244C109 260 108 276 105 292" fill="none" stroke="#A7643E" strokeWidth="18" strokeLinecap="round"/>
        <path d="M176 244C171 260 172 276 175 292" fill="none" stroke="#A7643E" strokeWidth="18" strokeLinecap="round"/>
        <path d="M112 257C122 242 132 235 140 235C148 235 158 242 168 257L160 299C148 307 132 307 120 299Z" fill="url(#numa-fur)"/>

        <path d="M103 240C114 248 125 254 140 257C155 254 166 248 177 240L173 271C160 283 120 283 107 271Z" fill="url(#numa-scarf)"/>
        <path d="M117 249L140 258L163 249L157 264L140 272L123 264Z" fill="#D9C7FF" opacity=".48"/>
        <path d="M124 258L140 265L156 258V275C149 281 131 281 124 275Z" fill="#4D209B" opacity=".9"/>

        <rect x="119" y="272" width="42" height="20" rx="8" fill="url(#numa-patch)"/>
        <path d="M140 277L144 284L152 285L146 290L148 297L140 293L132 297L134 290L128 285L136 284Z" fill="#6D3BD2"/>

        <path d="M81 236C59 240 48 251 40 267" fill="none" stroke="#A56740" strokeWidth="13" strokeLinecap="round"/>
        <path d="M199 236C221 240 232 251 240 267" fill="none" stroke="#A56740" strokeWidth="13" strokeLinecap="round"/>
        <path d="M42 266L31 275" stroke="#FFD39B" strokeWidth="10" strokeLinecap="round"/><path d="M238 266L249 275" stroke="#FFD39B" strokeWidth="10" strokeLinecap="round"/>

        <circle cx="57" cy="76" r="18" fill="#6D3BD2"/>
        <path d="M50 76H64M57 69V83" stroke="#FFF" strokeWidth="3.2" strokeLinecap="round"/>
      </g>

      <g className="palmi-mascot-blink"><circle cx="112" cy="145" r="2.2" fill="#FFF"/><circle cx="168" cy="145" r="2.2" fill="#FFF"/></g>
      {mood === "success" ? <path d="M118 221C128 231 152 231 162 221" fill="none" stroke="#6D3BD2" strokeWidth="3.4" strokeLinecap="round"/> : null}
      {mood === "alert" ? <path d="M119 218C130 210 150 210 161 218" fill="none" stroke="#6D3BD2" strokeWidth="3.2" strokeLinecap="round"/> : null}
    </svg>
  );
}