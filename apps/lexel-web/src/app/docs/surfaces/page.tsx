import type { Metadata } from 'next';
import { DocsShell } from '@/components/DocsShell';
import { SITE_SURFACES } from '@/lib/siteData';

export const metadata: Metadata = {
  title: 'Writing Surfaces',
  description:
    'Complete reference of Lexel built-in writing surfaces from ml/personas/surfaces.json, including character limits, link and emoji policies, and banned openers.',
};

export default function DocsSurfacesPage() {
  return (
    <DocsShell
      title="Writing Surfaces"
      description="Lexel ships 13 canonical surface profiles in ml/personas/surfaces.json, consumed identically by Rust (lexel-core), WebAssembly, TypeScript, and the ML training crucible."
    >
      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Automatic surface detection
        </h2>
        <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
          In the browser extension, Lexel matches hostname and path patterns (for example{' '}
          <code className="lx-inline-code">reddit.com/r/&lt;subreddit&gt;</code> or{' '}
          <code className="lx-inline-code">github.com/&lt;owner&gt;/&lt;repo&gt;/pull/*</code>) and
          activates the matching Tier 0 rules immediately without loading any AI model. In editors,{' '}
          <code className="lx-inline-code">lexel-ls</code> maps LSP language IDs (such as{' '}
          <code className="lx-inline-code">git-commit</code>,{' '}
          <code className="lx-inline-code">rust</code>,{' '}
          <code className="lx-inline-code">typescript</code>, and{' '}
          <code className="lx-inline-code">markdown</code>) to developer surfaces automatically.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Built-in surface matrix ({SITE_SURFACES.length} profiles)
        </h2>

        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable table region requires keyboard focus per WCAG 2.1.1 */}
        <section tabIndex={0} aria-labelledby="surfaces-table-caption" className="lx-table-region">
          <table className="lx-table">
            <caption
              id="surfaces-table-caption"
              className="border-b px-4 py-3 text-left text-xs font-medium"
              style={{
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg-muted)',
              }}
            >
              Canonical surface policies loaded from ml/personas/surfaces.json
            </caption>
            <thead>
              <tr>
                <th scope="col">Surface</th>
                <th scope="col">ID</th>
                <th scope="col">Max</th>
                <th scope="col">Policies</th>
                <th scope="col">Detection Signal</th>
              </tr>
            </thead>
            <tbody>
              {SITE_SURFACES.map((surface) => (
                <tr key={surface.id}>
                  <th scope="row">
                    <div>{surface.label}</div>
                    <div
                      className="lexel-mono text-[11px] font-normal"
                      style={{ color: 'var(--lx-fg-muted)' }}
                    >
                      {surface.register}
                    </div>
                  </th>
                  <td data-label="ID">
                    <code className="lx-inline-code text-xs">{surface.id}</code>
                  </td>
                  <td data-label="Max Chars" className="lexel-mono text-xs">
                    {surface.maxChars}
                  </td>
                  <td data-label="Policies" className="lexel-mono text-xs">
                    {surface.allowLinks ? 'Links' : 'No links'},{' '}
                    {surface.allowEmojis ? 'Emoji' : 'No emoji'},{' '}
                    {surface.allowEmDashes ? 'Em dash' : 'No em dash'}
                  </td>
                  <td data-label="Detection" className="lexel-mono text-xs break-words">
                    {surface.hostPatterns.length > 0
                      ? surface.hostPatterns.join(', ')
                      : 'LSP language ID'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </section>

      <section className="space-y-3">
        <h2 className="m-0 text-xl font-semibold" style={{ color: 'var(--lx-fg)' }}>
          Customizing surfaces
        </h2>
        <p className="m-0" style={{ color: 'var(--lx-fg-muted)' }}>
          Every built-in surface can be tuned in Lexel Desktop (character limits, link/emoji/hashtag
          policies, and prompt directive) and synced into{' '}
          <code className="lx-inline-code">lexel.db</code>. When a built-in surface matches its
          default values again, its override entry is cleared cleanly.
        </p>
      </section>
    </DocsShell>
  );
}
