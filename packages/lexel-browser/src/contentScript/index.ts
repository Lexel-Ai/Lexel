import '@webcomponents/custom-elements';
import { expandSnippetAtCursor } from 'lexel-ui';
import tokensCss from 'lexel-ui/tokens.css?inline';
import { getClosestBlockAncestor, isVisible, leafNodes } from 'lint-framework';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import appCss from '../app.css?inline';
import { detectSurfaceFromLocation, isSensitiveElement } from '../shared/surfaceDetector';
import { extractSmartThreadContext } from '../shared/threadContext';
import { checkPastedAiSlop } from '../shared/tier0Engine';
import type {
  AiTaskId,
  DetectedSurfaceContext,
  Hotkey,
  PastedAiCheck,
  SurfaceId,
  SurfaceProfile,
  TextSnippet,
} from '../shared/types';
import { type ActiveFieldHandle, AiFloatingPill } from './AiFloatingPill';
import { GhostTextOverlay } from './GhostTextOverlay';
import { createGoogleDocsBridgeSync, isGoogleDocsPage } from './googleDocs';
import { type ActiveLintPopup, LexelLintController } from './LexelLintController';
import { LexelSuggestionPopover } from './LexelSuggestionPopover';
import { PastedDeslopPill } from './PastedDeslopPill';
import ProtocolClient from './ProtocolClient';

let blocklistCache: string[] = [];
let surfaceOverrideCache: SurfaceId | null = null;
let customSurfacesCache: SurfaceProfile[] = [];
let customSlopTermsCache: string[] = [];
let disabledSlopTermsCache: string[] = [];
let crutchWordsCache: string[] = [];
let snippetsCache: TextSnippet[] = [];
let themeCache: 'dark' | 'light' = 'dark';
let aiEnabledCache = true;
let ghostTextEnabledCache = false;
let redactSecretsCache = false;
let localSecretBlocksCache = 0;
let hotkeyCache: Hotkey = { modifiers: ['Alt'], key: 'l' };

let activeField: ActiveFieldHandle | null = null;
let activeLintPopup: ActiveLintPopup | null = null;
let pastedAiCheck: PastedAiCheck | null = null;
let pastedBusy = false;
let ghostCompletion: { text: string; model?: string; prefixAtRequest: string } | null = null;
let ghostDebounceTimer: number | null = null;
let ghostRequestSeq = 0;

let openSignal = 0;
let requestedTask: { id: AiTaskId; seq: number } | null = null;
let taskSeq = 0;
let externalUndo: { previousText: string; message: string; seq: number } | null = null;
let undoSeq = 0;

let shadowHost: HTMLElement | null = null;
let overlayRoot: Root | null = null;

function currentSurfaceContext(el: Element | null): DetectedSurfaceContext {
  return detectSurfaceFromLocation(window.location.href, {
    blocklist: blocklistCache,
    overrideSurface: surfaceOverrideCache,
    focusedElement: el,
    doc: document,
    customSurfaces: customSurfacesCache,
  });
}

const lintController = new LexelLintController(
  (text, domain, options) => {
    const ctx = currentSurfaceContext(activeField?.element ?? null);
    if (ctx.isBlocked) {
      return Promise.resolve({});
    }
    return ProtocolClient.lint(text, domain, options, {
      surfaceId: ctx.surfaceId,
      subcontext: ctx.subcontext,
    });
  },
  {
    ignoreLint: (hash) => ProtocolClient.ignoreHash(hash),
    getDelay: () => ProtocolClient.getDelay(),
    onActiveLintChange: (next) => {
      activeLintPopup = next;
      renderOverlays();
    },
  },
);

const syncGoogleDocsBridge = createGoogleDocsBridgeSync(lintController);

function ensureShadowMount(): Root {
  if (overlayRoot) return overlayRoot;
  const host = document.createElement('div');
  host.id = 'lexel-shadow-host';
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.zIndex = '2147483647';
  host.style.pointerEvents = 'none';
  document.documentElement.appendChild(host);
  shadowHost = host;

  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = `${appCss}\n${tokensCss}`;
  shadow.appendChild(styleEl);

  const container = document.createElement('div');
  shadow.appendChild(container);
  overlayRoot = createRoot(container);
  return overlayRoot;
}

