import {
  CloseIcon,
  NibIcon,
  PanelIcon,
  RewriteDiffCard,
  SlidersIcon,
  StatusPill,
  SurfaceBadge,
} from 'lexel-ui';
import React, { useCallback, useEffect, useState } from 'react';
import type { LocalAiHealth } from '../shared/localAiClient';
import { getSurfaceProfile } from '../shared/surfaceDetector';
import type {
  AiTaskId,
  DetectedSurfaceContext,
  RewriteResult,
  SurfaceProfile,
} from '../shared/types';
import { hasSecrets } from '../shared/verifier';
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
  requestedTask?: { id: AiTaskId; seq: number } | null;
  customSurfaces?: SurfaceProfile[];
}

export function AiFloatingPill({
  field,
  context,
  theme,
  aiEnabled,
  openSignal,
  requestedTask,
  customSurfaces,
}: AiFloatingPillProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoText, setUndoText] = useState<string | null>(null);
  const [result, setResult] = useState<RewriteResult | null>(null);
  const [lastTask, setLastTask] = useState<AiTaskId>('rewrite_surface');
  const [copied, setCopied] = useState(false);
  const [health, setHealth] = useState<LocalAiHealth | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; visible: boolean }>({
    top: 0,
    left: 0,
    visible: false,
  });

  const profile = getSurfaceProfile(context.surfaceId, customSurfaces);

  const refreshHealth = useCallback(async () => {
    if (!aiEnabled) {
      setHealth({ ok: false, models: [], error: 'Local AI is turned off in Settings.' });
      return;
    }
    setCheckingHealth(true);
    try {
      const next = await ProtocolClient.getAiHealth();
      setHealth(next);
    } catch (err) {
      setHealth({ ok: false, models: [], error: (err as Error).message });
    } finally {
      setCheckingHealth(false);
    }
  }, [aiEnabled]);

  useEffect(() => {
    if (openSignal > 0 && field && !context.isBlocked) {
      setExpanded(true);
    }
  }, [openSignal, field, context.isBlocked]);

  useEffect(() => {
    if (expanded) {
      void refreshHealth();
    }
  }, [expanded, refreshHealth]);

  const activeElement = field?.element ?? null;
  useEffect(() => {
    if (activeElement !== undefined) {
      setResult(null);
      setError(null);
    }
  }, [activeElement]);

  useEffect(() => {
    if (!field || context.isBlocked) {
      setCoords((prev) => ({ ...prev, visible: false }));
      return;
    }

    const updatePosition = () => {
      const rect = field.element.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 14) {
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
        Math.min(window.innerHeight - (expanded ? 360 : 42), rect.bottom + 6),
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

  const runTask = useCallback(
    async (task: AiTaskId) => {
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
        domain: context.domain,
      });

      setLoading(false);
      if (!res.ok) {
        setError(res.error);
        void refreshHealth();
        return;
      }
      setResult(res.result);
    },
    [field, context.surfaceId, context.subcontext, context.domain, refreshHealth],
  );

  useEffect(() => {
    if (!requestedTask || !field || context.isBlocked || !aiEnabled) return;
    setExpanded(true);
    void runTask(requestedTask.id);
  }, [requestedTask, field, context.isBlocked, aiEnabled, runTask]);

  if (!field || !coords.visible || context.isBlocked) {
    return null;
  }

  const currentText = field.readText();
  const containsSecrets = hasSecrets(currentText);
  const healthState = !aiEnabled
    ? 'offline'
    : checkingHealth
      ? 'loading'
      : health?.ok && health.modelAvailable !== false
        ? 'ready'
        : health
          ? 'error'
          : 'loading';
  const healthLabel = !aiEnabled
    ? 'AI Off'
    : checkingHealth
      ? 'Checking...'
      : health?.ok && health.modelAvailable !== false
        ? 'Local AI Ready'
        : 'AI Offline';

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

  async function handleFixSafe() {
    if (!field) return;
    const text = field.readText();
    if (!text.trim()) return;
    const res = await ProtocolClient.fixSafeIssues(text, context.surfaceId);
    if (res.fixesApplied > 0) {
      setUndoText(text);
      field.writeText(res.text);
      setError(null);
    } else {
      setError('No deterministic slop, em dash, emoji, or hashtag fixes needed.');
    }
  }

  async function handleFixAllSafe() {
    if (!field) return;
    const text = field.readText();
    if (!text.trim()) return;
    const res = await ProtocolClient.fixAllSafe(text, context.surfaceId);
    if (res.fixesApplied > 0 && res.text !== text) {
      setUndoText(text);
      field.writeText(res.text);
      setError(null);
    } else {
      setError('No deterministic slop or unambiguous grammar fixes needed.');
    }
  }

  async function handleTitleCase() {
    if (!field) return;
    const text = field.readText();
    if (!text.trim()) return;
    const next = await ProtocolClient.toTitleCase(text);
    if (next !== text) {
      setUndoText(text);
      field.writeText(next);
    }
    setError(null);
  }

  async function handleSentenceCase() {
    if (!field) return;
    const text = field.readText();
    if (!text.trim()) return;
    const next = await ProtocolClient.toSentenceCase(text);
    if (next !== text) {
      setUndoText(text);
      field.writeText(next);
    }
    setError(null);
  }

  function handleUndoTransform() {
    if (!field || undoText == null) return;
    field.writeText(undoText);
    setUndoText(null);
    setError(null);
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
          onMouseDown={(e) => e.preventDefault()}
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
          {containsSecrets ? (
            <span
              className="lexel-mono"
              style={{
                color: 'var(--lx-danger)',
                fontSize: '10px',
                fontWeight: 600,
              }}
            >
              Secret
            </span>
          ) : null}
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
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
            }}
          >
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
              <StatusPill state={healthState} label={healthLabel} />
              {aiEnabled ? (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={async () => {
                    await ProtocolClient.setAiEnabled(false);
                    setExpanded(false);
                  }}
                  title="Shut down Local AI (keep grammar checks active)"
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
              ) : null}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
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
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void ProtocolClient.openOptions()}
                aria-label="Open Lexel Settings"
                title="Open Lexel Settings"
                style={{
                  padding: '4px',
                  borderRadius: '6px',
                  border: '1px solid var(--lx-border)',
                  backgroundColor: 'var(--lx-muted)',
                  color: 'var(--lx-fg)',
                }}
              >
                <SlidersIcon className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
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

          {containsSecrets ? (
            <div
              role="alert"
              style={{
                borderRadius: '6px',
                border: '1px solid var(--lx-danger)',
                backgroundColor: 'var(--lx-danger-bg)',
                padding: '7px 10px',
                fontSize: '11px',
                color: 'var(--lx-danger)',
              }}
            >
              Secrets Guard flagged sensitive credentials or PII in this field. AI rewrites are
              blocked.
            </div>
          ) : null}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void handleFixSafe()}
              style={{
                borderRadius: '6px',
                border: '1px solid var(--lx-signal)',
                backgroundColor: 'var(--lx-card)',
                color: 'var(--lx-signal)',
                padding: '4px 8px',
                fontSize: '11px',
                fontWeight: 600,
              }}
            >
              Fix Safe Issues
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void handleFixAllSafe()}
              style={{
                borderRadius: '6px',
                border: '1px solid var(--lx-border)',
                backgroundColor: 'var(--lx-muted)',
                color: 'var(--lx-fg)',
                padding: '4px 8px',
                fontSize: '11px',
                fontWeight: 600,
              }}
              title="Clean safe slop phrases, typography, and unambiguous Harper fixes"
            >
              Fix All Safe
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void handleTitleCase()}
              style={{
                borderRadius: '6px',
                border: '1px solid var(--lx-border)',
                backgroundColor: 'var(--lx-muted)',
                color: 'var(--lx-fg)',
                padding: '4px 8px',
                fontSize: '11px',
                fontWeight: 500,
              }}
            >
              Title Case
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void handleSentenceCase()}
              style={{
                borderRadius: '6px',
                border: '1px solid var(--lx-border)',
                backgroundColor: 'var(--lx-muted)',
                color: 'var(--lx-fg)',
                padding: '4px 8px',
                fontSize: '11px',
                fontWeight: 500,
              }}
            >
              Sentence Case
            </button>
            {undoText != null ? (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleUndoTransform()}
                style={{
                  borderRadius: '6px',
                  border: '1px solid var(--lx-warn)',
                  backgroundColor: 'var(--lx-warn-bg)',
                  color: 'var(--lx-warn)',
                  padding: '4px 8px',
                  fontSize: '11px',
                  fontWeight: 500,
                }}
              >
                Undo
              </button>
            ) : null}
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
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <span>Local AI is off. Grammar and anti-slop checks stay active.</span>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void ProtocolClient.setAiEnabled(true)}
                style={{
                  borderRadius: '6px',
                  padding: '4px 8px',
                  backgroundColor: 'var(--lx-accent)',
                  color: 'var(--lx-on-accent)',
                  fontSize: '11px',
                  fontWeight: 600,
                }}
              >
                Turn AI On
              </button>
            </div>
          ) : (
            <>
              {health && (!health.ok || health.modelAvailable === false) ? (
                <div
                  style={{
                    borderRadius: '6px',
                    border: '1px solid var(--lx-warn)',
                    backgroundColor: 'var(--lx-warn-bg)',
                    padding: '8px 10px',
                    fontSize: '11px',
                    color: 'var(--lx-warn)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <span style={{ wordBreak: 'break-word' }}>{health.error}</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void refreshHealth()}
                      style={{
                        borderRadius: '6px',
                        border: '1px solid var(--lx-border)',
                        backgroundColor: 'var(--lx-muted)',
                        color: 'var(--lx-fg)',
                        padding: '3px 8px',
                        fontSize: '11px',
                        fontWeight: 500,
                      }}
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void ProtocolClient.openOptions()}
                      style={{
                        borderRadius: '6px',
                        border: '1px solid var(--lx-border)',
                        backgroundColor: 'var(--lx-card)',
                        color: 'var(--lx-fg)',
                        padding: '3px 8px',
                        fontSize: '11px',
                      }}
                    >
                      AI Settings
                    </button>
                  </div>
                </div>
              ) : null}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {profile.quickActions.map((act) => (
                  <button
                    key={act.id}
                    type="button"
                    disabled={loading}
                    onMouseDown={(e) => e.preventDefault()}
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
            </>
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
