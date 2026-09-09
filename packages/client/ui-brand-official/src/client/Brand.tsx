import css from './Brand.module.css'

/** Render the compact MIP Autolabeling sidebar wordmark. */
export function MipAutolabelingName() {
  return (
    <span className={css.wordmark} data-brand-name="mip-autolabeling">
      <span className={css.initialism}>MIP</span>
      <span className={css.product}>Autolabeling</span>
    </span>
  )
}
