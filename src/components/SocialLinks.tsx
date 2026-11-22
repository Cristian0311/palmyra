import { useEffect, useState } from "react";
import {
  DEFAULT_FACEBOOK_URL,
  loadPublicSocialLinks,
  type PlatformSocialLinks,
} from "../services/platformSupport";

// Canal oficial. Se usa si la consulta a la plataforma falla para que el acceso
// no desaparezca por un problema de red.
export const DEFAULT_WHATSAPP_CHANNEL_URL =
  "https://whatsapp.com/channel/0029VbDo1KhAO7R97o0gPZ0S";

const FALLBACK_LINKS: PlatformSocialLinks = {
  facebook_url: DEFAULT_FACEBOOK_URL,
  whatsapp_channel_url: DEFAULT_WHATSAPP_CHANNEL_URL,
};

type SocialLinksProps = {
  variant?: "footer" | "sidebar";
  className?: string;
};

export function SocialLinks({ variant = "footer", className = "" }: SocialLinksProps) {
  const [links, setLinks] = useState<PlatformSocialLinks>(FALLBACK_LINKS);

  useEffect(() => {
    let alive = true;
    loadPublicSocialLinks()
      .then((loaded) => {
        if (!alive) return;
        setLinks({
          facebook_url: loaded.facebook_url || DEFAULT_FACEBOOK_URL,
          whatsapp_channel_url: loaded.whatsapp_channel_url || DEFAULT_WHATSAPP_CHANNEL_URL,
        });
      })
      .catch(() => {
        /* Los enlaces por defecto siguen visibles. */
      });
    return () => {
      alive = false;
    };
  }, []);

  const compact = variant === "sidebar";
  const wrapClass = compact
    ? `mt-1.5 grid grid-cols-2 gap-1 ${className}`
    : `flex shrink-0 items-center gap-2 ${className}`;
  const itemClass = compact
    ? "inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded-lg border border-base bg-subtle px-1.5 text-[6.5px] font-black uppercase tracking-wide text-primary transition-colors hover:border-[#6535C5]/40 active:scale-[.98]"
    : "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-violet-200 bg-white px-3 text-[10px] font-black text-[#5B2DBA] transition-colors hover:border-[#5B2DBA]/50 active:scale-[.98]";
  const iconClass = compact ? "h-3 w-3 shrink-0" : "h-4 w-4 shrink-0";

  return (
    <div className={wrapClass} aria-label="Canales oficiales de PALMYRA">
      <a
        href={links.facebook_url}
        target="_blank"
        rel="noopener noreferrer"
        className={itemClass}
        title="Página de Facebook de PALMYRA"
      >
        <FacebookMark className={iconClass} />
        <span className="truncate">Facebook</span>
      </a>
      <a
        href={links.whatsapp_channel_url || DEFAULT_WHATSAPP_CHANNEL_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={itemClass}
        title="Canal de WhatsApp de PALMYRA"
      >
        <WhatsAppMark className={iconClass} />
        <span className="truncate">WhatsApp</span>
      </a>
    </div>
  );
}

export function FacebookMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        d="M13.7 21v-7h2.4l.4-2.8h-2.8V9.4c0-.8.2-1.4 1.5-1.4h1.6V5.5c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.4-3.7 3.8v2H8.5V14H11v7h2.7Z"
      />
    </svg>
  );
}

export function WhatsAppMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        d="M12 3.1a8.8 8.8 0 0 0-7.6 13.3L3.1 21l4.8-1.2A8.9 8.9 0 1 0 12 3.1Zm0 1.8a7.1 7.1 0 0 1 6.1 10.8 7 7 0 0 1-8.1 3.1l-.5-.2-2.8.7.8-2.7-.3-.5A7.1 7.1 0 0 1 12 4.9Zm-3.2 2.9c-.2 0-.5.1-.7.4-.2.3-.8.8-.8 2 0 1.2.8 2.3.9 2.5.1.2 1.7 2.8 4.3 3.8 2.1.8 2.5.6 2.9.6.4 0 1.3-.5 1.5-1 .2-.5.2-.9.1-1-.1-.1-.3-.2-.7-.4l-.9-.4c-.4-.1-.6-.2-.8.2-.2.3-.6.8-.7 1-.1.2-.3.2-.6.1-.3-.1-1.1-.4-2-1.2-.7-.6-1.2-1.4-1.3-1.6-.1-.2 0-.3.1-.5l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.7-1.6c-.2-.4-.5-.5-.8-.5Z"
      />
    </svg>
  );
}
