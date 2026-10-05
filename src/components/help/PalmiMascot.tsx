import React from "react";

export function PalmiMascot({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 280 320" role="img" aria-label="Sira, guía inteligente de PALMYRA" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sira-fur" x1="15%" y1="5%" x2="85%" y2="100%"><stop offset="0" stopColor="#F6D09B"/><stop offset=".52" stopColor="#C9874D"/><stop offset="1" stopColor="#87502F"/></linearGradient>
        <linearGradient id="sira-muzzle" x1="25%" y1="15%" x2="80%" y2="90%"><stop offset="0" stopColor="#FFF8EA"/><stop offset="1" stopColor="#E8B477"/></linearGradient>
        <linearGradient id="sira-scarf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#B49AFF"/><stop offset=".55" stopColor="#6D3BD2"/><stop offset="1" stopColor="#47208F"/></linearGradient>
        <radialGradient id="sira-cheek"><stop offset="0" stopColor="#F0A37C" stopOpacity=".6"/><stop offset="1" stopColor="#F0A37C" stopOpacity="0"/></radialGradient>
        <filter id="sira-shadow" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="13" stdDeviation="10" floodColor="#2B1840" floodOpacity=".22"/></filter>
      </defs>

      <ellipse cx="142" cy="299" rx="88" ry="12" fill="#2B1840" opacity=".12"/>
      <g filter="url(#sira-shadow)">
        <!-- distinctive camel silhouette -->
        <path d="M93 118C72 99 48 101 29 121C49 121 65 131 77 151L96 158Z" fill="#8F5634"/>
        <path d="M190 112C213 94 238 100 251 122C232 120 216 131 204 151L185 157Z" fill="#8F5634"/>
        <path d="M111 118C108 82 118 52 139 45C161 52 172 83 168 119L183 178C188 223 170 254 139 262C108 254 90 223 95 178Z" fill="url(#sira-fur)"/>
        <!-- crown tuft -->
        <path d="M114 92C117 57 127 34 140 34C153 34 163 57 166 92C157 83 149 78 140 78C131 78 123 83 114 92Z" fill="#AA673D"/>
        <path d="M98 143C106 112 121 97 140 97C159 97 174 112 182 143L177 191C173 227 159 248 140 255C121 248 107 227 103 191Z" fill="url(#sira-muzzle)"/>
        <!-- eyes -->
        <ellipse cx="112" cy="144" rx="27" ry="31" fill="#FFFDF9"/>
        <ellipse cx="166" cy="140" rx="26" ry="30" fill="#FFFDF9"/>
        <ellipse cx="116" cy="147" rx="9" ry="13" fill="#24152F"/>
        <ellipse cx="169" cy="143" rx="9" ry="12" fill="#24152F"/>
        <circle cx="120" cy="142" r="3.5" fill="#FFF"/>
        <circle cx="173" cy="138" r="3.3" fill="#FFF"/>
        <path d="M94 123C100 112 108 107 118 107" fill="none" stroke="#673A2B" strokeWidth="5.5" strokeLinecap="round"/>
        <path d="M185 120C178 109 169 105 160 105" fill="none" stroke="#673A2B" strokeWidth="5.5" strokeLinecap="round"/>
        <!-- cheeks and friendly muzzle -->
        <circle cx="103" cy="180" r="18" fill="url(#sira-cheek)"/>
        <circle cx="177" cy="176" r="17" fill="url(#sira-cheek)"/>
        <ellipse cx="140" cy="190" rx="42" ry="33" fill="#E5AD73"/>
        <ellipse cx="126" cy="188" rx="8.5" ry="6.5" fill="#6B3B2A"/>
        <ellipse cx="154" cy="187" rx="8.5" ry="6.5" fill="#6B3B2A"/>
        <path d="M128 207C135 213 145 213 152 207" fill="none" stroke="#663426" strokeWidth="3.2" strokeLinecap="round"/>
        <path d="M132 217C137 221 143 221 148 217" fill="none" stroke="#663426" strokeWidth="2.2" strokeLinecap="round"/>
        <!-- body + branded scarf -->
        <path d="M101 232C109 250 119 263 140 266C161 263 171 250 179 232L194 286C179 301 101 301 86 286Z" fill="url(#sira-scarf)"/>
        <path d="M91 238C106 248 123 255 140 258C157 255 174 248 189 238L184 264C169 276 111 276 96 264Z" fill="#805BE0"/>
        <path d="M111 247L140 259L169 247L164 263L140 271L116 263Z" fill="#D8CAFF" opacity=".5"/>
        <!-- compass badge -->
        <circle cx="140" cy="284" r="13" fill="#F8F3FF"/>
        <circle cx="140" cy="284" r="9" fill="none" stroke="#6D3BD2" strokeWidth="2"/>
        <path d="M140 277L144 285L140 292L136 285Z" fill="#6D3BD2"/>
        <!-- arms -->
        <path d="M86 241C65 242 51 253 43 268" fill="none" stroke="#9B6038" strokeWidth="13" strokeLinecap="round"/>
        <path d="M194 241C215 242 229 253 237 268" fill="none" stroke="#9B6038" strokeWidth="13" strokeLinecap="round"/>
        <path d="M44 268L32 277" stroke="#F2C38B" strokeWidth="10" strokeLinecap="round"/>
        <path d="M236 268L248 277" stroke="#F2C38B" strokeWidth="10" strokeLinecap="round"/>
        <!-- guide spark -->
        <circle cx="58" cy="75" r="18" fill="#6D3BD2"/>
        <path d="M49 75L55 81L67 68" fill="none" stroke="#FFF" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
      </g>
    </svg>
  );
}
