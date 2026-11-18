import { SuggestionKind } from 'harper.js';
import type { IgnorableLintBox, UnpackedSuggestion } from 'lint-framework';
import { Check, PenTool, SlidersHorizontal, X } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ActiveLabLint } from '../lib/labLintController';

interface SafeMessageSegment {
  type: 'text' | 'code' | 'strong' | 'em' | 'break';
  text?: string;
}

export function parseSafeLintParagraphs(html: string): SafeMessageSegment[][] {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const paragraphs: SafeMessageSegment[][] = [];
  let current: SafeMessageSegment[] = [];

  const flushParagraph = () => {
    const hasContent = current.some((seg) => seg.type !== 'text' || Boolean(seg.text?.trim()));
    if (hasContent) {
      paragraphs.push(current);
    }
    current = [];
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? '';
      if (value) current.push({ type: 'text', text: value });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
      return;
    }
    if (tag === 'p' || tag === 'div') {
      flushParagraph();
      el.childNodes.forEach(walk);
      flushParagraph();
      return;
    }
    if (tag === 'br') {
      current.push({ type: 'break' });
      return;
    }
    if (tag === 'code') {
      const value = el.textContent ?? '';
      if (value) current.push({ type: 'code', text: value });
      return;
    }
    if (tag === 'strong' || tag === 'b') {
      const value = el.textContent ?? '';
      if (value) current.push({ type: 'strong', text: value });
      return;
    }
    if (tag === 'em' || tag === 'i') {
      const value = el.textContent ?? '';
      if (value) current.push({ type: 'em', text: value });
      return;
    }
    el.childNodes.forEach(walk);
  };

  doc.body.childNodes.forEach(walk);
  flushParagraph();
  return paragraphs;
}

function formatSuggestionDisplay(
  suggestion: UnpackedSuggestion,
  problemText: string,
): { action: string; label: string } {
  switch (suggestion.kind) {
    case SuggestionKind.Remove:
      return { action: 'Remove', label: `"${problemText}"` };
    case SuggestionKind.InsertAfter:
      return { action: 'Insert', label: suggestion.replacement_text };
    case SuggestionKind.Replace:
    default:
      return { action: 'Replace', label: suggestion.replacement_text || '(empty)' };
  }
}

function categoryBadgeStyle(rule: string, lintKind: string) {
  if (lintKind === 'Spelling' || lintKind === 'Typo') {
    return { bg: 'var(--lx-danger-bg)', border: 'var(--lx-danger)', color: 'var(--lx-danger)' };
  }
  if (
    rule === 'LexelAntiSlop' ||
    rule === 'LexelSurface' ||
    lintKind === 'Style' ||
    lintKind === 'Readability'
  ) {
    return { bg: 'var(--lx-warn-bg)', border: 'var(--lx-warn)', color: 'var(--lx-warn)' };
  }
  return { bg: 'var(--lx-signal-bg)', border: 'var(--lx-signal)', color: 'var(--lx-signal)' };
}

export interface LabSuggestionPopoverProps {
  active: ActiveLabLint | null;
  aiEnabled: boolean;
  onHoverChange: (hovered: boolean) => void;
  onClose: () => void;
  onAddToDictionary: (word: string) => void;
  onDisableRule: (ruleId: string) => void;
  onOpenSettings: () => void;
  onFixWithAi: (box: IgnorableLintBox) => void;
}