function dismissGhostCompletion() {
  if (ghostDebounceTimer != null) {
    window.clearTimeout(ghostDebounceTimer);
    ghostDebounceTimer = null;
  }
  if (ghostCompletion) {
    ghostCompletion = null;
    renderOverlays();
  }
}

function acceptGhostCompletion(): boolean {
  if (!activeField || !ghostCompletion) return false;
  const completion = ghostCompletion.text;
  const previous = activeField.readText();
  const needsSpace =
    previous.length > 0 && !/\s$/.test(previous) && !/^[\s.,;:!?)]/.test(completion);
  const nextText = `${previous}${needsSpace ? ' ' : ''}${completion}`;
  ghostCompletion = null;
  activeField.writeText(nextText);
  undoSeq += 1;
  externalUndo = {
    previousText: previous,
    message: 'Inserted local ghost-text completion.',
    seq: undoSeq,
  };
  renderOverlays();
  return true;
}

function scheduleGhostCompletion() {
  if (ghostDebounceTimer != null) {
    window.clearTimeout(ghostDebounceTimer);
    ghostDebounceTimer = null;
  }
  if (!ghostTextEnabledCache || !aiEnabledCache || !activeField) {
    dismissGhostCompletion();
    return;
  }
  const el = activeField.element;
  if (isSensitiveElement(el)) return;
  const ctx = currentSurfaceContext(el);
  if (ctx.isBlocked) return;

  const text = activeField.readText();
  if (text.trim().length < 18) {
    dismissGhostCompletion();
    return;
  }

  // Only suggest when caret is at the end of a textarea/input.
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    if (el.selectionStart !== el.value.length || el.selectionEnd !== el.value.length) {
      dismissGhostCompletion();
      return;
    }
  }

  const seq = ++ghostRequestSeq;
  const prefixAtRequest = text;
  ghostDebounceTimer = window.setTimeout(() => {
    ghostDebounceTimer = null;
    void ProtocolClient.ghostComplete({
      prefix: prefixAtRequest.slice(-400),
      surfaceId: ctx.surfaceId,
      subcontext: ctx.subcontext,
      domain: ctx.domain,
      maxTokens: 24,
    }).then((res) => {
      if (seq !== ghostRequestSeq || !activeField) return;
      if (activeField.readText() !== prefixAtRequest) return;
      if (res.ok && res.result.completion.trim()) {
        ghostCompletion = {
          text: res.result.completion.trim(),
          model: res.result.model,
          prefixAtRequest,
        };
        renderOverlays();
      } else {
        dismissGhostCompletion();
      }
    });
  }, 450);
}

async function handleHumanizePasted() {
  if (!activeField) return;
  const ctx = currentSurfaceContext(activeField.element);
  if (aiEnabledCache) {
    pastedAiCheck = null;
    taskSeq += 1;
    requestedTask = { id: 'deslop', seq: taskSeq };
    openSignal += 1;
    renderOverlays();
    return;
  }

  pastedBusy = true;
  renderOverlays();
  try {
    const original = activeField.readText();
    const res = await ProtocolClient.fixAllSafe(original, ctx.surfaceId);
    if (res.fixesApplied > 0 && res.text !== original) {
      activeField.writeText(res.text);
      undoSeq += 1;
      externalUndo = {
        previousText: original,
        message: `Humanized pasted text (${res.fixesApplied} deterministic fix${res.fixesApplied === 1 ? '' : 'es'}).`,
        seq: undoSeq,
      };
    }
  } finally {
    pastedBusy = false;
    pastedAiCheck = null;
    renderOverlays();
  }
}

