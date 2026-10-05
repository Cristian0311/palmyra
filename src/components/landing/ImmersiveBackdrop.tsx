export function ImmersiveBackdrop({ dark = false }: { dark?: boolean }) {
  return (
    <div className={"landing-backdrop" + (dark ? " landing-backdrop--dark" : "")} aria-hidden="true">
      <div className="landing-backdrop__grid" />
      <div className="landing-backdrop__orb landing-backdrop__orb--one" />
      <div className="landing-backdrop__orb landing-backdrop__orb--two" />
      <div className="landing-backdrop__line landing-backdrop__line--one" />
      <div className="landing-backdrop__line landing-backdrop__line--two" />
    </div>
  );
}
