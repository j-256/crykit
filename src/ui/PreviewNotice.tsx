import './preview-notice.css'

export function PreviewNotice() {
  const revision = document.querySelector<HTMLMetaElement>('meta[name="crykit-preview"]')?.content
  if (!revision) return null
  return <aside aria-label="Preview build" className="preview-notice"><strong>Preview</strong><span>Experimental drafts. Data saved here stays separate from the main site.</span><a href="https://crykit.lasers.app/">Main site</a><small>Revision {revision}</small></aside>
}
