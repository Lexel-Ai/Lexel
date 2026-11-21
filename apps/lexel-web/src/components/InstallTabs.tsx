'use client';

import { useRef, useState } from 'react';
import { INSTALL_TABS, RELEASES_URL } from '@/lib/siteData';
import { CodeCopyBlock } from './CodeCopyBlock';

export function InstallTabs() {
  const [activeId, setActiveId] = useState<string>(INSTALL_TABS[0].id);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    let nextIdx = idx;
    if (event.key === 'ArrowRight') {
      nextIdx = (idx + 1) % INSTALL_TABS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIdx = (idx - 1 + INSTALL_TABS.length) % INSTALL_TABS.length;
    } else if (event.key === 'Home') {
      nextIdx = 0;
    } else if (event.key === 'End') {
      nextIdx = INSTALL_TABS.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextTab = INSTALL_TABS[nextIdx];
    setActiveId(nextTab.id);
    tabRefs.current[nextIdx]?.focus();
  };

  return (
    <div
      className="rounded-[8px] border"
      style={{
        backgroundColor: 'var(--lx-card)',
        borderColor: 'var(--lx-border)',
      }}
    >
      <div role="tablist" aria-label="Install platforms" className="lx-tablist px-3 pt-1">
        {INSTALL_TABS.map((tab, idx) => {
          const selected = tab.id === activeId;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[idx] = el;
              }}
              type="button"
              role="tab"
              id={`install-tab-${tab.id}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveId(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, idx)}
              className="lx-tab"
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div>
        {INSTALL_TABS.map((tab) => {
          const selected = tab.id === activeId;
          return (
            <div
              key={tab.id}
              role="tabpanel"
              aria-labelledby={`install-tab-${tab.id}`}
              hidden={!selected}
              tabIndex={selected ? 0 : undefined}
            >
              <div className="space-y-4 p-4 sm:p-6">
                <p className="m-0 text-sm" style={{ color: 'var(--lx-fg-muted)' }}>
                  {tab.summary}
                </p>

                <CodeCopyBlock
                  code={tab.command}
                  label={`${tab.label} install command`}
                  languageLabel={tab.id === 'windows' ? 'powershell' : 'bash'}
                />

                {tab.secondaryCommand ? (
                  <div className="space-y-1.5">
                    <p className="m-0 text-xs font-medium" style={{ color: 'var(--lx-fg-muted)' }}>
                      {tab.secondaryLabel}
                    </p>
                    <CodeCopyBlock
                      code={tab.secondaryCommand}
                      label={`${tab.label} install with models command`}
                      languageLabel="bash"
                    />
                  </div>
                ) : null}

                <ul
                  className="m-0 space-y-1.5 pl-5 text-sm"
                  style={{ color: 'var(--lx-fg-muted)' }}
                >
                  {tab.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>

                {tab.id === 'releases' ? (
                  <div className="pt-1">
                    <a
                      href={RELEASES_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="lx-web-btn-secondary"
                    >
                      Open GitHub Releases
                    </a>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
