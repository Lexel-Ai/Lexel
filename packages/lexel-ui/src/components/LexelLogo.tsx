interface LexelLogoProps {
  className?: string;
  src?: string;
  alt?: string;
}

/**
 * Official Lexel mark. The source asset is `assets/brand/lexel-logo.svg`.
 * Use `h-* w-auto` classes so the 845:715 aspect ratio is preserved.
 */
export function LexelLogo({
  className = 'h-6 w-auto',
  src = '/lexel-logo.svg',
  alt = '',
}: LexelLogoProps) {
  return (
    <img src={src} alt={alt} className={className} width={845} height={715} draggable={false} />
  );
}