function renderOverlays() {
  const root = ensureShadowMount();
  const ctx = currentSurfaceContext(activeField?.element ?? null);
  root.render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(PastedDeslopPill, {
        field: activeField,
        check: ctx.isBlocked ? null : pastedAiCheck,
        theme: themeCache,
        busy: pastedBusy,
        onHumanize: () => void handleHumanizePasted(),
        onDismiss: () => {
          pastedAiCheck = null;
          renderOverlays();
        },
      }),
      React.createElement(GhostTextOverlay, {
        field: activeField,
        completion: ctx.isBlocked ? null : (ghostCompletion?.text ?? null),
        modelName: ghostCompletion?.model,
        theme: themeCache,
        onAccept: () => {
          acceptGhostCompletion();
        },
        onDismiss: () => dismissGhostCompletion(),
      }),
      React.createElement(AiFloatingPill, {
        field: activeField,
        context: ctx,
        theme: themeCache,
        aiEnabled: aiEnabledCache,
        openSignal,
        requestedTask,
        customSurfaces: customSurfacesCache,
        customSlopTerms: customSlopTermsCache,
        disabledSlopTerms: disabledSlopTermsCache,
        crutchWords: crutchWordsCache,
        redactSecrets: redactSecretsCache,
        localSecretBlocks: localSecretBlocksCache,
        externalUndo,
      }),
      React.createElement(LexelSuggestionPopover, {
        active: activeLintPopup,
        theme: themeCache,
        aiEnabled: aiEnabledCache,
        onHoverChange: (hovered) => lintController.setPopoverHovered(hovered),
        onClose: () => lintController.closePopup(),
        onApplied: () => {
          void lintController.requestLintUpdate(true);
        },
        onAddToDictionary: async (word) => {
          await ProtocolClient.addToUserDictionary([word]);
          await lintController.requestLintUpdate(true);
        },
        onDisableRule: async (ruleId) => {
          await ProtocolClient.setRuleEnabled(ruleId, false);
          await lintController.requestLintUpdate(true);
        },
        onAllowSlopTerm: async (term) => {
          await ProtocolClient.allowSlopTerm(term);
          await lintController.requestLintUpdate(true);
        },
        onOpenSettings: () => ProtocolClient.openOptions(),
        onFixWithAi: (box) => {
          const rootEl = resolveEditableRoot(box.source) ?? activeField?.element;
          if (rootEl) {
            activeField = makeFieldHandle(rootEl);
          }
          taskSeq += 1;
          let mappedTask: AiTaskId = 'fix_grammar_flow';
          if (box.rule === 'LexelAntiSlop') {
            mappedTask = 'deslop';
          } else if (box.rule === 'LexelGuard') {
            const label = box.lint.lint_kind_pretty.toLowerCase();
            if (label.includes('bluf') || label.includes('wall')) mappedTask = 'bluf';
            else if (label.includes('regret')) mappedTask = 'softer';
            else mappedTask = 'shorten';
          }
          requestedTask = { id: mappedTask, seq: taskSeq };
          openSignal += 1;
          renderOverlays();
        },
      }),
    ),
  );
}

function setElementValueSafely(el: HTMLElement, nextText: string) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) {
      descriptor.set.call(el, nextText);
    } else {
      el.value = nextText;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  el.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand('insertText', false, nextText);
    if (!inserted) {
      el.innerText = nextText;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: nextText }));
    }
  }
}

function makeFieldHandle(el: HTMLElement): ActiveFieldHandle {
  return {
    element: el,
    readText: () => {
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        return el.value;
      }
      return el.innerText;
    },
    writeText: (nextText: string) => {
      setElementValueSafely(el, nextText);
      void lintController.update();
    },
    // Explicit-action-only extraction: called only when user triggers reply/context actions.
    readThreadContext: () => extractSmartThreadContext(el, document, window.location.hostname),
  };
}

function isEditableElement(node: EventTarget | null): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false;
  if (isSensitiveElement(node)) return false;
  if (node instanceof HTMLTextAreaElement) return !node.disabled && !node.readOnly;
  if (node instanceof HTMLInputElement) {
    return node.type === 'text' && !node.disabled && !node.readOnly;
  }
  return node.isContentEditable;
}

