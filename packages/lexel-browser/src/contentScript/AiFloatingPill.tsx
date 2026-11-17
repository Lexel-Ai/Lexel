import React, { useEffect, useState } from 'react';
import { CloseIcon, NibIcon, PanelIcon, RewriteDiffCard, SurfaceBadge } from 'lexel-ui';
import { getSurfaceProfile } from '../shared/surfaceDetector';
import type { AiTaskId, DetectedSurfaceContext, RewriteResult } from '../shared/types';
import ProtocolClient from './ProtocolClient';

export interface ActiveFieldHandle {
  element: HTMLElement;
  readText: () => string;
  writeText: (nextText: string) => void;
  readThreadContext: () => string;
}

export interface AiFloatingPillProps {
  field: ActiveFieldHandle | null;
  context: DetectedSurfaceContext;
  theme: 'dark' | 'light';
  aiEnabled: boolean;
  openSignal: number;
}

export function AiFloatingPill({
  field,
  context,
  theme,
  aiEnabled,
  openSignal,
}: AiFloatingPillProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RewriteResult | null>(null);
  const [lastTask, setLastTask] = useState<AiTaskId>('rewrite_surface');
  const [copied, setCopied] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; visible: boolean }>({
    top: 0,
    left: 0,
    visible: false,
  });

  const profile = getSurfaceProfile(context.surfaceId);

  useEffect(() => {
    if (openSignal > 0 && field && !context.isBlocked) {
      setExpanded(true);
    }
  }, [openSignal, field, context.isBlocked]);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [field?.element]);

  useEffect(() => {
    if (!field || context.isBlocked) {
      setCoords((prev) => ({ ...prev, visible: false }));
      return;
    }

    const updatePosition = () => {
      const rect = field.element.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 24) {
        setCoords((prev) => ({ ...prev, visible: false }));
        return;
      }
      const panelWidth = expanded ? 360 : 196;
      const left = Math.max(
        12,
        Math.min(window.innerWidth - panelWidth - 12, rect.right - panelWidth),
      );
      const top = Math.max(
        12,
        Math.min(window.innerHeight - (expanded ? 340 : 42), rect.bottom + 6),
      );
      setCoords({ top, left, visible: true });
    };

    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [field, expanded, context.isBlocked]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  if (!aiEnabled || !field || !coords.visible || context.isBlocked) {
    return null;
  }

  const currentText = field.readText();

  async function runTask(task: AiTaskId) {
    if (!field) return;
    const source = field.readText().trim();
    if (!source) {
      setError('Type a few words or rough notes in the field first.');
      return;
    }
    setLastTask(task);
    setLoading(true);
    setError(null);
    setCopied(false);

    const threadContext = task === 'reply_draft' ? field.readThreadContext() : undefined;
    const res = await ProtocolClient.aiRewrite({
      text: source,
      task,
      surfaceId: context.surfaceId,
      subcontext: context.subcontext,
      threadContext,
    });

    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setResult(res.result);
  }

  async function handleApply() {
    if (!field || !result) return;
    field.writeText(result.suggestion);
    await ProtocolClient.saveVoiceExample({
      surfaceId: context.surfaceId,
      subcontext: context.subcontext,
      original: result.original,
      rewritten: result.suggestion,
      action: 'accepted',
    });
    setResult(null);
    setExpanded(false);
  }

  async function handleCopy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.suggestion);
    setCopied(true);
  }

  async function handleSendToSidePanel() {
    if (!field) return;
    await ProtocolClient.setActiveDraft({
      text: field.readText(),
      surfaceId: context.surfaceId,
      subcontext: context.subcontext,
    });
    await ProtocolClient.openSidePanel();
  }

  return (
    <div
      data-theme={theme}
      className="lexel-root"
      style={{
        position: 'fixed',
        top: `${coords.top}px`,
        left: `${coords.left}px`,
        zIndex: 2147483646,
        pointerEvents: 'auto',
      }}
    >
      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          title="Open Lexel AI rewrite actions (Alt+L)"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '5px 10px',
            borderRadius: '6px',
            border: '1px solid var(--lx-border)',
            backgroundColor: 'var(--lx-card)',
            color: 'var(--lx-fg)',
            fontSize: '12px',
            fontWeight: 500,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
          }}
        >
          <NibIcon className="w-3.5 h-3.5" />
          <span>Lexel</span>
          <span className="lexel-mono" style={{ color: 'var(--lx-fg-muted)', fontSize: '11px' }}>
            {context.label}
            {context.subcontext ? ` · ${context.subcontext}` : ''}
          </span>
        </button>
      ) : (
        <div
          role="dialog"
          aria-label="Lexel Local AI Assistant"
          style={{
            width: '360px',
            maxWidth: 'calc(100vw - 24px)',
            borderRadius: '8px',
            border: '1px solid var(--lx-border)',
            backgroundColor: 'var(--lx-bg)',
            color: 'var(--lx-fg)',
            padding: '12px',
            boxShadow: '0 10px 28px rgba(0, 0, 0, 0.36)',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <NibIcon className="w-4 h-4" />
              <SurfaceBadge
                label={context.label}
                subcontext={context.subcontext}
                charCount={currentText.length}
                maxChars={profile.maxChars}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <button
                type="button"
                onClick={async () => {
                  const current = await ProtocolClient.getAiSettings();
                  await chrome.runtime.sendMessage({
                    kind: 'setAiSettings',
                    settings: { ...current, enabled: false },
                  });
                  setExpanded(false);
                }}
                title="Shut down Local AI (keep Harper grammar active)"
                style={{
                  padding: '3px 6px',
                  borderRadius: '6px',
                  border: '1px solid var(--lx-border)',
                  backgroundColor: 'var(--lx-muted)',
                  color: 'var(--lx-fg-muted)',
                  fontSize: '11px',
                }}
              >
                AI Off
              </button>
              <button
                type="button"
                onClick={handleSendToSidePanel}
                aria-label="Open in Side Panel"
                title="Open in Side Panel"
                style={{
                  padding: '4px',
                  borderRadius: '6px',
                  border: '1px solid var(--lx-border)',
                  backgroundColor: 'var(--lx-muted)',
                  color: 'var(--lx-fg)',
                }}
              >
                <PanelIcon className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                aria-label="Close Lexel popover"
                style={{
                  padding: '4px',
                  borderRadius: '6px',
                  border: '1px solid transparent',
                  backgroundColor: 'transparent',
                  color: 'var(--lx-fg-muted)',
                }}
              >
                <CloseIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {!aiEnabled ? (
            <div
              style={{
                borderRadius: '6px',
                border: '1px solid var(--lx-border)',
                backgroundColor: 'var(--lx-card)',
                padding: '8px 10px',
                fontSize: '12px',
                color: 'var(--lx-fg-muted)',
              }}
            >
              Local AI is turned off in Settings. Harper grammar and anti-slop checks remain active.
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {profile.quickActions.map((act) => (
                <button
                  key={act.id}
                  type="button"
                  disabled={loading}
                  onClick={() => void runTask(act.id)}
                  style={{
                    borderRadius: '6px',
                    border: '1px solid var(--lx-border)',
                    backgroundColor: 'var(--lx-muted)',
                    color: 'var(--lx-fg)',
                    padding: '5px 9px',
                    fontSize: '12px',
                    fontWeight: 500,
                  }}
                >
                  {act.label}
                </button>
              ))}
            </div>
          )}

          {loading ? (
            <div
              style={{
                borderRadius: '6px',
                border: '1px solid var(--lx-border)',
                backgroundColor: 'var(--lx-card)',
                padding: '10px',
                fontSize: '12px',
                color: 'var(--lx-fg-muted)',
              }}
            >
              Running local model on {context.label} profile...
            </div>
          ) : null}

          {error ? (
            <div
              style={{
                borderRadius: '6px',
                border: '1px solid var(--lx-danger)',
                backgroundColor: 'var(--lx-danger-bg)',
                padding: '8px 10px',
                fontSize: '12px',
                color: 'var(--lx-danger)',
                wordBreak: 'break-word',
              }}
            >
              {error}
            </div>
          ) : null}

          {result && !loading ? (
            <RewriteDiffCard
              original={result.original}
              suggestion={result.suggestion}
              gates={result.gates}
              modelName={result.model}
              latencyMs={result.latencyMs}
              onApply={handleApply}
              onCopy={handleCopy}
              onRetry={() => void runTask(lastTask)}
              onReject={() => setResult(null)}
              copied={copied}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
