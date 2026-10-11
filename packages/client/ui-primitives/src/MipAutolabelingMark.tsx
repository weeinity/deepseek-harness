import type { IconProps } from './icons/props.ts'

/**
 * Render the MIP Autolabeling mark with its fixed brand palette.
 * @param props - square size and optional layout class.
 * @returns a decorative applied-label SVG.
 */
export function MipAutolabelingMark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 512 512"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-brand="mip-autolabeling"
    >
      <path
        d="M 256 52 H 96 A 44 44 0 0 0 52 96 V 256 L 226 430 a 42 42 0 0 0 60 0 L 430 286 a 42 42 0 0 0 0 -60 Z
           M 148.3 209.7 L 194 255.5 L 307.7 141.7 L 340.3 174.3 L 194 320.5 L 115.7 242.3 Z"
        fill="#0F6CBD"
        fillRule="evenodd"
      />
      <path
        d="M 410 42 Q 410 100 468 100 Q 410 100 410 158 Q 410 100 352 100 Q 410 100 410 42 Z"
        fill="#FFC53D"
      />
    </svg>
  )
}