/** Resolve inner <p>/<span> nodes of a rich editor up to its contenteditable root. */
function resolveEditableRoot(node: EventTarget | null): HTMLElement | null {
  if (!isEditableElement(node)) return null;
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
    return node;
  }
  let current: HTMLElement = node;
  while (current.parentElement && current.parentElement.isContentEditable) {
    current = current.parentElement;
  }
  return isSensitiveElement(current) ? null : current;
}

function scanFields() {
  void syncGoogleDocsBridge();
  if (isGoogleDocsPage()) return;

  document.querySelectorAll<HTMLTextAreaElement>('textarea').forEach((el) => {
    if (!el.disabled && !el.readOnly && isVisible(el) && !isSensitiveElement(el)) {
      lintController.addTarget(el);
    }
  });

  document
    .querySelectorAll<HTMLInputElement>('input[type="text"][spellcheck="true"]')
    .forEach((el) => {
      if (!el.disabled && !el.readOnly && !isSensitiveElement(el)) {
        lintController.addTarget(el);
      }
    });

  document.querySelectorAll('[contenteditable="true"], [contenteditable=""]').forEach((el) => {
    if (!(el instanceof HTMLElement) || isSensitiveElement(el)) return;
    if (el.matches('[role="combobox"]')) return;
    const isLexical = el.getAttribute('data-lexical-editor') === 'true';
    const isQuill = el.classList.contains('ql-editor');
    const isWebmail =
      window.location.hostname === 'mail.google.com' ||
      window.location.hostname === 'outlook.live.com';
    if (el.getAttribute('spellcheck') === 'false' && !isLexical && !isQuill && !isWebmail) {
      return;
    }

    const seenBlocks = new Set<Element>();
    for (const leaf of leafNodes(el)) {
      if (leaf.parentElement?.closest('[contenteditable="false"],[disabled],[readonly]') != null) {
        continue;
      }
      const block = getClosestBlockAncestor(leaf, el);
      if (!block || seenBlocks.has(block) || !isVisible(block)) {
        continue;
      }
      seenBlocks.add(block);
      lintController.addTarget(block);
    }

    if (seenBlocks.size === 0 && isVisible(el)) {
      lintController.addTarget(el);
    }
  });
}

async function hydrateConfig(initializeSummary = false) {
  try {
    const [
      blocklist,
      override,
      customSurfaces,
      slopCfg,
      crutchWords,
      snippets,
      theme,
      aiSettings,
      hoverEnabled,
      activationKey,
      hotkey,
      ghostTextEnabled,
      privacyStats,
    ] = await Promise.all([
      ProtocolClient.getPrivacyBlocklist().catch(() => []),
      ProtocolClient.getSurfaceOverride(window.location.hostname).catch(() => null),
      ProtocolClient.getCustomSurfaces().catch(() => []),
      ProtocolClient.getCustomSlopConfig().catch(() => ({ customTerms: [], disabledTerms: [] })),
      ProtocolClient.getCrutchWords().catch(() => []),
      ProtocolClient.getSnippets().catch(() => []),
      ProtocolClient.getTheme().catch(() => 'dark' as const),
      ProtocolClient.getAiSettings().catch(() => ({ enabled: true })),
      ProtocolClient.getOpenSuggestionsOnHover().catch(() => true),
      ProtocolClient.getActivationKey().catch(() => 'off' as const),
      ProtocolClient.getHotkey().catch(() => ({ modifiers: ['Alt'], key: 'l' }) as Hotkey),
      ProtocolClient.getGhostTextEnabled().catch(() => false),
      ProtocolClient.getPrivacyStats().catch(() => ({
        localSecretBlocks: 0,
        redactSecrets: false,
        blocklistCount: 0,
      })),
    ]);
    blocklistCache = blocklist;
    surfaceOverrideCache = override;
    customSurfacesCache = customSurfaces;
    customSlopTermsCache = slopCfg.customTerms;
    disabledSlopTermsCache = slopCfg.disabledTerms;
    crutchWordsCache = crutchWords;
    snippetsCache = snippets;
    themeCache = theme;
    aiEnabledCache = aiSettings.enabled;
    hotkeyCache = hotkey;
    ghostTextEnabledCache = ghostTextEnabled;
    redactSecretsCache = privacyStats.redactSecrets;
    localSecretBlocksCache = privacyStats.localSecretBlocks;
    lintController.setOpenSuggestionsOnHover(hoverEnabled);
    lintController.setActivationKey(activationKey);

    if (initializeSummary) {
      const ctx = currentSurfaceContext(activeField?.element ?? null);
      await ProtocolClient.setPageSummary({
        domain: ctx.domain,
        surfaceId: ctx.surfaceId,
        subcontext: ctx.subcontext,
        harperCount: 0,
        slopCount: 0,
        surfaceWarningCount: 0,
      }).catch(() => undefined);
    }
  } catch {
    // Keep defaults if background service worker is still waking up.
  }
}