export function LabSuggestionPopover({
  active,
  aiEnabled,
  onHoverChange,
  onClose,
  onAddToDictionary,
  onDisableRule,
  onOpenSettings,
  onFixWithAi,
}: LabSuggestionPopoverProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 12, left: 12 });

  const box = active?.box ?? null;

  useEffect(() => {
    setSelectedIndex(0);
  }, [box?.lint.context_hash, box?.lint.span.start]);

  useLayoutEffect(() => {
    if (!box) return;
    const measure = () => {
      const card = cardRef.current;
      const width = card?.offsetWidth || 312;
      const height = card?.offsetHeight || 190;
      const margin = 10;
      const gap = 6;
      const belowTop = box.y + box.height + gap;
      const fitsBelow = belowTop + height + margin <= window.innerHeight;
      const top = fitsBelow ? belowTop : Math.max(margin, box.y - height - gap);
      const left = Math.max(margin, Math.min(window.innerWidth - width - margin, box.x));
      setCoords({ top, left });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [box]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (active.trigger !== 'keyboard' || !box || box.lint.suggestions.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((idx) => (idx + 1) % box.lint.suggestions.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex(
          (idx) => (idx - 1 + box.lint.suggestions.length) % box.lint.suggestions.length,
        );
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const chosen = box.lint.suggestions[selectedIndex];
        if (chosen) {
          void Promise.resolve(box.applySuggestion(chosen)).then(onClose);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active, box, selectedIndex, onClose]);

  if (!box) return null;

  const suggestions = box.lint.suggestions;
  const paragraphs = parseSafeLintParagraphs(box.lint.message_html);
  const badge = categoryBadgeStyle(box.rule, box.lint.lint_kind);
  const canDisableRule =
    Boolean(box.rule) && box.rule !== 'LexelAntiSlop' && box.rule !== 'LexelSurface';

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`Lexel ${box.lint.lint_kind_pretty} suggestion`}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
      style={{
        position: 'fixed',
        top: `${coords.top}px`,
        left: `${coords.left}px`,
        width: '312px',
        maxWidth: 'calc(100vw - 20px)',
        zIndex: 50,
        borderRadius: '8px',
        border: '1px solid var(--lx-border)',
        backgroundColor: 'var(--lx-bg)',
        color: 'var(--lx-fg)',
        boxShadow: '0 12px 28px rgba(0, 0, 0, 0.36)',
        padding: '10px',
      }}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <PenTool className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span
            className="inline-flex items-center rounded-[4px] border px-1.5 py-0.5 text-[11px] font-semibold lexel-mono shrink-0"
            style={{
              backgroundColor: badge.bg,
              borderColor: badge.border,
              color: badge.color,
            }}
          >
            {box.lint.lint_kind_pretty}
          </span>
          <span
            className="text-[11px] lexel-mono truncate"
            style={{ color: 'var(--lx-fg-muted)' }}
            title={box.lint.problem_text}
          >
            {box.lint.problem_text}
          </span>
        </div>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
          aria-label="Close suggestion"
          className="rounded-[6px] p-1 shrink-0"
          style={{ color: 'var(--lx-fg-muted)' }}
        >
          <X className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      <div className="text-xs leading-relaxed space-y-1.5" style={{ color: 'var(--lx-fg-muted)' }}>
        {paragraphs.map((segments, pIdx) => (
          <p key={pIdx} className="m-0">
            {segments.map((seg, sIdx) => {
              if (seg.type === 'break') return <br key={sIdx} />;
              if (seg.type === 'code') {
                return (
                  <code
                    key={sIdx}
                    className="lexel-mono rounded-[4px] px-1 py-0.5 text-[11px]"
                    style={{ backgroundColor: 'var(--lx-muted)', color: 'var(--lx-fg)' }}
                  >
                    {seg.text}
                  </code>
                );
              }
              if (seg.type === 'strong') {
                return (
                  <strong key={sIdx} style={{ color: 'var(--lx-fg)' }}>
                    {seg.text}
                  </strong>
                );
              }
              if (seg.type === 'em') return <em key={sIdx}>{seg.text}</em>;
              return <React.Fragment key={sIdx}>{seg.text}</React.Fragment>;
            })}
          </p>
        ))}
      </div>

      {suggestions.length > 0 ? (
        <div role="menu" aria-label="Fixes" className="flex flex-col gap-1">
          {suggestions.map((sug, idx) => {
            const display = formatSuggestionDisplay(sug, box.lint.problem_text);
            const isSelected = idx === selectedIndex;
            return (
              <button
                key={`${sug.kind}-${sug.replacement_text}-${idx}`}
                type="button"
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setSelectedIndex(idx)}
                onClick={() => void Promise.resolve(box.applySuggestion(sug)).then(onClose)}
                className="w-full flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 text-left text-xs transition-colors"
                style={{
                  backgroundColor: isSelected ? 'var(--lx-card)' : 'var(--lx-muted)',
                  borderColor: isSelected ? 'var(--lx-signal)' : 'var(--lx-border)',
                  color: 'var(--lx-fg)',
                }}
              >
                <span className="font-semibold truncate">{display.label}</span>
                <span
                  className="inline-flex items-center gap-1 text-[11px] lexel-mono shrink-0"
                  style={{ color: isSelected ? 'var(--lx-signal)' : 'var(--lx-fg-muted)' }}
                >
                  {isSelected ? <Check className="w-3 h-3" strokeWidth={2} aria-hidden="true" /> : null}
                  <span>{display.action}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div
          className="rounded-[6px] border px-2.5 py-2 flex items-center justify-between gap-2 text-[11px]"
          style={{
            backgroundColor: 'var(--lx-card)',
            borderColor: 'var(--lx-border)',
            color: 'var(--lx-fg-muted)',
          }}
        >
          <span>No 1-click fix available.</span>
          {aiEnabled ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onFixWithAi(box);
                onClose();
              }}
              className="rounded-[6px] px-2 py-1 text-[11px] font-semibold shrink-0"
              style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
            >
              Rewrite with AI
            </button>
          ) : null}
        </div>
      )}

      <div
        className="flex flex-wrap items-center gap-1.5 pt-1.5 border-t"
        style={{ borderColor: 'var(--lx-border)' }}
      >
        {box.ignoreLint ? (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void Promise.resolve(box.ignoreLint?.()).then(onClose)}
            className="rounded-[6px] border px-2 py-1 text-[11px] font-medium"
            style={{
              backgroundColor: 'var(--lx-muted)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            Dismiss
          </button>
        ) : null}

        {box.lint.lint_kind === 'Spelling' ? (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onAddToDictionary(box.lint.problem_text);
              onClose();
            }}
            className="rounded-[6px] border px-2 py-1 text-[11px] font-medium"
            style={{
              backgroundColor: 'var(--lx-muted)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            + Dictionary
          </button>
        ) : null}

        {canDisableRule ? (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onDisableRule(box.rule);
              onClose();
            }}
            className="rounded-[6px] px-2 py-1 text-[11px]"
            style={{ color: 'var(--lx-fg-muted)' }}
          >
            Mute rule
          </button>
        ) : null}

        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onOpenSettings();
            onClose();
          }}
          className="ml-auto inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-[11px]"
          style={{ color: 'var(--lx-fg-muted)' }}
        >
          <SlidersHorizontal className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
          <span>Rule Settings</span>
        </button>
      </div>
    </div>
  );
}
