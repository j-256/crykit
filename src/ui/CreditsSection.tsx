import applicationLicenseUrl from '../../LICENSE?url'

const SOURCE_URL = 'https://github.com/j-256/crystal-companion'

export function CreditsSection() {
  return <div className="stack">
    <section className="settings-section">
      <h3>Crystal Companion</h3>
      <p>An unofficial fan planner for Crystal Project. This project is independent of the game's creators and is not endorsed by them.</p>
      <p>The original application code is available under <a href={applicationLicenseUrl} rel="noreferrer" target="_blank">AGPL-3.0-only</a>. <a href={SOURCE_URL} rel="noreferrer" target="_blank">Browse the source</a> or <a href={`${SOURCE_URL}/issues`} rel="noreferrer" target="_blank">report a problem</a>. Please leave personal backups, imports, and playthrough records out of public reports.</p>
    </section>
    <section className="settings-section">
      <h3>Game artwork and community reference</h3>
      <p><a href="https://store.steampowered.com/app/1637730/Crystal_Project/" rel="noreferrer" target="_blank">Crystal Project</a> is by Andrew Willman. The game and its artwork belong to their respective creators and rights holders. Crystal Companion did not create the game sprites, crystal artwork, or wiki images. These assets are credited separately and are not licensed under the application's AGPL license.</p>
      <p>Thanks to the <a href="https://crystal-project.fandom.com/wiki/Crystal_Project_Wiki" rel="noreferrer" target="_blank">Crystal Project Wiki contributors</a> for the community reference and file documentation. Wiki-derived text retains its <a href="https://www.fandom.com/licensing" rel="noreferrer" target="_blank">CC-BY-SA terms</a>. Artwork has separate rights; the wiki's Fairuse labels describe its use of copyrighted material, not an open license.</p>
      <p>Reference details link to each entry's source revisions and artwork file pages. <a href={`${SOURCE_URL}/blob/main/docs/catalog-sources.md`} rel="noreferrer" target="_blank">Catalog sources and artwork credits</a> also document the Archipelago identity tables, mod references, Crystal Edit class exports, and modding guide, along with their known gaps.</p>
    </section>
    <section className="settings-section">
      <h3>Typography and libraries</h3>
      <p><a href="https://www.dafont.com/pixel-operator.font" rel="noreferrer" target="_blank">Pixel Operator</a> is by Jayvee Enaguas (HarvettFox96) and is bundled under <a href={`${import.meta.env.BASE_URL}pixel-operator-CC0.txt`} rel="noreferrer" target="_blank">CC0</a>.</p>
      <p>Built with React, Dexie, Zod, fflate, Tesseract.js, and Lucide. Their licenses remain with their authors; see the bundled <a href={`${import.meta.env.BASE_URL}third-party-licenses.txt`} rel="noreferrer" target="_blank">third-party software licenses</a> and <a href={`${SOURCE_URL}/blob/main/NOTICE.md`} rel="noreferrer" target="_blank">project notices</a>.</p>
    </section>
    <section className="settings-section">
      <h3>Your data stays in this browser</h3>
      <p>There is no account, telemetry, or cloud sync. Imports and screenshot recognition run locally. The hosting provider receives ordinary requests for app files, but personal records and imported files are not uploaded. Source links open external sites only when you follow them.</p>
      <p>Export a backup before clearing browser storage or moving to another device or address. Browser storage can be cleared or evicted; offline caching is not a backup. A first visit contains labeled synthetic sample records.</p>
    </section>
  </div>
}