function captureFocusedElement(target: EventTarget | null) {
  const rootEl = resolveEditableRoot(target);
  if (!rootEl) return;
  if (activeField?.element !== rootEl) {
    pastedAiCheck = null;
    dismissGhostCompletion();
  }
  activeField = makeFieldHandle(rootEl);
  if (rootEl instanceof HTMLTextAreaElement || rootEl instanceof HTMLInputElement) {
    lintController.addTarget(rootEl);
  } else {
    scanFields();
    if (!lintController.hasTarget(rootEl) && target instanceof HTMLElement) {
      const hasRegisteredChild = Array.from(rootEl.querySelectorAll('*')).some((el) =>
        lintController.hasTarget(el),
      );
      if (!hasRegisteredChild) {
        lintController.addTarget(rootEl);
      }
    }
  }
  renderOverlays();
}

document.addEventListener(
  'focusin',
  (event) => {
    captureFocusedElement(event.target);
  },
  true,
);

document.addEventListener(
  'paste',
  (event) => {
    const rootEl = resolveEditableRoot(event.target);
    if (!rootEl) return;
    const ctx = currentSurfaceContext(rootEl);
    if (ctx.isBlocked) return;
    const pasted = event.clipboardData?.getData('text/plain') ?? '';
    if (!pasted) return;
    const check = checkPastedAiSlop(pasted, {
      customSlopTerms: customSlopTermsCache,
      disabledSlopTerms: disabledSlopTermsCache,
    });
    if (check.shouldOffer) {
      activeField = makeFieldHandle(rootEl);
      pastedAiCheck = check;
      renderOverlays();
    }
  },
  true,
);

document.addEventListener(
  'input',
  (event) => {
    if (!activeField) return;
    const rootEl = resolveEditableRoot(event.target);
    if (!rootEl || rootEl !== activeField.element) return;
    if (ghostCompletion) {
      dismissGhostCompletion();
    }
    scheduleGhostCompletion();
  },
  true,
);

document.addEventListener(
  'pointerdown',
  (event) => {
    if (!activeLintPopup) return;
    const path = event.composedPath();
    if (shadowHost && path.includes(shadowHost)) return;
    if (path.includes(activeLintPopup.box.source)) return;
    lintController.closePopup();
  },
  true,
);

