import React, { useEffect, useState } from 'react';
import {
  getBuiltinSurfaceDefault,
  isSurfaceProfileCustomized,
} from '../tier0/promptCore';
import type { SurfaceProfile } from '../tier0/types';

export interface EditableSurfaceCardProps {
  profile: SurfaceProfile;
  isCustomOnly: boolean;
  onSaveOverride: (
    baseSurface: SurfaceProfile,
    patch: Partial<
      Pick<
        SurfaceProfile,
        | 'promptDirective'
        | 'maxChars'
        | 'allowLinks'
        | 'allowEmojis'
        | 'allowHashtags'
        | 'allowEmDashes'
      >
    >,
  ) => void;
  onResetOrDelete: (profile: SurfaceProfile, isCustomOnly: boolean) => void;
}

export function EditableSurfaceCard({
  profile,
  isCustomOnly,
  onSaveOverride,
  onResetOrDelete,
}: EditableSurfaceCardProps) {
  const builtin = getBuiltinSurfaceDefault(profile.id);
  const customized = !isCustomOnly && isSurfaceProfileCustomized(builtin, profile);
  const [editing, setEditing] = useState(false);
  const [promptDraft, setPromptDraft] = useState(profile.promptDirective);
  const [maxCharsDraft, setMaxCharsDraft] = useState(profile.maxChars);
  const [allowLinksDraft, setAllowLinksDraft] = useState(profile.allowLinks);
  const [allowEmojisDraft, setAllowEmojisDraft] = useState(profile.allowEmojis);
  const [allowHashtagsDraft, setAllowHashtagsDraft] = useState(profile.allowHashtags);
  const [allowEmDashesDraft, setAllowEmDashesDraft] = useState(profile.allowEmDashes);

  useEffect(() => {
    setEditing(false);
  }, [profile.id]);

  useEffect(() => {
    setPromptDraft(profile.promptDirective);
    setMaxCharsDraft(profile.maxChars);
    setAllowLinksDraft(profile.allowLinks);
    setAllowEmojisDraft(profile.allowEmojis);
    setAllowHashtagsDraft(profile.allowHashtags);
    setAllowEmDashesDraft(profile.allowEmDashes);
  }, [profile]);

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    onSaveOverride(profile, {
      promptDirective: promptDraft,
      maxChars: maxCharsDraft,
      allowLinks: allowLinksDraft,
      allowEmojis: allowEmojisDraft,
      allowHashtags: allowHashtagsDraft,
      allowEmDashes: allowEmDashesDraft,
    });
    setEditing(false);
  }

  return (
    <div
      className="rounded-[8px] border p-3.5 text-xs flex flex-col gap-2"
      style={{ backgroundColor: 'var(--lx-bg)', borderColor: 'var(--lx-border)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="font-semibold text-xs">{profile.label}</span>
          <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-signal)' }}>
            {profile.id}
          </span>
          {customized ? (
            <span
              className="rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium"
              style={{ backgroundColor: 'var(--lx-signal-bg)', color: 'var(--lx-signal)' }}
            >
              Custom prompt
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="lexel-mono text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
            max {profile.maxChars} chars · links:{profile.allowLinks ? 'yes' : 'no'} · emojis:
            {profile.allowEmojis ? 'yes' : 'no'} · hashtags:{profile.allowHashtags ? 'yes' : 'no'}
          </span>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded-[4px] border px-2 py-0.5 text-[11px] font-medium"
            style={{
              backgroundColor: 'var(--lx-surface)',
              borderColor: 'var(--lx-border)',
              color: 'var(--lx-fg)',
            }}
          >
            {editing ? 'Cancel' : 'Edit prompt'}
          </button>
          {isCustomOnly ? (
            <button
              type="button"
              onClick={() => onResetOrDelete(profile, true)}
              className="rounded-[4px] border px-2 py-0.5 text-[11px]"
              style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-danger)' }}
            >
              Delete
            </button>
          ) : customized ? (
            <button
              type="button"
              onClick={() => {
                onResetOrDelete(profile, false);
                setEditing(false);
              }}
              className="rounded-[4px] border px-2 py-0.5 text-[11px]"
              style={{ borderColor: 'var(--lx-border)', color: 'var(--lx-fg-muted)' }}
            >
              Reset default
            </button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <form onSubmit={handleSave} className="flex flex-col gap-2 pt-1">
          <label className="flex flex-col gap-1">
            <span className="text-[11px]" style={{ color: 'var(--lx-fg-muted)' }}>
              AI Style Prompt (used for {profile.label} rewrites; numeric and anti-slop safety gates stay locked)
            </span>
            <textarea
              rows={2}
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              aria-label={`Style prompt for ${profile.label}`}
              className="w-full rounded-[6px] border px-2.5 py-1.5 text-xs leading-relaxed resize-y"
              style={{
                backgroundColor: 'var(--lx-card)',
                borderColor: 'var(--lx-border)',
                color: 'var(--lx-fg)',
              }}
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-3 text-[11px]">
              <label className="inline-flex items-center gap-1">
                <span style={{ color: 'var(--lx-fg-muted)' }}>Max chars</span>
                <input
                  type="number"
                  min={40}
                  max={30000}
                  value={maxCharsDraft}
                  onChange={(e) => setMaxCharsDraft(Number.parseInt(e.target.value || '280', 10))}
                  className="w-20 rounded-[4px] border px-1.5 py-0.5 text-[11px] lexel-mono"
                  style={{
                    backgroundColor: 'var(--lx-card)',
                    borderColor: 'var(--lx-border)',
                    color: 'var(--lx-fg)',
                  }}
                />
              </label>
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={allowLinksDraft}
                  onChange={(e) => setAllowLinksDraft(e.target.checked)}
                />
                <span>Links</span>
              </label>
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={allowEmojisDraft}
                  onChange={(e) => setAllowEmojisDraft(e.target.checked)}
                />
                <span>Emojis</span>
              </label>
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={allowHashtagsDraft}
                  onChange={(e) => setAllowHashtagsDraft(e.target.checked)}
                />
                <span>Hashtags</span>
              </label>
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={allowEmDashesDraft}
                  onChange={(e) => setAllowEmDashesDraft(e.target.checked)}
                />
                <span>Em dashes</span>
              </label>
            </div>
            <button
              type="submit"
              className="rounded-[6px] px-3 py-1 text-[11px] font-semibold"
              style={{ backgroundColor: 'var(--lx-accent)', color: 'var(--lx-on-accent)' }}
            >
              Save surface
            </button>
          </div>
        </form>
      ) : (
        <p className="m-0 text-[11px] leading-relaxed" style={{ color: 'var(--lx-fg-muted)' }}>
          {profile.promptDirective}
        </p>
      )}
    </div>
  );
}
