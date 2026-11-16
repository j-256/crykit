import applicationLicenseUrl from '../../LICENSE?url'
import { APP_TAGLINE } from '../branding'
import { PrivacyTermsLink } from './PrivacyTermsLink'

const SOURCE_URL = 'https://github.com/j-256/crykit'

export function CreditsSection() {
  return <div className="stack">
    <section className="settings-section">
      <h3>Crystal Kit</h3>
      <p>{APP_TAGLINE}, independent of and not endorsed by the game's creators.</p>
      <p>The original application code is available under <a href={applicationLicenseUrl} rel="noreferrer" target="_blank">AGPL-3.0-only</a>. <a href={SOURCE_URL} rel="noreferrer" target="_blank">Browse the source</a> or <a href={`${SOURCE_URL}/issues`} rel="noreferrer" target="_blank">report a problem</a>. Please leave personal backups, imports, and playthrough records out of public reports.</p>
    </section>
    <section className="settings-section">
      <h3>Game data and artwork</h3>
      <p><a href="https://store.steampowered.com/app/1637730/Crystal_Project/" rel="noreferrer" target="_blank">Crystal Project</a> is by Andrew Willman. The game, factual source data, and artwork belong to their respective creators and rights holders. The app's AGPL license does not grant rights to those materials.</p>
      <p>Bundled definitions, mechanics, and artwork come from fingerprinted game records and reviewed implementation evidence. Supplemental guide directions and imported sources retain their own attribution.</p>
      <p>Selected guide text credits the <a href="https://crystal-project.fandom.com/wiki/Crystal_Project_Wiki" rel="noreferrer" target="_blank">Crystal Project Wiki contributors</a> and retains its <a href="https://www.fandom.com/licensing" rel="noreferrer" target="_blank">CC-BY-SA terms</a>. Source controls link to the retained page revisions. Supplemental menu glyphs retain their separate artwork rights and file credits.</p>
      <p><a href={`${SOURCE_URL}/blob/main/docs/catalog-sources.md`} rel="noreferrer" target="_blank">Catalog sources and artwork credits</a> describe extraction, native coverage, and explicit gaps.</p>
    </section>
    <section className="settings-section">
      <h3>Typography and libraries</h3>
      <p><a href="https://www.dafont.com/pixel-operator.font" rel="noreferrer" target="_blank">Pixel Operator</a> is by Jayvee Enaguas (HarvettFox96) and is bundled under <a href={`${import.meta.env.BASE_URL}pixel-operator-CC0.txt`} rel="noreferrer" target="_blank">CC0</a>.</p>
      <p>Built with React, Dexie, Zod, fflate, Tesseract.js, and Lucide. Their licenses remain with their authors; see the bundled <a href={`${import.meta.env.BASE_URL}third-party-licenses.txt`} rel="noreferrer" target="_blank">third-party software licenses</a> and <a href={`${SOURCE_URL}/blob/main/NOTICE.md`} rel="noreferrer" target="_blank">project notices</a>.</p>
    </section>
    <section className="settings-section">
      <h3>Your data and privacy</h3>
      <p>Guest workspaces stay in this browser. Optional accounts can synchronize encrypted workspaces, and hosted sharing publishes only the snapshot you choose. Imports and screenshot recognition run in your browser. Source links open external sites when clicked.</p>
      <p>We collect limited technical information to help keep the site secure, reliable, and responsive. Account and security records support sign-in and abuse protection. Cloudflare performance monitoring, when enabled, helps us identify slow pages and interactions. See the <PrivacyTermsLink/> for the information collected and its limits.</p>
      <p>Before clearing browser storage or changing devices or site addresses, export a planner backup and download Mod Inspector files separately. Browser data can be cleared or evicted; offline caching is not a backup. New browsers start with labeled sample records.</p>
    </section>
  </div>
}