function tryExpandSnippetOnKey(event: KeyboardEvent): boolean {
  if (snippetsCache.length === 0 || !activeField) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key !== ' ' && event.key !== 'Tab' && event.key !== 'Enter') return false;

  const el = activeField.element;
  if (isSensitiveElement(el)) return false;
  const ctx = currentSurfaceContext(el);
  if (ctx.isBlocked) return false;

  const trailing = event.key === 'Enter' ? '\n' : ' ';
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start == null || end == null || start !== end) return false;
    const expanded = expandSnippetAtCursor(el.value, start, snippetsCache);
    if (!expanded) return false;
    event.preventDefault();
    const nextText = `${expanded.text.slice(0, expanded.cursor)}${trailing}${expanded.text.slice(expanded.cursor)}`;
    const nextCaret = expanded.cursor + trailing.length;
    setElementValueSafely(el, nextText);
    el.setSelectionRange(nextCaret, nextCaret);
    void lintController.update();
    return true;
  }

  if (el.isContentEditable) {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return false;
    const textContent = node.textContent ?? '';
    const expanded = expandSnippetAtCursor(textContent, range.startOffset, snippetsCache);
    if (!expanded) return false;
    event.preventDefault();
    const deleteRange = document.createRange();
    deleteRange.setStart(node, range.startOffset - expanded.expandedTrigger.length);
    deleteRange.setEnd(node, range.startOffset);
    sel.removeAllRanges();
    sel.addRange(deleteRange);
    const replacement = `${expanded.text.slice(range.startOffset - expanded.expandedTrigger.length, expanded.cursor)}${trailing}`;
    if (!document.execCommand('insertText', false, replacement)) {
      node.textContent = `${expanded.text.slice(0, expanded.cursor)}${trailing}${expanded.text.slice(expanded.cursor)}`;
    }
    void lintController.update();
    return true;
  }
  return false;
}

document.addEventListener('keydown', (event) => {
  if (!activeField) return;
  if (ghostCompletion) {
    if (
      event.key === 'Tab' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      acceptGhostCompletion();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      dismissGhostCompletion();
      return;
    }
  }
  if (tryExpandSnippetOnKey(event)) return;
  const needCtrl = hotkeyCache.modifiers.includes('Ctrl');
  const needShift = hotkeyCache.modifiers.includes('Shift');
  const needAlt = hotkeyCache.modifiers.includes('Alt');
  if (
    event.ctrlKey === needCtrl &&
    event.shiftKey === needShift &&
    event.altKey === needAlt &&
    event.key.toLowerCase() === hotkeyCache.key.toLowerCase()
  ) {
    event.preventDefault();
    openSignal += 1;
    renderOverlays();
  }
});

const WATCHED_STORAGE_KEYS = new Set([
  'lexel_theme',
  'lexel_ai_settings',
  'lexel_surface_overrides',
  'lexel_privacy_blocklist',
  'lexel_custom_slop_terms',
  'lexel_disabled_slop_terms',
  'lexel_custom_surfaces',
  'lexel_weirpacks',
  'lexel_style_guide',
  'lexel_snippets',
  'lexel_language_mode',
  'lexel_ghost_text_enabled',
  'lexel_redact_secrets',
  'lexel_crutch_words',
  'lexel_secret_block_count',
  'openSuggestionsOnHover',
  'activationKey',
  'hotkey',
  'defaultEnable',
  'delay',
  'userDictionary',
  'dialect',
  'isolateEnglish',
  'lintConfig',
  'ignoredLints',
]);

chrome.storage?.onChanged.addListener((changes) => {
  if (
    Object.keys(changes).some((k) => WATCHED_STORAGE_KEYS.has(k) || k.startsWith('domainStatus '))
  ) {
    void hydrateConfig().then(() => {
      ProtocolClient.clearCache();
      void lintController.update();
      renderOverlays();
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === 'getFocusedDraft') {
    const ctx = currentSurfaceContext(activeField?.element ?? null);
    sendResponse({
      text: activeField?.readText() ?? '',
      surfaceId: ctx.surfaceId,
      subcontext: ctx.subcontext,
    });
  } else if (msg?.kind === 'getSmartThreadContext') {
    const extracted = activeField
      ? activeField.readThreadContext()
      : extractSmartThreadContext(null, document, window.location.hostname);
    sendResponse(extracted);
  } else if (msg?.kind === 'applyDraftToFocused' && typeof msg.text === 'string' && activeField) {
    activeField.writeText(msg.text);
    sendResponse({ ok: true });
  }
});

void hydrateConfig(true).finally(() => {
  scanFields();
  if (document.activeElement) {
    captureFocusedElement(document.activeElement);
  }
});

const observer = new MutationObserver(() => scanFields());
if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}
